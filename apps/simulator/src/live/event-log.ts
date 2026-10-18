/**
 * The live event log (#235, `SIM_EVENT_LOG`): every plant event as the `sim-event/1` line the
 * event hub numbers run-wide, one per line, in the order the run emitted them. It is the headless
 * `events.jsonl` without its header line (the header lists the inputs, which a live run takes
 * while it runs), so a live run and a headless run of the same timeline compare byte for byte.
 *
 * Lines are buffered and written synchronously in chunks: when the buffer passes `flushBytes`, at
 * least every `flushMs` of wall time, and on `close`. A reader (the resilience suite's R3) sees
 * the log at most `flushMs` behind.
 *
 * A failed write (a full disk, a removed volume) never stops the simulation (#235 review): the
 * writer reports the error once through `onError`, drops what it holds, marks itself `failed`
 * (the control API's `sim_event_log_failed` gauge) and writes nothing more. The file then ends
 * before the error; a run whose log failed can't be compared.
 */
import { closeSync, openSync, writeSync } from 'node:fs';

export interface EventLogOptions {
  readonly flushBytes?: number;
  readonly flushMs?: number;
  /** Called once, with the first write or close error. */
  readonly onError?: (error: unknown) => void;
  /** `fs.writeSync`; replaced in tests to fail a write. */
  readonly write?: (fd: number, bytes: Buffer, offset: number) => number;
}

export class EventLogWriter {
  readonly #fd: number;
  readonly #flushBytes: number;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #onError: (error: unknown) => void;
  readonly #write: (fd: number, bytes: Buffer, offset: number) => number;
  #chunk = '';
  #closed = false;
  #failed = false;

  /** Creates (or truncates) the file at `path`; throws when it can't be opened. */
  constructor(
    path: string,
    {
      flushBytes = 1 << 16,
      flushMs = 250,
      onError = () => undefined,
      write = (fd, bytes, offset) => writeSync(fd, bytes, offset),
    }: EventLogOptions = {},
  ) {
    this.#fd = openSync(path, 'w');
    this.#flushBytes = flushBytes;
    this.#onError = onError;
    this.#write = write;
    this.#timer = setInterval(() => {
      this.flush();
    }, flushMs);
    this.#timer.unref();
  }

  /** True once a write failed: nothing is written any more. */
  get failed(): boolean {
    return this.#failed;
  }

  append(line: string): void {
    if (this.#closed || this.#failed) return;
    this.#chunk += `${line}\n`;
    if (this.#chunk.length >= this.#flushBytes) this.flush();
  }

  flush(): void {
    if (this.#closed || this.#failed || this.#chunk === '') return;
    const bytes = Buffer.from(this.#chunk, 'utf8');
    this.#chunk = '';
    try {
      // writeSync may write part of a buffer; the rest follows.
      for (let offset = 0; offset < bytes.length;) {
        offset += this.#write(this.#fd, bytes, offset);
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Flushes and closes; never throws (also safe from a process `exit` handler). */
  close(): void {
    if (this.#closed) return;
    this.flush();
    clearInterval(this.#timer);
    this.#closed = true;
    try {
      closeSync(this.#fd);
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#chunk = '';
    clearInterval(this.#timer);
    this.#onError(error);
  }
}
