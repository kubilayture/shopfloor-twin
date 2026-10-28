import { GENEALOGY_LIMITS, type TraceSearchDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { queryKeys } from '../api/queries.ts';
import { searchTrace } from '../api/trace.ts';
import { QueryError } from '../components/query-error.tsx';
import { OrderStatusBadge } from '../components/order-badges.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { TextInput } from '../components/ui/controls.tsx';
import { DataTable } from '../components/ui/data-table.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Missing } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { validQuery } from '../domain/trace.ts';
import {
  CartonStateBadge,
  linkClass,
  LotErpBadge,
  OrderLink,
  UnitStatusBadge,
} from './trace-common.tsx';
import { countOf } from '../domain/words.ts';

type Result = TraceSearchDto['results'][number];
type Kind = Result['kind'];

/** The order the results are grouped in: what a trace starts from first. */
const KINDS = ['serial', 'lot', 'carton', 'order'] as const;

const KIND_TEXT: Readonly<Record<Kind, { readonly one: string; readonly many: string }>> = {
  serial: { one: 'Serial', many: 'serials' },
  lot: { one: 'Lot', many: 'lots' },
  carton: { one: 'Carton', many: 'cartons' },
  order: { one: 'Order', many: 'orders' },
};

/** What following a result opens. */
const OPENS: Readonly<Record<Kind, string>> = {
  serial: 'Backward trace: its order, lots, machines, operators, readings and carton',
  lot: 'Forward trace: the units, orders and cartons that used it',
  carton: 'Its members and their lots',
  order: 'The production order',
};

function ResultLink({ result }: { readonly result: Result }) {
  const props = {
    className: `${linkClass} whitespace-nowrap`,
    'data-testid': `trace-result-${result.kind}-${result.id}`,
    'data-kind': result.kind,
  };
  const id = <Code>{result.id}</Code>;
  switch (result.kind) {
    case 'serial':
      return (
        <Link to="/trace/serials/$serial" params={{ serial: result.id }} search={{}} {...props}>
          {id}
        </Link>
      );
    case 'lot':
      return (
        <Link to="/trace/lots/$lot" params={{ lot: result.id }} {...props}>
          {id}
        </Link>
      );
    case 'carton':
      return (
        <Link to="/trace/cartons/$carton" params={{ carton: result.id }} {...props}>
          {id}
        </Link>
      );
    case 'order':
      return (
        <Link to="/orders/$id" params={{ id: result.id }} {...props}>
          {id}
        </Link>
      );
  }
}

/**
 * A result's status (#364), as the page it opens shows it: a serial's newest unit, a lot's ERP
 * status, a carton closed or filling, an order's MES status. `data-status` keeps the raw value; a
 * dash where the MES sent none (an order it no longer holds, or a MES before #364).
 */
function ResultStatus({ result }: { readonly result: Result }) {
  const testId = `result-status-${result.kind}-${result.id}`;
  const badge = (() => {
    if (result.status === undefined || result.status === null) return undefined;
    switch (result.kind) {
      case 'serial':
        return <UnitStatusBadge status={result.status} />;
      case 'lot':
        return <LotErpBadge status={result.status} />;
      case 'carton':
        return <CartonStateBadge status={result.status} />;
      case 'order':
        return <OrderStatusBadge order={{ status: result.status }} testId={null} />;
    }
  })();
  return (
    <span data-testid={testId} data-status={result.status ?? ''}>
      {badge ?? <Missing reason="status not known" />}
    </span>
  );
}

/** The order a result belongs to (#364): a serial's unit's, a carton's; a lot or an order has none. */
function ResultOrder({ result }: { readonly result: Result }) {
  const testId = `result-order-${result.kind}-${result.id}`;
  if (result.kind === 'lot') {
    return <Missing reason="a lot is used by any number of orders" testId={testId} />;
  }
  if (result.kind === 'order') return <Missing reason="the result is the order" testId={testId} />;
  if (result.order === undefined) return <Missing reason="no order known" testId={testId} />;
  return <OrderLink order={result.order} testId={testId} />;
}

/** "4 results: 2 serials, 1 lot, 1 order", counted by kind in the table's order. */
function summaryText(results: readonly Result[]): string {
  const parts = KINDS.flatMap((kind) => {
    const n = results.filter((result) => result.kind === kind).length;
    if (n === 0) return [];
    return [`${String(n)} ${n === 1 ? KIND_TEXT[kind].one.toLowerCase() : KIND_TEXT[kind].many}`];
  });
  const total = results.length;
  return `${countOf(total, 'result')}: ${parts.join(', ')}`;
}

function Results({ q }: { readonly q: string }) {
  const read = useQuery({
    queryKey: queryKeys.traceSearch(q),
    queryFn: ({ signal }) => searchTrace(q, signal),
  });
  if (read.isPending) return <Skeleton shape="table" rows={4} label="Searching…" />;
  if (read.isError) {
    return <QueryError what="the search" error={read.error} onRetry={() => void read.refetch()} />;
  }
  const results = read.data.results;
  if (results.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          icon="search"
          testId="trace-no-results"
          title={
            <>
              Nothing starts with “<Code>{q}</Code>”
            </>
          }
          body="No serial, lot, carton or order starts with this text. Check the id, or type less of it."
        />
      </div>
    );
  }
  // Grouped by kind (T-01): serials, lots, cartons, orders; within a kind as the MES sorted them.
  const rows = KINDS.flatMap((kind) => results.filter((result) => result.kind === kind));
  const cut = KINDS.filter(
    (kind) => results.filter((result) => result.kind === kind).length >= GENEALOGY_LIMITS.search,
  );
  return (
    <Section
      id="trace-results-title"
      title="Results"
      description={
        <>
          {summaryText(results)} for “<Code>{q}</Code>”
        </>
      }
    >
      <DataTable
        caption={`Serials, lots, cartons and orders starting with ${q}`}
        testId="trace-results"
        rows={rows}
        rowKey={(result) => `${result.kind}-${result.id}`}
        rowProps={(result) => ({ 'data-kind': result.kind })}
        narrow="stack"
        columns={[
          {
            key: 'id',
            header: 'Id',
            rowHeader: true,
            nowrap: true,
            cell: (result) => <ResultLink result={result} />,
          },
          {
            key: 'kind',
            header: 'Type',
            nowrap: true,
            cell: (result) => KIND_TEXT[result.kind].one,
          },
          {
            key: 'status',
            header: 'Status',
            nowrap: true,
            cell: (result) => <ResultStatus result={result} />,
          },
          {
            key: 'order',
            header: 'Order',
            nowrap: true,
            priority: 2,
            cell: (result) => <ResultOrder result={result} />,
          },
          {
            key: 'opens',
            header: 'Opens',
            priority: 2,
            cell: (result) => <span className="text-ink-secondary">{OPENS[result.kind]}</span>,
          },
        ]}
      />
      {cut.length > 0 ? (
        <Callout tone="neutral" className="mt-3">
          {cut.map((kind) => (
            <p key={kind} data-testid={`trace-more-${kind}`}>
              Only the first {GENEALOGY_LIMITS.search} {KIND_TEXT[kind].many} are shown: type more
              of the id.
            </p>
          ))}
        </Callout>
      ) : null}
    </Section>
  );
}

