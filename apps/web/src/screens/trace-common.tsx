import type { HoldRefDto, LotRefDto, TraceUnitDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ApiError, listEquipment } from '../api/client.ts';
import { queryKeys } from '../api/queries.ts';
import { useCan } from '../auth/auth.tsx';
import { FinalityBadge } from '../components/finality-badge.tsx';
import { HOLD_LOOK } from '../components/quality-ui.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { buttonClass } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { DataTable } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing } from '../components/ui/format.tsx';
import { NotFound } from '../components/ui/not-found.tsx';
import { PageHeader, type PageHeaderBack } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import {
  HOLD_STATE_TEXT,
  SUBJECT_TEXT,
  UNIT_STATUS_TEXT,
  UNIT_STATUS_TONE,
  blocking,
  tracePoll,
  unitKey,
} from '../domain/trace.ts';

// Parts shared by the trace pages (#202; on the design system since UX-8, #331): the header's
// back link and finality, the loading, not-found and invalid-id states, links between serials,
// lots, cartons and orders, the unit status badge and the holds section.

/**
 * A trace page's `refetchInterval` (`tracePoll`): polled while it has an answer, at the pace
 * `moving` gives it; stopped without an answer or after a 4xx.
 */
export function tracePolling<T>(
  moving: (data: T) => boolean,
): (query: {
  readonly state: { readonly data: T | undefined; readonly error: unknown };
}) => number | false {
  return ({ state }) =>
    tracePoll(
      state.data === undefined ? undefined : moving(state.data),
      state.error instanceof ApiError ? state.error.status : undefined,
    );
}

/**
 * A machine as people know it (design system 6.4, names before codes): "Leak tester `lkt-01`",
 * from the equipment list; the id alone until the list is read or when it does not name it.
 */
export function useMachineName(): (id: string) => ReactNode {
  const list = useQuery({
    queryKey: queryKeys.equipmentList,
    queryFn: ({ signal }) => listEquipment(signal),
    staleTime: Infinity,
  });
  return (id) => {
    const name = list.data?.find((item) => item.id.toLowerCase() === id.toLowerCase())?.name;
    if (name === undefined) return <Code className="whitespace-nowrap">{id}</Code>;
    return (
      // The name wraps at its spaces; the id never breaks at its hyphen ("asm-/01").
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
        <span>{name}</span> <Code className="whitespace-nowrap text-ink-secondary">{id}</Code>
      </span>
    );
  };
}

/** A link in body text: underlined (WCAG 1.4.1), an id in it never wraps. */
export const linkClass = 'text-link underline underline-offset-2 hover:text-accent-hover';
const idLinkClass = `${linkClass} whitespace-nowrap`;

/** Every trace page's way back (design system 3.3). */
export const TRACE_BACK: PageHeaderBack = {
  label: 'Traceability',
  link: { to: '/trace', search: {} },
};

/** The header's title for an id: "Serial `VB-100-000042`", the id in monospace. */
export function idTitle(kind: string, id: string): ReactNode {
  return (
    <>
      {kind} <Code className="whitespace-nowrap">{id}</Code>
    </>
  );
}

/**
 * While the first answer is read: the way back and a skeleton in the page's shape, no `h1` yet
 * (the heading takes the focus when it mounts).
 */
export function TraceLoading({ label }: { readonly label: string }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <Link
          to="/trace"
          search={{}}
          className="text-link underline-offset-4 hover:underline"
          data-testid="trace-back"
        >
          ‹ {TRACE_BACK.label}
        </Link>
      </p>
      <Skeleton shape="table" label={label} />
    </div>
  );
}

/** An id the MES does not know: the not-found page (G-21, T-06). */
export function TraceNotFound({
  kind,
  id,
  detail,
}: {
  readonly kind: 'serial' | 'lot' | 'carton';
  readonly id: string;
  readonly detail?: string;
}) {
  return (
    <NotFound
      kind={kind}
      id={id}
      back={{ to: '/trace', label: TRACE_BACK.label }}
      testId="trace-missing"
      {...(detail === undefined ? {} : { detail })}
    />
  );
}

