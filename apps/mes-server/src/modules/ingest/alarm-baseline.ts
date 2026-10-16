import type { AlarmAnchor, StoredAlarmSnapshot } from './store.ts';

/** What the device's anchors and its latest snapshot say about one alarm code (#141). */
export interface AlarmPointState {
  readonly code: string;
  readonly active: boolean;
  /** Which one decided: the anchor (its own fact) or the snapshot (the bits at `asOfSeq`). */
  readonly source: 'anchor' | 'snapshot';
  /** The anchor's `seq`, or the snapshot's `asOfSeq`. */
  readonly seq: number;
  readonly sourceTime: Date;
  /** The wire severity, when an anchor of the code is known. */
  readonly severity: number | null;
}

/**
 * The alarm state of one (equipment, device epoch) from its anchors and its latest snapshot, by
 * sequence (ADR-0017 amendment, #141): a snapshot with a higher `asOfSeq` than an anchor's `seq`
 * beats the anchor (it saw a later fact, such as a clear the MES never got); an anchor with a
 * higher `seq` beats the snapshot (it is a later fact). At equal numbers both describe the same
 * moment and the anchor, which carries the fact's own time and severity, is kept. A code that only
 * the snapshot names is active from the snapshot. Pure: the caller passes rows of one epoch that
 * are not stale. Sorted by code.
 */
export function resolveAlarmBaseline(
  anchors: readonly Pick<AlarmAnchor, 'code' | 'seq' | 'transition' | 'severity' | 'sourceTime'>[],
  snapshot: Pick<StoredAlarmSnapshot, 'asOfSeq' | 'active' | 'sourceTime'> | undefined,
): AlarmPointState[] {
  const codes = new Set([...anchors.map((a) => a.code), ...(snapshot?.active ?? [])]);
  return [...codes].sort().map((code) => {
    const anchor = anchors.find((a) => a.code === code);
    if (snapshot && (!anchor || snapshot.asOfSeq > anchor.seq)) {
      return {
        code,
        active: snapshot.active.includes(code),
        source: 'snapshot' as const,
        seq: snapshot.asOfSeq,
        sourceTime: snapshot.sourceTime,
        severity: anchor?.severity ?? null,
      };
    }
    if (!anchor) throw new Error('unreachable: every code comes from an anchor or the snapshot');
    return {
      code,
      active: anchor.transition === 'active',
      source: 'anchor' as const,
      seq: anchor.seq,
      sourceTime: anchor.sourceTime,
      severity: anchor.severity,
    };
  });
}
