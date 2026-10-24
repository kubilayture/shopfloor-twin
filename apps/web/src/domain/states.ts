import type { Clock, CurrentStateDto } from '@shopfloor/contracts/mes-api';
import type { Glyph } from './tones.ts';

/**
 * How a state looks (design system 2.4, UX-1c #315): a word, always, on the state's token colours;
 * grey for the states a plant spends its normal time in, colour for the ones that cost output, and
 * a glyph for most, so a state survives greyscale and colour blindness (never colour alone).
 */
export interface StateStyle {
  readonly label: string;
  /** Fill, text and border token utilities for the badge (WCAG AA). */
  readonly className: string;
  /**
   * The machine timeline's band: the state's fill with 4 px top and bottom edges in its border
   * colour (dashed for Setup), so states with near-equal fills (Running, Off, Planned stop) stay
   * apart on the bar, where a band has no word and no glyph.
   */
  readonly band: string;
  /** The glyph before the word (`aria-hidden`); Idle has none. */
  readonly icon?: Glyph;
}

// Each class written out in full: Tailwind finds class names in the source.
const STYLES: Readonly<Record<string, StateStyle>> = {
  Running: {
    label: 'Running',
    className: 'bg-state-running-fill text-state-running-ink border-state-running-border',
    band: 'bg-state-running-fill border-y-4 border-state-running-border',
    icon: 'play',
  },
  Idle: {
    label: 'Idle',
    className: 'bg-state-idle-fill text-state-idle-ink border-state-idle-border',
    band: 'bg-state-idle-fill border-y-4 border-state-idle-border',
  },
  Setup: {
    label: 'Setup',
    className: 'bg-state-setup-fill text-state-setup-ink border-state-setup-border border-dashed',
    band: 'bg-state-setup-fill border-y-4 border-state-setup-border border-dashed',
    icon: 'rotate',
  },
  PlannedStop: {
    label: 'Planned stop',
    className:
      'bg-state-planned-stop-fill text-state-planned-stop-ink border-state-planned-stop-border',
    band: 'bg-state-planned-stop-fill border-y-4 border-state-planned-stop-border',
    icon: 'pause',
  },
  Maintenance: {
    label: 'Maintenance',
    className:
      'bg-state-maintenance-fill text-state-maintenance-ink border-state-maintenance-border',
    band: 'bg-state-maintenance-fill border-y-4 border-state-maintenance-border',
    icon: 'wrench',
  },
  Off: {
    label: 'Off',
    className: 'bg-state-off-fill text-state-off-ink border-state-off-border',
    band: 'bg-state-off-fill border-y-4 border-state-off-border',
    icon: 'circle',
  },
  Starved: {
    label: 'Starved',
    className: 'bg-state-starved-fill text-state-starved-ink border-state-starved-border',
    band: 'bg-state-starved-fill border-y-4 border-state-starved-border',
    icon: 'triangle-left',
  },
  Blocked: {
    label: 'Blocked',
    className: 'bg-state-blocked-fill text-state-blocked-ink border-state-blocked-border',
    band: 'bg-state-blocked-fill border-y-4 border-state-blocked-border',
    icon: 'play-bar',
  },
  Stopped: {
    label: 'Stopped',
    className: 'bg-state-stopped-fill text-state-stopped-ink border-state-stopped-border',
    band: 'bg-state-stopped-fill border-y-4 border-state-stopped-border',
    icon: 'stop',
  },
  Down: {
    label: 'Down',
    className: 'bg-state-down-fill text-state-down-ink border-state-down-border',
    band: 'bg-state-down-fill border-y-4 border-state-down-border',
    icon: 'close',
  },
};

export const NO_DATA: StateStyle = {
  label: 'No data',
  className:
    'bg-state-no-data-fill text-state-no-data-ink border-state-no-data-border border-dashed',
  band: 'bg-state-no-data-fill border-y-4 border-state-no-data-border border-dashed',
  icon: 'question',
};

/** A state the web does not know yet: its raw name on the neutral tone, never a guessed colour. */
const UNKNOWN = 'bg-neutral-soft text-neutral-ink border-neutral-border';
const UNKNOWN_BAND = 'bg-neutral-soft border-y-4 border-neutral-border';

export function stateStyle(state: string): StateStyle {
  return STYLES[state] ?? { label: state, className: UNKNOWN, band: UNKNOWN_BAND };
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
