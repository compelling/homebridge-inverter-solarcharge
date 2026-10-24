import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Logging } from 'homebridge';
import type {
  InverterProfileConfig,
  InverterMetrics,
  ChargeDischargeState,
} from './inverter-profile.js';
import { InverterProfile } from './inverter-profile.js';

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    return JSON.stringify(error, Object.getOwnPropertyNames(error));
  }
  return String(error);
}

/**
 * Dynamic inverter profile loader.
 * Reads JSON profile configurations and instantiates InverterProfile implementations.
 * Supports runtime loading of new inverter profiles without code recompilation.
 */
export class ProfileLoader {
  private static readonly profilesDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'profiles',
  );
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
      const files = readdirSync(this.profilesDirectory).filter((f) =>
        f.endsWith('.json'),
      );

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
    return Array.from(all.values()).filter(
      (p) => p.manufacturer === manufacturer,
    );
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
  readonly killSwitch = false; // during developement only log updates but do not perform actual Modbus writes

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

      const u32 = new Set(tm.u32Registers ?? []);

      // Registers can be far apart, so read each one individually (u32 values span 2 registers)
      const read = async (register?: number): Promise<number> => {
        if (!register) {
          return 0;
        }
        if (u32.has(register)) {
          const res = await modbusClient.readInputRegisters(register, 2);
          return (res?.data?.[0] ?? 0) * 65536 + (res?.data?.[1] ?? 0);
        }
        const res = await modbusClient.readInputRegisters(register, 1);
        return res?.data?.[0] ?? 0;
      };

      const solar = await read(tm.solarPowerRegister);
      const exportP = await read(tm.exportPowerRegister);
      const importP = await read(tm.importPowerRegister);
      const load = await read(tm.loadPowerRegister);
      const charge = await read(tm.batteryChargePowerRegister);
      const discharge = await read(tm.batteryDischargePowerRegister);
      const soc = await read(tm.batterySocRegister);

      return {
        solarPower: solar * scale,
        exportPower: exportP * scale,
        importPower: importP * scale,
        loadPower: load * scale,
        batteryChargePower: charge * scale,
        batteryDischargePower: discharge * scale,
        batterySoC: Math.min(Math.max(soc, 0), 100),
        acFrequency: tm.acFrequencyRegister
          ? await read(tm.acFrequencyRegister)
          : undefined,
        inverterTemperature: tm.inverterTemperatureRegister
          ? await read(tm.inverterTemperatureRegister)
          : undefined,
      };
    } catch (error) {
      const errorMsg = describeError(error);
      this.log.error(
        `[${this.config.name}] Failed to read metrics: ${errorMsg}`,
      );
      throw error;
    }
  }

  private clockWriteUnsupported = false;

  async syncClock(modbusClient: any, maxSkewSeconds = 60): Promise<number | null> {
    const clock = this.config.clock;
    if (!clock) {
      return null;
    }
    const count = clock.layout === 'SixRegisters' ? 6 : 3;
    const raw: number[] = (
      await modbusClient.readHoldingRegisters(clock.register, count)
    ).data;

    let parts: number[]; // year, month, day, hour, minute, second
    if (clock.layout === 'SixRegisters') {
      parts = raw.slice(0, 6);
    } else {
      parts = [
        raw[0] >> 8, raw[0] & 0xff,
        raw[1] >> 8, raw[1] & 0xff,
        raw[2] >> 8, raw[2] & 0xff,
      ];
    }
    const twoDigitYear = parts[0] < 100;
    const year = twoDigitYear ? 2000 + parts[0] : parts[0];
    const inverterTime = new Date(
      year, parts[1] - 1, parts[2], parts[3], parts[4], parts[5],
    ).getTime();
    const now = new Date();
    const skew = Math.round((inverterTime - now.getTime()) / 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const text = `${year}-${pad(parts[1])}-${pad(parts[2])} ${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5])}`;

    if (Number.isNaN(skew)) {
      this.log.warn(`[${this.config.name}] Inverter clock unreadable (${raw.join(',')})`);
      return null;
    }
    if (Math.abs(skew) <= maxSkewSeconds) {
      this.log.debug(`[${this.config.name}] Inverter clock ${text} within ${skew}s of host time`);
      return skew;
    }

    const yearValue = twoDigitYear ? now.getFullYear() - 2000 : now.getFullYear();
    const values =
      clock.layout === 'SixRegisters'
        ? [yearValue, now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
        : [
          (yearValue << 8) | (now.getMonth() + 1),
          (now.getDate() << 8) | now.getHours(),
          (now.getMinutes() << 8) | now.getSeconds(),
        ];

    if (this.clockWriteUnsupported) {
      this.log.debug(`[${this.config.name}] Inverter clock ${text} is ${skew}s off host time (clock is not writable on this inverter)`);
      return skew;
    }
    this.log.warn(
      `[${this.config.name}] Inverter clock ${text} is ${skew}s off host time; ${this.killSwitch ? 'would set' : 'setting'} it to ${now.toString()}`,
    );
    if (this.killSwitch) {
      return skew;
    }

    // Try the write forms in turn: one multi-register write (function 16), function 16 per register, function 6 per register
    const attempts: Array<[string, () => Promise<void>]> = [
      ['function 16, all registers', async () => {
        await modbusClient.writeRegisters(clock.register, values);
      }],
      ['function 16, per register', async () => {
        for (let i = 0; i < values.length; i++) {
          await modbusClient.writeRegisters(clock.register + i, [values[i]]);
        }
      }],
      ['function 6, per register', async () => {
        for (let i = 0; i < values.length; i++) {
          await modbusClient.writeRegister(clock.register + i, values[i]);
        }
      }],
    ];
    const failures: string[] = [];
    for (const [name, attempt] of attempts) {
      try {
        await attempt();
        this.log.info(`[${this.config.name}] Inverter clock set via ${name}`);
        return skew;
      } catch (error) {
        failures.push(`${name}: ${describeError(error)}`);
      }
    }
    this.clockWriteUnsupported = true;
    this.log.warn(
      `[${this.config.name}] Could not set the inverter clock, giving up on writes (${failures.join(' | ')}). Skew will only be logged at debug level.`,
    );
    return skew;
  }

  async readDischargeSettings(
    modbusClient: any,
    includeTimes = false,
  ): Promise<ChargeDischargeState | null> {
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

      const readHolding = async (register: number): Promise<number> =>
        (await modbusClient.readHoldingRegisters(register, 1)).data[0] ?? 0;

      const enableRaw = await readHolding(cm.dischargeEnableRegister);
      const enable = enableRaw === 1;

      if (!includeTimes && !this.debugLogging) {
        return { startHour: 0, stopHour: 0, enable };
      }

      const startRaw = await readHolding(cm.dischargeStartTimeRegister);
      const stopRaw = await readHolding(cm.dischargeStopTimeRegister);
      const startTime = this.decodeTime(
        startRaw,
        this.config.encoding.timeFormat,
      );
      const stopTime = this.decodeTime(
        stopRaw,
        this.config.encoding.timeFormat,
      );
      if (this.debugLogging) {
        this.log.info(
          `[${this.config.name}] discharge raw -> start=0x${startRaw.toString(16)} stop=0x${stopRaw.toString(16)} enable=${enableRaw}`,
        );
      }

      return {
        startHour: startTime.hour,
        stopHour: stopTime.hour,
        enable,
        stopSoC: cm.dischargeStopSocRegister
          ? await readHolding(cm.dischargeStopSocRegister)
          : undefined,
      };
    } catch (error) {
      const errorMsg = describeError(error);
      this.log.error(
        `[${this.config.name}] Failed to read discharge settings: ${errorMsg}`,
      );
      return null;
    }
  }

  async readChargeSettings(
    modbusClient: any,
    includeTimes = false,
  ): Promise<ChargeDischargeState | null> {
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

      const readHolding = async (register: number): Promise<number> =>
        (await modbusClient.readHoldingRegisters(register, 1)).data[0] ?? 0;

      const enableRaw = await readHolding(cm.chargeEnableRegister);
      const enable = enableRaw === 1;

      if (!includeTimes && !this.debugLogging) {
        return { startHour: 0, stopHour: 0, enable };
      }

      const startRaw = await readHolding(cm.chargeStartTimeRegister);
      const stopRaw = await readHolding(cm.chargeStopTimeRegister);
      const startTime = this.decodeTime(
        startRaw,
        this.config.encoding.timeFormat,
      );
      const stopTime = this.decodeTime(
        stopRaw,
        this.config.encoding.timeFormat,
      );
      if (this.debugLogging) {
        this.log.info(
          `[${this.config.name}] charge raw -> start=0x${startRaw.toString(16)} stop=0x${stopRaw.toString(16)} enable=${enableRaw}`,
        );
      }

      return {
        startHour: startTime.hour,
        stopHour: stopTime.hour,
        enable,
        stopSoC: cm.chargeStopSocRegister
          ? await readHolding(cm.chargeStopSocRegister)
          : undefined,
      };
    } catch (error) {
      const errorMsg = describeError(error);
      this.log.error(
        `[${this.config.name}] Failed to read charge settings: ${errorMsg}`,
      );
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
      this.log.warn(
        `[${this.config.name}] SetDischargeSettings blocked by kill switch`,
      );
      return true;
    }
    try {
      const cm = this.config.control;

      if (
        !cm.dischargeStartTimeRegister ||
        !cm.dischargeStopTimeRegister ||
        !cm.dischargeEnableRegister
      ) {
        this.log.warn(
          `[${this.config.name}] Discharge not configured in profile`,
        );
        return false;
      }

      const startValue = this.encodeTime(
        startHour,
        0,
        this.config.encoding.timeFormat,
      );
      const stopValue = this.encodeTime(
        stopHour,
        0,
        this.config.encoding.timeFormat,
      );

      // Disabling only clears the enable flag so the stored schedule is preserved
      const registersToWrite: Array<[number, number]> = enable
        ? [
          [cm.dischargeStartTimeRegister, startValue],
          [cm.dischargeStopTimeRegister, stopValue],
        ]
        : [];

      if (enable && cm.dischargeStopSocRegister && minimumSoC !== undefined) {
        registersToWrite.push([cm.dischargeStopSocRegister, minimumSoC]);
      }

      if (cm.dischargeEnableRegister) {
        registersToWrite.push([cm.dischargeEnableRegister, enable ? 1 : 0]);
      }

      if (!enable && cm.dischargeEnableRegister) {
        // Writing 0 over an already-0 enable flag makes the inverter copy the other schedule's window
        const current =
          (await modbusClient.readHoldingRegisters(cm.dischargeEnableRegister, 1))
            .data[0] ?? 0;
        if (current === 0) {
          this.log.info(
            `[${this.config.name}] Discharge already disabled, nothing written`,
          );
          return true;
        }
      }

      for (const [register, value] of registersToWrite) {
        await modbusClient.writeRegister(register, value);
      }

      this.log.info(
        `[${this.config.name}] Discharge ${enable ? `ENABLED (${startHour}:00-${stopHour}:00)` : 'DISABLED (schedule unchanged)'}`,
      );
      return true;
    } catch (error) {
      const errorMsg = describeError(error);
      this.log.error(
        `[${this.config.name}] Failed to set discharge settings: ${errorMsg}`,
      );
      return false;
    }
  }

  async setChargeSettings(
    modbusClient: any,
    enable: boolean,
    startHour = 2,
    stopHour = 6,
    stopSoC?: number,
  ): Promise<boolean> {
    try {
      if (this.killSwitch) {
        this.log.warn(
          `[${this.config.name}] SetChargeSettings blocked by kill switch`,
        );
        return true;
      }

      const cm = this.config.control;
      if (
        !cm.chargeStartTimeRegister ||
        !cm.chargeStopTimeRegister ||
        !cm.chargeEnableRegister
      ) {
        this.log.warn(`[${this.config.name}] Charge not configured in profile`);
        return false;
      }

      const startValue = this.encodeTime(
        startHour,
        0,
        this.config.encoding.timeFormat,
      );
      const stopValue = this.encodeTime(
        stopHour,
        0,
        this.config.encoding.timeFormat,
      );

      // Disabling only clears the enable flag so the stored schedule is preserved
      const registersToWrite: Array<[number, number]> = enable
        ? [
          [cm.chargeStartTimeRegister, startValue],
          [cm.chargeStopTimeRegister, stopValue],
        ]
        : [];

      if (enable && cm.chargeStopSocRegister) {
        let socToWrite = stopSoC;
        if (socToWrite === undefined) {
          // Keep the inverter's own stop-SoC unless it is unset/invalid (an empty one makes charging stop at once)
          const current =
            (await modbusClient.readHoldingRegisters(cm.chargeStopSocRegister, 1))
              .data[0] ?? 0;
          if (current < 1 || current > 100) {
            socToWrite = 100;
          }
        }
        if (socToWrite !== undefined) {
          registersToWrite.push([cm.chargeStopSocRegister, socToWrite]);
        }
      }

      if (cm.chargeGridEnableRegister) {
        registersToWrite.push([cm.chargeGridEnableRegister, enable ? 1 : 0]);
      }

      if (cm.chargeEnableRegister) {
        registersToWrite.push([cm.chargeEnableRegister, enable ? 1 : 0]);
      }

      if (!enable && cm.chargeEnableRegister) {
        // Writing 0 over an already-0 enable flag makes the inverter copy the other schedule's window
        const current =
          (await modbusClient.readHoldingRegisters(cm.chargeEnableRegister, 1))
            .data[0] ?? 0;
        if (current === 0) {
          this.log.info(
            `[${this.config.name}] Charge already disabled, nothing written`,
          );
          return true;
        }
      }

      for (const [register, value] of registersToWrite) {
        await modbusClient.writeRegister(register, value);
      }

      // The inverter applies writes slightly late, so verify once after all writes
      await new Promise((resolve) => setTimeout(resolve, 2000));
      for (const [register, value] of registersToWrite) {
        const readBack =
          (await modbusClient.readHoldingRegisters(register, 1)).data[0] ?? 0;
        const message = `[${this.config.name}] charge write reg ${register} = ${value}, read back ${readBack}`;
        if (readBack !== value) {
          this.log.warn(`${message} (MISMATCH: inverter did not accept the value)`);
        } else if (this.debugLogging) {
          this.log.info(message);
        }
      }

      this.log.info(
        `[${this.config.name}] Charge ${enable ? `ENABLED (${startHour}:00-${stopHour}:00${stopSoC !== undefined ? `, stop at ${stopSoC}%` : ''})` : 'DISABLED (schedule unchanged)'}`,
      );
      return true;
    } catch (error) {
      const errorMsg = describeError(error);
      this.log.error(
        `[${this.config.name}] Failed to set charge settings: ${errorMsg}`,
      );
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
  static createFromName(
    profileName: string,
    log: Logging,
  ): InverterProfile | null {
    const config = ProfileLoader.getProfile(profileName);
    if (!config) {
      log.error(`Profile not found: ${profileName}`);
      return null;
    }
    return new DynamicInverterProfile(config, log);
  }

  static createFromConfig(
    config: InverterProfileConfig,
    log: Logging,
  ): InverterProfile {
    return new DynamicInverterProfile(config, log);
  }

  static listAvailable(): string[] {
    return ProfileLoader.listAvailableProfiles();
  }

  static getManufacturers(): string[] {
    return ProfileLoader.listManufacturers();
  }

  static getProfilesByManufacturer(
    manufacturer: string,
  ): InverterProfileConfig[] {
    return ProfileLoader.listByManufacturer(manufacturer);
  }

  static getProfileConfig(profileName: string): InverterProfileConfig | null {
    return ProfileLoader.getProfile(profileName);
  }
}
