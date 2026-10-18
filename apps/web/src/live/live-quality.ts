import type {
  CharacteristicDto,
  HoldDto,
  ServerMessage,
  SpcSignalDto,
} from '@shopfloor/contracts/mes-api';
import type { QueryClient } from '@tanstack/react-query';

// The `quality` topic (#200, holds #201) in the query cache (#203). The topic has no snapshot:
// a screen reads first (characteristics, chart, holds), then applies pushes by id; the pushed set
// is emptied when a screen takes the topic and when it lets go, and after a lost connection (the
// Phase 6 lesson, as `alarms`, `shifts` and `orders`).

/** A pushed signal episode; `removed` when the MES deleted it (provisional, re-derived away). */
export interface LiveSignal {
  readonly signal: SpcSignalDto;
  readonly removed: boolean;
}

/** Pushed episodes, holds and characteristic summaries by id, and a counter for every message. */
export interface LiveQuality {
  readonly signals: Readonly<Record<string, LiveSignal>>;
  readonly holds: Readonly<Record<string, HoldDto>>;
  readonly characteristics: Readonly<Record<string, CharacteristicDto>>;
  readonly seq: number;
}

/** Under `['live', …]`, so the live query defaults apply (no structural sharing, kept). */
export const liveQualityKey = ['live', 'quality'] as const;

const NO_QUALITY: LiveQuality = { signals: {}, holds: {}, characteristics: {}, seq: 0 };

/**
 * Whether `incoming` replaces `known` for the same episode: its `rowVersion` rises with an
 * acknowledgement and a status change, not with growth (ADR-0032 amendment), so at the same
 * version the later message (a grown extent) wins; a lower version never does. This rests on the
 * MES pushing every extent change (`updated`, in commit order on the one socket; its quality test
 * pins that a closing point emits one) and on a write's answer never being older than the pushes
 * before it at the same version (an acknowledgement raises the version).
 */
export const newerSignal = (incoming: SpcSignalDto, known: SpcSignalDto): boolean =>
  incoming.rowVersion >= known.rowVersion;

/** A hold's `version` rises with every transition; a scope change keeps it (later wins). */
export const newerHold = (incoming: HoldDto, known: HoldDto): boolean =>
  incoming.version >= known.version;

/** A characteristic's `version` rises with limits and notices; readings keep it (later wins). */
export const newerCharacteristic = (incoming: CharacteristicDto, known: CharacteristicDto) =>
  incoming.version >= known.version;

function mergeSignal(live: LiveQuality | undefined, signal: SpcSignalDto, removed: boolean) {
  const base = live ?? NO_QUALITY;
  const key = String(signal.id);
  const known = base.signals[key];
  if (known && !removed && !newerSignal(signal, known.signal)) {
    return { ...base, seq: base.seq + 1 };
  }
  return { ...base, signals: { ...base.signals, [key]: { signal, removed } }, seq: base.seq + 1 };
}

function mergeHold(live: LiveQuality | undefined, hold: HoldDto): LiveQuality {
  const base = live ?? NO_QUALITY;
  const known = base.holds[hold.id];
  if (known && !newerHold(hold, known)) return { ...base, seq: base.seq + 1 };
  return { ...base, holds: { ...base.holds, [hold.id]: hold }, seq: base.seq + 1 };
}

function mergeCharacteristic(live: LiveQuality | undefined, item: CharacteristicDto) {
  const base = live ?? NO_QUALITY;
  const known = base.characteristics[item.id];
  if (known && !newerCharacteristic(item, known)) return { ...base, seq: base.seq + 1 };
  return {
    ...base,
    characteristics: { ...base.characteristics, [item.id]: item },
    seq: base.seq + 1,
  };
}

/** An episode the app learned from a write's answer (an acknowledgement), merged like a push. */
export function upsertSignal(queryClient: QueryClient, signal: SpcSignalDto): void {
  queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) => mergeSignal(live, signal, false));
}

/** A hold the app learned from a write's answer, merged like a pushed one. */
export function upsertHold(queryClient: QueryClient, hold: HoldDto): void {
  queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) => mergeHold(live, hold));
}

/** A characteristic from a limit write's answer, merged like a pushed one. */
export function upsertCharacteristic(queryClient: QueryClient, item: CharacteristicDto): void {
  queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) => mergeCharacteristic(live, item));
}

/** Forgets every pushed episode, hold and characteristic (see the module comment). */
export function resetLiveQuality(queryClient: QueryClient): void {
  if (queryClient.getQueryData(liveQualityKey) === undefined) return;
  queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) => ({
    ...NO_QUALITY,
    seq: (live?.seq ?? 0) + 1,
  }));
}

/** Every REST read of the quality screens (prefix of `qualityKeys` in api/quality.ts). */
export const QUALITY_READS = [['quality']] as const;

type QualityMessage = Extract<
  ServerMessage,
  { type: 'spc-signal' | 'spc-characteristic' | 'quality-hold' }
>;

/**
 * Applies one `quality` push: upserts by id, and the reads the push does not carry are read again
 * (only active queries refetch): a characteristic's chart (its points; the ETag answers 304 when
 * the derivation did not move), a hold's detail (transitions, scope, incidents), a signal's
 * suggested hold scope (its window grows with the episode).
 */
export function applyQualityMessage(queryClient: QueryClient, message: QualityMessage): void {
  switch (message.type) {
    case 'spc-signal':
      queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) =>
        mergeSignal(live, message.signal, message.event === 'removed'),
      );
      void queryClient.invalidateQueries({
        queryKey: ['quality', 'suggestion', message.signal.id],
      });
      return;
    case 'spc-characteristic':
      queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) =>
        mergeCharacteristic(live, message.characteristic),
      );
      void queryClient.invalidateQueries({
        queryKey: ['quality', 'chart', message.characteristic.id],
      });
      return;
    case 'quality-hold':
      queryClient.setQueryData<LiveQuality>(liveQualityKey, (live) =>
        mergeHold(live, message.hold),
      );
      void queryClient.invalidateQueries({ queryKey: ['quality', 'hold', message.hold.id] });
      return;
  }
}
