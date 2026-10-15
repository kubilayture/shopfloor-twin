import type { Clock, CurrentStateDto } from '@shopfloor/contracts/mes-api';

/** How a state looks: a colour that always comes with its text label (never colour alone). */
export interface StateStyle {
  readonly label: string;
  /** Tailwind classes for a badge or band; text and background meet WCAG AA contrast. */
  readonly className: string;
}

const STYLES: Readonly<Record<string, StateStyle>> = {
  Running: { label: 'Running', className: 'bg-emerald-700 text-white' },
  Idle: { label: 'Idle', className: 'bg-slate-300 text-slate-950' },
  Starved: { label: 'Starved', className: 'bg-amber-200 text-amber-950' },
  Blocked: { label: 'Blocked', className: 'bg-orange-300 text-orange-950' },
  Stopped: { label: 'Stopped', className: 'bg-rose-200 text-rose-950' },
  Down: { label: 'Down', className: 'bg-red-700 text-white' },
  Setup: { label: 'Setup', className: 'bg-sky-700 text-white' },
  PlannedStop: { label: 'Planned stop', className: 'bg-indigo-200 text-indigo-950' },
  Maintenance: { label: 'Maintenance', className: 'bg-violet-700 text-white' },
  Off: { label: 'Off', className: 'bg-zinc-700 text-white' },
};

export const NO_DATA: StateStyle = {
  label: 'No data',
  className: 'border border-dashed border-slate-500 bg-white text-slate-700',
};

export function stateStyle(state: string): StateStyle {
  return STYLES[state] ?? { label: state, className: 'bg-gray-300 text-gray-950' };
}

/**
 * Whether `incoming` is at least as new as `known`: a newer device epoch wins, then the later
 * fact (`seq`; an anchor has none), then the later start. Pushed deltas and REST answers race,
 * so the cache keeps whichever is newer.
 */
export function isNewer(incoming: CurrentStateDto, known: CurrentStateDto | undefined): boolean {
  if (known === undefined) return true;
  if (incoming.epoch !== known.epoch) return incoming.epoch > known.epoch;
  const incomingSeq = incoming.seq ?? -1;
  const knownSeq = known.seq ?? -1;
  if (incomingSeq !== knownSeq) return incomingSeq > knownSeq;
  return Date.parse(incoming.since) >= Date.parse(known.since);
}

export function newest(
  ...candidates: (CurrentStateDto | null | undefined)[]
): CurrentStateDto | undefined {
  let best: CurrentStateDto | undefined;
  for (const candidate of candidates) {
    if (candidate && isNewer(candidate, best)) best = candidate;
  }
  return best;
}

export function isNewerClock(incoming: Clock, known: Clock | null | undefined): boolean {
  if (!known) return true;
  if (incoming.epoch !== known.epoch) return incoming.epoch > known.epoch;
  return Date.parse(incoming.watermark) >= Date.parse(known.watermark);
}

/** Time in the state up to the plant clock when it runs in the same epoch, else as reported. */
export function timeInState(current: CurrentStateDto, clock: Clock | null | undefined): number {
  if (clock?.epoch === current.epoch) {
    return Math.max(0, Date.parse(clock.watermark) - Date.parse(current.since));
  }
  return current.ageMs ?? 0;
}

export type Staleness = 'disconnected' | 'older-run' | undefined;

export const STALE_TEXT = {
  disconnected: 'Stale: live connection lost',
  'older-run': 'Stale: from an earlier run',
} as const;

/**
 * Why a shown state may be out of date: the live connection is down (nothing new arrives), or
 * the state belongs to an older run than the plant clock (the machine hasn't reported since).
 */
/**
 * Whether the live connection was lost: reconnecting, or stopped. The first connect is not a loss;
 * the header shows "Connecting…" then and the states from REST are as fresh as they get.
 */
export function isConnectionLost(status: string): boolean {
  return status === 'reconnecting' || status === 'stopped';
}

export function staleness(
  current: CurrentStateDto,
  clock: Clock | null | undefined,
  connectionLost: boolean,
): Staleness {
  if (connectionLost) return 'disconnected';
  if (clock && current.epoch < clock.epoch) return 'older-run';
  return undefined;
}
