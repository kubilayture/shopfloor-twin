import type { AlarmOccurrenceDto, AlarmPointDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACK,
  SCOPES,
  episode,
  hourKpi,
  kpiBucket,
  occurrence,
  point,
  shelf,
} from '../test/alarm-fixtures.ts';
import { EQUIPMENT, PLANT, json, problem } from '../test/fixtures.ts';
import { requestBody, requestUrl } from '../test/oee-fixtures.ts';
import { renderApp } from '../test/render-app.tsx';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type Post = (path: string, body: unknown) => Response;

interface State {
  active: AlarmOccurrenceDto[];
  acknowledged: AlarmOccurrenceDto[];
  shelved: AlarmOccurrenceDto[];
  history: AlarmOccurrenceDto[];
  points: AlarmPointDto[];
}

/** The MES as the alarm screen sees it; `post` answers every write. */
function mes(state: State, post: Post = () => json({})) {
  const calls: Call[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    calls.push({ method, path: url.pathname + url.search, body });
    if (method === 'POST') return Promise.resolve(post(url.pathname, body));
    const path = url.pathname;
    if (path === '/api/v1/equipment') return Promise.resolve(json({ equipment: EQUIPMENT }));
    if (path === '/api/v1/plant') return Promise.resolve(json(PLANT));
    if (path === '/api/v1/alarms/scopes') return Promise.resolve(json(SCOPES));
    if (path === '/api/v1/alarm-points') return Promise.resolve(json({ points: state.points }));
    if (path === '/api/v1/alarms') {
      const view = (url.searchParams.get('view') ?? 'active') as keyof State;
      return Promise.resolve(
        json({
          view,
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          next: null,
          alarms: state[view],
        }),
      );
    }
    const history = /^\/api\/v1\/alarms\/([^/]+)\/history$/.exec(path);
    if (history) {
      return Promise.resolve(
        json({
          id: decodeURIComponent(history[1] ?? ''),
          entries: [
            {
              source: 'fact',
              transition: 'raised',
              at: '2026-10-15T05:00:01.000Z',
              seq: 1,
              receivedAt: '2026-10-15T05:00:01.050Z',
              protocol: 'opcua',
              actor: null,
              authenticated: null,
              recordedAt: null,
              requestId: null,
              auditId: null,
              detail: null,
            },
            {
              source: 'audit',
              transition: 'comment',
              at: '2026-10-15T05:01:00.000Z',
              seq: null,
              receivedAt: null,
              protocol: null,
              actor: 'Mehmet',
              authenticated: false,
              recordedAt: '2026-10-16T08:00:00.000Z',
              requestId: 'req-1',
              auditId: 7,
              detail: { text: 'checking the pump' },
            },
          ],
        }),
      );
    }
    const detail = /^\/api\/v1\/alarms\/([^/]+)$/.exec(path);
    if (detail) {
      const id = decodeURIComponent(detail[1] ?? '');
      const found = [
        ...state.active,
        ...state.acknowledged,
        ...state.shelved,
        ...state.history,
      ].find((item) => item.id === id);
      if (!found) return Promise.resolve(problem(404, 'Not Found', `no occurrence ${id}`, path));
      const pointNow = state.points.find(
        (candidate) => candidate.equipment === found.equipment && candidate.code === found.code,
      );
      return Promise.resolve(
        json({
          occurrence: found,
          definition: {
            text: 'Coolant pressure low',
            consequence: 'Tool wear',
            response: 'Check the pump',
          },
          shelf: pointNow?.shelf ?? shelf(),
          comments: [
            {
              id: 7,
              text: 'checking the pump',
              actor: 'Mehmet',
              authenticated: false,
              at: '2026-10-16T08:00:00.000Z',
              plantAt: '2026-10-15T05:01:00.000Z',
              requestId: 'req-1',
            },
          ],
        }),
      );
    }
    return Promise.resolve(problem(404, 'Not Found', 'unknown', path));
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

const empty = (): State => ({ active: [], acknowledged: [], shelved: [], history: [], points: [] });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rowIds = () =>
  screen
    .queryAllByTestId(/^alarm-row-/)
    .map((row) => row.dataset.testid?.slice('alarm-row-'.length));

describe('alarm list', () => {
  it('shows the active alarms with priority as text and merges pushed upserts by id', async () => {
    const first = occurrence(1, { priority: 'high', code: 'SPINDLE-OVERLOAD' });
    const server = mes({ ...empty(), active: [first] });
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms');
    await app.open();
    const row = await screen.findByTestId(`alarm-row-${first.id}`);
    expect(row.dataset.priority).toBe('high');
    expect(row.textContent).toContain('High');
    expect(row.textContent).toContain('Active, unacknowledged');
    expect(screen.getByTestId('tab-active').getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(app.factory.last.sent.map((message) => message.topic)).toEqual(
        expect.arrayContaining([
          'alarms',
          'alarm-kpi:position:cell-m1',
          'alarm-kpi:position:line-a1',
        ]),
      );
    });

    // A raise joins the active list, newest first.
    const second = occurrence(2);
    await app.push({ type: 'alarm', event: 'raised', occurrence: second });
    expect(rowIds()).toEqual([second.id, first.id]);
    expect(screen.getByTestId('tab-active').dataset.count).toBe('2');

    // A clear does not acknowledge: it stays in the active list.
    const cleared = occurrence(2, {
      state: 'unacked-cleared',
      endedAt: '2026-10-15T05:10:00.000Z',
      endReason: 'cleared',
      active: false,
    });
    await app.push({ type: 'alarm', event: 'cleared', occurrence: cleared });
    expect(screen.getByTestId(`alarm-row-${second.id}`).dataset.state).toBe('unacked-cleared');

    // Acknowledged elsewhere: it moves to the acknowledged list; an older copy can't move it back.
    const acked = { ...first, state: 'acked-active' as const, acknowledged: ACK };
    await app.push({ type: 'alarm', event: 'acknowledged', occurrence: acked });
    expect(rowIds()).toEqual([second.id]);
    await app.push({ type: 'alarm', event: 'updated', occurrence: first });
    expect(rowIds()).toEqual([second.id]);
    fireEvent.click(screen.getByTestId('tab-acknowledged'));
    await waitFor(() => {
      expect(rowIds()).toEqual([first.id]);
    });

    // Shelving a point moves its alarms to the shelved list (the point's version decides).
    await app.push({
      type: 'alarm-point',
      event: 'shelved',
      point: point({ code: 'SPINDLE-OVERLOAD', shelf: shelf({ shelved: true, version: 1 }) }),
    });
    expect(rowIds()).toEqual([]);
    fireEvent.click(screen.getByTestId('tab-shelved'));
    await waitFor(() => {
      expect(rowIds()).toEqual([first.id]);
    });
    expect(screen.getByTestId('tab-active').dataset.count).toBe('1');
  });

  it('moves between tabs with the arrow keys and reads the history of the last day', async () => {
    const closed = occurrence(3, {
      state: 'closed',
      endedAt: '2026-10-15T05:30:00.000Z',
      endReason: 'cleared',
      active: false,
      acknowledged: ACK,
    });
    const server = mes({ ...empty(), history: [closed] });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    expect(await screen.findByTestId('alarm-list-empty')).toBeTruthy();
    const active = screen.getByTestId('tab-active');
    active.focus();
    fireEvent.keyDown(active, { key: 'End' });
    await waitFor(() => {
      expect(screen.getByTestId('tab-history').getAttribute('aria-selected')).toBe('true');
    });
    expect(document.activeElement).toBe(screen.getByTestId('tab-history'));
    await screen.findByTestId(`alarm-row-${closed.id}`);
    const read = server.calls.find((call) => call.path.includes('view=history'));
    expect(read?.path).toContain('from=2026-10-14T07%3A00%3A00.000Z');
    expect(read?.path).toContain('to=2026-10-15T07%3A00%3A00.000Z');
    // A closed alarm offers no acknowledgement.
    expect(screen.queryByTestId(`ack-${closed.id}`)).toBeNull();
    fireEvent.keyDown(screen.getByTestId('tab-history'), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(screen.getByTestId('tab-active').getAttribute('aria-selected')).toBe('true');
    });
    fireEvent.keyDown(screen.getByTestId('tab-active'), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByTestId('tab-history').getAttribute('aria-selected')).toBe('true');
    });
  });

  it('acknowledges the selected alarms in one bulk request', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const a = occurrence(1);
    const b = occurrence(2);
    const c = occurrence(3, { state: 'unacked-cleared', endedAt: '2026-10-15T05:10:00.000Z' });
    const server = mes({ ...empty(), active: [a, b, c] }, (path) =>
      path === '/api/v1/alarms/ack'
        ? json({
            results: [
              { id: a.id, changed: true },
              { id: c.id, changed: false },
            ],
            acknowledged: 1,
          })
        : json({}),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId(`alarm-row-${a.id}`);
    expect(screen.getByTestId<HTMLButtonElement>('ack-selected').disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`select-${a.id}`));
    fireEvent.click(screen.getByTestId(`select-${c.id}`));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(2)');
    expect(screen.getByTestId<HTMLInputElement>('select-all').indeterminate).toBe(true);
    fireEvent.click(screen.getByTestId('ack-selected'));
    const message = await screen.findByTestId('alarm-list-message');
    expect(message.dataset.kind).toBe('saved');
    expect(message.textContent).toBe('Acknowledged 1 (1 already acknowledged).');
    const post = server.calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/api/v1/alarms/ack');
    expect(post?.body).toEqual({ ids: [c.id, a.id], actor: 'Ayşe' });
    // The selection is cleared, and select all picks every alarm that can be acknowledged.
    expect(screen.getByTestId<HTMLInputElement>(`select-${a.id}`).checked).toBe(false);
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(3)');
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(0)');
  });

  it('asks for the operator name before any write and remembers it', async () => {
    const a = occurrence(1);
    const server = mes({ ...empty(), active: [a] }, () =>
      json({ occurrence: { ...a, state: 'acked-active', acknowledged: ACK }, changed: true }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`ack-${a.id}`));
    const message = screen.getByTestId('alarm-list-message');
    expect(message.dataset.kind).toBe('invalid');
    expect(document.activeElement).toBe(screen.getByTestId('operator-name'));
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);

    fireEvent.change(screen.getByTestId('operator-name'), { target: { value: ' Ali ' } });
    fireEvent.click(screen.getByTestId(`ack-${a.id}`));
    await waitFor(() => {
      expect(screen.getByTestId('alarm-list-message').dataset.kind).toBe('saved');
    });
    expect(server.calls.find((call) => call.method === 'POST')?.body).toEqual({ actor: 'Ali' });
    expect(localStorage.getItem('shopfloor.codedBy')).toBe('Ali');
    // The answer is applied at once: the alarm moves to the acknowledged list.
    await waitFor(() => {
      expect(screen.queryByTestId(`alarm-row-${a.id}`)).toBeNull();
    });
  });

  it.each([
    [403, 'Forbidden', 'a write needs an Origin header', /Open the app through its own address/],
    [405, 'Method Not Allowed', 'writes are off', /writes are turned off/],
    [415, 'Unsupported Media Type', 'Content-Type is not application/json', /only JSON/],
    [422, 'Unprocessable Entity', 'not applicable', /cannot apply this acknowledgement/],
    [429, 'Too Many Requests', 'write rate limit', /too many writes/],
  ])('explains a %i on acknowledge', async (status, title, detail, expected) => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const a = occurrence(1);
    const server = mes({ ...empty(), active: [a] }, () =>
      problem(status, title, detail, '/api/v1/alarms/x/ack'),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`ack-${a.id}`));
    const message = await screen.findByTestId('alarm-list-message');
    expect(message.getAttribute('role')).toBe('alert');
    expect(message.textContent).toMatch(expected);
    expect(message.textContent).toMatch(/^Not acknowledged/);
  });

  it('says when a list cannot be read', async () => {
    const server = mes(empty());
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(requestUrl(input), 'http://localhost').pathname === '/api/v1/alarms'
        ? Promise.resolve(problem(503, 'Service Unavailable', 'database down', '/api/v1/alarms'))
        : server.fetch(input, init),
    );
    await renderApp('/alarms');
    const alerts = await screen.findAllByText(/Could not load the active alarms/);
    expect(alerts).toHaveLength(1);
    expect(screen.getAllByText(/database down/).length).toBeGreaterThan(0);
  });

  it('shows a flood banner per position while an episode is open', async () => {
    const server = mes(empty());
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId('alarm-list-empty');
    expect(screen.queryByTestId('flood-banner-cell-m1')).toBeNull();
    await app.push({
      type: 'snapshot',
      topic: 'alarm-kpi:position:cell-m1',
      hour: hourKpi('2026-10-15T05:00:00.000Z'),
      shift: kpiBucket(),
      floods: [episode({ raises: 13, peak: 13 })],
    });
    const banner = screen.getByTestId('flood-banner-cell-m1');
    expect(banner.dataset.episode).toBe(episode().id);
    expect(within(banner).getByRole('alert').textContent).toContain('Alarm flood in Cell M1');
    expect(banner.textContent).toContain('13 since the flood began');
    expect(screen.queryByTestId('flood-banner-line-a1')).toBeNull();
    await app.push({
      type: 'alarm-kpi',
      topic: 'alarm-kpi:position:cell-m1',
      hour: hourKpi('2026-10-15T05:00:00.000Z'),
      shift: kpiBucket(),
      floods: [],
    });
    expect(screen.queryByTestId('flood-banner-cell-m1')).toBeNull();
  });
});

