import type { HoldState, SpcSignalDto } from '@shopfloor/contracts/mes-api';
import type { ReactNode } from 'react';
import { HOLD_STATE_TEXT, SIGNAL_STATUS_TEXT, type QualityFailure } from '../domain/quality.ts';
import { formatPlantTime } from '../domain/time.ts';

// Shared pieces of the SPC and holds screens (#203): sections, tables, badges and messages. State
// is always a word, never colour alone.

export const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
export const buttonClass =
  'rounded border border-slate-500 bg-white px-3 py-1 text-sm font-medium hover:bg-slate-100 disabled:opacity-50';
export const primaryClass =
  'rounded bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-50';
export const cell = 'px-2 py-1.5 align-top';
const head = `${cell} font-semibold`;

export const timeOf = (value: string | null): ReactNode =>
  value === null ? '–' : <time dateTime={value}>{formatPlantTime(value)}</time>;

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

export function Table({
  testId,
  caption,
  columns,
  children,
  count,
}: {
  readonly testId: string;
  readonly caption: string;
  readonly columns: readonly string[];
  readonly children: ReactNode;
  readonly count?: number;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
      <table
        className="w-full text-left text-sm"
        data-testid={testId}
        {...(count === undefined ? {} : { 'data-count': String(count) })}
      >
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-100">
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={head}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const STATUS_CLASS: Readonly<Record<SpcSignalDto['status'], string>> = {
  provisional: 'border-amber-700 bg-amber-50 text-amber-950',
  final: 'border-red-800 bg-red-50 text-red-950',
  withdrawn: 'border-slate-500 bg-slate-100 text-slate-800',
};

export function SignalStatusBadge({ signal }: { readonly signal: SpcSignalDto }) {
  return (
    <span
      data-testid="signal-status"
      data-status={signal.status}
      className={`inline-block rounded border px-1.5 text-xs font-semibold ${STATUS_CLASS[signal.status]}`}
    >
      {SIGNAL_STATUS_TEXT[signal.status]}
    </span>
  );
}

const HOLD_CLASS: Readonly<Record<HoldState, string>> = {
  open: 'border-red-800 bg-red-50 text-red-950',
  released: 'border-emerald-800 bg-emerald-50 text-emerald-950',
  rejected: 'border-slate-700 bg-slate-200 text-slate-900',
};

export function HoldStateBadge({ state }: { readonly state: HoldState }) {
  return (
    <span
      data-testid="hold-state"
      data-state={state}
      className={`inline-block rounded border px-1.5 text-xs font-semibold ${HOLD_CLASS[state]}`}
    >
      {HOLD_STATE_TEXT[state]}
    </span>
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
      {failure.type ? <p className="mt-1 font-mono text-xs">Problem type: {failure.type}</p> : null}
    </div>
  );
}

/** A comment box with its character count announced. */
export function CommentInput({
  id,
  label,
  value,
  onChange,
  testId,
  max,
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly max: number;
  readonly required: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? ' (required)' : ' (optional)'}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        value={value}
        rows={2}
        maxLength={max}
        aria-describedby={`${id}-count`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${inputClass} w-full`}
      />
      <span id={`${id}-count`} className="text-xs text-slate-700">
        {value.length} of {max} characters
      </span>
    </div>
  );
}
