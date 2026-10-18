import {
  PROBLEM_TYPES,
  QUALITY_LIMITS,
  holdSubjectSchema,
  type CharacteristicDto,
  type HoldDto,
  type HoldReasonList,
  type HoldState,
  type HoldSubjectDto,
  type HoldSubjectKind,
  type SpcChartDto,
  type SpcChartName,
  type SpcPointDto,
  type SpcSignalDto,
} from '@shopfloor/contracts/mes-api';
import { ApiError } from '../api/client.ts';
import {
  newerCharacteristic,
  newerHold,
  newerSignal,
  type LiveQuality,
} from '../live/live-quality.ts';
import { PLANT_TIME_ZONE } from './time.ts';
import { writeFailure, type WriteFailure } from './writes.ts';

// The SPC and holds screens' rules (#203), apart from React so they are tested as data.

export const CHART_TEXT: Readonly<Record<SpcChartName, { label: string; short: string }>> = {
  I: { label: 'Individuals (I)', short: 'I' },
  MR: { label: 'Moving ranges (MR)', short: 'MR' },
  Xbar: { label: 'Subgroup means (X̄)', short: 'X̄' },
  R: { label: 'Subgroup ranges (R)', short: 'R' },
};

/** The Nelson rules in a few words (ADR-0032's definitions; `ruleText` comes with each signal). */
export const RULE_SHORT: Readonly<Record<number, string>> = {
  1: 'beyond a control limit',
  2: 'nine on one side',
  3: 'six rising or falling',
  4: 'fourteen alternating',
  5: 'two of three beyond 2σ',
  6: 'four of five beyond 1σ',
  7: 'fifteen within 1σ',
  8: 'eight beyond 1σ on both sides',
};

export const rulesText = (rules: readonly number[]): string =>
  rules.length === 0 ? 'none' : rules.map((r) => String(r)).join(', ');

export const SIGNAL_STATUS_TEXT: Readonly<Record<SpcSignalDto['status'], string>> = {
  provisional: 'Provisional',
  final: 'Final',
  withdrawn: 'Withdrawn',
};

export const HOLD_STATE_TEXT: Readonly<Record<HoldState, string>> = {
  open: 'Open',
  released: 'Released',
  rejected: 'Rejected',
};

export const SUBJECT_TEXT: Readonly<Record<HoldSubjectKind, string>> = {
  lot: 'Lot',
  serial: 'Serial',
  carton: 'Carton',
  order: 'Order',
};

export const subjectText = (subject: HoldSubjectDto): string =>
  `${SUBJECT_TEXT[subject.kind]} ${subject.id}`;

/** Whether an episode is still open (no point has closed it yet). */
export const isOpenEpisode = (signal: SpcSignalDto): boolean =>
  signal.status !== 'withdrawn' && signal.closedBy === null;

/** Whether a final episode's extent can still grow (shaded apart on the chart). */
export const isGrowing = (signal: SpcSignalDto): boolean =>
  signal.status === 'final' && !signal.extentFinal;

/** Whether an acknowledgement is still possible (once per episode, never once withdrawn). */
export const canAcknowledgeSignal = (signal: SpcSignalDto): boolean =>
  signal.status !== 'withdrawn' && signal.acknowledged === null;

/** Whether an episode may suggest a hold scope (the API answers 404 for a withdrawn one). */
export const canSuggestHold = (signal: SpcSignalDto): boolean => signal.status !== 'withdrawn';

/** The episode's finality in words: identity, then extent (ADR-0032 amendment). */
export function finalityText(signal: SpcSignalDto): string {
  if (signal.status === 'withdrawn') return 'Withdrawn';
  if (signal.status === 'provisional') return 'Provisional: a late reading can still move it';
  return signal.extentFinal
    ? 'Final, extent final'
    : 'Final; its extent can still grow (the tester is not final through its last point)';
}

/** The REST episodes with the pushed ones of this characteristic merged by id, newest first. */
export function mergeSignals(
  characteristic: string,
  rest: readonly SpcSignalDto[],
  live: LiveQuality | undefined,
): SpcSignalDto[] {
  const byId = new Map(rest.map((s) => [s.id, s]));
  for (const pushed of Object.values(live?.signals ?? {})) {
    if (pushed.signal.characteristic !== characteristic) continue;
    if (pushed.removed) {
      byId.delete(pushed.signal.id);
      continue;
    }
    const known = byId.get(pushed.signal.id);
    if (!known || newerSignal(pushed.signal, known)) byId.set(pushed.signal.id, pushed.signal);
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.first.at) - Date.parse(a.first.at) || b.id - a.id,
  );
}