describe('alarm panel', () => {
  it('shows the definition, comments and history, and acknowledges with a comment', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const a = occurrence(1, { comments: 1 });
    const server = mes({ ...empty(), active: [a], points: [point()] }, (path, body) =>
      path.endsWith('/comments')
        ? json({
            comment: {
              id: 8,
              text: (body as { text: string }).text,
              actor: 'Ayşe',
              authenticated: false,
              at: '2026-10-16T08:01:00.000Z',
              plantAt: null,
              requestId: 'req-2',
            },
            occurrence: { ...a, comments: 2 },
          })
        : json({
            occurrence: {
              ...a,
              comments: 2,
              state: 'acked-active',
              acknowledged: { ...ACK, comment: 'on it' },
            },
            changed: true,
          }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`details-${a.id}`));
    const panel = await screen.findByTestId('alarm-panel');
    expect(panel.dataset.alarm).toBe(a.id);
    await within(panel).findByText('Check the pump');
    expect((await within(panel).findByTestId('comment')).textContent).toContain(
      'checking the pump',
    );
    const entries = await within(panel).findAllByTestId('history-entry');
    expect(entries.map((entry) => entry.dataset.transition)).toEqual(['raised', 'comment']);
    expect(entries[0]?.textContent).toContain('seq 1');
    expect(entries[1]?.textContent).toContain('request req-1');

    fireEvent.change(within(panel).getByTestId('comment-text'), {
      target: { value: 'pump replaced' },
    });
    fireEvent.click(within(panel).getByTestId('add-comment'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Comment added.');
    });
    expect(server.calls.find((call) => call.path.endsWith('/comments'))?.body).toEqual({
      actor: 'Ayşe',
      text: 'pump replaced',
    });

    fireEvent.change(within(panel).getByTestId('ack-comment'), { target: { value: 'on it' } });
    fireEvent.click(within(panel).getByTestId('ack-detail'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Acknowledged.');
    });
    expect(server.calls.find((call) => call.path.endsWith('/ack'))?.body).toEqual({
      actor: 'Ayşe',
      comment: 'on it',
    });
    expect(within(panel).getByTestId('alarm-state').dataset.state).toBe('acked-active');
    expect(within(panel).queryByTestId('ack-detail')).toBeNull();

    // Escape closes it and focus returns to the row's Details button (in the acknowledged tab
    // now, so the heading takes it).
    fireEvent.keyDown(within(panel).getByTestId('comment-text'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-panel')).toBeNull();
    });
  });

  it('on 409 reads the shelf again and sends the new version next time', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const a = occurrence(1);
    const state = { ...empty(), active: [a], points: [point({ shelf: shelf({ version: 1 }) })] };
    let posts = 0;
    const server = mes(state, (_path, body) => {
      posts += 1;
      if (posts === 1) {
        // Someone shelved and unshelved it meanwhile: version 3 now.
        state.points = [point({ shelf: shelf({ version: 3 }) })];
        return problem(409, 'Conflict', 'version 1 is not the current 3', '/api/v1/alarm-points');
      }
      const request = body as { durationMs: number; reason: string; version: number };
      return json({
        point: point({
          shelf: shelf({
            shelved: true,
            version: request.version + 1,
            by: 'Ayşe',
            reason: request.reason,
            until: '2026-10-15T07:10:00.000Z',
            durationMs: request.durationMs,
          }),
        }),
      });
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`);
    const panel = await screen.findByTestId('alarm-panel');
    const section = await within(panel).findByTestId('shelf-section');
    await waitFor(() => {
      expect(within(section).getByTestId('shelf-state').dataset.version).toBe('1');
    });
    // No reason: nothing is sent.
    fireEvent.click(within(section).getByTestId('shelve'));
    expect(within(panel).getByTestId('alarm-message').textContent).toContain('reason');
    fireEvent.change(within(section).getByTestId('shelve-reason'), {
      target: { value: 'sensor fault' },
    });
    fireEvent.change(within(section).getByTestId('shelve-duration'), {
      target: { value: String(3_600_000) },
    });
    fireEvent.click(within(section).getByTestId('shelve'));
    const message = await within(panel).findByTestId('alarm-message');
    await waitFor(() => {
      expect(message.dataset.kind).toBe('conflict');
    });
    expect(message.textContent).toMatch(/^Not shelved: the point's shelf changed/);
    await waitFor(() => {
      expect(within(section).getByTestId('shelf-state').dataset.version).toBe('3');
    });
    expect(within(section).queryByTestId('shelf-conflict')).toBeNull();
    fireEvent.click(within(section).getByTestId('shelve'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').dataset.kind).toBe('saved');
    });
    const bodies = server.calls.filter((call) => call.method === 'POST').map((call) => call.body);
    expect(bodies).toEqual([
      { actor: 'Ayşe', reason: 'sensor fault', durationMs: 3_600_000, version: 1 },
      { actor: 'Ayşe', reason: 'sensor fault', durationMs: 3_600_000, version: 3 },
    ]);
    expect(server.calls.find((call) => call.method === 'POST')?.path).toBe(
      '/api/v1/alarm-points/cnc-01/COOLANT-PRESSURE/shelve',
    );
    // Shelved now: the alarm left the active list, and the panel offers to unshelve.
    await waitFor(() => {
      expect(within(section).getByTestId('shelf-state').dataset.shelved).toBe('true');
    });
    expect(screen.queryByTestId(`alarm-row-${a.id}`)).toBeNull();
  });

  it('never sends a shelve draft over a shelf that moved on, and unshelves', async () => {
    localStorage.setItem('shopfloor.codedBy', 'Ayşe');
    const a = occurrence(1);
    const state = { ...empty(), active: [a], points: [point({ shelf: shelf({ version: 1 }) })] };
    const server = mes(state, (path) =>
      path.endsWith('/unshelve')
        ? json({ point: point({ shelf: shelf({ version: 4 }) }) })
        : problem(500, 'Error', 'unexpected', path),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`);
    await app.open();
    const section = await screen.findByTestId('shelf-section');
    await waitFor(() => {
      expect(within(section).getByTestId('shelf-state').dataset.version).toBe('1');
    });
    fireEvent.change(within(section).getByTestId('shelve-reason'), { target: { value: 'x' } });
    // Someone else shelves it meanwhile (pushed).
    await app.push({
      type: 'alarm-point',
      event: 'shelved',
      point: point({ shelf: shelf({ shelved: true, version: 2, by: 'Mehmet', reason: 'test' }) }),
    });
    const conflict = within(section).getByTestId('shelf-conflict');
    expect(conflict.textContent).toContain('version 1 → 2');
    fireEvent.click(within(section).getByTestId('unshelve'));
    expect(screen.getByTestId('alarm-message').dataset.kind).toBe('conflict');
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(within(conflict).getByTestId('reload-shelf'));
    expect(within(section).queryByTestId('shelf-conflict')).toBeNull();
    expect(within(section).getByTestId('shelf-state').textContent).toContain('Mehmet');
    fireEvent.click(within(section).getByTestId('unshelve'));
    await waitFor(() => {
      expect(screen.getByTestId('alarm-message').textContent).toBe('Unshelved.');
    });
    expect(server.calls.find((call) => call.method === 'POST')?.body).toEqual({
      actor: 'Ayşe',
      version: 2,
    });
  });

  it('opens an occurrence outside the lists by its id, and says when there is none', async () => {
    const closed = occurrence(9, { state: 'closed', acknowledged: ACK, endedAt: ACK.plantAt });
    const server = mes({ ...empty(), history: [closed] });
    vi.stubGlobal('fetch', server.fetch);
    const view = await renderApp(`/alarms?alarm=${encodeURIComponent(closed.id)}`);
    const panel = await screen.findByTestId('alarm-panel');
    expect(panel.dataset.alarm).toBe(closed.id);
    expect(within(panel).getByTestId('alarm-state').textContent).toContain('Closed');
    fireEvent.click(within(panel).getByTestId('close-alarm'));
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-panel')).toBeNull();
    });
    view.unmount();

    await renderApp(`/alarms?alarm=${encodeURIComponent(occurrence(10).id)}`);
    expect(await screen.findByText(/Could not load the alarm\./)).toBeTruthy();
    expect(screen.queryByTestId('alarm-panel')).toBeNull();
  });
});
