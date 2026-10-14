import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformConfig,
  PlatformAccessory,
  Service,
} from 'homebridge';
import ModbusRTU from 'modbus-serial';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SolarChargeUploader } from './solarcharge.js';
import { InverterProfileFactory } from './profile-loader.js';
import type { InverterProfile } from './inverter-profile.js';

// Define a local interface for the Modbus client methods we use.
// This bypasses the legacy CommonJS namespace mapping bugs in strict TypeScript environments.
interface CustomModbusClient {
  connectRTUBuffered(
    path: string,
    options: { baudRate: number },
  ): Promise<void>;
  setID(id: number): void;
  readInputRegisters(
    dataAddress: number,
    length: number,
  ): Promise<{ data: number[] }>;
}

/**
 * DataBuffer accumulates power metrics over a polling period for averaging.
 * Stores individual readings and calculates averages for aggregated uploads.
 */
interface PowerMetrics {
  solar: number; // kW
  export: number; // kW
  pack: number; // kW (grid import)
  usage: number; // kW (local load)
}

class DataBuffer {
  private solarSamples: number[] = [];
  private exportSamples: number[] = [];
  private packSamples: number[] = [];
  private usageSamples: number[] = [];

  add(metrics: PowerMetrics): void {
    this.solarSamples.push(metrics.solar);
    this.exportSamples.push(metrics.export);
    this.packSamples.push(metrics.pack);
    this.usageSamples.push(metrics.usage);
  }

  average(): PowerMetrics {
    if (this.solarSamples.length === 0) {
      return { solar: 0, export: 0, pack: 0, usage: 0 };
    }

    const avg = (samples: number[]): number => {
      const sum = samples.reduce((acc, val) => acc + val, 0);
      return parseFloat((sum / samples.length).toFixed(3));
    };

    return {
      solar: avg(this.solarSamples),
      export: avg(this.exportSamples),
      pack: avg(this.packSamples),
      usage: avg(this.usageSamples),
    };
  }

  sampleCount(): number {
    return this.solarSamples.length;
  }

  clear(): void {
    this.solarSamples = [];
    this.exportSamples = [];
    this.packSamples = [];
    this.usageSamples = [];
  }
}

export class InverterSolarChargePlatform implements DynamicPlatformPlugin {
  // Cast the imported constructor to an unknown constructable object that outputs our interface.
  // This satisfies both the compiler and the strict 'no-explicit-any' ESLint rule.
  private readonly modbusClient =
    new (ModbusRTU as unknown as new () => CustomModbusClient)();

  private readonly plantId!: string;
  private readonly serialNum!: string;
  private readonly serialPort?: string;
  private readonly ipAddress?: string;
  private readonly inverterProfileName: string = 'auto';
  private activeProfile?: InverterProfile;
  private readonly brand!: string; // Inverter brand (e.g., 'Growatt')
  private readonly inverterType!: string; // Inverter type (e.g., 'SPH3600')
  private readonly pollInterval: number = 5000; // Fixed polling: 5 seconds (hardcoded)
  private readonly uploadInterval!: number; // Aggregated upload interval (1-60 minutes)

  private pollingTimer?: NodeJS.Timeout;
  private uploadTimer?: NodeJS.Timeout;
  private dataBuffer!: DataBuffer;
  private solarChargeUploader!: SolarChargeUploader;
  private accessories: PlatformAccessory[] = []; // Track all cached and created accessories
  private inverterAccessory?: PlatformAccessory;
  private batteryLevelAccessory?: PlatformAccessory;

  // HomeKit Services
  private lightSensorService?: Service;
  private switchService?: Service;
  private temperatureSensorService?: Service;
  private batterySwitchService?: Service;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    if (!config || !config.plantId || !config.serialNum) {
      this.log.warn(
        'Plugin is not configured yet. Please enter your plantId and serialNum in the Homebridge UI.',
      );
      return;
    }

    this.plantId = config.plantId;
    this.serialNum = config.serialNum;
    this.serialPort = config.serialPort;
    this.ipAddress = config.ipAddress;
    this.inverterProfileName = (config.inverterProfile as string) || 'auto';