/** The newer of the read characteristic and the pushed one. */
export function newestCharacteristic(
  rest: CharacteristicDto,
  live: LiveQuality | undefined,
): CharacteristicDto {
  const pushed = live?.characteristics[rest.id];
  return pushed && newerCharacteristic(pushed, rest) ? pushed : rest;
}

/** The newer of a read hold and its pushed copy. */
export function newestHold(rest: HoldDto, live: LiveQuality | undefined): HoldDto {
  const pushed = live?.holds[rest.id];
  return pushed && newerHold(pushed, rest) ? pushed : rest;
}

/** Whether a hold matches a list filter (states, one subject), for pushed holds. */
export function holdMatches(
  hold: HoldDto,
  filter: { readonly states: readonly HoldState[]; readonly subject?: HoldSubjectDto | undefined },
): boolean {
  if (filter.states.length > 0 && !filter.states.includes(hold.state)) return false;
  if (filter.subject) {
    return hold.subject.kind === filter.subject.kind && hold.subject.id === filter.subject.id;
  }
  return true;
}

/** The read holds with the pushed ones merged (newer wins; new ones that match), newest first. */
export function mergeHolds(
  rest: readonly HoldDto[],
  live: LiveQuality | undefined,
  filter: { readonly states: readonly HoldState[]; readonly subject?: HoldSubjectDto | undefined },
): HoldDto[] {
  const byId = new Map(rest.map((h) => [h.id, h]));
  for (const pushed of Object.values(live?.holds ?? {})) {
    const known = byId.get(pushed.id);
    if (known ? newerHold(pushed, known) : holdMatches(pushed, filter)) byId.set(pushed.id, pushed);
  }
  return [...byId.values()]
    .filter((h) => holdMatches(h, filter))
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt) || (a.id < b.id ? -1 : 1));
}

/** The reasons of `quality.yaml` listed for a transition. */
export function reasonsFor(
  reasons: HoldReasonList['reasons'],
  use: 'open' | 'release' | 'reject',
): HoldReasonList['reasons'] {
  return reasons.filter((r) => r.for.includes(use));
}

/** A hold subject from a URL's search (`kind`, `id`), when both are valid; undefined otherwise. */
export function subjectFromSearch(kind: unknown, id: unknown): HoldSubjectDto | undefined {
  const parsed = holdSubjectSchema.safeParse({ kind, id });
  return parsed.success ? parsed.data : undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The hold ids a problem's detail names (a close refused with `quality-hold` lists them). */
export const holdIdsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(UUID)].map((m) => m[0].toLowerCase())),
];

/** A failed quality write: `writeFailure`'s kinds and the quality module's 409s. */
export interface QualityFailure {
  readonly kind: WriteFailure['kind'] | 'stale' | 'decided' | 'withdrawn' | 'state' | 'exists';
  readonly text: string;
  /** The problem type the MES answered (`urn:shopfloor:…`). */
  readonly type: string | undefined;
  /** The holds the refusal names (`hold-exists`: the open hold already on the subject). */
  readonly holds?: readonly string[];
}

export function qualityFailure(
  error: unknown,
  texts: { readonly not: string; readonly what: string; readonly thing: string },
): QualityFailure {
  const type =
    error instanceof ApiError && error.problem?.type !== 'about:blank'
      ? error.problem?.type
      : undefined;
  if (error instanceof ApiError && error.status === 409) {
    const detail = error.problem?.detail ?? error.message;
    switch (type ?? '') {
      case PROBLEM_TYPES.limitsStale:
      case PROBLEM_TYPES.signalStale:
      case PROBLEM_TYPES.holdStale:
        return {
          kind: 'stale',
          type,
          text: `${texts.not}: the ${texts.thing} changed since you started (409). Nothing was sent with the newer version; it is read again so you can check it and start again.`,
        };
      case PROBLEM_TYPES.signalAcknowledged:
        return {
          kind: 'decided',
          type,
          text: `${texts.not}: someone acknowledged this episode already (409, ${detail}).`,
        };
      case PROBLEM_TYPES.holdDecided:
        return {
          kind: 'decided',
          type,
          text: `${texts.not}: the hold is released or rejected already (409, ${detail}).`,
        };
      case PROBLEM_TYPES.signalWithdrawn:
        return {
          kind: 'withdrawn',
          type,
          text: `${texts.not}: the episode was withdrawn (a late reading re-derived it away; 409).`,
        };
      case PROBLEM_TYPES.holdExists: {
        const holds = error.problem?.holds ?? holdIdsIn(detail);
        return {
          kind: 'exists',
          type,
          holds,
          text: `${texts.not}: an open hold with this subject and reason exists already (409); see it below.`,
        };
      }
      case PROBLEM_TYPES.limitsV1Missing:
        return {
          kind: 'state',
          type,
          text: `${texts.not}: limit version 1 does not exist yet; the MES estimates it once the baseline's readings are final (409).`,
        };
      case PROBLEM_TYPES.limitsEnded:
        return {
          kind: 'state',
          type,
          text: `${texts.not}: this limit version is ended already (409).`,
        };
      default:
        break;
    }
  }
  const failure = writeFailure(error, {
    not: texts.not,
    conflict: 'the MES refused it as a conflict.',
    what: texts.what,
  });
  return { ...failure, type };
}

