/**
 * The reference consumer rule of ADR-0015: deduplication and gap detection for UNS messages
 * delivered at least once. The MES ingest (Phase 4) implements the same rule.
 */

export interface Identified {
  readonly scope: 'device' | 'topic';
  readonly epoch: number;
  readonly seq: number;
  readonly source: { readonly id: string };
  readonly kind?: 'event' | 'snapshot';
}

export type Verdict =
  { readonly status: 'new'; readonly epochChanged: boolean } | { readonly status: 'duplicate' };

export interface Gap {
  readonly stream: string;
  readonly epoch: number;
  readonly from: number;
  readonly to: number;
}

interface Stream {
  epoch: number;
  /** Every seq up to and including this one has been seen. */
  contiguous: number;
  /** Seen above `contiguous` (out of order, or after a gap). */
  readonly ahead: Set<number>;
}

/**
 * Stream key: device facts share one stream per equipment; gateway counters are per topic.
 */
export const streamKey = (topic: string, message: Identified): string =>
  message.scope === 'device' ? `device:${message.source.id}` : `topic:${topic}`;

export class Deduplicator {
  readonly #streams = new Map<string, Stream>();

  /**
   * Classifies one delivery. The first message of a stream, or of a new epoch, starts it: earlier
   * numbers of that epoch are not reported as gaps, since the consumer joined late.
   */
  accept(topic: string, message: Identified): Verdict {
    const key = streamKey(topic, message);
    const stream = this.#streams.get(key);
    if (!stream || message.epoch > stream.epoch) {
      this.#streams.set(key, {
        epoch: message.epoch,
        contiguous: message.seq,
        ahead: new Set(),
      });
      return { status: 'new', epochChanged: stream !== undefined };
    }
    if (
      message.epoch < stream.epoch ||
      message.seq <= stream.contiguous ||
      stream.ahead.has(message.seq)
    ) {
      return { status: 'duplicate' };
    }
    if (message.seq === stream.contiguous + 1) {
      stream.contiguous = message.seq;
      while (stream.ahead.delete(stream.contiguous + 1)) {
        stream.contiguous++;
      }
    } else {
      stream.ahead.add(message.seq);
    }
    return { status: 'new', epochChanged: false };
  }

  /** Numbers missing below the highest seen number of each stream's current epoch. */
  gaps(): Gap[] {
    const result: Gap[] = [];
    for (const [key, stream] of this.#streams) {
      const seen = [...stream.ahead].sort((a, b) => a - b);
      let expected = stream.contiguous + 1;
      for (const seq of seen) {
        if (seq > expected) {
          result.push({ stream: key, epoch: stream.epoch, from: expected, to: seq - 1 });
        }
        expected = seq + 1;
      }
    }
    return result;
  }
}