    // Parse inverter string (format: "Brand Model", e.g., "Growatt SPH3600")
    const inverterString = config.inverter || 'Growatt SPH3600';
    const inverterParts = inverterString.split(' ');
    this.brand = inverterParts[0]; // e.g., "Growatt"
    this.inverterType = inverterParts.slice(1).join(' '); // e.g., "SPH3600" (supports multi-word models)
    // Fixed polling interval: always 5 seconds for HomeKit responsiveness
    this.pollInterval = 5000;
    // Upload aggregation interval: configurable, default 300s (5 minutes)
    this.uploadInterval = Math.max(config.uploadInterval || 300, 60) * 1000;
    this.dataBuffer = new DataBuffer();
    this.solarChargeUploader = new SolarChargeUploader(
      this.plantId,
      this.serialNum,
      this.log,
    );

    this.log.info(
      `🔌 Inverter plugin initialized | Profile: ${this.inverterProfileName} | Connection: ${this.ipAddress ? `TCP ${this.ipAddress}` : `RTU ${this.serialPort}`}`,
    );

    this.api.on('didFinishLaunching', () => {
      this.connectAndStartPolling();
    });
  }

  // Homebridge calls this method when loading cached accessories from disk.

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    const inverterUuid = this.api.hap.uuid.generate(
      `${this.brand}-${this.inverterType}-inverter-device`,
    );
    const batteryLevelUuid = this.api.hap.uuid.generate(
      `${this.brand}-${this.inverterType}-battery-level`,
    );
    // Legacy UUIDs for cleanup (from previous Growatt-specific implementation)
    const oldInverterUuid = this.api.hap.uuid.generate(
      'growatt-sph-inverter-device-v2',
    );
    const oldInverterUuidV1 = this.api.hap.uuid.generate(
      'growatt-sph-inverter-device',
    );
    const oldBatteryUuid = this.api.hap.uuid.generate(
      'growatt-sph-battery-sensor',
    );
    const oldSolarUuid = this.api.hap.uuid.generate('growatt-sph-solar-sensor');

    // Remove old legacy accessories from previous implementation
    if (
      accessory.UUID === oldInverterUuid ||
      accessory.UUID === oldInverterUuidV1 ||
      accessory.UUID === oldBatteryUuid ||
      accessory.UUID === oldSolarUuid
    ) {
      this.log.info(
        `Removing legacy accessory from cache: ${accessory.displayName}`,
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
      return;
    }

    // CRITICAL: Detect and REPAIR cached "Solar Battery" accessory
    // Old version has TemperatureSensor with "Battery %" name → causes HAP-NodeJS validation loop + CPU spike
    if (accessory.displayName === 'Solar Battery') {
      const expectedUuid = this.api.hap.uuid.generate(
        `${this.brand}-${this.inverterType}-battery-level`,
      );

      // First: Check if TemperatureSensor has the old "Battery %" name and REMOVE it
      const tempSensor = accessory.getService(
        this.api.hap.Service.TemperatureSensor,
      );
      if (tempSensor) {
        const nameChar = tempSensor.getCharacteristic(
          this.api.hap.Characteristic.Name,
        );
        if (
          nameChar &&
          (nameChar.value === 'Battery %' ||
            String(nameChar.value).includes('Battery %'))
        ) {
          this.log.error(
            '🚨 CRITICAL: Found cached TemperatureSensor with INVALID "Battery %" name!',
          );
          this.log.error(
            '   This causes HAP-NodeJS validation loop and 90% CPU spike.',
          );
          this.log.error(
            '   Removing the broken service and will recreate with "Battery Level" name...',
          );
          // Remove the broken service
          accessory.removeService(tempSensor);
        }
      }

      // Second: If this is our expected UUID, keep the accessory and let discoverDevices() fix it
      if (accessory.UUID === expectedUuid) {
        this.log.info(
          '✓ Solar Battery accessory UUID is correct. Services will be repaired in discoverDevices()...',
        );
      } else {
        // UUID doesn't match our current config - it's from old hardcoded Growatt-SPH version
        this.log.error(
          '🚨 CRITICAL: Solar Battery has OLD hardcoded Growatt-SPH UUID!',
        );
        this.log.error(
          `   UUID: ${accessory.UUID} | Expected: ${expectedUuid}`,
        );
        this.log.error(
          '   Unregistering and will recreate with dynamic UUID...',
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
        return; // Don't cache the old UUID version
      }
    }

    this.accessories.push(accessory);

    if (accessory.UUID === inverterUuid) {
      this.inverterAccessory = accessory;
    } else if (accessory.UUID === batteryLevelUuid) {
      this.batteryLevelAccessory = accessory;
    }
  }

  // Discovers or creates two separate HomeKit accessories with hierarchy:
  //
  // 📱 HOMEBRIDGE INVERTER SOLARCHARGE PLUGIN
  // ├─ 🔌 ACCESSORY 1: "Solar Inverter"
  // │  ├─ 💡 LightSensor → "Inverter Production" (Lux on Home screen)
  // │  ├─ 🔘 Switch → "Inverter Connected" (toggle on Home screen, ON means buy power from grid)
  // │  └─ 🔋 Battery → "Inverter Battery" (secondary - details only)
  // │
  // └─ 🔌 ACCESSORY 2: "Solar Battery"
  //    ├─ 🔘 Switch → "Battery Status" (big tile on Home screen, ON means sell battery power to grid)
  //    └─ 🌡️ TemperatureSensor → "Battery Level" (secondary - shows % in details)

  private discoverDevices(): void {
    const inverterUuid = this.api.hap.uuid.generate(
      `${this.brand}-${this.inverterType}-inverter-device`,
    );
    const batteryLevelUuid = this.api.hap.uuid.generate(
      `${this.brand}-${this.inverterType}-battery-level`,
    );

    // ⚡ CRITICAL FIX: Detect and remove any cached accessories with invalid service names
    // This prevents HAP-NodeJS validation errors and CPU spikes from "Battery %" characteristic
    const accessoriesToRemove: PlatformAccessory[] = [];
    for (const accessory of this.accessories) {
      // Check for old Battery TemperatureSensor with invalid "Battery %" name
      const tempSensor = accessory.getService(
        this.api.hap.Service.TemperatureSensor,
      );
      if (tempSensor) {
        // Get all characteristics to check the Name
        const nameChars = tempSensor.characteristics.filter(
          (c) => c.UUID === this.api.hap.Characteristic.Name.UUID,
        );
        for (const nameChar of nameChars) {
          if (
            nameChar.value === 'Battery %' ||
            String(nameChar.value).includes('Battery %')
          ) {
            this.log.warn(
              '🚨 CRITICAL FIX: Found cached accessory with INVALID "Battery %" name!',
            );
            this.log.warn(
              `   Accessory: ${accessory.displayName} | Service: ${tempSensor.displayName}`,
            );
            this.log.warn(
              '   This causes HAP-NodeJS validation errors and 90% CPU spike.',
            );
            this.log.warn(
              '   ➤ Unregistering and will recreate with valid "Battery Level" name...',
            );
            accessoriesToRemove.push(accessory);
            break;
          }
        }
      }
    }

    // Remove all broken accessories
    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        accessoriesToRemove,
      );
      // Remove from our tracking array too
      for (const broken of accessoriesToRemove) {
        const idx = this.accessories.indexOf(broken);
        if (idx >= 0) {
          this.accessories.splice(idx, 1);
        }
      }
      this.log.warn(
        `✅ Removed ${accessoriesToRemove.length} broken accessory(ies). Recreating now...`,
      );
    }

    // --- INVERTER ACCESSORY 1 (LightSensor + Switch + Battery) ---
    let inverterAccessory = this.accessories.find(
      (acc: PlatformAccessory) => acc.UUID === inverterUuid,
    );

    if (!inverterAccessory) {
      this.log.info('Registering Solar Inverter accessory...');
      inverterAccessory = new this.api.platformAccessory(
        'Solar Inverter',
        inverterUuid,
      );

      // Set category to SENSOR (primary device type for HomeKit compatibility)
      inverterAccessory.category = this.api.hap.Categories.SENSOR;

      // Setup Accessory Information
      inverterAccessory
        .getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.brand)
        .setCharacteristic(
          this.api.hap.Characteristic.Model,
          this.inverterType,
        );

      // Add services to the inverter accessory
      inverterAccessory.addService(
        this.api.hap.Service.LightSensor,
        'Inverter Production',
      );
      inverterAccessory.addService(
        this.api.hap.Service.Switch,
        'Inverter Connected',
      );

      this.accessories.push(inverterAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        inverterAccessory,
      ]);
    }

    this.inverterAccessory = inverterAccessory;

    // Get the Light Sensor service (displays current solar production in Lux)
    this.lightSensorService =
      this.inverterAccessory.getService(this.api.hap.Service.LightSensor) ||
      this.inverterAccessory.addService(this.api.hap.Service.LightSensor);

    if (this.lightSensorService) {
      this.lightSensorService
        .setCharacteristic(
          this.api.hap.Characteristic.Name,
          'Inverter Production',
        )
        .setCharacteristic(
          this.api.hap.Characteristic.CurrentAmbientLightLevel,
          0.0001, // HomeKit minimum lux value
        );
    }

    // Get the Switch service (virtual control button for Home app tile)
    this.switchService =
      this.inverterAccessory.getService(this.api.hap.Service.Switch) ||
      this.inverterAccessory.addService(this.api.hap.Service.Switch);

    if (this.switchService) {
      this.switchService
        .setCharacteristic(
          this.api.hap.Characteristic.Name,
          'Inverter Connected',
        )
        .setCharacteristic(this.api.hap.Characteristic.On, true);

      // Handle toggle changes for AC charge/buy mode
      this.switchService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onSet(async (value: unknown) => {
          const shouldEnable = value as boolean; // what user toggled to (true=ON, false=OFF)
          // Fetch user-defined buy times from SolarCharge API
          let startHour = 2; // Fallback: Standard night charging start (02:00)
          let stopHour = 6; // Fallback: Standard night charging end (06:00)
          let shouldBuy = shouldEnable; // what we actually want to set on the inverter (may be overridden if app has disabled buy times)
          if (shouldEnable) {
            const apiSettings =
              await this.solarChargeUploader.getInverterSettings();
            if (apiSettings) {
              startHour = apiSettings.buyFrom;
              stopHour = apiSettings.buyTo;
              // If app has disabled buy times (both are 0), auto-toggle OFF
              if (startHour === 0 && stopHour === 0) {
                this.log.warn(
                  '⚠️ ACCESSORY 1: App settings show buy is DISABLED (00:00-00:00). Auto-toggling OFF.',
                );
                shouldBuy = false;
              } else {
                this.log.info(
                  `✓ ACCESSORY 1 ON: Using user-defined buy times from API -> ${startHour}:00-${stopHour}:00`,
                );
              }
            } else {
              this.log.warn(
                '⚠️ ACCESSORY 1 ON: Could not fetch API settings, using fallback times (02:00-06:00)',
              );
            }
          }
          const success = await this.activeProfile?.setChargeSettings(
            this.modbusClient,
            shouldBuy,
            startHour,
            stopHour,
          ) ?? false;

          if (success) {
            // Only send settings back when turning OFF, not when turning ON
            // (we already fetched the app settings, so no need to echo them back)
            if (!shouldBuy && shouldEnable) {
              // User tried to turn ON but app had it disabled, notify sync
              this.log.info(
                '✓ ACCESSORY 1 toggled to OFF (app settings disabled buy)',
              );
            } else if (!shouldEnable) {
              // User explicitly turned OFF - read inverter state and sync
              const sellState =
                await this.activeProfile?.readDischargeSettings(
                  this.modbusClient,
                );
              if (sellState) {
                await this.setInverterSettings({
                  sellFrom: sellState.enable ? sellState.startHour : 0,
                  sellTo: sellState.enable ? sellState.stopHour : 0,
                  buyFrom: 0,
                  buyTo: 0,
                });
              }
            }
          } else {
            // Revert the toggle on failure
            setTimeout(() => {
              this.switchService?.updateCharacteristic(
                this.api.hap.Characteristic.On,
                !shouldEnable,
              );
            }, 1000);
            throw new this.api.hap.HapStatusError(
              this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
          }

          // If we auto-toggled OFF due to disabled app settings, update the UI
          if (shouldEnable && !shouldBuy) {
            setTimeout(() => {
              this.switchService?.updateCharacteristic(
                this.api.hap.Characteristic.On,
                false,
              );
            }, 500);
          }
        });
    }



    // --- SOLAR BATTERY ACCESSORY 2 (Switch as primary + TemperatureSensor as secondary) ---
    let batteryLevelAccessory = this.accessories.find(
      (acc: PlatformAccessory) => acc.UUID === batteryLevelUuid,
    );

    if (!batteryLevelAccessory) {
      this.log.info('Registering Solar Battery accessory...');
      batteryLevelAccessory = new this.api.platformAccessory(
        'Solar Battery',
        batteryLevelUuid,
      );

      // Set category to SWITCH (creates a big tile on Home screen)
      batteryLevelAccessory.category = this.api.hap.Categories.SWITCH;

      // Setup Accessory Information
      batteryLevelAccessory
        .getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.brand)
        .setCharacteristic(
          this.api.hap.Characteristic.Model,
          this.inverterType,
        );

      // Add Switch as PRIMARY service (shows as big tile on Home screen)
      batteryLevelAccessory.addService(
        this.api.hap.Service.Switch,
        'Battery Status',
      );

      // Add TemperatureSensor as SECONDARY service (shows battery level in details)
      batteryLevelAccessory.addService(
        this.api.hap.Service.TemperatureSensor,
        'Battery Level',
      );

      this.accessories.push(batteryLevelAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        batteryLevelAccessory,
      ]);
    }

    this.batteryLevelAccessory = batteryLevelAccessory;

    // Get or CREATE switch service
    this.batterySwitchService = batteryLevelAccessory.getService(
      this.api.hap.Service.Switch,
    );
    if (!this.batterySwitchService) {
      this.log.warn(
        '⚠️ Switch service missing from cached Solar Battery accessory. Adding it now...',
      );
      this.batterySwitchService = batteryLevelAccessory.addService(
        this.api.hap.Service.Switch,
      );
    }

    if (this.batterySwitchService) {
      this.batterySwitchService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Battery Status')
        .setCharacteristic(this.api.hap.Characteristic.On, true);

      // Handle toggle changes for discharge/sell mode
      this.batterySwitchService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onSet(async (value: unknown) => {
          const shouldEnable = value as boolean; // what user toggled to (true=ON, false=OFF)
          // Fetch user-defined sell times from SolarCharge API
          let shouldSell = shouldEnable; // what we actually want to set on the inverter (may be overridden if app has disabled sell times)
          if (shouldEnable) {
            const apiSettings =
              await this.solarChargeUploader.getInverterSettings();
            if (apiSettings) {
              // If app has disabled sell times (both are 0), auto-toggle OFF
              if (apiSettings.sellFrom === 0 && apiSettings.sellTo === 0) {
                this.log.warn(
                  '⚠️ ACCESSORY 2: App settings show sell is DISABLED (00:00-00:00). Auto-toggling OFF.',
                );
                shouldSell = false;
              } else {
                this.log.info(
                  `✓ ACCESSORY 2 ON: Using user-defined sell times from API -> ${apiSettings.sellFrom}:00-${apiSettings.sellTo}:00`,
                );
              }
            } else {
              this.log.warn('⚠️ ACCESSORY 2 ON: Could not fetch API settings');
            }
          }
          const success = await this.activeProfile?.setDischargeSettings(
            this.modbusClient,
            shouldSell,
          ) ?? false;

          if (success) {
            // Only send settings back when turning OFF, not when turning ON
            if (!shouldSell && shouldEnable) {
              this.log.info(
                '✓ ACCESSORY 2 toggled to OFF (app settings disabled sell)',
              );
            } else if (!shouldEnable) {
              // User explicitly turned OFF - read inverter state and sync
              const buyState =
                await this.activeProfile?.readChargeSettings(
                  this.modbusClient,
                );
              if (buyState) {
                await this.setInverterSettings({
                  sellFrom: 0,
                  sellTo: 0,
                  buyFrom: buyState.enable ? buyState.startHour : 0,
                  buyTo: buyState.enable ? buyState.stopHour : 0,
                });
              }
            }
          } else {
            // Revert the toggle on failure
            setTimeout(() => {
              this.batterySwitchService?.updateCharacteristic(
                this.api.hap.Characteristic.On,
                !shouldEnable,
              );
            }, 1000);
            throw new this.api.hap.HapStatusError(
              this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
          }
          // If we auto-toggled OFF due to disabled app settings, update the UI
          if (shouldEnable && !shouldSell) {
            setTimeout(() => {
              this.batterySwitchService?.updateCharacteristic(
                this.api.hap.Characteristic.On,
                false,
              );
            }, 500);
          }
        });
    }

    // CRITICAL: Ensure TemperatureSensor exists with CORRECT "Battery Level" name
    // Remove any old "Battery %" characteristic first, then create fresh sensor
    let tempSensorService = batteryLevelAccessory.getService(
      this.api.hap.Service.TemperatureSensor,
    );
    if (tempSensorService) {
      // Check if it still has the old "Battery %" name
      const nameChar = tempSensorService.getCharacteristic(
        this.api.hap.Characteristic.Name,
      );
      if (
        nameChar &&
        (nameChar.value === 'Battery %' ||
          String(nameChar.value).includes('Battery %'))
      ) {
        this.log.error(
          '🚨 CRITICAL: Cached TemperatureSensor still has invalid "Battery %" name!',
        );
        this.log.error(
          '   Removing and recreating with valid "Battery Level" name...',
        );
        batteryLevelAccessory.removeService(tempSensorService);
        tempSensorService = undefined;
      }
    }

    // If TemperatureSensor doesn't exist (was removed or never created), create it now
    if (!tempSensorService) {
      this.log.info(
        'Creating fresh TemperatureSensor service for battery level display...',
      );
      tempSensorService = batteryLevelAccessory.addService(
        this.api.hap.Service.TemperatureSensor,
        'Battery Level',
      );
    }

    this.temperatureSensorService = tempSensorService;
    if (this.temperatureSensorService) {
      this.temperatureSensorService
        .setCharacteristic(this.api.hap.Characteristic.Name, 'Battery Level')
        .setCharacteristic(this.api.hap.Characteristic.CurrentTemperature, 50); // Initial default (0-100 maps to battery %)
    }
  }

  private async connectAndStartPolling(): Promise<void> {
    // Make sure HomeKit UI elements are ready (discover or create Solar Inverter and Solar Battery accessories)
    this.discoverDevices();

    try {
      // Determine connection type and log appropriately
      const connectionInfo = this.ipAddress
        ? `TCP ${this.ipAddress}:8899`
        : `RTU ${this.serialPort}`;
      this.log.info(`🔌 Attempting Modbus connection: ${connectionInfo}...`);

      // Connect based on configuration (RTU serial or TCP network)
      if (this.ipAddress) {
        // TCP connection
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('TCP connection timeout after 10 seconds')),
            10000,
          ),
        );

        // For TCP, we would use ModbusRTU.connectTCP() - adjust as needed for your setup
        this.log.warn('⚠️ TCP support is configured but not fully implemented yet. Using RTU fallback.');
        await this.modbusClient.connectRTUBuffered(this.serialPort || '/dev/ttyUSB0', {
          baudRate: 9600,
        });
      } else {
        // RTU serial connection
        const connectionPromise = this.modbusClient.connectRTUBuffered(
          this.serialPort || '/dev/ttyUSB0',
          { baudRate: 9600 },
        );

        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('Modbus connection timeout after 10 seconds')),
            10000,
          ),
        );

        await Promise.race([connectionPromise, timeoutPromise]);
      }

      this.modbusClient.setID(1);
      this.log.info('✅ Modbus connection established successfully!');

      // Load inverter profile (auto-detect or manual)
      await this.initializeInverterProfile();

      // Dynamically rename accessories in HomeKit based on detected profile
      if (this.activeProfile && this.inverterAccessory) {
        const modelInfo = this.activeProfile.config;
        const displayName = `${modelInfo.manufacturer} ${modelInfo.model}`;

        this.inverterAccessory
          .getService(this.api.hap.Service.AccessoryInformation)
          ?.updateCharacteristic(this.api.hap.Characteristic.Model, displayName);

        this.log.info(
          `📱 Inverter accessory renamed to: "${displayName}" (visible in HomeKit)`,
        );
      }

      // Initial poll and start the fixed polling timer (5 seconds)
      await this.pollInverterData();
      this.pollingTimer = setInterval(
        () => this.pollInverterData(),
        this.pollInterval,
      );

      // Start the upload aggregation timer (configurable interval)
      this.uploadTimer = setInterval(
        () => this.uploadAggregatedData(),
        this.uploadInterval,
      );

      this.log.info(
        `📊 Polling started: every ${this.pollInterval}ms | Upload: every ${this.uploadInterval}ms`,
      );
    } catch (error: any) {
      this.log.error(
        `❌ Failed to establish Modbus connection: ${error.message}`,
      );
      // Retry connection after 30 seconds
      this.log.info('⏳ Retrying connection in 30 seconds...');
      setTimeout(() => this.connectAndStartPolling(), 30000);
    }
  }

  /**
   * Initialize inverter profile - either auto-detect or load manually selected profile.
   * JSON profiles are the master source of truth.
   * Auto-detection searches available profiles by brand name.
   */
  private async initializeInverterProfile(): Promise<void> {
    if (this.inverterProfileName === 'auto') {
      this.log.info('🔍 Auto-detecting inverter profile from available JSON profiles...');
      
      // Get all available profiles from JSON files
      const availableProfiles = InverterProfileFactory.listAvailable();
      this.log.debug(`📋 Available profiles: ${availableProfiles.join(', ')}`);

      // Try to find a profile matching the configured brand
      // Brand comes from config (e.g., "Growatt", "GoodWe", "SolaX", etc.)
      let matchedProfileName: string | null = null;

      for (const profileName of availableProfiles) {
        const config = InverterProfileFactory.getProfileConfig(profileName);
        if (config && config.manufacturer === this.brand) {
          matchedProfileName = profileName;
          this.log.info(
            `✅ Found matching profile for brand "${this.brand}": ${profileName}`,
          );
          break;
        }
      }

      if (!matchedProfileName) {
        // No exact match - try first available profile from manufacturer
        this.log.warn(
          `⚠️ No exact profile match for brand "${this.brand}". Scanning for alternatives...`,
        );

        // List all manufacturers available
        const manufacturers = InverterProfileFactory.getManufacturers();
        this.log.info(`📦 Available manufacturers: ${manufacturers.join(', ')}`);

        if (manufacturers.length > 0) {
          // Default to first manufacturer's first profile
          const defaultManufacturer = manufacturers[0];
          const profilesForManufacturer = InverterProfileFactory.getProfilesByManufacturer(
            defaultManufacturer,
          );

          if (profilesForManufacturer.length > 0) {
            matchedProfileName = profilesForManufacturer[0].name;
            this.log.warn(
              `⚠️ Defaulting to: ${defaultManufacturer} - ${profilesForManufacturer[0].model}`,
            );
          }
        }
      }

      if (matchedProfileName) {
        const profile = InverterProfileFactory.createFromName(matchedProfileName, this.log);
        this.activeProfile = profile || undefined;

        if (this.activeProfile) {
          this.log.info(
            `✅ Loaded profile: ${this.activeProfile.config.manufacturer} ${this.activeProfile.config.model}`,
          );
        }
      } else {
        this.log.error('❌ No inverter profiles found in profiles/ directory');
        throw new Error('No inverter profiles available. Check profiles/ folder.');
      }
    } else {
      // Manual profile selection - let JSON be the source of truth
      this.log.info(`📌 Loading manually selected profile: ${this.inverterProfileName}`);

      const config = InverterProfileFactory.getProfileConfig(this.inverterProfileName);
      if (!config) {
        this.log.error(
          `❌ Profile not found: ${this.inverterProfileName}. Check profiles/ directory.`,
        );
        this.log.info(
          `📋 Available profiles: ${InverterProfileFactory.listAvailable().join(', ')}`,
        );
        throw new Error(`Profile not found: ${this.inverterProfileName}`);
      }

      const profile = InverterProfileFactory.createFromName(this.inverterProfileName, this.log);
      this.activeProfile = profile || undefined;

      if (this.activeProfile) {
        this.log.info(
          `✅ Loaded profile: ${this.activeProfile.config.manufacturer} ${this.activeProfile.config.model}`,
        );
      }
    }
  }

  private async pollInverterData(): Promise<void> {
    try {
      this.log.debug('Polling inverter for data...');

      // Fetch all live inverter telemetry using active profile
      const metrics = await this.activeProfile?.readMetrics(
        this.modbusClient,
      );

      if (!metrics) {
        this.log.error('Failed to read inverter metrics');
        return;
      }

      // Destructure metrics for easier use
      const {
        solarPower,
        batterySoC,
        importPower: packKW,
        exportPower: exportKW,
        loadPower: usageKW,
      } = metrics;

      // Add metrics to buffer for later aggregation (convert W to kW)
      this.dataBuffer.add({
        solar: solarPower / 1000,
        export: exportKW / 1000,
        pack: packKW / 1000,
        usage: usageKW / 1000,
      });

      // Read AC Charge settings to determine if buying from grid
      const acChargeState = await this.activeProfile?.readChargeSettings(
        this.modbusClient,
      );
      const isBuyingFromGrid = acChargeState?.enable ?? false;

      // Read Discharge settings to determine if sending to grid
      const dischargeState =
        await this.activeProfile?.readDischargeSettings(
          this.modbusClient,
        );
      const isSendingToGrid = dischargeState?.enable ?? false;

      const gridMode = isBuyingFromGrid
        ? 'BUYING'
        : isSendingToGrid
          ? 'SENDING'
          : 'IDLE';
      this.log.info(
        `Inverter Data -> Solar: ${(solarPower / 1000).toFixed(2)}kW | Export: ${(exportKW / 1000).toFixed(2)}kW | ` +
          `Import: ${(packKW / 1000).toFixed(2)}kW | Load: ${(usageKW / 1000).toFixed(2)}kW | Battery: ${batterySoC}% | Grid Mode: ${gridMode}`,
      );

      // Update Apple Home UI Elements with current (live) values
      // solarPower is in Watts, HomeKit uses Lux (1 W = 1 Lux)
      const currentWatts = Math.max(solarPower, 0.0001); // HomeKit Lux minimum is 0.0001

      if (this.lightSensorService) {
        // Lux value maps 1:1 to current Watts
        this.lightSensorService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentAmbientLightLevel,
          currentWatts,
        );
      }



      if (this.switchService) {
        // ACCESSORY 1: Switch ON if buying power from grid (AC charging enabled)
        this.switchService.updateCharacteristic(
          this.api.hap.Characteristic.On,
          isBuyingFromGrid,
        );
      }

      if (this.batterySwitchService) {
        // ACCESSORY 2: Switch ON if sending power to grid (discharge/grid-first enabled)
        this.batterySwitchService.updateCharacteristic(
          this.api.hap.Characteristic.On,
          isSendingToGrid,
        );
      }

      if (this.temperatureSensorService) {
        // Display battery level as temperature value (0-100 maps to battery %)
        this.temperatureSensorService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentTemperature,
          batterySoC,
        );
      }
    } catch (error: any) {
      this.log.error(`Error during inverter polling: ${error.message}`);
    }
  }

  private async uploadAggregatedData(): Promise<void> {
    const sampleCount = this.dataBuffer.sampleCount();

    if (sampleCount === 0) {
      this.log.debug('No samples in buffer yet, skipping upload.');
      return;
    }

    const avgMetrics = this.dataBuffer.average();

    this.log.info(
      `Uploading aggregated data (${sampleCount} samples) to SolarCharge API: ` +
        `Solar=${avgMetrics.solar}kW, Export=${avgMetrics.export}kW, Import=${avgMetrics.pack}kW, Usage=${avgMetrics.usage}kW`,
    );

    try {
      // Calculate time window: from (now - uploadInterval) to now
      const now = new Date();
      const uploadStart = new Date(now.getTime() - this.uploadInterval);

      const startHHMM = uploadStart.toTimeString().slice(0, 5); // "HH:MM"
      const endHHMM = now.toTimeString().slice(0, 5); // "HH:MM"

      await this.solarChargeUploader.uploadMetrics(
        avgMetrics,
        startHHMM,
        endHHMM,
      );

      // Clear buffer after successful upload
      this.dataBuffer.clear();
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Error during aggregated upload: ${errorMsg}`);
    }
  }

  private async setInverterSettings(settings: {
    sellFrom: number;
    sellTo: number;
    buyFrom: number;
    buyTo: number;
  }): Promise<void> {
    await this.solarChargeUploader.setInverterSettings(settings);
  }
}