/** A path segment that cannot be an id at all (a space, a slash): said so, under its own `h1`. */
export function InvalidId({ kind }: { readonly kind: 'Serial' | 'Lot' | 'Carton' }) {
  return (
    <div>
      <PageHeader back={TRACE_BACK} title={kind} />
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          size="page"
          icon="search"
          testId="trace-invalid"
          title={`This is not a ${kind.toLowerCase()} id the MES could know`}
          body="An id has no spaces or slashes and at most 128 characters. Search for it instead."
          action={
            <Link to="/trace" search={{}} className={buttonClass({ variant: 'secondary' })}>
              Search the traceability
            </Link>
          }
        />
      </div>
    </div>
  );
}

/**
 * The answer's finality (ADR-0034) in the page header, shown once for the page (design system
 * 2.6): Final, or Provisional while some machine may still send facts. `trace-finality` with its
 * `data-final` and `data-not-final` is the Final badge, or the notice that says what is missing.
 */
export function FinalityStatus({ final }: { readonly final: boolean }) {
  return final ? (
    <Badge
      tone="neutral"
      variant="outline"
      icon="check"
      title="Every machine has reported through the latest record shown"
      data-testid="trace-finality"
      data-final="true"
      data-not-final=""
    >
      Final
    </Badge>
  ) : (
    <FinalityBadge final={false} title="Facts may still arrive and change this answer" />
  );
}

/** Which machines may still send facts, under the header while the answer is not final. */
export function FinalityNotice({
  final,
  notFinal,
}: {
  readonly final: boolean;
  readonly notFinal: readonly string[];
}) {
  if (final) return null;
  return (
    <Callout
      tone="warn"
      role="status"
      title="Not final yet"
      className="mb-6"
      data-testid="trace-finality"
      data-final="false"
      data-not-final={notFinal.join(',')}
    >
      {notFinal.length > 0
        ? `Facts from ${notFinal.join(', ')} may still arrive and change this answer.`
        : 'Genealogy has not processed every fact yet.'}{' '}
      The page reads it again every few seconds.
    </Callout>
  );
}

/** A "label value" pair of the header's key facts (design system 3.3: an inline `dl`). */
export type HeaderFact = readonly [label: string, value: ReactNode];

