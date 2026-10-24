import { SerialPort } from 'serialport';
import type { Logging } from 'homebridge';

const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;
const MASTER_SIGN = 0x77;
const MIN_AMPS = 6;
const LINKREADY_REPEATS = 5;
const RELINK_AFTER_MS = 10_000;
/** Without a fresh setAmps() call the offered current drops to 0 A. */
const FAILSAFE_MS = 10 * 60 * 1000;

export interface TwcSlaveStatus {
  state: number;
  maxAmps: number;
  actualAmps: number;
}

/** SLIP-style framing used by the Tesla Wall Connector Gen 2 load-share bus: checksum + escaping + 0xC0 delimiters. */
export function encodeTwcFrame(payload: number[]): Buffer {
  let checksum = 0;
  for (let i = 1; i < payload.length; i++) {
    checksum += payload[i];
  }
  const out: number[] = [END];
  for (const byte of [...payload, checksum & 0xff]) {
    if (byte === END) {
      out.push(ESC, ESC_END);
    } else if (byte === ESC) {
      out.push(ESC, ESC_ESC);
    } else {
      out.push(byte);
    }
  }
  out.push(END);
  return Buffer.from(out);
}

/** Splits a byte stream into unescaped frames (checksum verified and stripped). Returns the unconsumed rest. */
export function decodeTwcFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let current: number[] | null = null;
  let escaped = false;
  let consumed = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte === END) {
      if (current && current.length > 2) {
        let sum = 0;
        for (let j = 1; j < current.length - 1; j++) {
          sum += current[j];
        }
        if ((sum & 0xff) === current[current.length - 1]) {
          frames.push(Buffer.from(current.slice(0, -1)));
        }
      }
      current = [];
      escaped = false;
      consumed = i;
    } else if (current) {
      if (escaped) {
        current.push(byte === ESC_END ? END : byte === ESC_ESC ? ESC : byte);
        escaped = false;
      } else if (byte === ESC) {
        escaped = true;
      } else {
        current.push(byte);
      }
    } else {
      consumed = i + 1;
    }
  }
  return { frames, rest: buffer.subarray(consumed) };
}

/**
 * Minimal Tesla Wall Connector Gen 2 load-share master (protocol as implemented by TWCManager).
 * Opens its own serial port (separate from the inverter's Modbus port), announces itself as master,
 * adopts the first slave that answers and keeps offering it the requested current.
 */
export class TwcMaster {
  private port?: SerialPort;
  private rx: Buffer = Buffer.alloc(0);
  private readonly masterId: number[];
  private slaveId?: number[];
  private desiredAmps = 0;
  private desiredSetAt = Date.now();
  private lastRxAt = 0;
  private relinkTimer?: NodeJS.Timeout;
  private linking = false;
  public status?: TwcSlaveStatus;

  constructor(
    private readonly path: string,
    private readonly baudRate: number,
    private readonly log: Logging,
  ) {
    this.masterId = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false });
      port.on('data', (chunk: Buffer) => this.onData(chunk));
      port.on('error', (error) => this.log.error(`TWC serial error: ${error.message}`));
      port.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.port = port;
        this.log.info(`🔌 TWC master listening on ${this.path} @ ${this.baudRate} baud`);
        void this.linkReady();
        this.relinkTimer = setInterval(() => {
          if (Date.now() - this.lastRxAt > RELINK_AFTER_MS) {
            void this.linkReady();
          }
        }, RELINK_AFTER_MS);
        resolve();
      });
    });
  }

  close(): void {
    clearInterval(this.relinkTimer);
    if (this.port?.isOpen) {
      this.port.close();
    }
  }

  /** Sets the current offered to the Wall Connector (0 = stop). Values below 6 A are not supported by the car and become 0. */
  setAmps(amps: number): void {
    this.desiredAmps = amps >= MIN_AMPS ? Math.round(amps) : 0;
    this.desiredSetAt = Date.now();
  }

  private offeredAmps(): number {
    return Date.now() - this.desiredSetAt > FAILSAFE_MS ? 0 : this.desiredAmps;
  }

  private send(payload: number[]): void {
    this.port?.write(encodeTwcFrame(payload));
  }

  private async linkReady(): Promise<void> {
    if (this.linking) {
      return;
    }
    this.linking = true;
    try {
      for (const command of [[0xfc, 0xe1], [0xfb, 0xe2]]) {
        for (let i = 0; i < LINKREADY_REPEATS; i++) {
          this.send([...command, ...this.masterId, MASTER_SIGN, 0, 0, 0, 0, 0, 0, 0, 0]);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } finally {
      this.linking = false;
    }
  }

  private sendHeartbeat(): void {
    if (!this.slaveId) {
      return;
    }
    const amps = this.offeredAmps() * 100;
    // 0x09 limits a charging slave; 0x05 sets the limit before a car starts charging.
    const charging = [0x01, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a].includes(this.status?.state ?? 0);
    this.send([
      0xfb, 0xe0, ...this.masterId, ...this.slaveId,
      charging ? 0x09 : 0x05, (amps >> 8) & 0xff, amps & 0xff, 0, 0, 0, 0, 0, 0,
    ]);
  }

  private onData(chunk: Buffer): void {
    const { frames, rest } = decodeTwcFrames(Buffer.concat([this.rx, chunk]));
    this.rx = rest.length > 512 ? Buffer.alloc(0) : rest;
    for (const frame of frames) {
      this.lastRxAt = Date.now();
      if (frame[0] === 0xfd && frame[1] === 0xe2 && frame.length >= 8) {
        const id = [frame[2], frame[3]];
        if (!this.slaveId) {
          this.slaveId = id;
          this.log.info(`🔗 TWC slave ${id.map((b) => b.toString(16).padStart(2, '0')).join('')} linked (max ${((frame[5] << 8) | frame[6]) / 100} A)`);
        }
        if (id[0] === this.slaveId[0] && id[1] === this.slaveId[1]) {
          this.sendHeartbeat();
        }
      } else if (frame[0] === 0xfd && frame[1] === 0xe0 && frame.length >= 13 && this.slaveId
        && frame[2] === this.slaveId[0] && frame[3] === this.slaveId[1]) {
        this.status = {
          state: frame[6],
          maxAmps: ((frame[7] << 8) | frame[8]) / 100,
          actualAmps: ((frame[9] << 8) | frame[10]) / 100,
        };
        this.sendHeartbeat();
      }
    }
  }
}
