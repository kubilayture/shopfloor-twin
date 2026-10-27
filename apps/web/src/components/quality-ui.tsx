import type { HoldState, SpcSignalDto } from '@shopfloor/contracts/mes-api';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { HOLD_STATE_TEXT, SIGNAL_STATUS_TEXT, type QualityFailure } from '../domain/quality.ts';
import { formatPlantTime, wallTimeText } from '../domain/time.ts';
import { Badge, type BadgeVariant } from './ui/badge.tsx';
import { Callout } from './ui/callout.tsx';
import { Textarea } from './ui/controls.tsx';
import type { Tone } from './ui/tokens.ts';

// Shared pieces of the SPC and holds screens (#203): times, badges and messages. State is always a
// word, never colour alone.

export const timeOf = (value: string | null): ReactNode =>
  value === null ? '–' : <time dateTime={value}>{formatPlantTime(value)}</time>;

/** A wall-clock time (when the MES or a person did it), labelled so (#295): never like plant time. */
export const wallTimeOf = (value: string | null): ReactNode =>
  value === null ? '–' : <time dateTime={value}>{wallTimeText(value)}</time>;

/** The plant clock beside a wall time, when the MES recorded one: ` (plant Thu 15 Oct, 08:51:00)`. */
export const plantBeside = (plantAt: string | null): ReactNode =>
  plantAt === null ? null : <> (plant {timeOf(plantAt)})</>;

/** When something happened: in plant time when the MES knew the plant clock, else wall time. */
export const plantOrWall = (plantAt: string | null, wallAt: string): ReactNode =>
  plantAt === null ? wallTimeOf(wallAt) : timeOf(plantAt);

/** An SPC signal episode (design system 2.6): the tone, not the word, says it is a signal. */
const SIGNAL_LOOK: Readonly<
  Record<SpcSignalDto['status'], { readonly tone: Tone; readonly variant: BadgeVariant }>
> = {
  provisional: { tone: 'warn', variant: 'soft' },
  final: { tone: 'alarm', variant: 'soft' },
  withdrawn: { tone: 'neutral', variant: 'outline' },
};

export function SignalStatusBadge({ signal }: { readonly signal: SpcSignalDto }) {
  const look = SIGNAL_LOOK[signal.status];
  return (
    <Badge
      data-testid="signal-status"
      data-status={signal.status}
      tone={look.tone}
      variant={look.variant}
      className={signal.status === 'withdrawn' ? 'line-through' : undefined}
    >
      {SIGNAL_STATUS_TEXT[signal.status]}
    </Badge>
  );
}

/** A quality hold (design system 2.6): open is `alarm`, released `ok`, rejected neutral solid. */
export const HOLD_LOOK: Readonly<
  Record<HoldState, { readonly tone: Tone; readonly variant: BadgeVariant }>
> = {
  open: { tone: 'alarm', variant: 'soft' },
  released: { tone: 'ok', variant: 'soft' },
  rejected: { tone: 'neutral', variant: 'solid' },
};

export function HoldStateBadge({ state }: { readonly state: HoldState }) {
  const look = HOLD_LOOK[state];
  return (
    <Badge data-testid="hold-state" data-state={state} tone={look.tone} variant={look.variant}>
      {HOLD_STATE_TEXT[state]}
    </Badge>
  );
}

/**
 * A refused write: what happened, and the problem type as the MES named it; an `alarm` callout
 * (design system 4.13), announced.
 */
export function FailureMessage({
  failure,
  testId,
}: {
  readonly failure: QualityFailure;
  readonly testId: string;
}) {
  return (
    <Callout
      tone="alarm"
      role="alert"
      data-testid={testId}
      data-kind={failure.kind}
      data-type={failure.type ?? ''}
    >
      <p>{failure.text}</p>
      {failure.holds && failure.holds.length > 0 ? (
        <ul className="mt-1 list-disc pl-5" data-testid={`${testId}-holds`}>
          {failure.holds.map((id) => (
            <li key={id}>
              <Link
                to="/quality/holds/$id"
                params={{ id }}
                className="text-link underline underline-offset-2 hover:text-accent-hover"
              >
                Hold {id}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {failure.type ? (
        <p className="mt-1 font-mono text-xs break-all">Problem type: {failure.type}</p>
      ) : null}
    </Callout>
  );
}

/**
 * A comment box with its character count announced: a `Textarea` with its `CharacterCount`
 * (design system 4.7); " (required)" in the label when it is, nothing when it is optional.
 */
export function CommentInput({
  id,
  label,
  value,
  onChange,
  testId,
  max,
  required,
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly max: number;
  readonly required: boolean;
  readonly error?: string | undefined;
}) {
  return (
    <Textarea
      id={id}
      name={testId}
      label={label}
      required={required}
      error={error}
      data-testid={testId}
      value={value}
      rows={2}
      max={max}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
