import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test/fixtures.ts';
import {
  lineBucket,
  lineOee,
  orderOee,
  record,
  requestBody,
  requestUrl,
  SHIFT_END,
  SHIFT_START,
} from '../test/oee-fixtures.ts';
import {
  ApiError,
  getDowntime,
  getLineOee,
  getOee,
  getOrderOee,
  getShiftOee,
  putCoding,
} from './client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OEE and downtime reads', () => {
  it('asks the MES with the documented paths and queries', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.startsWith('/api/v1/shifts/')) {
        return Promise.resolve(
          json({
            shiftKey: '2026-10-15/A',
            start: SHIFT_START,
            end: SHIFT_END,
            equipment: [],
            workCenters: [],
          }),
        );
      }
      if (url.startsWith('/api/v1/oee')) {
        return Promise.resolve(
          json({
            scope: 'work-center',
            id: 'cell-m1',
            bucket: 'hour',
            from: SHIFT_START,
            to: SHIFT_END,
            buckets: [],
          }),
        );
      }
      return Promise.resolve(
        json({ from: SHIFT_START, to: SHIFT_END, truncated: false, records: [] }),
      );
    });
    await getShiftOee('2026-10-15/A');
    await getOee({
      scope: 'work-center',
      id: 'cell-m1',
      bucket: 'hour',
      from: Date.parse(SHIFT_START),
      to: Date.parse(SHIFT_END),
    });
    await getDowntime({ from: Date.parse(SHIFT_START), to: Date.parse(SHIFT_END), uncoded: true });
    expect(urls).toEqual([
      '/api/v1/shifts/2026-10-15/A/oee',
      '/api/v1/oee?scope=work-center&id=cell-m1&bucket=hour&from=2026-10-15T03%3A00%3A00.000Z&to=2026-10-15T11%3A00%3A00.000Z',
      '/api/v1/downtime?from=2026-10-15T03%3A00%3A00.000Z&to=2026-10-15T11%3A00%3A00.000Z&uncoded=true',
    ]);
  });
});

describe('order and line OEE reads (#233)', () => {
  it('asks the MES with the documented paths and parses the answers', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      return Promise.resolve(
        url.startsWith('/api/v1/oee/orders/')
          ? json(orderOee('PO 1'))
          : json(lineOee('shift', [lineBucket('shift', '2026-10-15/A')])),
      );
    });
    expect((await getOrderOee('PO 1')).orderId).toBe('PO 1');
    const line = await getLineOee({
      bucket: 'shift',
      from: Date.parse(SHIFT_START),
      to: Date.parse(SHIFT_END),
    });
    expect(line.bottlenecks[0]?.equipment).toEqual(['asm-01']);
    expect(urls).toEqual([
      '/api/v1/oee/orders/PO%201',
      '/api/v1/oee/line?bucket=shift&from=2026-10-15T03%3A00%3A00.000Z&to=2026-10-15T11%3A00%3A00.000Z',
    ]);
  });
});

describe('putCoding', () => {
  it('sends JSON same-origin with PUT, never a form or text/plain', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: requestUrl(input), init };
      return Promise.resolve(json({ record: record(), version: 4 }));
    });
    const body = { segments: [], version: 3 };
    const result = await putCoding('cnc-01~1790000000~1', body);
    expect(result.version).toBe(4);
    expect(seen?.url).toBe('/api/v1/downtime/cnc-01~1790000000~1/coding');
    expect(seen?.init?.method).toBe('PUT');
    expect(seen?.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(seen?.init?.mode).toBe('same-origin');
    expect(requestBody(seen?.init)).toEqual(body);
  });

  it("keeps a 429's Retry-After and the problem details", async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Too Many Requests',
            status: 429,
            detail: 'write rate limit',
            instance: '/api/v1/downtime/x/coding',
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '2' },
          },
        ),
      ),
    );
    const error = await putCoding('cnc-01~1~1', { segments: [], version: 0 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfter).toBe(2);
    expect((error as ApiError).problem?.detail).toBe('write rate limit');
  });
});
