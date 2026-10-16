import {
  ENTRY_SIZE,
  MODBUS_MAP_VERSION,
  MODBUS_MAX_READ,
  MODBUS_PORT,
  MODBUS_UNIT_ID,
  RING_CAPACITY,
  RING_END,
  REGISTERS,
  STATUS_BITS,
  MACHINE_STATES,
  encodeActiveAlarms,
  encodeEntry,
  modbusTables,
  ringSlot,
  writeU32,
  writeU64,
  type ModbusTables,
  type RingEntry,
} from '@shopfloor/contracts';
import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime } from '@shopfloor/sim-core';
import { ServerTCP } from 'modbus-serial';
import type { PlantEvent } from '../plant/line.ts';
import type { ProcessValues } from '../plant/process-values.ts';

export interface WasherServerOptions {
  readonly config: PlantConfig;
  readonly epoch: number;
  readonly host?: string;
  readonly port?: number;
  /** Errors after a successful start (for example running out of file descriptors). */
  readonly onError?: (error: unknown) => void;
}

export interface WasherSources {
  readonly simulation: { readonly now: SimTime };
  readonly processValues: ProcessValues;
}

type Callback = (error: Error | null, values: number[]) => void;

const illegalAddress = (message: string) =>
  Object.assign(new Error(message), { modbusErrorCode: 2 });

const illegalFunction = () =>
  Object.assign(new Error('only function 3 (read holding registers) is supported'), {
    modbusErrorCode: 1,
  });

/** Tables shared with the gateway: both derive them from the plant configuration. */
export function washerTables(config: PlantConfig): ModbusTables {
  const machine = config.process.processValues.washer.machine;
  const failures = config.failures.equipment[machine];
  return modbusTables({
    products: config.products.products.map((p) => p.id),
    failureCodes: failures?.failureModes.map((m) => m.code) ?? [],
    minorStopCauses: failures?.minorStops.causes ?? [],
  });
}

/**
 * WSH-01 as a legacy Modbus TCP device (docs/contracts/modbus-register-map.md): a snapshot block
 * plus a ring buffer of its last 64 facts, so that a poller loses nothing between polls.
 */
export class WasherModbusServer {
  readonly machineId: string;
  readonly port: number;
  readonly tables: ModbusTables;
  readonly #host: string;
  readonly #onError: (error: unknown) => void;
  readonly #registers = new Array<number>(RING_END).fill(0);
  readonly #resolution: { bath: number; conveyor: number };
  readonly #heaterFault: string;
  #sources: WasherSources | undefined;
  #server: ServerTCP | undefined;
  #seq = 0;
  #cycles = 0;
  #heaterFaultActive = false;
  readonly #activeAlarms = new Set<string>();
  #silent = false;

