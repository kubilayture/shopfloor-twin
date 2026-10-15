import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENTRY_SIZE,
  RING_CAPACITY,
  REGISTERS,
  decodeEntry,
  encodeEntry,
  i16,
  modbusTables,
  ringSlot,
  u32,
  u64,
  writeU32,
  writeU64,
  type RingEntry,
} from './modbus.ts';

const tables = modbusTables({
  products: ['VB-100', 'VB-200'],
  failureCodes: ['HEATER-FAULT'],
  minorStopCauses: ['CONVEYOR-JAM'],
});

describe('WSH-01 register map encoding', () => {
  it('builds the lookup tables in a fixed order', () => {
    expect(tables).toEqual({
      causes: ['', 'HEATER-FAULT', 'CONVEYOR-JAM', 'BREAK', 'SHIFT-END', 'NO-OPERATOR'],
      products: ['VB-100', 'VB-200'],
      alarms: ['HEATER-FAULT'],
    });
  });

  it('round-trips 32- and 64-bit values high word first, and signed 16-bit values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.integer({ min: 0, max: 2 ** 53 - 1 }),
        (a, b) => {
          const words = new Array<number>(6).fill(0);
          writeU32(words, 0, a);
          writeU64(words, 2, b);
          expect(words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)).toBe(true);
          expect([u32(words, 0), u64(words, 2)]).toEqual([a, b]);
        },
      ),
    );
    const words: number[] = [];
    writeU32(words, 0, 0x1234_5678);
    expect(words).toEqual([0x1234, 0x5678]);
    expect([i16(0xffff), i16(600), i16(0x8000)]).toEqual([-1, 600, -32768]);
  });

  it.each<RingEntry>([
    { type: 'state', seq: 1, at: 1_791_774_000_000, state: 'Down', cause: 'HEATER-FAULT' },
    { type: 'state', seq: 2, at: 1_791_774_000_001, state: 'Starved', cause: null },
    {
      type: 'cycle',
      seq: 3,
      at: 1_791_774_060_000,
      product: 'VB-200',
      result: 'rework',
      partId: 70_123,
    },
    { type: 'alarm', seq: 4_000_000_000, at: 1, code: 'HEATER-FAULT', transition: 'cleared' },
  ])('round-trips a $type entry', (entry) => {
    const words = encodeEntry(entry, tables);
    expect(words).toHaveLength(ENTRY_SIZE);
    expect(decodeEntry(words, tables)).toEqual(entry);
  });

  it('decodes an empty slot or an unknown type as nothing', () => {
    expect(decodeEntry(new Array<number>(ENTRY_SIZE).fill(0), tables)).toBeUndefined();
    const words = encodeEntry(
      { type: 'alarm', seq: 1, at: 1, code: 'HEATER-FAULT', transition: 'active' },
      tables,
    );
    words[6] = 9;
    expect(decodeEntry(words, tables)).toBeUndefined();
  });

  it('places entry s at slot (s − 1) mod 64, so the ring wraps after 64 facts', () => {
    expect(ringSlot(1)).toBe(REGISTERS.ring);
    expect(ringSlot(64)).toBe(REGISTERS.ring + 63 * ENTRY_SIZE);
    expect(ringSlot(65)).toBe(REGISTERS.ring);
    expect(RING_CAPACITY).toBe(64);
  });
});
