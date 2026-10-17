import { GENEALOGY_LIMITS, type TraceSearchDto } from '@shopfloor/contracts/mes-api';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { queryKeys } from '../api/queries.ts';
import { searchTrace } from '../api/trace.ts';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import { validQuery } from '../domain/trace.ts';
import { linkClass } from './trace-common.tsx';

type Result = TraceSearchDto['results'][number];

const KIND_TEXT: Readonly<Record<Result['kind'], string>> = {
  serial: 'Serials (backward trace)',
  lot: 'Lots (forward trace)',
  carton: 'Cartons',
  order: 'Orders',
};

const KINDS = ['serial', 'lot', 'carton', 'order'] as const;

function ResultLink({ result }: { readonly result: Result }) {
  const props = {
    className: linkClass,
    'data-testid': `trace-result-${result.kind}-${result.id}`,
    'data-kind': result.kind,
  };
  switch (result.kind) {
    case 'serial':
      return (
        <Link to="/trace/serials/$serial" params={{ serial: result.id }} search={{}} {...props}>
          {result.id}
        </Link>
      );
    case 'lot':
      return (
        <Link to="/trace/lots/$lot" params={{ lot: result.id }} {...props}>
          {result.id}
        </Link>
      );
    case 'carton':
      return (
        <Link to="/trace/cartons/$carton" params={{ carton: result.id }} {...props}>
          {result.id}
        </Link>
      );
    case 'order':
      return (
        <Link to="/orders/$id" params={{ id: result.id }} {...props}>
          {result.id}
        </Link>
      );
  }
}

function Results({ q }: { readonly q: string }) {
  const read = useQuery({
    queryKey: queryKeys.traceSearch(q),
    queryFn: ({ signal }) => searchTrace(q, signal),
  });
  if (read.isPending) return <p className="mt-4">Searching…</p>;
  if (read.isError) {
    return (
      <div className="mt-4">
        <QueryError what="the search" error={read.error} onRetry={() => void read.refetch()} />
      </div>
    );
  }
  const results = read.data.results;
  if (results.length === 0) {
    return (
      <p className="mt-4" data-testid="trace-no-results">
        No serial, lot, carton or order starts with “{q}”.
      </p>
    );
  }
  return (
    <div className="mt-4" data-testid="trace-results" data-count={String(results.length)}>
      {KINDS.map((kind) => {
        const ofKind = results.filter((result) => result.kind === kind);
        if (ofKind.length === 0) return null;
        return (
          <section key={kind} aria-labelledby={`trace-kind-${kind}`} className="mt-3">
            <h2 id={`trace-kind-${kind}`} className="text-lg font-semibold">
              {KIND_TEXT[kind]}
            </h2>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {ofKind.map((result) => (
                <li key={result.id}>
                  <ResultLink result={result} />
                </li>
              ))}
            </ul>
            {ofKind.length >= GENEALOGY_LIMITS.search ? (
              <p className="mt-1 text-sm text-slate-700" data-testid={`trace-more-${kind}`}>
                Only the first {GENEALOGY_LIMITS.search} are shown: type more of the id.
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** `/trace?q=` (#202): find a serial, lot, carton or order by the start of its id. */
export function TraceSearch() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const search = useSearch({ from: '/trace' });
  const navigate = useNavigate({ from: '/trace' });
  const inputId = useId();
  const hintId = useId();
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
      <h1 ref={heading} id="trace-title" tabIndex={-1} className="text-2xl font-bold">
        Traceability
      </h1>
      <p className="mt-1 text-sm text-slate-700">
        Trace a serial back to its lots, machines, operators and leak readings, or a lot forward to
        the units, orders and cartons that used it.
      </p>
      <form
        role="search"
        className="mt-3 flex flex-wrap items-end gap-2"
        data-testid="trace-search"
        onSubmit={submit}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            Serial, lot, carton or order
          </label>
          <input
            id={inputId}
            type="search"
            aria-describedby={hintId}
            data-testid="trace-query"
            value={text}
            maxLength={GENEALOGY_LIMITS.id}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft({ for: search.q, text: event.target.value });
            }}
            className="w-72 max-w-full rounded border border-slate-500 bg-white px-2 py-1 font-mono text-sm"
          />
        </div>
        <button
          type="submit"
          data-testid="trace-submit"
          className="rounded border border-sky-800 bg-sky-800 px-3 py-1 text-sm font-medium text-white hover:bg-sky-900"
        >
          Search
        </button>
        <p id={hintId} className="w-full text-xs text-slate-700">
          The start of an id is enough, e.g. VB-100-0000, BL100 or PO-2610.
        </p>
      </form>
      {search.q === undefined ? null : <Results key={search.q} q={search.q} />}
    </section>
  );
}
