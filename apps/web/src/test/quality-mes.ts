import type {
  CharacteristicDto,
  HoldDetailDto,
  HoldDto,
  HoldSuggestionDto,
  SpcChartDto,
} from '@shopfloor/contracts/mes-api';
import { PLANT, SESSION, json, problem } from './fixtures.ts';
import { requestBody, requestUrl } from './oee-fixtures.ts';
import { REASONS, chart as chartOf } from './quality-fixtures.ts';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly ifNoneMatch?: string | undefined;
}

/** What the fake MES holds; tests change it between reads. */
export interface QualityState {
  characteristics: CharacteristicDto[];
  chart: SpcChartDto;
  /** The chart's ETag; a matching `If-None-Match` answers 304. */
  etag: string;
  holds: HoldDto[];
  details: Record<string, HoldDetailDto>;
  suggestions: Record<number, HoldSuggestionDto>;
}

export function qualityState(overrides: Partial<QualityState> = {}): QualityState {
  const chart = overrides.chart ?? chartOf();
  return {
    characteristics: [chart.characteristic],
    chart,
    etag: '"rev-1"',
    holds: [],
    details: {},
    suggestions: {},
    ...overrides,
  };
}

export type Write = (method: string, path: string, body: unknown) => Response;

/** The MES as the quality screens see it; `write` answers the POSTs. */
export function qualityMes(state: QualityState, write: Write = () => json({})) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    const path = url.pathname;
    const headers = new Headers(init?.headers);
    const ifNoneMatch = headers.get('if-none-match') ?? undefined;
    calls.push({ method, path: path + url.search, body, ifNoneMatch });
    if (method !== 'GET') return Promise.resolve(write(method, path, body));
    if (path === '/api/v1/session') return Promise.resolve(json(SESSION));
    if (path === '/api/v1/plant') return Promise.resolve(json(PLANT));
    if (path === '/api/v1/quality/characteristics') {
      return Promise.resolve(json({ characteristics: state.characteristics }));
    }
    const chart = /^\/api\/v1\/quality\/characteristics\/([^/]+)\/chart$/.exec(path);
    if (chart) {
      if (decodeURIComponent(chart[1] ?? '') !== state.chart.characteristic.id) {
        return Promise.resolve(problem(404, 'Not Found', 'no characteristic', path));
      }
      if (ifNoneMatch === state.etag) {
        return Promise.resolve(new Response(null, { status: 304, headers: { etag: state.etag } }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(state.chart), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: state.etag },
        }),
      );
    }
    if (path === '/api/v1/quality/hold-reasons') return Promise.resolve(json(REASONS));
    if (path === '/api/v1/quality/holds') {
      const states = url.searchParams.get('state')?.split(',');
      const kind = url.searchParams.get('subjectKind');
      const id = url.searchParams.get('subjectId');
      const holds = state.holds.filter(
        (h) =>
          (!states || states.includes(h.state)) &&
          (kind === null || (h.subject.kind === kind && h.subject.id === id)),
      );
      return Promise.resolve(json({ holds, truncated: false }));
    }
    const detail = /^\/api\/v1\/quality\/holds\/([^/]+)$/.exec(path);
    if (detail) {
      const found = state.details[decodeURIComponent(detail[1] ?? '')];
      return Promise.resolve(found ? json(found) : problem(404, 'Not Found', 'no hold', path));
    }
    const suggested = /^\/api\/v1\/quality\/signals\/(\d+)\/hold-suggestion$/.exec(path);
    if (suggested) {
      const found = state.suggestions[Number(suggested[1])];
      return Promise.resolve(found ? json(found) : problem(404, 'Not Found', 'no signal', path));
    }
    return Promise.resolve(problem(404, 'Not Found', 'no route', path));
  };
  return {
    fetch,
    calls,
    posts: () => calls.filter((call) => call.method === 'POST'),
    reads: (prefix: string) => calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix)),
  };
}
