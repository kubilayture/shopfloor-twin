/**
 * The reference consumer rule of ADR-0015: deduplication and gap detection for UNS messages
 * delivered at least once. The MES ingest (Phase 4) implements the same rule.
 */

export interface Identified {
  readonly scope: 'device' | 'topic';
  readonly epoch: number;
  readonly seq: number;
  readonly source: { readonly id: string };
}

export interface Gap {
  readonly stream: string;
  readonly epoch: number;
  readonly from: number;
  readonly to: number;
}

export type Verdict =
  | {
      readonly status: 'new';
      /** True when this message started a newer epoch of a known stream. */
      readonly epochChanged: boolean;
      /** Gaps still open in the epoch that just ended; they can no longer be filled. */
      readonly closedGaps: readonly Gap[];
    }
  | { readonly status: 'duplicate' };

export interface AcceptOptions {
  /**
   * The broker delivered a retained message on subscribe. It restores current state but is not
   * part of the live stream, so it neither starts the stream nor creates gaps.
   */
  readonly retained?: boolean;
}

interface Stream {
  epoch: number;
  /** Sorted, non-overlapping, non-adjacent ranges [from, to] of numbers seen or written off. */
  readonly seen: [number, number][];
}

/** Stream key: device facts share one stream per equipment; gateway counters are per topic. */
export const streamKey = (topic: string, message: Identified): string =>
  message.scope === 'device' ? `device:${message.source.id}` : `topic:${topic}`;

function contains(ranges: readonly (readonly [number, number])[], seq: number): boolean {
  return ranges.some(([from, to]) => seq >= from && seq <= to);
}

function insert(ranges: [number, number][], from: number, to: number): void {
  ranges.push([from, to]);
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < ranges.length - 1;) {
    const current = ranges[i];
    const next = ranges[i + 1];
    if (current && next && next[0] <= current[1] + 1) {
      current[1] = Math.max(current[1], next[1]);
      ranges.splice(i + 1, 1);
    } else {
      i++;
    }
  }
}

function holes(key: string, stream: Stream): Gap[] {
  const result: Gap[] = [];
  for (let i = 0; i < stream.seen.length - 1; i++) {
    const before = stream.seen[i];
    const after = stream.seen[i + 1];
    if (before && after) {
      result.push({ stream: key, epoch: stream.epoch, from: before[1] + 1, to: after[0] - 1 });
    }
  }
  return result;
}

export class Deduplicator {
  readonly #streams = new Map<string, Stream>();

  /**
   * Classifies one delivery. Numbers below the first one seen are accepted when they arrive (a
   * late joiner, or a reordered start) but never reported as gaps: only holes between seen numbers
   * are. Memory grows with the number of open gaps, not with the number of messages.
   */
  accept(topic: string, message: Identified, options: AcceptOptions = {}): Verdict {
    const key = streamKey(topic, message);
    const stream = this.#streams.get(key);
    const seenBefore =
      stream !== undefined &&
      (message.epoch < stream.epoch ||
        (message.epoch === stream.epoch && contains(stream.seen, message.seq)));
    if (seenBefore) {
      return { status: 'duplicate' };
    }
    if (options.retained) {
      return { status: 'new', epochChanged: false, closedGaps: [] };
    }
    if (!stream || message.epoch > stream.epoch) {
      const closedGaps = stream ? holes(key, stream) : [];
      this.#streams.set(key, { epoch: message.epoch, seen: [[message.seq, message.seq]] });
      return { status: 'new', epochChanged: stream !== undefined, closedGaps };
    }
    insert(stream.seen, message.seq, message.seq);
    return { status: 'new', epochChanged: false, closedGaps: [] };
  }

  /** Holes between the numbers seen in each stream's current epoch. */
  gaps(): Gap[] {
    return [...this.#streams].flatMap(([key, stream]) => holes(key, stream));
  }

  /** Writes a gap off once it is recorded as an incident: its numbers then count as seen. */
  acknowledge(gap: Gap): void {
    const stream = this.#streams.get(gap.stream);
    if (stream?.epoch === gap.epoch) {
      insert(stream.seen, gap.from, gap.to);
    }
  }
}
