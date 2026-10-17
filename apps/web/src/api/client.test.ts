import { equipmentListSchema } from '@shopfloor/contracts/mes-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EPOCH, EQUIPMENT, fakeFetch, json } from '../test/fixtures.ts';
import {
  ApiError,
  MAX_INTERVAL_PAGES,
  getIntervals,
  getJson,
  getSeries,
  listEquipment,
  serverClockOffsetMs,
} from './client.ts';
import { shouldRetry } from './queries.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const range = {
  from: new Date('2026-10-15T06:00:00.000Z'),
  to: new Date('2026-10-15T08:00:00.000Z'),
};

function intervalsPage(from: string, next: string | null, states: string[]) {
  return {
    equipment: 'cnc-01',
    from,
    to: '2026-10-15T08:00:00.000Z',
    truncated: next !== null,
    next,
    intervals: states.map((state, index) => ({
      epoch: EPOCH,
      start: from,
      end: from,
      state,
      cause: null,
      provisional: false,
      intervalStart: from,
      startSeq: index,
    })),
  };
}

describe('getJson', () => {
  it('parses an answer with the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ '/api/v1/equipment': () => json({ equipment: EQUIPMENT }) }),
    );
    await expect(listEquipment()).resolves.toHaveLength(3);
  });

  it('turns problem details into an ApiError', async () => {
    vi.stubGlobal('fetch', fakeFetch({}));
    const error = await getJson('/equipment/x', equipmentListSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      message: 'Not Found: Unknown equipment, metric or route',
      problem: { instance: '/api/v1/equipment/x' },
    });
  });

  it('reports errors without problem details, bad JSON, wrong shapes and network failures', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/a': () => new Response('gateway down', { status: 502 }),
        '/api/v1/b': () => new Response('{', { status: 200 }),
        '/api/v1/c': () => json({ equipment: [{ id: 1 }] }),
        '/api/v1/d': () =>
          new Response('{', {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          }),
      }),
    );
    await expect(getJson('/a', equipmentListSchema)).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502',
    });
    await expect(getJson('/b', equipmentListSchema)).rejects.toThrow(/not JSON/);
    await expect(getJson('/c', equipmentListSchema)).rejects.toThrow(/Unexpected answer from \/c/);
    await expect(getJson('/d', equipmentListSchema)).rejects.toMatchObject({ status: 500 });

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(getJson('/a', equipmentListSchema)).rejects.toMatchObject({
      status: 0,
      message: 'The MES cannot be reached',
    });
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', () => Promise.reject(abort));
    await expect(getJson('/a', equipmentListSchema)).rejects.toBe(abort);
  });
});

describe('the MES clock offset and the HTTP cache (#170)', () => {
  it('reads every answer uncached and takes the offset only from fast answers', async () => {
    const inits: (RequestInit | undefined)[] = [];
    let date = '';
    let roundTripMs = 0;
    let now = Date.parse('2026-10-15T08:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      now += roundTripMs;
      return Promise.resolve(
        new Response(JSON.stringify({ equipment: [] }), {
          headers: { 'content-type': 'application/json', date },
        }),
      );
    });
    // The MES's clock about 90 s ahead, answered within 200 ms: `Date` (whole seconds) minus the
    // midpoint of the round trip.
    roundTripMs = 200;
    date = new Date(now + 90_100).toUTCString();
    await getJson('/equipment', equipmentListSchema);
    expect(inits[0]?.cache).toBe('no-store');
    expect(serverClockOffsetMs()).toBe(89_900);
    // A slow answer (2 s) says nothing about the clock: the offset stays.
    roundTripMs = 2_000;
    date = new Date(now + 500_000).toUTCString();
    await getJson('/equipment', equipmentListSchema);
    expect(serverClockOffsetMs()).toBe(89_900);
  });
});

describe('getIntervals', () => {
  it('follows `next` while the MES truncates its answer', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/equipment/cnc-01/intervals': (url) => {
          const from = url.searchParams.get('from') ?? '';
          requested.push(from);
          return json(
            from === '2026-10-15T06:00:00.000Z'
              ? intervalsPage(from, '2026-10-15T07:00:00.000Z', ['Running', 'Down'])
              : intervalsPage(from, null, ['Idle']),
          );
        },
      }),
    );
    const read = await getIntervals('cnc-01', range);
    expect(requested).toEqual(['2026-10-15T06:00:00.000Z', '2026-10-15T07:00:00.000Z']);
    expect(read.truncated).toBe(false);
    expect(read.intervals.map((interval) => interval.state)).toEqual(['Running', 'Down', 'Idle']);
  });

  it('stops at the page limit or when `next` does not move', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/equipment/cnc-01/intervals': (url) => {
          calls += 1;
          const from = Date.parse(url.searchParams.get('from') ?? '');
          return json(
            intervalsPage(new Date(from).toISOString(), new Date(from + 1000).toISOString(), []),
          );
        },
        '/api/v1/equipment/stuck/intervals': (url) =>
          json({
            ...intervalsPage(url.searchParams.get('from') ?? '', range.from.toISOString(), []),
            equipment: 'stuck',
          }),
      }),
    );
    await expect(getIntervals('cnc-01', range)).resolves.toMatchObject({ truncated: true });
    expect(calls).toBe(MAX_INTERVAL_PAGES);
    await expect(getIntervals('stuck', range)).resolves.toMatchObject({ truncated: true });
  });
});

describe('getSeries', () => {
  it('asks for at most 8 metrics and 5000 points', async () => {
    let query: URLSearchParams | undefined;
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/v1/equipment/wsh-01/telemetry': (url) => {
          query = url.searchParams;
          return json({
            equipment: 'wsh-01',
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            bucketMs: 1000,
            series: [],
          });
        },
      }),
    );
    const metrics = Array.from({ length: 10 }, (_, index) => `m${String(index)}`);
    await getSeries('wsh-01', metrics, range, 9_999);
    expect(query?.getAll('metric')).toHaveLength(8);
    expect(query?.get('maxPoints')).toBe('5000');
  });
});

describe('shouldRetry', () => {
  it('retries server and network errors a few times, never refusals', () => {
    expect(shouldRetry(0, new ApiError('x', 404))).toBe(false);
    expect(shouldRetry(0, new ApiError('x', 503))).toBe(true);
    expect(shouldRetry(3, new ApiError('x', 0))).toBe(false);
  });
});