/** Before a search: what the page finds, with an example of each kind of id. */
function Start() {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <EmptyState
        icon="search"
        title="Search for a serial, lot, carton or order"
        body={
          <>
            The start of an id is enough: <Code>VB-100-0000</Code> finds the serials of that run,{' '}
            <Code>BL100</Code> the blank lots, <Code>PO-2610</Code> the orders and their cartons.
          </>
        }
      />
    </div>
  );
}

/** `/trace?q=` (#202): find a serial, lot, carton or order by the start of its id. */
export function TraceSearch() {
  const search = useSearch({ from: '/trace' });
  const navigate = useNavigate({ from: '/trace' });
  // Keyed by the URL's query: going back or forward shows that search in the field.
  const [draft, setDraft] = useState({ for: search.q, text: search.q ?? '' });
  const text = draft.for === search.q ? draft.text : (search.q ?? '');
  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const q = validQuery(text);
    setDraft({ for: q, text: q ?? '' });
    void navigate({ search: { q } });
  };
  return (
    <section aria-labelledby="trace-title">
      <PageHeader
        id="trace-title"
        title="Traceability"
        description="Trace a serial back to its lots, machines, operators and leak readings, or a lot forward to the units, orders and cartons that used it."
        filters={
          <form
            role="search"
            aria-label="Trace search"
            className="flex w-full flex-wrap items-start gap-2"
            data-testid="trace-search"
            onSubmit={submit}
          >
            <TextInput
              label="Serial, lot, carton or order"
              name="q"
              type="search"
              hint="The start of an id is enough, e.g. VB-100-0000, BL100 or PO-2610."
              data-testid="trace-query"
              value={text}
              maxLength={GENEALOGY_LIMITS.id}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setDraft({ for: search.q, text: event.target.value });
              }}
              fieldClassName="w-full max-w-md"
              className="w-full font-mono"
            />
            <Button
              type="submit"
              variant="primary"
              icon="search"
              data-testid="trace-submit"
              className="sm:mt-6"
            >
              Search
            </Button>
          </form>
        }
      />
      {search.q === undefined ? <Start /> : <Results key={search.q} q={search.q} />}
    </section>
  );
}
