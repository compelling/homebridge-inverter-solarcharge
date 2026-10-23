import type { Logging } from 'homebridge';
import ModbusRTU from 'modbus-serial';
import { ChargerProfileLoader } from './charger-profile.js';
import type { ChargerProfileConfig } from './charger-profile.js';
import type { ChargerSettingsPayload } from './solarcharge.js';

interface ChargerModbusClient {
  connectTCP(address: string, options: { port: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  writeRegister(address: number, value: number): Promise<unknown>;
  writeRegisters(address: number, values: Buffer | number[]): Promise<unknown>;
  close(callback: () => void): void;
}

export interface ChargerControllerOptions {
  profileName: string;
  host: string;
  port?: number;
}

export const DEFAULT_MAX_AMPS = 16;

/**
 * Chargers have no schedule register, so the plugin acts as the scheduler:
 * on every platform poll it receives the SolarCharge charger settings and writes either the
 * allowed amps (inside the window) or 0 A / pause (outside it).
 */
export class ChargerController {
  private running = false;
  private lastSettings: ChargerSettingsPayload | null = null;
  private lastAmps?: number;
  private override = false;
  private lastVoltage = 230;
  private lastMaxAmps = DEFAULT_MAX_AMPS;
  /** Called after every applied current limit (0 = not charging) with the resulting power in watts. */
  public onUpdate?: (amps: number, watts: number) => void;
  private readonly profile: ChargerProfileConfig;

  constructor(
    private readonly options: ChargerControllerOptions,
    private readonly log: Logging,
  ) {
    const profile = ChargerProfileLoader.getProfile(options.profileName);
    if (!profile) {
      throw new Error(
        `Unknown charger profile "${options.profileName}". Available: ${ChargerProfileLoader.listAvailableProfiles().join(', ')}`,
      );
    }
    this.profile = profile;
  }

  /** True if the hour is inside [from, to). Supports windows wrapping midnight. 0/0 means deactivated. */
  static isActive(settings: ChargerSettingsPayload, hour: number): boolean {
    const { from, to, amps } = settings;
    if (amps <= 0 || (from === 0 && to === 0) || from === to) {
      return false;
    }
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }

  get profileName(): string {
    return this.profile.name;
  }

  start(): void {
    this.log.info(`🔌 EV charger enabled: ${this.profile.manufacturer} ${this.profile.model} @ ${this.options.host}`);
  }

  /** Manual override from HomeKit: true charges at max current regardless of the schedule. */
  setOverride(enabled: boolean): Promise<void> {
    this.override = enabled;
    return this.applySettings(this.lastSettings);
  }

  /** Applies the latest SolarCharge settings (null = backend unreachable); called by the platform. */
  async applySettings(settings: ChargerSettingsPayload | null): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastSettings = settings;
    try {
      if (!settings && !this.override) {
        return; // keep the last state when the backend is unreachable
      }
      const maxAmps = settings?.maxAmps || this.lastMaxAmps;
      this.lastMaxAmps = maxAmps;
      const amps = this.override
        ? maxAmps
        : (settings !== null && ChargerController.isActive(settings, new Date().getHours()))
          ? Math.min(settings.amps, maxAmps)
          : 0;
      await this.apply(amps);
      if (amps !== this.lastAmps) {
        this.log.info(`⚡ EV charger current limit set to ${amps} A`);
      }
      this.lastAmps = amps;
      this.lastVoltage = settings?.voltage || this.lastVoltage;
      this.onUpdate?.(amps, amps * this.lastVoltage);
    } catch (error: unknown) {
      this.log.error(`EV charger update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async apply(amps: number): Promise<void> {
    if (this.profile.connectionType === 'HTTP') {
      await this.applyHttp(amps);
    } else {
      await this.applyModbus(amps);
    }
  }

  private async applyHttp(amps: number): Promise<void> {
    const { control, connection } = this.profile;
    const raw = String(ChargerProfileLoader.ampsToRaw(this.profile, amps));
    const pausing = amps === 0 && !!control.pauseEndpoint;
    const path = pausing ? control.pauseEndpoint! : (control.setEndpoint ?? '').replace('{value}', raw);
    const method = (pausing ? control.pauseMethod : control.setMethod) ?? 'GET';
    const body = !pausing && method === 'POST' && control.setBody ? control.setBody.replace('{value}', raw) : undefined;
    const port = this.options.port ?? connection.defaultHttpPort ?? 80;
    const response = await fetch(`http://${this.options.host}:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Charger HTTP ${response.status} ${response.statusText}`);
    }
  }

  private async applyModbus(amps: number): Promise<void> {
    const { control, connection } = this.profile;
    if (control.currentLimitRegister === undefined) {
      throw new Error('Charger profile has no currentLimitRegister');
    }
    const client = new (ModbusRTU as unknown as new () => ChargerModbusClient)();
    try {
      await client.connectTCP(this.options.host, { port: this.options.port ?? connection.defaultTcpPort ?? 502 });
      client.setID(connection.modbusSlaveId ?? 1);
      client.setTimeout(3000);
      const raw = ChargerProfileLoader.ampsToRaw(this.profile, amps);
      if (control.writeFunction === 'writeMultipleRegisters') {
        await client.writeRegisters(control.currentLimitRegister, ChargerProfileLoader.encodeRegisters(this.profile, raw));
      } else {
        await client.writeRegister(control.currentLimitRegister, raw);
      }
    } finally {
      try {
        client.close(() => undefined);
      } catch {
        // connection may already be closed
      }
    }
  }
}
