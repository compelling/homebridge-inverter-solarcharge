import type { Logging } from 'homebridge';

/**
 * Time representation formats used by different inverter manufacturers.
 * PackedBytes: (Hour << 8) | Minute (e.g., Growatt: 0x0202 = 02:02)
 * MinutesFromMidnight: Total minutes since 00:00 (e.g., 02:00 = 120)
 * RawInteger: Direct hour value (some limit to 0-24 range)
 */
export type TimeFormat = 'PackedBytes' | 'MinutesFromMidnight' | 'RawInteger';

/**
 * Byte order used in Modbus register values.
 * BigEndian: Standard Modbus (MSB first)
 * LittleEndian: Some manufacturers deviate from standard
 */
export type Endianness = 'BigEndian' | 'LittleEndian';

/**
 * Physical connection parameters specific to each inverter.
 * RTU = Serial RS485 connection
 * TCP = Network Modbus TCP connection
 */
export interface ConnectionConfig {
  baudRate?: number;              // Serial speed: 9600, 19200, 115200, etc.
  dataBits?: 7 | 8;               // Usually 8
  stopBits?: 1 | 2;               // Usually 1
  parity?: 'none' | 'even' | 'odd'; // Usually 'none' or 'even'
  defaultTcpPort?: number;        // Network: 502, 8899, etc.
  modbusSlaveId: number;          // Modbus device address (typically 1)
}

/**
 * Telemetry/metrics registers - reading live energy data.
 * Uses Modbus Input Registers (Function 04).
 * All values are raw register readings before scaling.
 */
export interface TelemetryMap {
  solarPowerRegister: number;      // PV input power (W)
  loadPowerRegister: number;       // Household consumption (W)
  exportPowerRegister: number;     // Power to grid (W)
  importPowerRegister: number;     // Power from grid (W)
  batteryChargePowerRegister: number;   // Charging rate (W)
  batteryDischargePowerRegister: number; // Discharging rate (W)
  batterySocRegister: number;      // Battery State of Charge (%)
  acFrequencyRegister?: number;    // Grid frequency (Hz)
  inverterTemperatureRegister?: number; // Device temperature (°C)
  scalingFactor: number;           // Multiplier: e.g., 0.1 for W→kW, 1 for direct
}

/**
 * Control registers - setting and reading battery charging/discharging schedules.
 * Uses Modbus Holding Registers (Functions 03, 06, 16).
 */
export interface ControlMap {
  // Discharge / Sell-to-grid settings
  dischargeRateRegister?: number;     // Output power limit (%)
  dischargeStopSocRegister?: number;  // Stop discharge at this battery %
  dischargeStartTimeRegister?: number; // Start time for discharge window
  dischargeStopTimeRegister?: number;  // End time for discharge window
  dischargeEnableRegister?: number;   // Bit/flag to enable discharge schedule

  // Charge / Buy-from-grid settings
  chargeRateRegister?: number;        // Input power limit (%)
  chargeStopSocRegister?: number;     // Stop charging at this battery %
  chargeStartTimeRegister?: number;   // Start time for charge window
  chargeStopTimeRegister?: number;    // End time for charge window
  chargeEnableRegister?: number;      // Bit/flag to enable charge schedule
}

/**
 * Data encoding configuration for this inverter model.
 * Different manufacturers use different byte layouts and value formats.
 */
export interface EncodingConfig {
  timeFormat: TimeFormat;         // How times are represented in registers
  endianness: Endianness;         // Byte order for multi-byte values
  timeScaleFactor?: number;       // If MinutesFromMidnight, multiplier for raw value
}

/**
 * Complete inverter profile specification.
 * Each inverter manufacturer (Growatt, GoodWe, SolarEdge, etc.) provides one of these.
 * This is the bridge between generic HomeKit operations and manufacturer-specific Modbus registers.
 */
export interface InverterProfileConfig {
  // Identifying information
  name: string;                   // E.g., "Growatt_SPH", "GoodWe_ET", "SolarEdge_SE5000"
  manufacturer: string;           // E.g., "Growatt", "GoodWe", "SolarEdge"
  model: string;                  // E.g., "SPH 5000", "ET 5332P"
  phases: 1 | 3;                  // Single-phase or three-phase
  hasBattery: boolean;            // Battery support capability

