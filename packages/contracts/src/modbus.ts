/**
 * WSH-01 Modbus TCP register map (docs/contracts/modbus-register-map.md). Holding registers only
 * (function code 3), 16-bit words, big-endian; 32- and 64-bit values put the high word first.
 */
import { CAUSES } from './causes.ts';
import { MACHINE_STATES, type MachineState } from './uns/payloads.ts';

/** Severity of a machine's failure-code alarms (OPC UA and Modbus alike, 1–1000). */
export const FAILURE_ALARM_SEVERITY = 700;

export const MODBUS_PORT = 5020;
export const MODBUS_UNIT_ID = 1;
export const MODBUS_MAP_VERSION = 1;
/** Standard Modbus limit for one read of holding registers. */
export const MODBUS_MAX_READ = 125;

export const REGISTERS = {
  mapVersion: 0,
  epoch: 1, // u32
  simTime: 3, // u64, ms since 1970 (simulation time of this snapshot)
  state: 7, // index into MACHINE_STATES
  status: 8, // bit 0 heater on, bit 1 heater fault active, bit 2 conveyor running
  bathTemperature: 9, // i16, °C / bath resolution
  conveyorSpeed: 10, // u16, m/min / conveyor resolution
  cycles: 11, // u32, cycles completed since start
  eventCounter: 13, // u32, sequence of the newest ring entry (0: none yet)
  ringCapacity: 15,
  entrySize: 16,
  ring: 100,
} as const;

export const SNAPSHOT_LENGTH = 17;
export const RING_CAPACITY = 64;
export const ENTRY_SIZE = 10;
export const RING_END = REGISTERS.ring + RING_CAPACITY * ENTRY_SIZE;

export const STATUS_BITS = { heaterOn: 1, heaterFault: 2, conveyorRunning: 4 } as const;

export const ENTRY_TYPES = { state: 1, cycle: 2, alarm: 3 } as const;
export const CYCLE_RESULTS = ['good', 'scrap', 'rework'] as const;

/** Causes the plant model gives when a station is unavailable (not failure or minor-stop codes). */
export const UNAVAILABLE_CAUSES = [CAUSES.break, CAUSES.shiftEnd, CAUSES.noOperator] as const;

export interface ModbusTables {
  /** Index 0 means "no cause". */
  readonly causes: readonly string[];
  readonly products: readonly string[];
  readonly alarms: readonly string[];
}

/** The lookup tables of the register map, derived from the plant configuration the same way on both ends. */
export function modbusTables(input: {
  readonly products: readonly string[];
  readonly failureCodes: readonly string[];
  readonly minorStopCauses: readonly string[];
}): ModbusTables {
  return {
    causes: ['', ...input.failureCodes, ...input.minorStopCauses, ...UNAVAILABLE_CAUSES],
    products: [...input.products],
    alarms: [...input.failureCodes],
  };
}

export const ringSlot = (seq: number): number =>
  REGISTERS.ring + ((seq - 1) % RING_CAPACITY) * ENTRY_SIZE;

export const u32 = (words: readonly number[], at: number): number =>
  (words[at] ?? 0) * 0x1_0000 + (words[at + 1] ?? 0);

export const u64 = (words: readonly number[], at: number): number =>
  ((words[at] ?? 0) * 0x1_0000 + (words[at + 1] ?? 0)) * 0x1_0000_0000 +
  (words[at + 2] ?? 0) * 0x1_0000 +
  (words[at + 3] ?? 0);

export const i16 = (word: number): number => (word >= 0x8000 ? word - 0x1_0000 : word);

export function writeU32(words: number[], at: number, value: number): void {
  words[at] = Math.floor(value / 0x1_0000) & 0xffff;
  words[at + 1] = value & 0xffff;
}

export function writeU64(words: number[], at: number, value: number): void {
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value - high * 0x1_0000_0000;
  writeU32(words, at, high);
  writeU32(words, at + 2, low);
}

export type RingEntry =
  | {
      readonly type: 'state';
      readonly seq: number;
      readonly at: number;
      readonly state: MachineState;
      readonly cause: string | null;
    }
  | {
      readonly type: 'cycle';
      readonly seq: number;
      readonly at: number;
      readonly product: string;
      readonly result: (typeof CYCLE_RESULTS)[number];
      readonly partId: number;
    }
  | {
      readonly type: 'alarm';
      readonly seq: number;
      readonly at: number;
      readonly code: string;
      readonly transition: 'active' | 'cleared';
    };

function indexIn(table: readonly string[], value: string, what: string): number {
  const index = table.indexOf(value);
  if (index < 0) {
    throw new RangeError(`${what} "${value}" is not in the register map's table`);
  }
  return index;
}

/** Encodes one ring entry into ENTRY_SIZE words; throws for a value outside the tables. */
export function encodeEntry(entry: RingEntry, tables: ModbusTables): number[] {
  const words = new Array<number>(ENTRY_SIZE).fill(0);
  writeU32(words, 0, entry.seq);
  writeU64(words, 2, entry.at);
  switch (entry.type) {
    case 'state':
      words[6] = ENTRY_TYPES.state;
      words[7] = MACHINE_STATES.indexOf(entry.state);
      writeU32(words, 8, indexIn(tables.causes, entry.cause ?? '', 'cause'));
      break;
    case 'cycle':
      words[6] = ENTRY_TYPES.cycle;
      words[7] =
        indexIn(tables.products, entry.product, 'product') +
        (CYCLE_RESULTS.indexOf(entry.result) << 8);
      writeU32(words, 8, entry.partId);
      break;
    case 'alarm':
      words[6] = ENTRY_TYPES.alarm;
      words[7] = entry.transition === 'active' ? 1 : 0;
      writeU32(words, 8, indexIn(tables.alarms, entry.code, 'alarm code'));
      break;
  }
  return words;
}

/** Decodes ENTRY_SIZE words; undefined for an empty or malformed slot. */
export function decodeEntry(words: readonly number[], tables: ModbusTables): RingEntry | undefined {
  const seq = u32(words, 0);
  const at = u64(words, 2);
  const a = words[7] ?? 0;
  const b = u32(words, 8);
  const type = words[6] ?? 0;
  if (seq === 0) return undefined;
  switch (type) {
    case ENTRY_TYPES.state: {
      const state = MACHINE_STATES[a];
      if (!state) return undefined;
      return { type: 'state', seq, at, state, cause: b === 0 ? null : (tables.causes[b] ?? null) };
    }
    case ENTRY_TYPES.cycle: {
      const product = tables.products[a & 0xff];
      const result = CYCLE_RESULTS[a >> 8];
      if (!product || !result) return undefined;
      return { type: 'cycle', seq, at, product, result, partId: b };
    }
    case ENTRY_TYPES.alarm: {
      const code = tables.alarms[b];
      if (!code) return undefined;
      return { type: 'alarm', seq, at, code, transition: a === 1 ? 'active' : 'cleared' };
    }
    default:
      return undefined;
  }
}
