import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Logging } from 'homebridge';
import type {
  InverterProfileConfig,
  InverterMetrics,
  ChargeDischargeState,
} from './inverter-profile.js';
import { InverterProfile } from './inverter-profile.js';

/**
 * Dynamic inverter profile loader.
 * Reads JSON profile configurations and instantiates InverterProfile implementations.
 * Supports runtime loading of new inverter profiles without code recompilation.
 */
export class ProfileLoader {
  private static readonly profilesDirectory = join(__dirname, '..', 'profiles');
  private static cache: Map<string, InverterProfileConfig> = new Map();

  /**
   * Loads all available profile configurations from the profiles/ directory.
   * Caches results for performance.
   */
  static loadAllProfiles(): Map<string, InverterProfileConfig> {
    if (this.cache.size > 0) {
      return this.cache;
    }

    try {
      const files = readdirSync(this.profilesDirectory).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        const filePath = join(this.profilesDirectory, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const config = JSON.parse(content) as InverterProfileConfig;
          this.cache.set(config.name, config);
        } catch (error) {
          console.warn(`Failed to load profile ${file}:`, error);
        }
      }
    } catch (error) {
      console.warn('Failed to read profiles directory:', error);
    }

    return this.cache;
  }

  /**
   * Gets a single profile configuration by name.
   * @param profileName e.g., "Growatt_SPH", "GoodWe_ET"
   */
  static getProfile(profileName: string): InverterProfileConfig | null {
    const all = this.loadAllProfiles();
    return all.get(profileName) || null;
  }

  /**
   * Lists all available profile names.
   */
  static listAvailableProfiles(): string[] {
    return Array.from(this.loadAllProfiles().keys());
  }

  /**
   * Lists profiles by manufacturer.
   */
  static listByManufacturer(manufacturer: string): InverterProfileConfig[] {
    const all = this.loadAllProfiles();
    return Array.from(all.values()).filter((p) => p.manufacturer === manufacturer);
  }

  /**
   * Gets all manufacturers with available profiles.
   */
  static listManufacturers(): string[] {
    const all = this.loadAllProfiles();
    const manufacturers = new Set<string>();
    for (const config of all.values()) {
      manufacturers.add(config.manufacturer);
    }
    return Array.from(manufacturers).sort();
  }
}

/**
 * Generic inverter profile implementation that uses loaded JSON configuration.
 * Delegates register operations based on the config mapping.
 */
export class DynamicInverterProfile extends InverterProfile {
  readonly config: InverterProfileConfig;
  readonly killSwitch = true; // during developement only log updates but do not perform actual Modbus writes

  constructor(config: InverterProfileConfig, log: Logging) {
    super(log);
    this.config = config;
    this.log.info(
      `✅ Initialized profile: ${config.manufacturer} ${config.model} (${config.connectionType})`,
    );
  }

