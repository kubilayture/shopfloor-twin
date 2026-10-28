import type { AlarmConfig, AlarmOccurrenceDto, AlarmPointDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACK,
  SCOPES,
  alarmConfig,
  episode,
  hourKpi,
  kpiBucket,
  occurrence,
  point,
  shelf,
} from '../test/alarm-fixtures.ts';
import { EQUIPMENT, PLANT, json, problem, sessionOf } from '../test/fixtures.ts';
import { network, resetNetwork } from '../test/network.ts';
import { requestBody, requestUrl } from '../test/oee-fixtures.ts';
import { renderApp, settle } from '../test/render-app.tsx';

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
  /** `GET /alarms/config` (#160); default alarms.yaml's. */
  config?: AlarmConfig;
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
    if (path === '/api/v1/alarms/config') {
      return Promise.resolve(json(state.config ?? alarmConfig()));
    }
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

const empty = (): State => ({ active: [], acknowledged: [], shelved: [], history: [], points: [] });

afterEach(() => {
  vi.unstubAllGlobals();
  resetNetwork();
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

    // A raise joins the active list in priority order (#371): the newer medium one goes below the
    // high one.
    const second = occurrence(2);
    await app.push({ type: 'alarm', event: 'raised', occurrence: second });
    expect(rowIds()).toEqual([first.id, second.id]);
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

  it("dates a raise that is not on the plant clock's day, in the list and the history (A-01)", async () => {
    // The plant clock reads Thu 15 Oct, 09:10 (fixtures PLANT).
    const today = occurrence(1);
    const old = occurrence(2, {
      code: 'SPINDLE-OVERLOAD',
      raisedAt: '2026-10-12T04:15:00.000Z',
    });
    const closed = occurrence(3, {
      state: 'closed',
      raisedAt: '2026-10-14T20:59:59.000Z',
      endedAt: '2026-10-14T21:30:00.000Z',
      endReason: 'cleared',
      active: false,
      acknowledged: ACK,
    });
    // Half past plant midnight: still the 14th in UTC, already the clock's day (the 15th) in plant.
    const afterMidnight = occurrence(4, {
      state: 'closed',
      raisedAt: '2026-10-14T21:30:00.000Z',
      endedAt: '2026-10-14T21:40:00.000Z',
      endReason: 'cleared',
      active: false,
      acknowledged: ACK,
    });
    const server = mes({
      ...empty(),
      active: [today, old],
      history: [afterMidnight, closed],
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    const raised = (id: string) => {
      const time = screen.getByTestId(`alarm-row-${id}`).querySelector('time');
      return {
        text: time?.textContent,
        dateTime: time?.getAttribute('dateTime'),
        title: time?.getAttribute('title'),
      };
    };
    await screen.findByTestId(`alarm-row-${old.id}`);
    await waitFor(() => {
      expect(raised(today.id).text).toBe('08:00:01');
    });
    // Same plant day: the time only, the full plant date-time in the tooltip.
    expect(raised(today.id)).toEqual({
      text: '08:00:01',
      dateTime: today.raisedAt,
      title: 'Thu 15 Oct, 08:00:01',
    });
    expect(raised(old.id)).toEqual({
      text: 'Mon 12 Oct, 07:15:00',
      dateTime: '2026-10-12T04:15:00.000Z',
      title: 'Mon 12 Oct, 07:15:00',
    });
    expect(screen.getByRole('columnheader', { name: 'Raised' })).toBeTruthy();

    // In the history: a second before plant midnight is the day before; half an hour after it is
    // the plant clock's day, although its UTC date is still the 14th.
    fireEvent.click(screen.getByTestId('tab-history'));
    await screen.findByTestId(`alarm-row-${closed.id}`);
    expect(raised(closed.id).text).toBe('Wed 14 Oct, 23:59:59');
    expect(raised(afterMidnight.id)).toEqual({
      text: '00:30:00',
      dateTime: '2026-10-14T21:30:00.000Z',
      title: 'Thu 15 Oct, 00:30:00',
    });
  });

  it('acknowledges the selected alarms in one bulk request', async () => {
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
    expect(screen.getByTestId('ack-selected').getAttribute('aria-disabled')).toBe('true');
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
    // In the rows' order: the active one before the cleared one of the same priority (#371).
    expect(post?.body).toEqual({ ids: [a.id, c.id] });
    // The selection is cleared, and select all picks every alarm that can be acknowledged.
    expect(screen.getByTestId<HTMLInputElement>(`select-${a.id}`).checked).toBe(false);
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(3)');
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(0)');
  });

  it("acknowledges as the session's user, with no name to type", async () => {
    const a = occurrence(1);
    const server = mes({ ...empty(), active: [a] }, () =>
      json({ occurrence: { ...a, state: 'acked-active', acknowledged: ACK }, changed: true }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`ack-${a.id}`));
    expect(screen.queryByTestId('operator-name')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('alarm-list-message').dataset.kind).toBe('saved');
    });
    expect(server.calls.find((call) => call.method === 'POST')?.body).toEqual({});
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

  it('says when a list cannot be read, with no bulk action over the failed list', async () => {
    const server = mes(empty());
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(requestUrl(input), 'http://localhost').pathname === '/api/v1/alarms'
        ? Promise.resolve(problem(503, 'Service Unavailable', 'database down', '/api/v1/alarms'))
        : server.fetch(input, init),
    );
    await renderApp('/alarms');
    const alerts = await screen.findAllByText(/Could not load the active alarms/);
    expect(alerts).toHaveLength(1);
    // One error for the three failed lists (#394), in the tab panel, not one per tab count.
    const alert = screen.getByRole('alert');
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    expect(alert.textContent).toContain(
      'Could not load the active alarms, the acknowledged alarms and the shelved alarms.',
    );
    expect(within(screen.getByTestId('alarm-list')).getByRole('alert')).toBe(alert);
    expect(screen.getAllByText(/database down/)).toHaveLength(1);
    expect(screen.queryByTestId('ack-selected')).toBeNull();
  });

  it('says the other tabs’ failed lists in one error above the tabs, the shown one in its panel (#394)', async () => {
    const server = mes(empty());
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input), 'http://localhost');
      return url.pathname === '/api/v1/alarms' && url.searchParams.get('view') !== 'active'
        ? Promise.resolve(problem(503, 'Service Unavailable', 'database down', '/api/v1/alarms'))
        : server.fetch(input, init);
    });
    await renderApp('/alarms');
    await screen.findByTestId('alarm-list-empty');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Could not load the acknowledged alarms and the shelved alarms.',
    );
    expect(screen.getAllByRole('alert')).toEqual([alert]);
    expect(within(screen.getByTestId('alarm-list')).queryByRole('alert')).toBeNull();
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
    await waitFor(() => {
      expect(screen.getByTestId('flood-text-cell-m1').textContent).toContain(
        'Up to 13 raises in 10 min (more than 10 is a flood)',
      );
    });
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
    const comment = await within(panel).findByTestId('comment');
    expect(comment.textContent).toContain('checking the pump');
    // A legacy comment typed before login says so.
    expect(comment.textContent).toContain('Mehmet (not authenticated)');
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
      text: 'pump replaced',
    });

    fireEvent.change(within(panel).getByTestId('ack-comment'), { target: { value: 'on it' } });
    fireEvent.click(within(panel).getByTestId('ack-detail'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Acknowledged.');
    });
    expect(server.calls.find((call) => call.path.endsWith('/ack'))?.body).toEqual({
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

  it('fails a comment sent offline at once, keeps the draft and never sends it by itself (#312)', async () => {
    const a = occurrence(1);
    const server = mes({ ...empty(), active: [a], points: [point()] }, (_path, body) =>
      json({
        comment: {
          id: 8,
          text: (body as { text: string }).text,
          actor: 'Ayşe',
          authenticated: true,
          at: '2026-10-16T08:01:00.000Z',
          plantAt: null,
          requestId: 'req-2',
        },
        occurrence: { ...a, comments: 1 },
      }),
    );
    const net = network(server.fetch);
    vi.stubGlobal('fetch', net.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`details-${a.id}`));
    const panel = await screen.findByTestId('alarm-panel');
    await within(panel).findAllByTestId('history-entry');

    await net.cut();
    const text = within(panel).getByTestId<HTMLTextAreaElement>('comment-text');
    fireEvent.change(text, { target: { value: 'pump replaced' } });
    fireEvent.click(within(panel).getByTestId('add-comment'));
    // Where a refused write shows, at once: not queued until the network returns.
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe(
        'Comment not saved: the MES cannot be reached.',
      );
    });
    expect(net.calls.filter((call) => call.method === 'POST')).toEqual([
      { method: 'POST', up: false },
    ]);
    expect(text.value).toBe('pump replaced');
    expect(within(panel).getByTestId<HTMLButtonElement>('add-comment').disabled).toBe(false);

    // Back online: nothing is sent again by itself; the person sends the kept draft.
    await net.restore();
    await settle(() => undefined);
    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(text.value).toBe('pump replaced');
    fireEvent.click(within(panel).getByTestId('add-comment'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Comment added.');
    });
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('on 409 reads the shelf again and sends the new version next time', async () => {
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
      { reason: 'sensor fault', durationMs: 3_600_000, version: 1 },
      { reason: 'sensor fault', durationMs: 3_600_000, version: 3 },
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

  it('caps the shelving presets at the served maxShelveMs (#160)', async () => {
    const a = occurrence(1);
    const server = mes({
      ...empty(),
      active: [a],
      points: [point({ shelf: shelf({ version: 1 }) })],
      config: alarmConfig({ maxShelveMs: 2 * 3_600_000 }),
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`);
    const section = await screen.findByTestId('shelf-section');
    await waitFor(() => {
      const select = within(section).getByTestId<HTMLSelectElement>('shelve-duration');
      expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
        ['900000', '15 min'],
        ['3600000', '1 h'],
        ['7200000', '2 h'],
      ]);
    });
  });

  it('explains a flood with the served threshold and window (#160)', async () => {
    const server = mes({
      ...empty(),
      config: alarmConfig({ kpi: { floodThreshold: 8, windowMs: 300_000 } }),
    });
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId('alarm-list-empty');
    await app.push({
      type: 'snapshot',
      topic: 'alarm-kpi:position:cell-m1',
      hour: hourKpi('2026-10-15T05:00:00.000Z'),
      shift: kpiBucket(),
      floods: [episode({ raises: 9, peak: 9 })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('flood-text-cell-m1').textContent).toContain(
        'Up to 9 raises in 5 min (more than 8 is a flood)',
      );
    });
  });

  it('never sends a shelve draft over a shelf that moved on, and unshelves', async () => {
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

  it('starts every draft afresh when another alarm is opened', async () => {
    const a = occurrence(1);
    const b = occurrence(2);
    const server = mes({ ...empty(), active: [a, b], points: [point()] });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`);
    const panel = await screen.findByTestId('alarm-panel');
    fireEvent.change(within(panel).getByTestId('comment-text'), { target: { value: 'for A' } });
    fireEvent.change(within(panel).getByTestId('ack-comment'), { target: { value: 'ack A' } });
    fireEvent.click(screen.getByTestId(`details-${b.id}`));
    await waitFor(() => {
      expect(screen.getByTestId('alarm-panel').dataset.alarm).toBe(b.id);
    });
    const next = screen.getByTestId('alarm-panel');
    expect(within(next).getByTestId<HTMLTextAreaElement>('comment-text').value).toBe('');
    expect(within(next).getByTestId<HTMLInputElement>('ack-comment').value).toBe('');
    expect(server.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('alarm list after leaving it', () => {
  it('drops pushed copies when the screen lets go, so changes made meanwhile show', async () => {
    const a = occurrence(1);
    const state = { ...empty(), active: [a] };
    const server = mes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId(`alarm-row-${a.id}`);
    const pushed = occurrence(2);
    await app.push({ type: 'alarm', event: 'raised', occurrence: pushed });
    expect(rowIds()).toEqual([pushed.id, a.id]);

    // Away from the list (the topic is released); both are acknowledged elsewhere meanwhile, and
    // no push arrives for them.
    fireEvent.click(screen.getByTestId('nav-overview'));
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-list')).toBeNull();
    });
    // Both cleared and were acknowledged elsewhere meanwhile: closed, so in History, which the
    // Active tab doesn't read; no push arrives for them.
    const close = (item: AlarmOccurrenceDto): AlarmOccurrenceDto => ({
      ...item,
      state: 'closed',
      active: false,
      endedAt: '2026-10-15T05:30:00.000Z',
      endReason: 'cleared',
      acknowledged: ACK,
    });
    state.active = [];
    state.history = [close(a), close(pushed)];
    fireEvent.click(screen.getByTestId('nav-alarms'));
    await waitFor(() => {
      expect(screen.getByTestId('tab-active').dataset.count).toBe('0');
    });
    expect(rowIds()).toEqual([]);
  });

  it('applies a pushed priority change and a late clear replacing a lost end', async () => {
    const lost = occurrence(1, {
      state: 'unacked-cleared',
      active: false,
      endedAt: '2026-10-15T05:30:00.000Z',
      endReason: 'lost',
    });
    const server = mes({ ...empty(), active: [lost] });
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/alarms?alarm=${encodeURIComponent(lost.id)}`);
    await app.open();
    const row = await screen.findByTestId(`alarm-row-${lost.id}`);
    expect(row.dataset.priority).toBe('medium');
    await app.push({ type: 'alarm', event: 'updated', occurrence: { ...lost, priority: 'high' } });
    expect(screen.getByTestId(`alarm-row-${lost.id}`).dataset.priority).toBe('high');
    const panel = screen.getByTestId('alarm-panel');
    expect(panel.textContent).toContain('clear lost');
    await app.push({
      type: 'alarm',
      event: 'updated',
      occurrence: {
        ...lost,
        priority: 'high',
        endedAt: '2026-10-15T05:20:00.000Z',
        endReason: 'cleared',
      },
    });
    expect(panel.textContent).toContain('cleared by the device');
  });

  it('clears the selection when the tab changes and offers no bulk action on Acknowledged', async () => {
    const a = occurrence(1);
    const server = mes({ ...empty(), active: [a] });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    fireEvent.click(await screen.findByTestId(`select-${a.id}`));
    expect(screen.getByTestId('ack-selected').textContent).toContain('(1)');
    fireEvent.click(screen.getByTestId('tab-acknowledged'));
    await waitFor(() => {
      expect(screen.getByTestId('alarm-list').dataset.view).toBe('acknowledged');
    });
    expect(screen.queryByTestId('ack-selected')).toBeNull();
    fireEvent.click(screen.getByTestId('tab-active'));
    await waitFor(() => {
      expect(screen.getByTestId('ack-selected').textContent).toContain('(0)');
    });
    expect(screen.getByTestId<HTMLInputElement>(`select-${a.id}`).checked).toBe(false);
  });
});

describe('alarm writes by role (#170)', () => {
  it('offers an admin no acknowledgement, comment or shelf action', async () => {
    const a = occurrence(1);
    const server = mes({
      ...empty(),
      active: [a],
      points: [point({ shelf: shelf({ version: 1 }) })],
    });
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`, {
      session: sessionOf(['admin']),
    });
    await screen.findByTestId(`alarm-row-${a.id}`);
    expect(screen.queryByTestId(`ack-${a.id}`)).toBeNull();
    expect(screen.queryByTestId(`select-${a.id}`)).toBeNull();
    expect(screen.queryByTestId('ack-selected')).toBeNull();
    const panel = await screen.findByTestId('alarm-panel');
    // The alarm, its comments and history stay visible.
    expect(await within(panel).findByTestId('comment')).toBeTruthy();
    expect((await within(panel).findAllByTestId('history-entry')).length).toBe(2);
    expect(within(panel).queryByTestId('ack-detail')).toBeNull();
    expect(within(panel).queryByTestId('ack-comment')).toBeNull();
    expect(within(panel).queryByTestId('comment-text')).toBeNull();
    expect(within(panel).queryByTestId('add-comment')).toBeNull();
    await waitFor(() => {
      expect(within(panel).getByTestId('shelf-state').dataset.shelved).toBe('false');
    });
    expect(within(panel).queryByTestId('shelve')).toBeNull();
    expect(within(panel).queryByTestId('shelve-reason')).toBeNull();
  });

  it('offers quality acknowledgement and comments but no shelving', async () => {
    const a = occurrence(1);
    const state = { ...empty(), active: [a], points: [point({ shelf: shelf({ version: 1 }) })] };
    const server = mes(state, (path, body) =>
      path.endsWith('/comments')
        ? json({
            comment: {
              id: 8,
              text: (body as { text: string }).text,
              actor: 'ayse',
              authenticated: true,
              at: '2026-10-16T08:01:00.000Z',
              plantAt: null,
              requestId: 'req-2',
            },
            occurrence: { ...a, comments: 2 },
          })
        : json({ occurrence: { ...a, state: 'acked-active', acknowledged: ACK }, changed: true }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`, {
      session: sessionOf(['quality']),
    });
    await app.open();
    await screen.findByTestId(`alarm-row-${a.id}`);
    expect(screen.getByTestId(`ack-${a.id}`)).toBeTruthy();
    expect(screen.getByTestId('ack-selected')).toBeTruthy();
    const panel = await screen.findByTestId('alarm-panel');
    expect(within(panel).getByTestId('ack-detail')).toBeTruthy();
    await waitFor(() => {
      expect(within(panel).getByTestId('shelf-state').dataset.shelved).toBe('false');
    });
    expect(within(panel).queryByTestId('shelve')).toBeNull();

    fireEvent.change(within(panel).getByTestId('comment-text'), { target: { value: 'seen' } });
    fireEvent.click(within(panel).getByTestId('add-comment'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Comment added.');
    });
    fireEvent.click(within(panel).getByTestId('ack-detail'));
    await waitFor(() => {
      expect(within(panel).getByTestId('alarm-message').textContent).toBe('Acknowledged.');
    });
    const posts = server.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.body)).toEqual([{ text: 'seen' }, {}]);
    for (const post of posts) expect(post.body).not.toHaveProperty('actor');

    // A shelf made by someone else is shown, but not offered to be lifted.
    await app.push({
      type: 'alarm-point',
      event: 'shelved',
      point: point({ shelf: shelf({ shelved: true, version: 2, by: 'mehmet', reason: 'test' }) }),
    });
    await waitFor(() => {
      expect(within(panel).getByTestId('shelf-state').textContent).toContain('mehmet');
    });
    expect(within(panel).queryByTestId('unshelve')).toBeNull();
  });
});

/**
 * `matchMedia` for a window `width` px wide: the shell's `xl` nav, the DataTable's `md` stack and
 * the detail's `wide` panel (design system 3.1) each answer by their own query.
 */
function stubWidth(width: number) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const min = /min-width:\s*([\d.]+)rem/.exec(query);
      const max = /max-width:\s*([\d.]+)rem/.exec(query);
      const px = (match: RegExpExecArray) => Number(match[1]) * 16;
      return {
        matches: min ? width >= px(min) : max ? width <= px(max) : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }),
  );
}

describe('the alarm list on the design system (UX-4a, #324)', () => {
  it('marks unacknowledged rows with their priority bar and bold text; acknowledged rows are plain (A-03)', async () => {
    const high = occurrence(1, { priority: 'high', code: 'SPINDLE-OVERLOAD', text: null });
    const medium = occurrence(2);
    const acked = occurrence(3, { state: 'acked-active', acknowledged: ACK, priority: 'high' });
    vi.stubGlobal(
      'fetch',
      mes({ ...empty(), active: [high, medium], acknowledged: [acked] }).fetch,
    );
    await renderApp('/alarms');
    const row = (id: string) => screen.getByTestId(`alarm-row-${id}`);
    const cell = (id: string, name: string) =>
      row(id).querySelector<HTMLElement>(`[data-cell="${name}"]`);
    await screen.findByTestId(`alarm-row-${medium.id}`);
    // The bar sits in the first cell (the checkbox's), in the priority's border colour.
    expect(cell(high.id, 'select')?.className).toContain('var(--color-alarm-border)');
    expect(cell(medium.id, 'select')?.className).toContain('var(--color-warn-border)');
    expect(cell(medium.id, 'c-alarm')?.className).toContain('font-semibold');
    expect(cell(medium.id, 'c-machine')?.className).toContain('font-semibold');
    // Names first: the alarm's text, its code after it; the row is named by it.
    expect(cell(medium.id, 'c-alarm')?.tagName).toBe('TH');
    expect(cell(medium.id, 'c-alarm')?.textContent).toBe('Coolant pressure lowCOOLANT-PRESSURE');
    expect(cell(high.id, 'c-alarm')?.textContent).toBe('SPINDLE-OVERLOAD');
    // The row actions side by side in one cell (A-02).
    expect(
      [...(cell(medium.id, 'actions')?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    ).toEqual(['Acknowledge', 'Details']);
    fireEvent.click(screen.getByTestId('tab-acknowledged'));
    await screen.findByTestId(`alarm-row-${acked.id}`);
    const plain = row(acked.id).querySelector<HTMLElement>('[data-cell="c-alarm"]');
    expect(plain?.className).not.toContain('font-semibold');
    expect(row(acked.id).innerHTML).not.toContain('border)]');
  });

  it('dates the flood banner unless the flood began on the plant clock day (UX-B2 rule)', async () => {
    vi.stubGlobal('fetch', mes(empty()).fetch);
    const app = await renderApp('/alarms');
    await app.open();
    await screen.findByTestId('alarm-list-empty');
    const flood = async (startAt: string) => {
      await app.push({
        type: 'alarm-kpi',
        topic: 'alarm-kpi:position:cell-m1',
        hour: hourKpi('2026-10-15T05:00:00.000Z'),
        shift: kpiBucket(),
        floods: [episode({ startAt })],
      });
      const time = within(screen.getByTestId('flood-banner-cell-m1'))
        .getByRole('alert')
        .querySelector('time');
      return [time?.textContent, time?.getAttribute('title'), time?.getAttribute('dateTime')];
    };
    // The plant clock reads Thu 15 Oct, 09:10: a flood since 08:00 that day shows the time only.
    await waitFor(async () => {
      expect(await flood('2026-10-15T05:00:00.000Z')).toEqual([
        '08:00:00',
        'Thu 15 Oct, 08:00:00',
        '2026-10-15T05:00:00.000Z',
      ]);
    });
    // One that began before plant midnight carries its date.
    expect(await flood('2026-10-14T20:00:00.000Z')).toEqual([
      'Wed 14 Oct, 23:00:00',
      'Wed 14 Oct, 23:00:00',
      '2026-10-14T20:00:00.000Z',
    ]);
  });

  it('moves the focus to the next row when an acknowledgement takes a row away, and says so', async () => {
    const a = occurrence(2);
    const b = occurrence(1);
    const server = mes({ ...empty(), active: [a, b] }, () =>
      json({ occurrence: { ...a, state: 'acked-active', acknowledged: ACK }, changed: true }),
    );
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await answered;
      return server.fetch(input, init);
    });
    await renderApp('/alarms');
    const button = await screen.findByTestId<HTMLButtonElement>(`ack-${a.id}`);
    button.focus();
    fireEvent.click(button);
    // On its way: busy, not disabled, so the focus stays on it; the other rows stay usable.
    await waitFor(() => {
      expect(button.getAttribute('aria-busy')).toBe('true');
    });
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(screen.getByTestId<HTMLButtonElement>(`ack-${b.id}`).hasAttribute('aria-busy')).toBe(
      false,
    );
    release();
    await waitFor(() => {
      expect(screen.queryByTestId(`alarm-row-${a.id}`)).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByTestId(`ack-${b.id}`));
    // Names first for a screen reader: the alarm's text, then the machine.
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Acknowledge Coolant pressure low, Machine cnc-01',
    );
    expect(screen.getByTestId(`details-${b.id}`).getAttribute('aria-label')).toBe(
      'Details of Coolant pressure low, Machine cnc-01',
    );
    expect(screen.getByTestId(`select-${b.id}`).getAttribute('aria-label')).toBe(
      'Select Coolant pressure low, Machine cnc-01',
    );
    expect(
      screen
        .getAllByRole('status')
        .some(
          (status) => status.textContent === 'The alarm left the Active list; 1 alarm remains.',
        ),
    ).toBe(true);
  });

  it('opens the detail as a sticky side panel from 1440 px, after a skip link, and focuses its title', async () => {
    stubWidth(1440);
    const a = occurrence(1);
    vi.stubGlobal('fetch', mes({ ...empty(), active: [a] }).fetch);
    await renderApp('/alarms');
    const details = await screen.findByTestId(`details-${a.id}`);
    // With nothing chosen the list has the width to itself, and there is nothing to skip to.
    expect(screen.queryByTestId('alarm-panel')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Skip to the details' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Machine' })).toBeTruthy();
    details.focus();
    fireEvent.click(details);
    const panel = await screen.findByTestId('alarm-panel');
    expect(panel.tagName).toBe('SECTION');
    expect(panel.dataset.variant).toBe('panel');
    expect(panel.className).toContain('sticky');
    const title = within(panel).getByRole('heading', { level: 2, name: 'Coolant pressure low' });
    expect(document.activeElement).toBe(title);
    expect(panel.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.nextElementSibling?.querySelector('code')?.textContent).toBe('COOLANT-PRESSURE');
    expect(screen.getByRole('link', { name: 'Skip to the details' }).getAttribute('href')).toBe(
      `#${title.id}`,
    );
    expect(screen.getByTestId(`alarm-row-${a.id}`).getAttribute('aria-current')).toBe('true');
    // The open unacknowledged row keeps its priority bar beside the accent fill.
    const open = screen.getByTestId(`alarm-row-${a.id}`);
    expect(open.className).toContain('bg-accent-subtle');
    expect(open.querySelector('[data-cell="select"]')?.className).toContain(
      'var(--color-warn-border)',
    );
    // The state keeps to the condition beside the panel; the acknowledgement is said.
    const state = open.querySelector<HTMLElement>('[data-cell="c-state"]');
    expect(state?.textContent).toBe('Active, unacknowledged');
    expect(state?.querySelector('.sr-only')?.textContent).toBe(', unacknowledged');
    // Beside the panel the machine joins the alarm's cell, so the actions stay in view.
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '',
      'Priority',
      'Alarm and machine',
      'Raised',
      'State',
      'Actions',
    ]);
    expect(
      screen.getByTestId(`alarm-row-${a.id}`).querySelector('[data-cell="c-alarm"]')?.textContent,
    ).toBe('Coolant pressure lowCOOLANT-PRESSUREMachine cnc-01');
    fireEvent.click(within(panel).getByTestId('close-alarm'));
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-panel')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByTestId(`details-${a.id}`));
  });

  it('opens the detail as a side sheet below 1440 px (1280 included) with the same test ids', async () => {
    stubWidth(1280);
    const a = occurrence(1);
    vi.stubGlobal('fetch', mes({ ...empty(), active: [a] }).fetch);
    await renderApp('/alarms');
    const details = await screen.findByTestId(`details-${a.id}`);
    details.focus();
    fireEvent.click(details);
    const sheet = await screen.findByTestId('alarm-panel');
    expect(sheet.tagName).toBe('DIALOG');
    expect(sheet.dataset.variant).toBe('sheet');
    expect(sheet.dataset.alarm).toBe(a.id);
    expect(sheet.hasAttribute('open')).toBe(true);
    // The focus starts on the title, not in the acknowledgement's comment box.
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Coolant pressure low');
    expect(screen.queryByRole('link', { name: 'Skip to the details' })).toBeNull();
    expect((await within(sheet).findAllByTestId('history-entry')).length).toBe(2);
    fireEvent.click(within(sheet).getByTestId('close-alarm'));
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-panel')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByTestId(`details-${a.id}`));
  });

  it('stacks each alarm as a card with its actions at 390 px (G-27)', async () => {
    stubWidth(390);
    const a = occurrence(1);
    vi.stubGlobal('fetch', mes({ ...empty(), active: [a] }).fetch);
    await renderApp('/alarms');
    const row = await screen.findByTestId(`alarm-row-${a.id}`);
    expect(row.tagName).toBe('LI');
    // 44 px touch targets on the cards.
    expect(within(row).getByTestId(`ack-${a.id}`).className).toContain('min-h-11');
    expect(within(row).getByTestId(`details-${a.id}`)).toBeTruthy();
    expect(within(row).getByTestId(`select-${a.id}`)).toBeTruthy();
    expect(screen.getByTestId('select-all')).toBeTruthy();
    expect(row.textContent).toContain('Active, unacknowledged');
  });

  it('ties a missing shelving reason to its field, and names the point without raw ids (A-06)', async () => {
    const a = occurrence(1);
    vi.stubGlobal('fetch', mes({ ...empty(), active: [a], points: [point()] }).fetch);
    await renderApp(`/alarms?alarm=${encodeURIComponent(a.id)}`);
    const section = await screen.findByTestId('shelf-section');
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe('Shelving');
    await waitFor(() => {
      expect(within(section).getByTestId('shelf-state').dataset.shelved).toBe('false');
    });
    const reason = within(section).getByRole('textbox', { name: 'Reason (required)' });
    expect(reason.dataset.testid).toBe('shelve-reason');
    fireEvent.click(within(section).getByTestId('shelve'));
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    const error = document.getElementById(reason.getAttribute('aria-describedby') ?? '');
    expect(error?.textContent).toBe('Enter a reason for shelving.');
    fireEvent.change(reason, { target: { value: 'sensor swap' } });
    expect(reason.getAttribute('aria-invalid')).toBeNull();
    // The history speaks words; the fact's sequence number waits in its technical details.
    const entries = await screen.findAllByTestId('history-entry');
    expect(entries[0]?.querySelector('p')?.textContent).toBe('Raised 08:00:01');
    expect(entries[0]?.querySelector('details summary')?.textContent).toBe('Technical details');
  });
});

describe('the alarm list toolbar (#369 review)', () => {
  it('shows the outcome of a write in its own reserved row and keeps it until the next outcome', async () => {
    const a = occurrence(2);
    const b = occurrence(1);
    const server = mes({ ...empty(), active: [a, b] }, (path) =>
      json({
        occurrence: {
          ...(path.includes(encodeURIComponent(a.id)) ? a : b),
          state: 'acked-active',
          acknowledged: ACK,
        },
        changed: true,
      }),
    );
    let release: () => void = () => undefined;
    let gate = Promise.resolve();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await gate;
      return server.fetch(input, init);
    });
    await renderApp('/alarms');
    await screen.findByTestId(`alarm-row-${a.id}`);
    // The row is there before any message, above the table, so a message does not move the rows.
    const toolbar = screen.getByTestId('alarm-toolbar');
    expect(toolbar.className).toContain('min-h-11');
    expect(
      toolbar.compareDocumentPosition(screen.getByTestId('alarm-table')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId(`ack-${a.id}`));
    const message = await within(toolbar).findByTestId('alarm-list-message');
    expect(message.dataset.kind).toBe('saved');
    expect(message.getAttribute('role')).toBe('status');
    // The next acknowledgement leaves it in place while its answer is on the way.
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(await screen.findByTestId(`ack-${b.id}`));
    await waitFor(() => {
      expect(screen.getByTestId(`ack-${b.id}`).getAttribute('aria-busy')).toBe('true');
    });
    expect(within(toolbar).getByTestId('alarm-list-message').textContent).toContain(a.code);
    release();
    await waitFor(() => {
      expect(screen.queryByTestId(`alarm-row-${b.id}`)).toBeNull();
    });
  });

  it('keeps the focus on "Acknowledge selected" after a bulk acknowledgement empties the selection', async () => {
    const a = occurrence(1);
    const b = occurrence(2);
    const server = mes({ ...empty(), active: [a, b] }, () =>
      json({
        results: [
          { id: a.id, changed: true },
          { id: b.id, changed: true },
        ],
        acknowledged: 2,
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/alarms');
    await screen.findByTestId(`alarm-row-${a.id}`);
    fireEvent.click(screen.getByTestId('select-all'));
    const button = screen.getByTestId<HTMLButtonElement>('ack-selected');
    expect(button.textContent).toContain('(2)');
    button.focus();
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId('alarm-list-message').textContent).toBe('Acknowledged 2.');
    });
    expect(button.textContent).toContain('(0)');
    // Not disabled, so the focus is not lost to the page; a press with nothing selected sends
    // nothing.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    const posts = server.calls.filter((call) => call.method === 'POST').length;
    await settle(() => {
      fireEvent.click(button);
    });
    expect(server.calls.filter((call) => call.method === 'POST').length).toBe(posts);
    expect(screen.getByTestId('alarm-list-message').textContent).toBe('Acknowledged 2.');
  });
});

describe('the alarm list order and salience (#371, ISA-18.2)', () => {
  const low = occurrence(4, { priority: 'low' });
  const high = occurrence(1, { priority: 'high', code: 'SPINDLE-OVERLOAD' });
  const medium = occurrence(3);
  const caption = () => screen.getByTestId('alarm-table').querySelector('caption')?.textContent;

  it('lists by priority, then newest raise, by default, and by raise time from the sort switch', async () => {
    vi.stubGlobal('fetch', mes({ ...empty(), active: [low, medium, high] }).fetch);
    const app = await renderApp(`/alarms?alarm=${encodeURIComponent(medium.id)}`);
    await screen.findByTestId(`alarm-row-${low.id}`);
    expect(rowIds()).toEqual([high.id, medium.id, low.id]);
    expect(caption()).toBe(
      'Active alarms, highest priority first, active before cleared, then newest raise',
    );
    const group = screen.getByRole('group', { name: 'Sort by' });
    expect(group.dataset.testid).toBe('alarm-sort');
    const byPriority = within(group).getByRole('link', { name: 'Priority' });
    const byRaise = within(group).getByRole('link', { name: 'Newest raise' });
    expect(byPriority.getAttribute('aria-current')).toBe('page');
    expect(byRaise.getAttribute('aria-current')).toBeNull();
    // The links keep the open alarm; the default leaves `sort` out of the URL.
    expect(byPriority.getAttribute('href')).not.toContain('sort=');
    expect(byRaise.getAttribute('href')).toContain('sort=raised');
    expect(byRaise.getAttribute('href')).toContain('alarm=');

    fireEvent.click(byRaise);
    await waitFor(() => {
      expect(rowIds()).toEqual([low.id, medium.id, high.id]);
    });
    expect(app.history.location.search).toContain('sort=raised');
    expect(caption()).toBe('Active alarms, newest raise first');
    const sortLink = (name: string) =>
      within(screen.getByRole('group', { name: 'Sort by' })).getByRole('link', { name });
    expect(sortLink('Newest raise').getAttribute('aria-current')).toBe('page');
    expect(sortLink('Priority').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('alarm-panel').dataset.alarm).toBe(medium.id);

    // Back to the default: `sort` leaves the URL again.
    expect(sortLink('Priority').getAttribute('href')).not.toContain('sort=');
    fireEvent.click(sortLink('Priority'));
    await waitFor(() => {
      expect(rowIds()).toEqual([high.id, medium.id, low.id]);
    });
    expect(app.history.location.search).not.toContain('sort=');
    fireEvent.click(sortLink('Newest raise'));
    await waitFor(() => {
      expect(rowIds()).toEqual([low.id, medium.id, high.id]);
    });

    // Another tab keeps the order.
    fireEvent.click(screen.getByTestId('tab-history'));
    await waitFor(() => {
      expect(screen.getByTestId('alarm-list').dataset.view).toBe('history');
    });
    expect(app.history.location.search).toContain('sort=raised');
  });

  it('lists the history by raise time unless priority is chosen', async () => {
    const closed = (seq: number, priority: 'high' | 'low') =>
      occurrence(seq, {
        priority,
        state: 'closed',
        endedAt: '2026-10-15T05:30:00.000Z',
        endReason: 'cleared',
        active: false,
        acknowledged: ACK,
      });
    const oldHigh = closed(1, 'high');
    const newLow = closed(2, 'low');
    vi.stubGlobal('fetch', mes({ ...empty(), history: [oldHigh, newLow] }).fetch);
    const app = await renderApp('/alarms?view=history');
    await screen.findByTestId(`alarm-row-${newLow.id}`);
    expect(rowIds()).toEqual([newLow.id, oldHigh.id]);
    expect(caption()).toBe('History alarms, newest raise first, the last 24 hours');
    const group = screen.getByRole('group', { name: 'Sort by' });
    const byRaise = within(group).getByRole('link', { name: 'Newest raise' });
    const byPriority = within(group).getByRole('link', { name: 'Priority' });
    expect(byRaise.getAttribute('aria-current')).toBe('page');
    expect(byPriority.getAttribute('aria-current')).toBeNull();
    // History's default leaves `sort` out; priority is the explicit choice here.
    expect(byRaise.getAttribute('href')).not.toContain('sort=');
    expect(byPriority.getAttribute('href')).toContain('sort=priority');
    fireEvent.click(byPriority);
    await waitFor(() => {
      expect(rowIds()).toEqual([oldHigh.id, newLow.id]);
    });
    expect(app.history.location.search).toContain('sort=priority');
    expect(
      within(screen.getByRole('group', { name: 'Sort by' }))
        .getByRole('link', { name: 'Priority' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('puts the active alarms of a priority before its cleared ones', async () => {
    const newerCleared = occurrence(9, {
      priority: 'high',
      state: 'unacked-cleared',
      endedAt: '2026-10-15T05:10:00.000Z',
      endReason: 'cleared',
      active: false,
    });
    vi.stubGlobal('fetch', mes({ ...empty(), active: [newerCleared, low, high] }).fetch);
    await renderApp('/alarms');
    await screen.findByTestId(`alarm-row-${newerCleared.id}`);
    expect(rowIds()).toEqual([high.id, newerCleared.id, low.id]);
  });

  it('opens a shared link in its order', async () => {
    vi.stubGlobal('fetch', mes({ ...empty(), active: [low, medium, high] }).fetch);
    await renderApp('/alarms?sort=raised');
    await screen.findByTestId(`alarm-row-${low.id}`);
    expect(rowIds()).toEqual([low.id, medium.id, high.id]);
  });

  it('ignores an unknown order in the URL', async () => {
    vi.stubGlobal('fetch', mes({ ...empty(), active: [low, medium, high] }).fetch);
    await renderApp('/alarms?sort=oldest');
    await screen.findByTestId(`alarm-row-${low.id}`);
    expect(rowIds()).toEqual([high.id, medium.id, low.id]);
  });

  it('makes an active unacknowledged alarm the most salient row; cleared and acknowledged ones less', async () => {
    const cleared = occurrence(2, {
      priority: 'high',
      state: 'unacked-cleared',
      endedAt: '2026-10-15T05:10:00.000Z',
      endReason: 'cleared',
      active: false,
    });
    const acked = occurrence(5, { state: 'acked-active', acknowledged: ACK });
    vi.stubGlobal(
      'fetch',
      mes({ ...empty(), active: [high, cleared], acknowledged: [acked] }).fetch,
    );
    await renderApp('/alarms');
    const row = (id: string) => screen.getByTestId(`alarm-row-${id}`);
    const cell = (id: string, name: string) =>
      row(id).querySelector<HTMLElement>(`[data-cell="${name}"]`);
    const badge = (id: string) =>
      cell(id, 'c-state')?.querySelector<HTMLElement>('[data-condition]');
    await screen.findByTestId(`alarm-row-${cleared.id}`);

    // Active and unacknowledged: the bar, bold text and a solid "Active" badge.
    expect(cell(high.id, 'select')?.className).toContain('var(--color-alarm-border)');
    expect(cell(high.id, 'c-alarm')?.className).toContain('font-semibold');
    expect(badge(high.id)?.textContent).toBe('Active');
    expect(badge(high.id)?.dataset.condition).toBe('active');
    expect(badge(high.id)?.className).toContain('bg-neutral-solid');
    expect(cell(high.id, 'c-state')?.textContent).toBe('Active, unacknowledged');

    // Cleared and unacknowledged: still barred (it awaits its acknowledgement), not bold, soft.
    expect(cell(cleared.id, 'select')?.className).toContain('var(--color-alarm-border)');
    expect(cell(cleared.id, 'c-alarm')?.className).not.toContain('font-semibold');
    expect(cell(cleared.id, 'c-machine')?.className).not.toContain('font-semibold');
    expect(badge(cleared.id)?.textContent).toBe('Cleared');
    expect(badge(cleared.id)?.className).toContain('bg-neutral-soft');
    expect(cell(cleared.id, 'c-state')?.textContent).toBe('Cleared, unacknowledged');

    // Active and acknowledged: plain, an outline badge, "acknowledged" in secondary text.
    fireEvent.click(screen.getByTestId('tab-acknowledged'));
    await screen.findByTestId(`alarm-row-${acked.id}`);
    expect(cell(acked.id, 'c-alarm')?.className).not.toContain('font-semibold');
    expect(badge(acked.id)?.className).toContain('bg-surface');
    expect(badge(acked.id)?.className).toContain('border-neutral-border');
    expect(cell(acked.id, 'c-state')?.textContent).toBe('Active, acknowledged');
    expect(
      within(cell(acked.id, 'c-state') ?? document.body).getByText('acknowledged').className,
    ).toContain('text-ink-secondary');
  });

  it('shows a closed alarm as a soft "Closed" badge with nothing after it', async () => {
    const closed = occurrence(3, {
      state: 'closed',
      endedAt: '2026-10-15T05:30:00.000Z',
      endReason: 'cleared',
      active: false,
      acknowledged: ACK,
    });
    vi.stubGlobal('fetch', mes({ ...empty(), history: [closed] }).fetch);
    await renderApp('/alarms?view=history');
    const row = await screen.findByTestId(`alarm-row-${closed.id}`);
    const state = row.querySelector<HTMLElement>('[data-cell="c-state"]');
    expect(state?.textContent).toBe('Closed');
    expect(state?.querySelector('[data-condition]')?.className).toContain('bg-neutral-soft');
    expect(row.innerHTML).not.toContain('border)]');
  });
});
