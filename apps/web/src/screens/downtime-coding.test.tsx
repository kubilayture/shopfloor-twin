import type { DowntimeRecordDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, json, problem } from '../test/fixtures.ts';
import {
  CURRENT_SHIFT,
  REASONS,
  SHIFT,
  SHIFT_END,
  SHIFT_START,
  record,
  requestBody,
  requestUrl,
} from '../test/oee-fixtures.ts';
import { renderApp } from '../test/render-app.tsx';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

const UNCODED = record();
const CODED = record({
  id: 'wsh-01~1790000000~1760500000000',
  equipment: 'wsh-01',
  start: '2026-10-15T03:30:00.000Z',
  end: '2026-10-15T03:40:00.000Z',
  state: 'Setup',
  uncoded: false,
  reason: 'SETUP/TOOL-CHANGE',
  autoReason: 'SETUP/TOOL-CHANGE',
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** The MES as the coding screen sees it; `put` answers the coding write. */
function mes(put: (body: unknown) => Response, records: () => DowntimeRecordDto[]) {
  const calls: Call[] = [];
  const routes: Record<string, () => Response> = {
    '/api/v1/equipment': () => json({ equipment: EQUIPMENT }),
    '/api/v1/plant': () => json(PLANT),
    '/api/v1/shifts/current': () => json(CURRENT_SHIFT),
    '/api/v1/shifts': () => json({ from: SHIFT_START, to: SHIFT_END, shifts: [SHIFT] }),
    '/api/v1/shifts/2026-10-15/A/oee': () =>
      json({
        shiftKey: SHIFT.key,
        start: SHIFT_START,
        end: SHIFT_END,
        equipment: [],
        workCenters: [],
      }),
    '/api/v1/reason-codes': () => json(REASONS),
    '/api/v1/downtime': () =>
      json({ from: SHIFT_START, to: SHIFT_END, truncated: false, records: records() }),
  };
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    calls.push({ method, path: url.pathname + url.search, body });
    if (method === 'PUT') return Promise.resolve(put(body));
    if (url.pathname.endsWith('/audit')) {
      return Promise.resolve(
        json({
          record: UNCODED.id,
          entries: [
            {
              id: 1,
              recordId: UNCODED.id,
              from: UNCODED.start,
              to: UNCODED.end,
              action: 'coded',
              before: [],
              after: [
                {
                  from: UNCODED.start,
                  to: UNCODED.end,
                  reason: 'SETUP',
                  comment: 'earlier',
                  codedBy: 'Mehmet',
                  codedAt: '2026-10-16T07:00:00.000Z',
                },
              ],
              actor: 'Mehmet',
              authenticated: false,
              at: '2026-10-16T07:00:00.000Z',
              requestId: 'r1',
              version: 3,
            },
          ],
        }),
      );
    }
    const handler = routes[url.pathname];
    return Promise.resolve(
      handler ? handler() : problem(404, 'Not Found', 'unknown', url.pathname),
    );
  };
  return { calls, fetch };
}

/** An in-memory Storage: Node's own `localStorage` global (without a file) shadows jsdom's. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openRecord() {
  const row = await screen.findByTestId(`downtime-row-${UNCODED.id}`);
  fireEvent.click(within(row).getByRole('button', { name: /^Code / }));
  return screen.findByTestId('coding-panel');
}

describe('downtime coding', () => {
  it('lists uncoded records first and codes a split with a reason and a comment', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const saved = {
      ...UNCODED,
      uncoded: true,
      reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
      version: 4,
      codings: [
        {
          from: UNCODED.start,
          to: '2026-10-15T04:04:00.000Z',
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          comment: 'bearing noise',
          codedBy: 'Ayşe K.',
          codedAt: '2026-10-16T08:00:00.000Z',
          version: 4,
        },
      ],
    };
    const server = mes(
      () => json({ record: saved, version: 4 }),
      () => [UNCODED, CODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');

    const rows = await screen.findAllByTestId(/^downtime-row-/);
    expect(rows.map((row) => row.dataset.uncoded)).toEqual(['true', 'false']);
    expect(rows[1]?.textContent).toContain('Tool change');
    expect(screen.getByTestId('downtime-summary').textContent).toContain('1 with uncoded time');

    const panel = await openRecord();
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toContain('Down');
    // The history from the audit.
    expect((await within(panel).findByTestId('audit-entry')).textContent).toContain('Mehmet');

    fireEvent.change(within(panel).getByTestId('split-at'), { target: { value: '07:04:00' } });
    fireEvent.click(within(panel).getByTestId('split'));
    const pickers = within(panel).getAllByTestId('reason-picker');
    expect(pickers).toHaveLength(2);
    const first = within(within(panel).getByTestId('segment-0'));
    const optionTexts = first
      .getAllByRole('option')
      .map((option) => [option.textContent, (option as HTMLOptionElement).disabled]);
    expect(optionTexts).toContainEqual(['  Spindle overload', false]);
    expect(optionTexts).toContainEqual(['Not coded (not codable)', true]);
    fireEvent.change(first.getByTestId('reason-picker'), {
      target: { value: 'BREAKDOWN/SPINDLE-OVERLOAD' },
    });
    fireEvent.change(first.getByTestId('segment-comment'), {
      target: { value: 'bearing noise' },
    });
    const codedBy = within(panel).getByTestId<HTMLInputElement>('coded-by');
    expect(codedBy.value).toBe('Ayşe');
    fireEvent.change(codedBy, { target: { value: 'Ayşe K.' } });
    fireEvent.click(within(panel).getByTestId('save-coding'));

    const message = await within(panel).findByTestId('coding-message');
    expect(message.dataset.kind).toBe('saved');
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe(`/api/v1/downtime/${encodeURIComponent(UNCODED.id)}/coding`);
    expect(put?.body).toEqual({
      segments: [
        {
          from: '2026-10-15T04:00:00.000Z',
          to: '2026-10-15T04:04:00.000Z',
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          comment: 'bearing noise',
        },
      ],
      codedBy: 'Ayşe K.',
      version: 3,
    });
    expect(localStorage.getItem('shopfloor.codedBy')).toBe('Ayşe K.');
    // The saved record is shown, and the history read again.
    await waitFor(() => {
      expect(screen.getByTestId(`downtime-row-${UNCODED.id}`).dataset.reason).toBe(
        'BREAKDOWN/SPINDLE-OVERLOAD',
      );
    });
    expect(
      server.calls.filter((call) => call.path.endsWith('/audit')).length,
    ).toBeGreaterThanOrEqual(2);
    // The machine's other records carry the old version now: the list is read again.
    await waitFor(() => {
      expect(server.calls.filter((call) => call.path.startsWith('/api/v1/downtime?')).length).toBe(
        2,
      );
    });
  });

  it('refuses an incomplete form without writing', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    fireEvent.click(within(panel).getByTestId('save-coding'));
    expect(within(panel).getByTestId('coding-errors').textContent).toContain('Coded by');
    fireEvent.change(within(panel).getByTestId('split-at'), { target: { value: '09:00' } });
    fireEvent.click(within(panel).getByTestId('split'));
    expect(within(panel).getByText(/inside the record/)).toBeTruthy();
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('on 409 reads the records again and says the codings changed', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    let version = 3;
    const server = mes(
      () => problem(409, 'Conflict', 'version 3 is not the current 5', '/api/v1/downtime/x/coding'),
      () => [{ ...UNCODED, version }],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    version = 5;
    const listReads = () =>
      server.calls.filter((call) => call.path.startsWith('/api/v1/downtime?')).length;
    const before = listReads();
    fireEvent.click(within(panel).getByTestId('save-coding'));
    const message = await within(panel).findByTestId('coding-message');
    expect(message.dataset.kind).toBe('conflict');
    expect(message.getAttribute('role')).toBe('alert');
    await waitFor(() => {
      expect(listReads()).toBeGreaterThan(before);
    });
    // The draft was reset to what the MES holds now; a second save sends the new version.
    await waitFor(() => {
      expect(within(panel).getByTestId<HTMLSelectElement>('reason-picker').value).toBe('');
    });
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    fireEvent.click(within(panel).getByTestId('save-coding'));
    await waitFor(() => {
      expect(server.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toMatchObject({
        version: 5,
      });
    });
  });

  it.each([
    [403, 'Forbidden', 'a write needs an Origin header', /Open the app through its own address/],
    [415, 'Unsupported Media Type', 'Content-Type is not application/json', /only JSON/],
    [422, 'Unprocessable Entity', 'segment outside the record', /segment outside the record/],
    [429, 'Too Many Requests', 'write rate limit', /too many writes/],
  ])('explains a %i from the MES', async (status, title, detail, expected) => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const server = mes(
      () => problem(status, title, detail, '/api/v1/downtime/x/coding'),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    fireEvent.click(within(panel).getByTestId('save-coding'));
    const message = await within(panel).findByTestId('coding-message');
    expect(message.textContent).toMatch(expected);
  });

  it('never sends a stale draft after someone else recoded the record mid-edit', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const server = mes(
      () => json({ record: { ...UNCODED, version: 6 }, version: 6 }),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/downtime');
    await app.open();
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });

    // A write to another record of the machine only moves the version: adopted silently.
    await app.push({ type: 'downtime', event: 'updated', record: { ...UNCODED, version: 4 } });
    expect(within(panel).queryByTestId('draft-conflict')).toBeNull();

    // B codes this record meanwhile: A's draft is stale.
    const byB = {
      ...UNCODED,
      version: 5,
      uncoded: false,
      reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
      codings: [
        {
          from: UNCODED.start,
          to: UNCODED.end ?? UNCODED.start,
          reason: 'BREAKDOWN/SPINDLE-OVERLOAD',
          comment: '',
          codedBy: 'B',
          codedAt: '2026-10-16T08:00:00.000Z',
          version: 5,
        },
      ],
    };
    await app.push({ type: 'downtime', event: 'recoded', record: byB });
    const conflict = within(panel).getByTestId('draft-conflict');
    expect(conflict.dataset.kind).toBe('conflict');
    fireEvent.click(within(panel).getByTestId('save-coding'));
    expect(within(panel).getByTestId('coding-errors').textContent).toContain('Reload the draft');
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false);

    // Reloading starts from B's coding; a save then sends B's version.
    fireEvent.click(within(conflict).getByTestId('reload-draft'));
    expect(within(panel).queryByTestId('draft-conflict')).toBeNull();
    expect(within(panel).getByTestId<HTMLSelectElement>('reason-picker').value).toBe(
      'BREAKDOWN/SPINDLE-OVERLOAD',
    );
    fireEvent.click(within(panel).getByTestId('save-coding'));
    await waitFor(() => {
      expect(server.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        version: 5,
        segments: [{ reason: 'BREAKDOWN/SPINDLE-OVERLOAD' }],
      });
    });
  });

  it('adopts a moved version for an unchanged record and sends it', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const server = mes(
      () => json({ record: { ...UNCODED, version: 9 }, version: 9 }),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/downtime');
    await app.open();
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    await app.push({ type: 'downtime', event: 'updated', record: { ...UNCODED, version: 8 } });
    fireEvent.click(within(panel).getByTestId('save-coding'));
    await waitFor(() => {
      expect(server.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
        version: 8,
      });
    });
  });

  it('closes with Escape or Close and returns focus to the row', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED, CODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    fireEvent.keyDown(within(panel).getByTestId('coded-by'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('coding-panel')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`code-${UNCODED.id}`));
    });

    fireEvent.click(screen.getByTestId(`code-${CODED.id}`));
    fireEvent.click(await screen.findByTestId('close-coding'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`code-${CODED.id}`));
    });
    fireEvent.change(screen.getByTestId('machine-filter'), { target: { value: 'wsh-01' } });
    expect(screen.queryByTestId(`downtime-row-${UNCODED.id}`)).toBeNull();
  });

  it('applies pushed records: new ones join, recoded ones change, removed ones go', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED, CODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/downtime?uncoded=true');
    await app.open();
    await screen.findByTestId(`downtime-row-${UNCODED.id}`);
    expect(server.calls.some((call) => call.path.includes('uncoded=true'))).toBe(true);
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toContain('downtime');
    });

    const created = record({
      id: 'cnc-01~1790000000~2',
      start: '2026-10-15T05:00:00.000Z',
      end: null,
    });
    await app.push({ type: 'downtime', event: 'created', record: created });
    expect(screen.getByTestId(`downtime-row-${created.id}`).textContent).toContain('(open)');

    // Coded by someone else: with "only uncoded" it leaves the list.
    await app.push({
      type: 'downtime',
      event: 'recoded',
      record: { ...UNCODED, uncoded: false, reason: 'SETUP', version: 4 },
    });
    expect(screen.queryByTestId(`downtime-row-${UNCODED.id}`)).toBeNull();

    await app.push({ type: 'downtime', event: 'removed', record: created });
    expect(screen.queryByTestId(`downtime-row-${created.id}`)).toBeNull();
    expect(screen.getByText('No uncoded downtime in this shift.')).toBeTruthy();
  });
});