  constructor({
    config,
    epoch,
    host = '127.0.0.1',
    port = MODBUS_PORT,
    onError = () => undefined,
  }: WasherServerOptions) {
    this.#onError = onError;
    const washer = config.process.processValues.washer;
    this.machineId = washer.machine;
    this.port = port;
    this.#host = host;
    this.tables = washerTables(config);
    this.#resolution = { bath: washer.bath.resolution, conveyor: washer.conveyor.resolution };
    this.#heaterFault = washer.heaterFaultCode;
    this.#registers[REGISTERS.mapVersion] = MODBUS_MAP_VERSION;
    writeU32(this.#registers, REGISTERS.epoch, epoch);
    this.#registers[REGISTERS.ringCapacity] = RING_CAPACITY;
    this.#registers[REGISTERS.entrySize] = ENTRY_SIZE;
  }

  get started(): boolean {
    return this.#server !== undefined;
  }

  get sequence(): number {
    return this.#seq;
  }

  /** A silent device accepts connections but never answers (control API fault, plan section 4). */
  get silent(): boolean {
    return this.#silent;
  }

  set silent(value: boolean) {
    this.#silent = value;
  }

  attach(sources: WasherSources): void {
    this.#sources = sources;
  }

  record(event: PlantEvent): void {
    if (!('machineId' in event) || event.machineId !== this.machineId) {
      return;
    }
    switch (event.type) {
      case 'state':
        this.#registers[REGISTERS.state] = MACHINE_STATES.indexOf(event.to);
        this.#append({
          type: 'state',
          seq: this.#seq + 1,
          at: event.at,
          state: event.to,
          cause: event.cause ?? null,
        });
        break;
      case 'cycle-complete':
        this.#cycles++;
        writeU32(this.#registers, REGISTERS.cycles, this.#cycles);
        this.#append({
          type: 'cycle',
          seq: this.#seq + 1,
          at: event.at,
          product: event.product,
          result: event.result,
          partId: event.partId,
        });
        break;
      case 'alarm':
        if (event.code === this.#heaterFault) {
          this.#heaterFaultActive = event.transition === 'active';
        }
        if (event.transition === 'active') {
          this.#activeAlarms.add(event.code);
        } else {
          this.#activeAlarms.delete(event.code);
        }
        // Written with the entry and its counter in the same turn, so one read of the snapshot
        // block gives bits that belong to its eventCounter (map version 2, #141).
        this.#registers[REGISTERS.activeAlarms] = encodeActiveAlarms(
          this.#activeAlarms,
          this.tables,
        );
        this.#append({
          type: 'alarm',
          seq: this.#seq + 1,
          at: event.at,
          code: event.code,
          transition: event.transition,
        });
        break;
      case 'material-consumed':
      case 'program-loaded':
      case 'repair-start':
      case 'repair-end':
      case 'operator':
      case 'injection-held':
      case 'injection-applied':
        break;
    }
  }

  async start(): Promise<void> {
    const server = await new Promise<ServerTCP>((resolve, reject) => {
      const vector = {
        getHoldingRegister: (
          address: number,
          _unit: number,
          cb: (error: Error | null, value: number) => void,
        ) => {
          this.#read(address, 1, (error, values) => {
            cb(error, values[0] ?? 0);
          });
        },
        getMultipleHoldingRegisters: (
          address: number,
          length: number,
          _unit: number,
          cb: Callback,
        ) => {
          this.#read(address, length, cb);
        },
        // Without these, modbus-serial would not answer at all; a real device answers exception 1.
        getInputRegister: (_a: number, _u: number, cb: (e: Error | null, v: number) => void) => {
          this.#refuse(() => {
            cb(illegalFunction(), 0);
          });
        },
        getMultipleInputRegisters: (_a: number, _l: number, _u: number, cb: Callback) => {
          this.#refuse(() => {
            cb(illegalFunction(), []);
          });
        },
        getCoil: (_a: number, _u: number, cb: (e: Error | null, v: boolean) => void) => {
          this.#refuse(() => {
            cb(illegalFunction(), false);
          });
        },
        getDiscreteInput: (_a: number, _u: number, cb: (e: Error | null, v: boolean) => void) => {
          this.#refuse(() => {
            cb(illegalFunction(), false);
          });
        },
        setRegister: (_a: number, _v: number, _u: number, cb: (e: Error | null) => void) => {
          this.#refuse(() => {
            cb(illegalFunction());
          });
        },
        setRegisterArray: (_a: number, _v: number[], _u: number, cb: (e: Error | null) => void) => {
          this.#refuse(() => {
            cb(illegalFunction());
          });
        },
        setCoil: (_a: number, _v: boolean, _u: number, cb: (e: Error | null) => void) => {
          this.#refuse(() => {
            cb(illegalFunction());
          });
        },
      };
      const tcp = new ServerTCP(vector, {
        host: this.#host,
        port: this.port,
        unitID: MODBUS_UNIT_ID,
      });
      let started = false;
      tcp.on('initialized', () => {
        started = true;
        resolve(tcp);
      });
      tcp.on('serverError', (error: unknown) => {
        if (started) {
          this.#onError(error);
        } else {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    for (const socket of server.socks.keys()) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  #append(entry: RingEntry): void {
    this.#seq = entry.seq;
    const words = encodeEntry(entry, this.tables);
    this.#registers.splice(ringSlot(entry.seq), ENTRY_SIZE, ...words);
    writeU32(this.#registers, REGISTERS.eventCounter, this.#seq);
  }

  #refuse(answer: () => void): void {
    if (!this.#silent) {
      answer();
    }
  }

  #read(address: number, length: number, cb: Callback): void {
    if (this.#silent) {
      return;
    }
    if (length < 1 || length > MODBUS_MAX_READ || address + length > RING_END) {
      cb(illegalAddress(`registers ${String(address)}+${String(length)} outside the map`), []);
      return;
    }
    this.#refresh();
    cb(null, this.#registers.slice(address, address + length));
  }

  /** Values that are functions of time are computed at the last processed simulation step. */
  #refresh(): void {
    const sources = this.#sources;
    if (!sources) return;
    const now = sources.simulation.now;
    writeU64(this.#registers, REGISTERS.simTime, now);
    const reading = sources.processValues.readWasher(now);
    if (reading) {
      this.#registers[REGISTERS.bathTemperature] =
        Math.round(reading.bathCelsius / this.#resolution.bath) & 0xffff;
      this.#registers[REGISTERS.conveyorSpeed] = Math.min(
        0xffff,
        Math.max(0, Math.round(reading.conveyorMetresPerMinute / this.#resolution.conveyor)),
      );
    }
    this.#registers[REGISTERS.status] =
      (reading?.heaterOn ? STATUS_BITS.heaterOn : 0) |
      (this.#heaterFaultActive ? STATUS_BITS.heaterFault : 0) |
      ((reading?.conveyorMetresPerMinute ?? 0) > 0 ? STATUS_BITS.conveyorRunning : 0);
  }
}
