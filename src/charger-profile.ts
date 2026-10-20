import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface ChargerProfileConfig {
  name: string;
  manufacturer: string;
  model: string;
  connectionType: 'TCP' | 'HTTP';
  connection: {
    defaultTcpPort?: number;
    defaultHttpPort?: number;
    modbusSlaveId?: number;
    supportsRtu?: boolean;
    baseUrl?: string;
  };
  control: {
    currentLimitRegister?: number;
    dataType: 'uint16' | 'float32' | 'int';
    registerCount?: number;
    scalingFactor: number;
    writeFunction?: 'writeSingleRegister' | 'writeMultipleRegisters';
    setEndpoint?: string;
    setMethod?: 'GET' | 'POST';
    setBody?: string;
    pauseMethod?: 'GET' | 'POST';
    pauseEndpoint?: string;
    statusEndpoint?: string;
  };
  encoding?: {
    endianness: 'BigEndian' | 'LittleEndian';
  };
  detection?: {
    type: 'modbus' | 'http';
    probeRegister?: number;
    registerCount?: number;
    probePath?: string;
    probeKey?: string;
    probeKeys?: string[];
  };
  source?: string;
}

/**
 * Loads EV charger profiles from the chargerProfiles/ directory.
 */
export class ChargerProfileLoader {
  private static readonly directory = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'chargerProfiles',
  );
  private static cache: Map<string, ChargerProfileConfig> = new Map();

  static loadAll(): Map<string, ChargerProfileConfig> {
    if (this.cache.size > 0) {
      return this.cache;
    }
    try {
      for (const file of readdirSync(this.directory).filter((f) => f.endsWith('.json'))) {
        try {
          const config = JSON.parse(readFileSync(join(this.directory, file), 'utf-8')) as ChargerProfileConfig;
          this.cache.set(config.name, config);
        } catch (error) {
          console.warn(`Failed to load charger profile ${file}:`, error);
        }
      }
    } catch (error) {
      console.warn('Failed to read chargerProfiles directory:', error);
    }
    return this.cache;
  }

  static getProfile(name: string): ChargerProfileConfig | null {
    return this.loadAll().get(name) ?? null;
  }

  static listAvailableProfiles(): string[] {
    return Array.from(this.loadAll().keys());
  }

  /** Converts amps to the raw register/API value using the profile scale. */
  static ampsToRaw(profile: ChargerProfileConfig, amps: number): number {
    const raw = amps / profile.control.scalingFactor;
    return profile.control.dataType === 'float32' ? raw : Math.round(raw);
  }

  /** Encodes a raw value into big-endian register bytes for Modbus writes. */
  static encodeRegisters(profile: ChargerProfileConfig, raw: number): Buffer {
    if (profile.control.dataType === 'float32') {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(raw, 0);
      return buf;
    }
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(raw, 0);
    return buf;
  }
}