/** The header's key facts: inline label and value pairs that wrap, never a fixed label column. */
export function HeaderFacts({
  facts,
  testId,
  data,
}: {
  readonly facts: readonly HeaderFact[];
  readonly testId?: string;
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <dl data-testid={testId} {...data} className="flex flex-wrap gap-x-6 gap-y-1">
      {facts.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-ink-secondary">{label}</dt>
          <dd className="min-w-0 whitespace-nowrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A unit's status as a badge (T-02): Scrapped raised as `alarm`. */
export function UnitStatusBadge({ status }: { readonly status: TraceUnitDto['status'] }) {
  return (
    <Badge tone={UNIT_STATUS_TONE[status]} icon={status === 'scrapped' ? 'alert' : undefined}>
      {UNIT_STATUS_TEXT[status]}
    </Badge>
  );
}

export const unitStatus = (status: keyof typeof UNIT_STATUS_TEXT): string =>
  UNIT_STATUS_TEXT[status];

export function LotLink({ lot }: { readonly lot: LotRefDto }) {
  return (
    <Link
      to="/trace/lots/$lot"
      params={{ lot: lot.lot }}
      className={idLinkClass}
      data-testid={`lot-link-${lot.lot}`}
      data-material={lot.material}
    >
      <Code>{lot.lot}</Code>
    </Link>
  );
}

/**
 * Lots as links with their material; `null` (not reported) and `[]` (none) said apart (design
 * system 6.3): "Not reported", and none as an em dash with its reason in a table (`stack`, one
 * lot a line) or the caller's sentence in prose (`inline`).
 */
export function LotList({
  lots,
  testId,
  layout = 'stack',
  none = 'No lot consumed',
}: {
  readonly lots: readonly LotRefDto[] | null;
  readonly testId?: string;
  readonly layout?: 'stack' | 'inline';
  /** The reason (a table) or the sentence (prose) for a reported empty list. */
  readonly none?: string;
}) {
  const id = testId === undefined ? {} : { 'data-testid': testId };
  if (lots === null) {
    return (
      <span {...id} data-reported="false" className="text-ink-secondary">
        Not reported
      </span>
    );
  }
  if (lots.length === 0) {
    return (
      <span {...id} data-reported="true" data-count="0">
        {layout === 'stack' ? <Missing reason={none} /> : none}
      </span>
    );
  }
  return (
    <span
      {...id}
      data-reported="true"
      data-count={String(lots.length)}
      className={layout === 'stack' ? 'flex flex-col gap-0.5' : 'flex flex-wrap gap-x-4 gap-y-1'}
    >
      {lots.map((lot, index) => (
        // The lot id never breaks (its link is nowrap); in a table the material may go under it.
        <span
          key={`${lot.lot}-${String(index)}`}
          className={layout === 'stack' ? undefined : 'whitespace-nowrap'}
        >
          <LotLink lot={lot} />{' '}
          <span className="whitespace-nowrap text-ink-secondary">{lot.material}</span>
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
    return <span className="text-ink-secondary">Part {unit.partId}, no serial yet</span>;
  }
  return (
    <Link
      to="/trace/serials/$serial"
      params={{ serial: unit.serial }}
      search={{ unit: unitKey(unit) }}
      className={idLinkClass}
      data-testid={`serial-link-${unitKey(unit)}`}
    >
      <Code>{unit.serial}</Code>
    </Link>
  );
}

const NO_CARTON = 'Not packed into a carton';
const NO_ORDER = 'No order (schedule mode)';

export function CartonLink({ carton }: { readonly carton: string | null }) {
  if (carton === null) return <Missing reason={NO_CARTON} />;
  return (
    <Link
      to="/trace/cartons/$carton"
      params={{ carton }}
      className={idLinkClass}
      data-testid={`trace-carton-${carton}`}
    >
      <Code>{carton}</Code>
    </Link>
  );
}

export function OrderLink({ order }: { readonly order: string | null }) {
  if (order === null) return <Missing reason={NO_ORDER} />;
  return (
    <Link
      to="/orders/$id"
      params={{ id: order }}
      className={idLinkClass}
      data-testid={`trace-order-${order}`}
    >
      <Code>{order}</Code>
    </Link>
  );
}

/**
 * An order or carton id as text in a long table whose page lists each once as a link (the lot's
 * Orders and Cartons sections): one tab stop per row, not three (G-33).
 */
export function IdText({
  id,
  kind,
}: {
  readonly id: string | null;
  readonly kind: 'order' | 'carton';
}) {
  if (id === null) return <Missing reason={kind === 'order' ? NO_ORDER : NO_CARTON} />;
  return <Code className="whitespace-nowrap">{id}</Code>;
}

/** Order, lot, carton and order links as chips that wrap: a section's short list of ids. */
export function IdLinks({
  children,
  count,
}: {
  readonly children: readonly ReactNode[];
  readonly count: number;
}) {
  return (
    <ul
      className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-line bg-surface p-4 text-sm"
      data-count={String(count)}
    >
      {children}
    </ul>
  );
}

/** A hold subject's page: its trace page, or an order's detail (also the holds screens', #203). */
export function SubjectLink({
  subject,
  testId,
}: {
  readonly subject: HoldRefDto['subject'];
  /** A `data-testid` for the link (with the subject's kind in `data-kind`). */
  readonly testId?: string;
}) {
  const text = `${SUBJECT_TEXT[subject.kind]} ${subject.id}`;
  const hooks = testId === undefined ? {} : { 'data-testid': testId, 'data-kind': subject.kind };
  switch (subject.kind) {
    case 'lot':
      return (
        <Link to="/trace/lots/$lot" params={{ lot: subject.id }} className={linkClass} {...hooks}>
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
          {...hooks}
        >
          {text}
        </Link>
      );
    case 'carton':
      return (
        <Link
          to="/trace/cartons/$carton"
          params={{ carton: subject.id }}
          className={linkClass}
          {...hooks}
        >
          {text}
        </Link>
      );
    case 'order':
      return (
        <Link to="/orders/$id" params={{ id: subject.id }} className={linkClass} {...hooks}>
          {text}
        </Link>
      );
  }
}

/** An abnormal state at the top of the page (a hold): a callout, announced politely. */
export function HeldNotice({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <Callout
      tone="alarm"
      role="status"
      title="On quality hold"
      className="mb-6"
      data-testid={testId}
    >
      {children}
    </Callout>
  );
}

/** The header's badge for a page under an open or rejected hold. */
export function HeldBadge({ holds }: { readonly holds: readonly HoldRefDto[] }) {
  if (!blocking(holds)) return null;
  return (
    <Badge tone="alarm" icon="ban">
      Held
    </Badge>
  );
}

/**
 * The quality holds an answer names (#201): open and rejected ones block; read-only here, opened
 * and decided on the holds screen (#203).
 */
export function Holds({
  holds,
  what,
  subject,
}: {
  readonly holds: readonly HoldRefDto[];
  readonly what: string;
  /** The page's own subject, which a `quality:hold` user may hold from here (#203). */
  readonly subject?: { readonly kind: 'lot' | 'serial' | 'carton'; readonly id: string };
}) {
  const canHold = useCan('quality:hold');
  return (
    <Section
      id="trace-holds-title"
      testId="trace-holds"
      title="Quality holds"
      description={
        <>
          Holds on {what}, by the scope the MES last derived. They are opened, released and rejected
          on the{' '}
          <Link
            to="/quality/holds"
            search={{}}
            className={linkClass}
            data-testid="holds-screen-link"
          >
            holds screen
          </Link>
          .
        </>
      }
      actions={
        canHold && subject ? (
          <Link
            to="/quality/holds/new"
            search={{ kind: subject.kind, id: subject.id }}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
            data-testid="trace-hold-open"
          >
            Hold this {SUBJECT_TEXT[subject.kind].toLowerCase()}
          </Link>
        ) : undefined
      }
    >
      {holds.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-4">
          <EmptyState
            size="inline"
            icon="check"
            testId="trace-holds-empty"
            title="No open or rejected hold"
            body="Nothing here blocks shipping; the scope grows as facts arrive."
          />
        </div>
      ) : (
        <DataTable
          caption={`Quality holds on ${what}`}
          testId="trace-holds-table"
          rows={holds}
          rowKey={(hold) => hold.id}
          rowTestId={(hold) => `hold-${hold.id}`}
          rowProps={(hold) => ({
            'data-state': hold.state,
            'data-subject-kind': hold.subject.kind,
            'data-subject-id': hold.subject.id,
          })}
          // The bar says "blocks shipping" (open and rejected alike), not the hold's state: the
          // badge beside it carries the state (a rejected hold is a neutral solid badge, 2.6).
          rowTone={(hold) => (hold.state === 'released' ? undefined : 'alarm')}
          columns={[
            {
              key: 'hold',
              header: 'Hold',
              rowHeader: true,
              nowrap: true,
              cell: (hold) => (
                <Link
                  to="/quality/holds/$id"
                  params={{ id: hold.id }}
                  className={idLinkClass}
                  data-testid={`hold-link-${hold.id}`}
                >
                  Hold {hold.id}
                </Link>
              ),
            },
            {
              key: 'state',
              header: 'State',
              nowrap: true,
              cell: (hold) => (
                <Badge tone={HOLD_LOOK[hold.state].tone} variant={HOLD_LOOK[hold.state].variant}>
                  {HOLD_STATE_TEXT[hold.state]}
                </Badge>
              ),
            },
            {
              key: 'subject',
              header: 'Held subject',
              cell: (hold) => <SubjectLink subject={hold.subject} />,
            },
          ]}
        />
      )}
    </Section>
  );
}
