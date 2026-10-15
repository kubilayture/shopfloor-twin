/**
 * Gateway-side identity (ADR-0015): messages the gateway originates (telemetry, snapshots, `_sys`)
 * carry `scope: topic`, the gateway's epoch and a counter per topic.
 */
export class TopicSequences {
  readonly epoch: number;
  readonly #next = new Map<string, number>();

  constructor(epoch: number) {
    this.epoch = epoch;
  }

  next(topic: string): number {
    const seq = (this.#next.get(topic) ?? 0) + 1;
    this.#next.set(topic, seq);
    return seq;
  }
}

export const unixSeconds = (ms: number): number => Math.floor(ms / 1000);
