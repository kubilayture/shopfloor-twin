/** The live event log (#235, `SIM_EVENT_LOG`): buffered lines, flushed by size, time and close. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventLogWriter } from './event-log.ts';

const folder = mkdtempSync(join(tmpdir(), 'sim-event-log-'));

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('EventLogWriter (#235)', () => {
  it('truncates the file and writes one line per event, flushed by size and on close', () => {
    const path = join(folder, 'size.jsonl');
    writeFileSync(path, 'stale\n');
    const log = new EventLogWriter(path, { flushBytes: 10, flushMs: 60_000 });
    expect(readFileSync(path, 'utf8')).toBe('');
    log.append('{"a":1}');
    expect(readFileSync(path, 'utf8')).toBe('');
    log.append('{"b":2}');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    log.append('{"c":3}');
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    log.append('{"after":"close"}');
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  it('flushes at least every flushMs of wall time', async () => {
    const path = join(folder, 'time.jsonl');
    const log = new EventLogWriter(path, { flushMs: 10 });
    log.append('{"a":1}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    log.close();
  });
});
