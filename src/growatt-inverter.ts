// src/growatt-commands.ts

export interface InverterDischargeState {
  dischargeRate: number;
  stopSoc: number;
  fromHour: number;
  toHour: number;
  enable: boolean;
}

// Interface for the new AC grid charging (Grid Charging)
export interface InverterAcChargeState {
  acChargeRate: number; // Register 1068 (%)
  acStopSoc: number;    // Register 1069 (%)
  fromHour: number;     // Register 1075 (Timer)
  toHour: number;       // Register 1076 (Timer)
  enable: boolean;      // Register 1077 (On/Off toggle)
}

// Interface for live inverter telemetry data
export interface InverterMetrics {
  solarKW: number;     // PV Power (Registers 1-2, u32)
  batterySoc: number;  // Battery SoC % (Register 1014, u16)
  gridImportKW: number; // Grid Import Power (Registers 1021-1022, u32)
  gridExportKW: number; // Grid Export Power (Registers 1029-1030, u32)
  localLoadKW: number;  // Local Load Power (Registers 1037-1038, u32)
}

export class GrowattInverterCommands {
  // Safety flag: Set to true to prevent all inverter write operations
  public static readonly DISABLE_INVERTER_WRITES = true;

  // =========================================================================
  // Discharge / Grid First
  // =========================================================================

  public static async setDischargingSettings(modbusClient: any, enable: boolean, log: any): Promise<boolean> {
    if (this.DISABLE_INVERTER_WRITES) {
      log.info(`[Safety] Inverter updates disabled - skipping discharge settings update (would set: ${enable ? 'ENABLED' : 'DISABLED'})`);
      return true; // Return success to prevent UI errors, but don't write
    }

    try {
      const fromHour = 17; const toHour = 21; const stopSoc = 15; const rate = 100;
      const startValue = (fromHour << 8) | 0;
      const stopValue  = (toHour << 8) | 0;
      const isEnabled  = enable ? 1 : 0;

      log.info(`[Modbus Write] Setting discharge to: ${enable ? 'ENABLED' : 'DISABLED'} (${fromHour}:00 - ${toHour}:00)`);
      await modbusClient.writeHoldingRegister(1070, rate);
      await modbusClient.writeHoldingRegister(1071, stopSoc);
      await modbusClient.writeHoldingRegister(1080, startValue);
      await modbusClient.writeHoldingRegister(1081, stopValue);
      await modbusClient.writeHoldingRegister(1082, isEnabled);
      return true;
    } catch (error) {
      log.error('Error while writing discharge data to inverter:', error);
      return false;
    }
  }

  public static async getDischargingSettings(modbusClient: any, log: any): Promise<InverterDischargeState | null> {
    try {
      const registers = await modbusClient.readHoldingRegisters(1070, 13);
      if (!registers || registers.length < 13) {
        throw new Error('Invalid register frame');
      }
      const dischargeRate = registers[0];
      const stopSoc       = registers[1];
      const rawStart      = registers[10];
      const rawStop       = registers[11];
      const isEnabled     = registers[12] === 1;
      return { dischargeRate, stopSoc, fromHour: rawStart >> 8, toHour: rawStop >> 8, enable: isEnabled };
    } catch (error) {
      log.error('Could not read discharge settings:', error);
      return null;
    }
  }

  // =========================================================================
  // AC Charge / Grid Charging
  // =========================================================================

  /**
   * SET API: Configures forced AC charging from the grid (mix_ac_charge_time_period)
   * @param modbusClient Your active CustomModbusClient instance
   * @param enable true = enable network charging, false = disable network charging
   * @param fromHour Starting hour (0-23)
   * @param toHour Ending hour (0-23)
   * @param log Homebridge logger reference
   */
  public static async setChargingSettings(
    modbusClient: any,
    enable: boolean,
    fromHour: number,
    toHour: number,
    log: any,
  ): Promise<boolean> {
    if (this.DISABLE_INVERTER_WRITES) {
      log.info(`[Safety] Inverter updates disabled - skipping AC charging update (would set: ${enable ? 'ENABLED' : 'DISABLED'} ${fromHour}-${toHour})`);
      return true; // Return success to prevent UI errors, but don't write
    }

    try {
      // Default parameters matching your PHP array script logic
      const acPowerRate = 100; // param1: 100% AC Charge Rate power
      const acStopSoc   = 100; // param2: 100% AC Stop SOC (Charge full)
      
      // Pack times into Growatt's uint16 representation (Hour << 8 | Minute)
      const startValue = (fromHour << 8) | 0; // e.g., 02:00 -> 0x0200
      const stopValue  = (toHour << 8) | 0;   // e.g., 06:00 -> 0x0600
      const isEnabled  = enable ? 1 : 0;      // param3 & param8 toggles

      log.info(`[Modbus Write] Setting AC grid-Charging to: ${enable ? 'ENABLED' : 'DISABLED'} (${fromHour}:00 - ${toHour}:00)`);

      // Write parameters down into the consecutive SPH Holding Registers
      await modbusClient.writeHoldingRegister(1068, acPowerRate); // Reg 1068: AC Charge Power rate %
      await modbusClient.writeHoldingRegister(1069, acStopSoc);   // Reg 1069: AC Stop SOC %
      await modbusClient.writeHoldingRegister(1075, startValue);  // Reg 1075: Slot 1 Start Time
      await modbusClient.writeHoldingRegister(1076, stopValue);   // Reg 1076: Slot 1 End Time
      await modbusClient.writeHoldingRegister(1077, isEnabled);   // Reg 1077: Slot 1 AC Charge Toggle

      log.info('[Modbus Write] AC grid-Charging registers successfully saved on the inverter.');
      return true;
    } catch (error) {
      log.error('Failed to write AC charging parameters to inverter over Modbus:', error);
      return false;
    }
  }

