import ModbusRTU from 'modbus-serial';
import { ChargerProfileLoader } from './charger-profile.js';
import type { ChargerProfileConfig } from './charger-profile.js';

interface ProbeModbusClient {
  connectTCP(address: string, options: { port: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  readHoldingRegisters(address: number, length: number): Promise<unknown>;
  close(callback: () => void): void;
}

export interface DetectionResult {
  /** Matching profile names; exactly one means a confident detection. */
  matches: string[];
  /** False when the host could not be reached at all. */
  reachable: boolean;
}

async function probeModbus(profile: ChargerProfileConfig, host: string, port?: number): Promise<{ reachable: boolean; match: boolean }> {
  const detection = profile.detection;
  if (!detection || detection.probeRegister === undefined) {
    return { reachable: false, match: false };
  }
  const client = new (ModbusRTU as unknown as new () => ProbeModbusClient)();
  try {
    await client.connectTCP(host, { port: port ?? profile.connection.defaultTcpPort ?? 502 });
  } catch {
    return { reachable: false, match: false };
  }
  try {
    client.setID(profile.connection.modbusSlaveId ?? 1);
    client.setTimeout(3000);
    await client.readHoldingRegisters(detection.probeRegister, detection.registerCount ?? 1);
    return { reachable: true, match: true };
  } catch {
    return { reachable: true, match: false };
  } finally {
    try {
      client.close(() => undefined);
    } catch {
      // already closed
    }
  }
}

async function probeHttp(profile: ChargerProfileConfig, host: string, port?: number): Promise<{ reachable: boolean; match: boolean }> {
  const detection = profile.detection;
  if (!detection?.probePath) {
    return { reachable: false, match: false };
  }
  try {
    const response = await fetch(`http://${host}:${port ?? profile.connection.defaultHttpPort ?? 80}${detection.probePath}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { reachable: true, match: false };
    }
    const data = await response.json() as Record<string, unknown>;
    const keys = detection.probeKeys ?? (detection.probeKey ? [detection.probeKey] : []);
    return { reachable: true, match: keys.length === 0 || keys.some((k) => k in data) };
  } catch {
    return { reachable: false, match: false };
  }
}

/** Splits "host:port" (e.g. "127.0.0.1:8080") into its parts; an explicit port argument wins. */
export function parseHostPort(input: string, port?: number): { host: string; port?: number } {
  const match = /^([^:/\s]+):(\d{1,5})$/.exec(input.trim());
  if (match) {
    return { host: match[1], port: port ?? parseInt(match[2], 10) };
  }
  return { host: input.trim(), port };
}

/**
 * Probes every charger profile that declares a "detection" block (read-only requests)
 * and returns the profiles that responded. Modbus register probes can overlap between
 * vendors, so callers should only trust a result with a single match.
 */
export async function detectCharger(host: string, port?: number): Promise<DetectionResult> {
  const matches: string[] = [];
  let reachable = false;
  for (const name of ChargerProfileLoader.listAvailableProfiles()) {
    const profile = ChargerProfileLoader.getProfile(name);
    if (!profile?.detection) {
      continue;
    }
    const result = profile.detection.type === 'http'
      ? await probeHttp(profile, host, port)
      : await probeModbus(profile, host, port);
    reachable ||= result.reachable;
    if (result.match) {
      matches.push(name);
    }
  }
  return { matches, reachable };
}
