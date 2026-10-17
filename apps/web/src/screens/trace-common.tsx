import type { HoldRefDto, LotRefDto } from '@shopfloor/contracts/mes-api';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import {
  HOLDS_HREF,
  HOLD_STATE_TEXT,
  SUBJECT_TEXT,
  UNIT_STATUS_TEXT,
  holdHref,
  unitKey,
} from '../domain/trace.ts';
import { formatPlantTime } from '../domain/time.ts';

// Parts shared by the trace pages (#202): sections, tables, the finality notice, holds and links
// between serials, lots, cartons and orders.

export const cell = 'px-2 py-1.5 align-top';
const head = `${cell} font-semibold`;
export const linkClass = 'text-sky-800 underline';

export const plantTime = (value: string | null): ReactNode =>
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
  count,
  children,
}: {
  readonly testId: string;
  readonly caption: string;
  readonly columns: readonly string[];
  readonly count?: number;
  readonly children: ReactNode;
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

export function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="text-slate-700">{label}:</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The search page, from every trace page. */
export function BackToSearch() {
  return (
    <p className="text-sm">
      <Link to="/trace" search={{}} className={linkClass} data-testid="trace-back">
        Trace search
      </Link>
    </p>
  );
}

/**
 * The answer's finality (ADR-0034): final once every machine of the routing is final through its
 * latest record and genealogy processed it; otherwise which machines may still send facts.
 */
export function Finality({
  final,
  notFinal,
}: {
  readonly final: boolean;
  readonly notFinal: readonly string[];
}) {
  return final ? (
    <p
      className="mt-2 text-sm text-emerald-900"
      data-testid="trace-finality"
      data-final="true"
      data-not-final=""
    >
      Final: every machine has reported through the latest record shown.
    </p>
  ) : (
    <p
      role="status"
      className="mt-2 rounded border border-amber-700 bg-amber-50 p-2 text-sm text-amber-950"
      data-testid="trace-finality"
      data-final="false"
      data-not-final={notFinal.join(',')}
    >
      <span className="font-semibold">Not final yet:</span>{' '}
      {notFinal.length > 0
        ? `facts from ${notFinal.join(', ')} may still arrive and change this answer.`
        : 'genealogy has not processed every fact yet.'}{' '}
      The page reads it again every few seconds.
    </p>
  );
}

export function LotLink({ lot }: { readonly lot: LotRefDto }) {
  return (
    <Link
      to="/trace/lots/$lot"
      params={{ lot: lot.lot }}
      className={linkClass}
      data-testid={`lot-link-${lot.lot}`}
      data-material={lot.material}
    >
      {lot.lot}
    </Link>
  );
}

/** Lots as links with their material; `null` (not reported) and `[]` (none) said apart. */
export function LotList({
  lots,
  testId,
}: {
  readonly lots: readonly LotRefDto[] | null;
  readonly testId?: string;
}) {
  const id = testId === undefined ? {} : { 'data-testid': testId };
  if (lots === null) {
    return (
      <span {...id} data-reported="false" className="text-slate-700">
        Not reported
      </span>
    );
  }
  if (lots.length === 0) {
    return (
      <span {...id} data-reported="true" data-count="0">
        None
      </span>
    );
  }
  return (
    <span {...id} data-reported="true" data-count={String(lots.length)}>
      {lots.map((lot, index) => (
        <span key={`${lot.lot}-${String(index)}`}>
          {index > 0 ? ', ' : ''}
          <LotLink lot={lot} /> <span className="text-slate-700">({lot.material})</span>
        </span>
      ))}
    </span>
  );
}

export function SerialLink({
  unit,
}: {
  readonly unit: { epoch: number; partId: number; serial: string | null };
}) {
  if (unit.serial === null) {
    return <span className="text-slate-700">Part {unit.partId} (no serial)</span>;
  }
  return (
    <Link
      to="/trace/serials/$serial"
      params={{ serial: unit.serial }}
      search={{ unit: unitKey(unit) }}
      className={linkClass}
      data-testid={`serial-link-${unitKey(unit)}`}
    >
      {unit.serial}
    </Link>
  );
}

export function CartonLink({ carton }: { readonly carton: string | null }) {
  if (carton === null) return <span className="text-slate-700">None</span>;
  return (
    <Link
      to="/trace/cartons/$carton"
      params={{ carton }}
      className={linkClass}
      data-testid={`trace-carton-${carton}`}
    >
      {carton}
    </Link>
  );
}

export function OrderLink({ order }: { readonly order: string | null }) {
  if (order === null) return <span className="text-slate-700">None (schedule mode)</span>;
  return (
    <Link
      to="/orders/$id"
      params={{ id: order }}
      className={linkClass}
      data-testid={`trace-order-${order}`}
    >
      {order}
    </Link>
  );
}

export const unitStatus = (status: keyof typeof UNIT_STATUS_TEXT): string =>
  UNIT_STATUS_TEXT[status];

function SubjectLink({ subject }: { readonly subject: HoldRefDto['subject'] }) {
  const text = `${SUBJECT_TEXT[subject.kind]} ${subject.id}`;
  switch (subject.kind) {
    case 'lot':
      return (
        <Link to="/trace/lots/$lot" params={{ lot: subject.id }} className={linkClass}>
          {text}
        </Link>
      );
    case 'serial':
      return (
        <Link
          to="/trace/serials/$serial"
          params={{ serial: subject.id }}
          search={{}}
          className={linkClass}
        >
          {text}
        </Link>
      );
    case 'carton':
      return (
        <Link to="/trace/cartons/$carton" params={{ carton: subject.id }} className={linkClass}>
          {text}
        </Link>
      );
    case 'order':
      return (
        <Link to="/orders/$id" params={{ id: subject.id }} className={linkClass}>
          {text}
        </Link>
      );
  }
}

/**
 * The quality holds an answer names (#201): open and rejected ones block; read-only here, opened
 * and decided on the holds screen (#203).
 */
export function Holds({
  holds,
  what,
}: {
  readonly holds: readonly HoldRefDto[];
  readonly what: string;
}) {
  return (
    <Section id="trace-holds" title="Quality holds">
      <p className="text-sm text-slate-700">
        Holds on {what}, by the scope the MES last derived; the scope grows as facts arrive. Holds
        are opened, released and rejected on the{' '}
        {/* Plain links until #203 adds `/quality/holds`; #203 converts them to `Link`s. */}
        <a href={HOLDS_HREF} className={linkClass} data-testid="holds-screen-link">
          holds screen
        </a>
        .
      </p>
      {holds.length === 0 ? (
        <p className="mt-1 text-sm" data-testid="trace-holds-empty">
          No open or rejected hold.
        </p>
      ) : (
        <ul
          className="mt-2 flex flex-col gap-1 text-sm"
          aria-label="Quality holds"
          data-count={String(holds.length)}
        >
          {holds.map((hold) => (
            <li
              key={hold.id}
              data-testid={`hold-${hold.id}`}
              data-state={hold.state}
              data-subject-kind={hold.subject.kind}
              data-subject-id={hold.subject.id}
              className={`rounded border p-2 ${
                hold.state === 'released'
                  ? 'border-slate-300 bg-white'
                  : 'border-red-700 bg-red-50 text-red-950'
              }`}
            >
              <span className="font-semibold">{HOLD_STATE_TEXT[hold.state]}</span> hold on{' '}
              <SubjectLink subject={hold.subject} />{' '}
              <a
                href={holdHref(hold.id)}
                className={linkClass}
                data-testid={`hold-link-${hold.id}`}
              >
                (details)
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