  async readMetrics(modbusClient: any): Promise<InverterMetrics> {
    try {
      const tm = this.config.telemetry;
      const scale = tm.scalingFactor ?? 1;

      // Read input registers for all metrics
      // Collect all unique registers to minimize Modbus calls
      const registerSet = new Set<number>();
      if (tm.solarPowerRegister) {
        registerSet.add(tm.solarPowerRegister);
      }
      if (tm.exportPowerRegister) {
        registerSet.add(tm.exportPowerRegister);
      }
      if (tm.importPowerRegister) {
        registerSet.add(tm.importPowerRegister);
      }
      if (tm.loadPowerRegister) {
        registerSet.add(tm.loadPowerRegister);
      }
      if (tm.batteryChargePowerRegister) {
        registerSet.add(tm.batteryChargePowerRegister);
      }
      if (tm.batteryDischargePowerRegister) {
        registerSet.add(tm.batteryDischargePowerRegister);
      }
      if (tm.batterySocRegister) {
        registerSet.add(tm.batterySocRegister);
      }

      const registers = Array.from(registerSet).sort((a, b) => a - b);

      if (registers.length === 0) {
        this.log.warn(`[${this.config.name}] No telemetry registers configured`);
        return this.defaultMetrics();
      }

      // Read the smallest contiguous range
      const minReg = registers[0];
      const maxReg = registers[registers.length - 1];
      const rangeSize = maxReg - minReg + 1;

      const values = await modbusClient.readInputRegisters(minReg, rangeSize);
      const registerMap = new Map<number, number>();

      for (let i = 0; i < registers.length; i++) {
        const regAddr = registers[i];
        const offset = regAddr - minReg;
        if (offset < values.length) {
          registerMap.set(regAddr, values[offset]);
        }
      }

      return {
        solarPower: this.readRegister(registerMap, tm.solarPowerRegister) * scale,
        exportPower: this.readRegister(registerMap, tm.exportPowerRegister) * scale,
        importPower: this.readRegister(registerMap, tm.importPowerRegister) * scale,
        loadPower: this.readRegister(registerMap, tm.loadPowerRegister) * scale,
        batteryChargePower: this.readRegister(registerMap, tm.batteryChargePowerRegister) * scale,
        batteryDischargePower:
          this.readRegister(registerMap, tm.batteryDischargePowerRegister) * scale,
        batterySoC: this.readRegister(registerMap, tm.batterySocRegister),
        acFrequency: tm.acFrequencyRegister
          ? this.readRegister(registerMap, tm.acFrequencyRegister)
          : undefined,
        inverterTemperature: tm.inverterTemperatureRegister
          ? this.readRegister(registerMap, tm.inverterTemperatureRegister)
          : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`[${this.config.name}] Failed to read metrics: ${errorMsg}`);
      throw error;
    }
  }

  async readDischargeSettings(modbusClient: any): Promise<ChargeDischargeState | null> {
    try {
      const cm = this.config.control;

      if (
        !cm.dischargeStartTimeRegister ||
        !cm.dischargeStopTimeRegister ||
        !cm.dischargeEnableRegister
      ) {
        this.log.debug(`[${this.config.name}] Discharge not configured`);
        return null;
      }

      const regs = await modbusClient.readHoldingRegisters(cm.dischargeStartTimeRegister, 4);

      const startTime = this.decodeTime(regs[0], this.config.encoding.timeFormat);
      const stopTime = this.decodeTime(regs[1], this.config.encoding.timeFormat);
      const enable = regs[3] !== 0;

      return {
        startHour: startTime.hour,
        stopHour: stopTime.hour,
        enable,
        stopSoC: cm.dischargeStopSocRegister ? regs[2] : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`[${this.config.name}] Failed to read discharge settings: ${errorMsg}`);
      return null;
    }
  }

  async readChargeSettings(modbusClient: any): Promise<ChargeDischargeState | null> {
    try {
      const cm = this.config.control;

      if (
        !cm.chargeStartTimeRegister ||
        !cm.chargeStopTimeRegister ||
        !cm.chargeEnableRegister
      ) {
        this.log.debug(`[${this.config.name}] Charge not configured`);
        return null;
      }

      const regs = await modbusClient.readHoldingRegisters(cm.chargeStartTimeRegister, 4);

      const startTime = this.decodeTime(regs[0], this.config.encoding.timeFormat);
      const stopTime = this.decodeTime(regs[1], this.config.encoding.timeFormat);
      const enable = regs[3] !== 0;

      return {
        startHour: startTime.hour,
        stopHour: stopTime.hour,
        enable,
        stopSoC: cm.chargeStopSocRegister ? regs[2] : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`[${this.config.name}] Failed to read charge settings: ${errorMsg}`);
      return null;
    }
  }

