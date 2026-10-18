/** The live event log (#235, `SIM_EVENT_LOG`): buffered lines, flushed by size, time and close. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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

describe('EventLogWriter when a write fails (#235 review)', () => {
  it('reports once, keeps what was written, and stops writing without throwing', () => {
    const path = join(folder, 'full.jsonl');
    const errors: unknown[] = [];
    let calls = 0;
    const log = new EventLogWriter(path, {
      flushBytes: 8,
      flushMs: 60_000,
      onError: (error) => errors.push(error),
      write: (fd, bytes, offset) => {
        calls++;
        if (calls >= 2) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        return writeSync(fd, bytes, offset);
      },
    });
    log.append('{"a":1}');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    expect(() => {
      log.append('{"b":2}');
      log.append('{"c":3}');
      log.flush();
      log.close();
    }).not.toThrow();
    expect(log.failed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(calls).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('after a failure reports nothing more and writes nothing, however often it is fed', () => {
    const path = join(folder, 'failed-twice.jsonl');
    const errors: unknown[] = [];
    let attempts = 0;
    const log = new EventLogWriter(path, {
      flushBytes: 1,
      flushMs: 60_000,
      onError: (error) => errors.push(error),
      // Every write fails, so any write after the first failure would be a second error.
      write: () => {
        attempts++;
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      },
    });
    log.append('{"a":1}');
    expect(errors).toHaveLength(1);
    expect(log.failed).toBe(true);
    for (let i = 0; i < 5; i++) {
      log.append(`{"after":${String(i)}}`);
      log.flush();
    }
    log.close();
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('writes the rest of a chunk a partial write left', () => {
    const path = join(folder, 'partial.jsonl');
    const log = new EventLogWriter(path, {
      flushMs: 60_000,
      write: (fd, bytes, offset) =>
        writeSync(fd, bytes, offset, Math.min(3, bytes.length - offset)),
    });
    log.append('{"long":"line"}');
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('{"long":"line"}\n');
  });
});
