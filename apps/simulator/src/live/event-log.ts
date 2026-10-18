/**
 * The live event log (#235, `SIM_EVENT_LOG`): every plant event as the `sim-event/1` line the
 * event hub numbers run-wide, one per line, in the order the run emitted them. It is the headless
 * `events.jsonl` without its header line (the header lists the inputs, which a live run takes
 * while it runs), so a live run and a headless run of the same timeline compare byte for byte.
 *
 * Lines are buffered and written synchronously in chunks: when the buffer passes `flushBytes`, at
 * least every `flushMs` of wall time, and on `close`. A reader (the resilience suite's R3) sees
 * the log at most `flushMs` behind.
 */
import { closeSync, openSync, writeSync } from 'node:fs';

export interface EventLogOptions {
  readonly flushBytes?: number;
  readonly flushMs?: number;
}

export class EventLogWriter {
  readonly #fd: number;
  readonly #flushBytes: number;
  readonly #timer: ReturnType<typeof setInterval>;
  #chunk = '';
  #closed = false;

  /** Creates (or truncates) the file at `path`. */
  constructor(path: string, { flushBytes = 1 << 16, flushMs = 250 }: EventLogOptions = {}) {
    this.#fd = openSync(path, 'w');
    this.#flushBytes = flushBytes;
    this.#timer = setInterval(() => {
      this.flush();
    }, flushMs);
    this.#timer.unref();
  }

  append(line: string): void {
    if (this.#closed) return;
    this.#chunk += `${line}\n`;
    if (this.#chunk.length >= this.#flushBytes) this.flush();
  }

  flush(): void {
    if (this.#closed || this.#chunk === '') return;
    writeSync(this.#fd, this.#chunk);
    this.#chunk = '';
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    clearInterval(this.#timer);
    this.#closed = true;
    closeSync(this.#fd);
  }
}