  async setDischargeSettings(
    modbusClient: any,
    enable: boolean,
    startHour = 17,
    stopHour = 21,
    minimumSoC?: number,
  ): Promise<boolean> {
    if (this.killSwitch) {
      this.log.warn(`[${this.config.name}] SetDischargeSettings blocked by kill switch`);
      return true;
    }
    try {
      const cm = this.config.control;

      if (
        !cm.dischargeStartTimeRegister ||
        !cm.dischargeStopTimeRegister ||
        !cm.dischargeEnableRegister
      ) {
        this.log.warn(`[${this.config.name}] Discharge not configured in profile`);
        return false;
      }

      const startValue = this.encodeTime(startHour, 0, this.config.encoding.timeFormat);
      const stopValue = this.encodeTime(stopHour, 0, this.config.encoding.timeFormat);

      const registersToWrite: Array<[number, number]> = [
        [cm.dischargeStartTimeRegister, startValue],
        [cm.dischargeStopTimeRegister, stopValue],
      ];

      if (cm.dischargeStopSocRegister && minimumSoC !== undefined) {
        registersToWrite.push([cm.dischargeStopSocRegister, minimumSoC]);
      }

      if (cm.dischargeEnableRegister) {
        registersToWrite.push([cm.dischargeEnableRegister, enable ? 1 : 0]);
      }

      for (const [register, value] of registersToWrite) {
        await modbusClient.writeRegister(register, value);
      }

      this.log.info(
        `[${this.config.name}] Discharge ${enable ? 'ENABLED' : 'DISABLED'} (${startHour}:00-${stopHour}:00)`,
      );
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`[${this.config.name}] Failed to set discharge settings: ${errorMsg}`);
      return false;
    }
  }

  async setChargeSettings(
    modbusClient: any,
    enable: boolean,
    startHour = 2,
    stopHour = 6,
    stopSoC = 100,
  ): Promise<boolean> {
    try {
      if (this.killSwitch) {
        this.log.warn(`[${this.config.name}] SetChargeSettings blocked by kill switch`);
        return true;
      }

      const cm = this.config.control;
      if (!cm.chargeStartTimeRegister || !cm.chargeStopTimeRegister || !cm.chargeEnableRegister) {
        this.log.warn(`[${this.config.name}] Charge not configured in profile`);
        return false;
      }

      const startValue = this.encodeTime(startHour, 0, this.config.encoding.timeFormat);
      const stopValue = this.encodeTime(stopHour, 0, this.config.encoding.timeFormat);

      const registersToWrite: Array<[number, number]> = [
        [cm.chargeStartTimeRegister, startValue],
        [cm.chargeStopTimeRegister, stopValue],
      ];

      if (cm.chargeStopSocRegister && stopSoC !== undefined) {
        registersToWrite.push([cm.chargeStopSocRegister, stopSoC]);
      }

      if (cm.chargeEnableRegister) {
        registersToWrite.push([cm.chargeEnableRegister, enable ? 1 : 0]);
      }

      for (const [register, value] of registersToWrite) {
        await modbusClient.writeRegister(register, value);
      }

      this.log.info(
        `[${this.config.name}] Charge ${enable ? 'ENABLED' : 'DISABLED'} (${startHour}:00-${stopHour}:00, stop at ${stopSoC}%)`,
      );
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`[${this.config.name}] Failed to set charge settings: ${errorMsg}`);
      return false;
    }
  }

  private readRegister(
    registerMap: Map<number, number>,
    registerAddress?: number,
  ): number {
    if (!registerAddress) {
      return 0;
    }
    return registerMap.get(registerAddress) ?? 0;
  }

  private defaultMetrics(): InverterMetrics {
    return {
      solarPower: 0,
      exportPower: 0,
      importPower: 0,
      loadPower: 0,
      batteryChargePower: 0,
      batteryDischargePower: 0,
      batterySoC: 0,
    };
  }
}

/**
 * Factory to create inverter profiles from JSON config or profile name.
 */
export class InverterProfileFactory {
  static createFromName(profileName: string, log: Logging): InverterProfile | null {
    const config = ProfileLoader.getProfile(profileName);
    if (!config) {
      log.error(`Profile not found: ${profileName}`);
      return null;
    }
    return new DynamicInverterProfile(config, log);
  }

  static createFromConfig(config: InverterProfileConfig, log: Logging): InverterProfile {
    return new DynamicInverterProfile(config, log);
  }

  static listAvailable(): string[] {
    return ProfileLoader.listAvailableProfiles();
  }

  static getManufacturers(): string[] {
    return ProfileLoader.listManufacturers();
  }

  static getProfilesByManufacturer(manufacturer: string): InverterProfileConfig[] {
    return ProfileLoader.listByManufacturer(manufacturer);
  }

  static getProfileConfig(profileName: string): InverterProfileConfig | null {
    return ProfileLoader.getProfile(profileName);
  }
}
