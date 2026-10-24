import type { HoldState, SpcSignalDto } from '@shopfloor/contracts/mes-api';
import { Link } from '@tanstack/react-router';
import { Children, type ReactNode } from 'react';
import { HOLD_STATE_TEXT, SIGNAL_STATUS_TEXT, type QualityFailure } from '../domain/quality.ts';
import { formatPlantTime, wallTimeText } from '../domain/time.ts';
import { Badge, type BadgeVariant } from './ui/badge.tsx';
import { buttonClass as uiButtonClass } from './ui/button.tsx';
import { Textarea } from './ui/controls.tsx';
import { controlClass } from './ui/field.tsx';
import {
  HEADER_CELL,
  SCROLL_STICKY_HEADER_CELL,
  STICKY_HEADER_CELL,
  TableFrame,
} from './ui/data-table.tsx';
import type { Tone } from './ui/tokens.ts';

// Shared pieces of the SPC and holds screens (#203): sections, tables, badges and messages. State
// is always a word, never colour alone.

// The control and button looks of the primitives (UX-1d2, #319), kept as class strings until the
// SPC and holds screens move onto `TextInput`, `Select` and `Button` themselves.
export const inputClass = controlClass();
export const buttonClass = uiButtonClass({ variant: 'secondary' });
export const primaryClass = uiButtonClass({ variant: 'primary' });
export const cell = 'px-2 py-1.5 align-top';
/** Row dividers and hover on the legacy table's own rows (design system 4.5: no zebra). */
/** The header cells' padding, as `cell`'s (`HEADER_CELL` aligns them to the bottom). */
const LEGACY_HEADER_PAD = 'px-2 py-1.5';
const LEGACY_BODY = 'divide-y divide-line-subtle *:hover:bg-surface-sunken';

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

export function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} data-testid={id} className="mt-6">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * The quality screens' table with rows of their own (#203), on `DataTable`'s frame and header
 * (UX-1d1, #318): the same look, the sticky header in both of its modes (on when more than 15
 * rows), `bounded` for a long list inside a detail. Real `table` → `tbody` → `tr` → `td` markup
 * for the positional reads. Kept until the last screen moves to `DataTable` (UX-2+).
 */
export function Table({
  testId,
  caption,
  columns,
  children,
  count,
  bounded,
}: {
  readonly testId: string;
  readonly caption: string;
  readonly columns: readonly string[];
  readonly children: ReactNode;
  readonly count?: number;
  readonly bounded?: boolean;
}) {
  const sticky = (count ?? Children.count(children)) > 15;
  return (
    <TableFrame
      testId={testId}
      caption={caption}
      count={count}
      bounded={bounded}
      bodyClassName={LEGACY_BODY}
      head={columns.map((column, index) => (
        <th
          // An unnamed column (the actions) may repeat the empty name.
          key={`${String(index)}-${column}`}
          scope="col"
          className={`${HEADER_CELL} ${LEGACY_HEADER_PAD} ${sticky ? STICKY_HEADER_CELL : SCROLL_STICKY_HEADER_CELL}`}
        >
          {column}
        </th>
      ))}
    >
      {children}
    </TableFrame>
  );
}

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
const HOLD_LOOK: Readonly<
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

/** A refused write: what happened, and the problem type as the MES named it. */
export function FailureMessage({
  failure,
  testId,
}: {
  readonly failure: QualityFailure;
  readonly testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      data-kind={failure.kind}
      data-type={failure.type ?? ''}
      className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
    >
      <p>{failure.text}</p>
      {failure.holds && failure.holds.length > 0 ? (
        <ul className="mt-1 list-disc pl-5" data-testid={`${testId}-holds`}>
          {failure.holds.map((id) => (
            <li key={id}>
              <Link to="/quality/holds/$id" params={{ id }} className="text-sky-800 underline">
                Hold {id}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {failure.type ? <p className="mt-1 font-mono text-xs">Problem type: {failure.type}</p> : null}
    </div>
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
