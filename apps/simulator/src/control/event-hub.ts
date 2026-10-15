import type { PlantEvent } from '../plant/line.ts';
import { EVENT_SCHEMA, isoTime, stableStringify } from '../headless/serialize.ts';

export type EventListener = (line: string, event: PlantEvent) => void;

/**
 * Numbers live plant events run-wide and fans them out as `sim-event/1` lines,
 * the same format as the headless event log.
 */
export class EventHub {
  readonly #listeners = new Set<EventListener>();
  readonly #counts = new Map<string, number>();
  #seq = 0;

  get seq(): number {
    return this.#seq;
  }

  /** Events recorded so far, by type. */
  get counts(): ReadonlyMap<string, number> {
    return this.#counts;
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  record(event: PlantEvent): void {
    this.#seq++;
    this.#counts.set(event.type, (this.#counts.get(event.type) ?? 0) + 1);
    if (this.#listeners.size === 0) {
      return;
    }
    const line = stableStringify({
      ...event,
      schema: EVENT_SCHEMA,
      seq: this.#seq,
      at: isoTime(event.at),
    });
    for (const listener of this.#listeners) {
      listener(line, event);
    }
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