  // Connection type and parameters
  connectionType: 'RTU' | 'TCP';  // Modbus RTU (serial) or TCP (network)
  connection: ConnectionConfig;

  // Register mappings (5 parameter groups)
  telemetry: TelemetryMap;        // 1. Read-only metrics (telemetry)
  control: ControlMap;            // 2. Control registers (setpoints)
  encoding: EncodingConfig;       // 3. & 4. Data encoding format
}

/**
 * Normalized metrics returned by all inverter profiles.
 * Provides a consistent HomeKit-friendly interface across manufacturers.
 */
export interface InverterMetrics {
  solarPower: number;              // W
  exportPower: number;             // W
  importPower: number;             // W
  loadPower: number;               // W
  batteryChargePower: number;      // W
  batteryDischargePower: number;   // W
  batterySoC: number;              // 0-100 %
  acFrequency?: number;            // Hz
  inverterTemperature?: number;    // °C
}

/**
 * Normalized charge/discharge settings.
 * Used consistently across all inverter brands in HomeKit.
 */
export interface ChargeDischargeState {
  startHour: number;               // 0-23
  stopHour: number;                // 0-23
  enable: boolean;
  stopSoC?: number;                // 0-100 %
  minimumSoC?: number;             // 0-100 %
  ratePercent?: number;            // 0-100 % power limit
}

/**
 * Abstract base class for all inverter profiles.
 * Subclasses implement manufacturer-specific Modbus operations.
 */
export abstract class InverterProfile {
  abstract readonly config: InverterProfileConfig;

  constructor(protected log: Logging) {}

  /**
   * Reads current inverter metrics and normalizes to InverterMetrics format.
   * Implementation handles manufacturer-specific register parsing, scaling, and endianness.
   */
  abstract readMetrics(modbusClient: any): Promise<InverterMetrics>;

  /**
   * Reads battery discharge/sell-to-grid settings from Modbus holding registers.
   */
  abstract readDischargeSettings(modbusClient: any): Promise<ChargeDischargeState | null>;

  /**
   * Reads battery charge/buy-from-grid settings from Modbus holding registers.
   */
  abstract readChargeSettings(modbusClient: any): Promise<ChargeDischargeState | null>;

  /**
   * Sets discharge enable/disable and optionally updates schedule.
   * Implementation varies per manufacturer (some support time windows, others don't).
   */
  abstract setDischargeSettings(
    modbusClient: any,
    enable: boolean,
    startHour?: number,
    stopHour?: number,
    minimumSoC?: number,
  ): Promise<boolean>;

  /**
   * Sets charge enable/disable and optionally updates schedule.
   */
  abstract setChargeSettings(
    modbusClient: any,
    enable: boolean,
    startHour?: number,
    stopHour?: number,
    stopSoC?: number,
  ): Promise<boolean>;

  /**
   * Optional: Attempt to auto-detect this inverter type by reading Modbus registers.
   * Returns true if registers match expected pattern for this manufacturer.
   */
  async autoDetect(modbusClient: any): Promise<boolean> {
    return false;
  }

  /**
   * Helper: Convert time string (HH:MM) to manufacturer-specific register format.
   */
  protected encodeTime(hour: number, minute: number, format: TimeFormat): number {
    switch (format) {
      case 'PackedBytes':
        return (hour << 8) | minute;
      case 'MinutesFromMidnight':
        return hour * 60 + minute;
      case 'RawInteger':
        return hour;
      default:
        return hour;
    }
  }

  /**
   * Helper: Decode time from manufacturer-specific register format to hours.
   */
  protected decodeTime(value: number, format: TimeFormat): { hour: number; minute: number } {
    switch (format) {
      case 'PackedBytes':
        return {
          hour: (value >> 8) & 0xff,
          minute: value & 0xff,
        };
      case 'MinutesFromMidnight':
        return {
          hour: Math.floor(value / 60) % 24,
          minute: value % 60,
        };
      case 'RawInteger':
        return {
          hour: value % 24,
          minute: 0,
        };
      default:
        return { hour: 0, minute: 0 };
    }
  }

  /**
   * Helper: Apply endianness correction to 16-bit value.
   */
  protected applyEndianness(value: number, endianness: Endianness): number {
    if (endianness === 'LittleEndian') {
      return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
    }
    return value;
  }
}