  /**
   * GET API: Reads the current forced AC grid charging setup from the inverter
   * @param modbusClient Your active CustomModbusClient instance
   * @param log Homebridge logger reference
   */
  public static async getChargingSettings(
    modbusClient: any,
    log: any,
  ): Promise<InverterAcChargeState | null> {
    try {
      // Read a block of 10 registers starting from 1068 down to 1077
      const registers = await modbusClient.readHoldingRegisters(1068, 10);

      if (!registers || registers.length < 10) {
        throw new Error('Truncated response block received during AC register lookup');
      }

      // Extract raw values using zero-based block offset positions
      const acChargeRate = registers[0]; // Offset 0 (Reg 1068)
      const acStopSoc    = registers[1]; // Offset 1 (Reg 1069)
      const rawStart     = registers[7]; // Offset 7 (Reg 1075)
      const rawStop      = registers[8]; // Offset 8 (Reg 1076)
      const isEnabled    = registers[9] === 1; // Offset 9 (Reg 1077)

      // Decode high bytes to read back the hour values
      const fromHour = rawStart >> 8;
      const toHour   = rawStop >> 8;

      log.info(`[Modbus Read] SPH Current AC Charging Configuration -> Rate: ${acChargeRate}% | Stop SOC: ${acStopSoc}% | Window: ${fromHour}:00 - ${toHour}:00 (Active: ${isEnabled})`);

      return {
        acChargeRate,
        acStopSoc,
        fromHour,
        toHour,
        enable: isEnabled,
      };
    } catch (error) {
      log.error('Failed to parse active AC charging parameters from SPH inverter:', error);
      return null;
    }
  }

  // =========================================================================
  // Telemetry / Live Inverter Metrics
  // =========================================================================

  /**
   * Helper: Combine two 16-bit register values into a single 32-bit value (u32).
   * Modbus u32 values span 2 consecutive registers: high word first, then low word.
   */
  private static combineU32(highWord: number, lowWord: number): number {
    return (highWord << 16) | lowWord;
  }

  /**
   * Helper: Convert raw Growatt Modbus register value to kWatt (kW).
   * Growatt SPH handles values with a 0.1 multiplier for Watts.
   * Dividing by 1000 converts to kW.
   * Total conversion factor: (value * 0.1) / 1000 = value / 10000
   */
  private static convertRegisterToKW(rawValue: number): number {
    const kW = rawValue / 10000;
    return parseFloat(kW.toFixed(3));
  }

  /**
   * GET API: Reads all live inverter telemetry (power and battery state)
   * Fetches: PV power, battery SoC, grid import/export, and local load
   * @param modbusClient Your active CustomModbusClient instance
   * @param log Homebridge logger reference
   */
  public static async getInverterMetrics(
    modbusClient: any,
    log: any,
  ): Promise<InverterMetrics | null> {
    try {
      // Register 1-2: PV Power (u32)
      const pvResult = await modbusClient.readInputRegisters(1, 2);
      const pvRaw = pvResult?.data
        ? this.combineU32(pvResult.data[0] || 0, pvResult.data[1] || 0)
        : 0;
      const solarKW = this.convertRegisterToKW(pvRaw);

      // Register 1014: Battery SoC (u16)
      const batteryResult = await modbusClient.readInputRegisters(1014, 1);
      const batterySoc = Math.min(Math.max(batteryResult?.data?.[0] || 0, 0), 100);

      // Register 1021-1022: Grid Import Power (u32)
      const importResult = await modbusClient.readInputRegisters(1021, 2);
      const importRaw = importResult?.data
        ? this.combineU32(importResult.data[0] || 0, importResult.data[1] || 0)
        : 0;
      const gridImportKW = this.convertRegisterToKW(importRaw);

      // Register 1029-1030: Grid Export Power (u32)
      const exportResult = await modbusClient.readInputRegisters(1029, 2);
      const exportRaw = exportResult?.data
        ? this.combineU32(exportResult.data[0] || 0, exportResult.data[1] || 0)
        : 0;
      const gridExportKW = this.convertRegisterToKW(exportRaw);

      // Register 1037-1038: Local Load Power (u32)
      const loadResult = await modbusClient.readInputRegisters(1037, 2);
      const loadRaw = loadResult?.data
        ? this.combineU32(loadResult.data[0] || 0, loadResult.data[1] || 0)
        : 0;
      const localLoadKW = this.convertRegisterToKW(loadRaw);

      log.debug(
        `[Modbus Read] SPH Telemetry -> Solar: ${solarKW}kW | Export: ${gridExportKW}kW | ` +
        `Import: ${gridImportKW}kW | Load: ${localLoadKW}kW | Battery: ${batterySoc}%`,
      );

      return {
        solarKW,
        batterySoc,
        gridImportKW,
        gridExportKW,
        localLoadKW,
      };
    } catch (error) {
      log.error('Failed to read inverter telemetry from SPH:', error);
      return null;
    }
  }

}