/** Characters of a comment, as the request schemas allow. */
export const COMMENT_MAX = QUALITY_LIMITS.comment;

/** The comment's problem, if any: required ones must not be blank. */
export function commentProblem(comment: string, required: boolean): string | undefined {
  const trimmed = comment.trim();
  if (required && trimmed === '') return 'A comment is required.';
  if (trimmed.length > COMMENT_MAX) return `At most ${String(COMMENT_MAX)} characters.`;
  return undefined;
}

// ---- Plant time in `datetime-local` inputs ----

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: PLANT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The plant zone's offset from UTC at an instant, in ms. */
function plantOffset(instant: number): number {
  const p = Object.fromEntries(parts.formatToParts(instant).map((x) => [x.type, x.value]));
  const local = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return local - (instant - (instant % 1000));
}

/** An ISO time as a `datetime-local` value in plant time (to the second). */
export function toPlantInput(iso: string): string {
  const instant = Date.parse(iso);
  const local = new Date(instant + plantOffset(instant));
  return local.toISOString().slice(0, 19);
}

/** A `datetime-local` value read as plant time, as ISO UTC; undefined when it is no time. */
export function fromPlantInput(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const asUtc = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (!Number.isFinite(asUtc)) return undefined;
  const instant = asUtc - plantOffset(asUtc);
  // Across an offset change the first guess can be an hour off: correct once.
  const corrected = asUtc - plantOffset(instant);
  return new Date(corrected).toISOString();
}

// ---- Limit re-estimation ----

/**
 * A window to estimate a new limit version from, offered to start with: the last
 * `baseline.needed` final first-pass readings shown (the size of version 1's baseline), or every
 * final one when fewer are shown; undefined without a final point.
 */
export function suggestedWindow(
  chart: Pick<SpcChartDto, 'points' | 'characteristic'>,
): { from: string; to: string } | undefined {
  const final = chart.points.I.filter((p) => p.final);
  const last = final.at(-1);
  if (!last) return undefined;
  const needed = Math.max(1, chart.characteristic.baseline.needed);
  const first = final[Math.max(0, final.length - needed)] ?? last;
  return { from: first.at, to: last.at };
}

/**
 * Final first-pass points of the I chart shown inside [from, to] (a window is estimated from final
 * readings only), and whether the window starts before the first point shown (`pointsFrom`: the
 * MES counts readings this page doesn't show).
 */
export function pointsInWindow(
  points: readonly SpcPointDto[],
  from: string,
  to: string,
  pointsFrom: string | null = null,
): { readonly final: number; readonly beyondShown: boolean } {
  const a = Date.parse(from);
  const b = Date.parse(to);
  return {
    final: points.filter((p) => {
      const t = Date.parse(p.at);
      return p.final && t >= a && t <= b;
    }).length,
    beyondShown: pointsFrom !== null && a < Date.parse(pointsFrom),
  };
}

/** The limits draft's problems before sending. */
export function limitsDraftProblems(draft: {
  readonly from: string;
  readonly to: string;
  readonly comment: string;
}): string[] {
  const found: string[] = [];
  const from = fromPlantInput(draft.from);
  const to = fromPlantInput(draft.to);
  if (from === undefined) found.push('Give the window’s first time.');
  if (to === undefined) found.push('Give the window’s last time.');
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    found.push('The window’s first time must not be after its last.');
  }
  const comment = commentProblem(draft.comment, true);
  if (comment) found.push(comment);
  return found;
}

/** Whether a version-checked draft is stale: the thing moved past the version it started on. */
export const isStale = (draftVersion: number, currentVersion: number): boolean =>
  currentVersion !== draftVersion;
