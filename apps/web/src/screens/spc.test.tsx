import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetCharts } from '../api/quality.ts';
import { json, problem, sessionOf } from '../test/fixtures.ts';
import { characteristic, chart, limitVersion, point, signal } from '../test/quality-fixtures.ts';
import { qualityMes, qualityState, type Write } from '../test/quality-mes.ts';
import { renderApp, settle } from '../test/render-app.tsx';

// jsdom has no canvas: the chart is a stub, the tables beside it carry the values.
vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  forgetCharts();
});

const subscribed = (app: Awaited<ReturnType<typeof renderApp>>) =>
  app.factory.last.sent.filter((m) => m.type === 'subscribe').map((m) => m.topic);

const QUALITY = sessionOf(['quality'], { username: 'quinn' });

describe('SPC characteristics', () => {
  it('lists the characteristics and follows a pushed summary', async () => {
    const state = qualityState();
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    const app = await renderApp('/quality/spc');
    await app.open();
    const card = await screen.findByTestId('spc-characteristic-leak-rate');
    expect(card.dataset.limits).toBe('1');
    expect(card.dataset.unacknowledged).toBe('2');
    expect(subscribed(app)).toContain('quality');
    expect(screen.getByTestId('nav-spc')).toBeTruthy();
    await app.push({
      type: 'spc-characteristic',
      event: 'notice',
      characteristic: characteristic({
        version: 3,
        notice: { kind: 'baseline-changed', at: '2026-10-15T06:00:00.000Z', detail: 'late' },
      }),
    });
    expect(screen.getByTestId('spc-characteristic-leak-rate').dataset.notice).toBe(
      'baseline-changed',
    );
    // An older copy never takes it back.
    await app.push({
      type: 'spc-characteristic',
      event: 'readings',
      characteristic: characteristic({ version: 2 }),
    });
    expect(screen.getByTestId('spc-characteristic-leak-rate').dataset.version).toBe('3');
  });

  it('says when no limits exist yet', async () => {
    const state = qualityState();
    state.characteristics = [
      characteristic({ currentLimits: null, baseline: { needed: 100, final: 40 } }),
    ];
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp('/quality/spc');
    const baseline = await screen.findByTestId('spc-baseline');
    expect(baseline.dataset.limits).toBe('none');
    expect(baseline.textContent).toContain('40 so far');
  });
});

describe('SPC chart page', () => {
  it('shows the charts, points, retests, episodes and limit versions; live episodes by id', async () => {
    const state = qualityState();
    const server = qualityMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate');
    await app.open();
    await screen.findByTestId('spc-chart-page');
    expect(screen.getByTestId('spc-summary-I').textContent).toContain('2 points (1 provisional)');
    expect(screen.getByTestId('spc-signal-points-I').dataset.count).toBe('1');
    expect(screen.getByTestId('spc-no-points-Xbar')).toBeTruthy();
    expect(screen.getByTestId('spc-retests').dataset.count).toBe('1');
    // Every value on request.
    fireEvent.click(screen.getByTestId('spc-values-toggle-I'));
    expect(screen.getByTestId('spc-values-I').dataset.count).toBe('2');
    // Episodes, newest first, with their finality.
    const row2 = screen.getByTestId('signal-row-2');
    expect(row2.dataset.status).toBe('provisional');
    expect(row2.dataset.open).toBe('true');
    const row1 = screen.getByTestId('signal-row-1');
    expect(row1.dataset.extentFinal).toBe('true');
    expect(within(row1).getByTestId('signal-finality').textContent).toBe('Final, extent final');
    expect(screen.getByTestId('limit-version-1').dataset.createdBy).toBe('system');
    // A pushed episode grows, another opens, a provisional one is removed.
    await app.push({
      type: 'spc-signal',
      event: 'final',
      signal: signal(2, { status: 'final', rowVersion: 2, points: 3 }),
    });
    expect(screen.getByTestId('signal-row-2').dataset.status).toBe('final');
    await app.push({ type: 'spc-signal', event: 'opened', signal: signal(3) });
    expect(screen.getByTestId('signal-row-3')).toBeTruthy();
    await app.push({ type: 'spc-signal', event: 'removed', signal: signal(3) });
    expect(screen.queryByTestId('signal-row-3')).toBeNull();
    // An older copy of 2 does not take it back.
    await app.push({ type: 'spc-signal', event: 'updated', signal: signal(2) });
    expect(screen.getByTestId('signal-row-2').dataset.status).toBe('final');
    // The filter.
    fireEvent.change(screen.getByTestId('signal-filter'), { target: { value: 'open' } });
    expect(screen.getByTestId('signal-list').dataset.count).toBe('1');
    fireEvent.change(screen.getByTestId('signal-filter'), { target: { value: 'withdrawn' } });
    expect(screen.getByTestId('signals-empty')).toBeTruthy();
  });

  it('shows values at the characteristic’s precision, never a raw double (#295)', async () => {
    // What the MES sends for 3381 steps of 0.001 (`3381 * 0.001`), as in the demo's scene 6.
    const noisy = { value: 3381 * 0.001, steps: '3381/1' };
    const base = limitVersion(1);
    const state = qualityState({
      chart: chart({
        points: {
          I: [point(101, 2.1), { ...point(102, 3.381, { rules: [1] }), value: noisy }],
          MR: [{ ...point(102, 1.281), value: { value: 0.1 + 0.2, steps: '300/1' } }],
          Xbar: [{ ...point(105, 3.3812), value: { value: 3.3812000000000006, steps: '16906/5' } }],
          R: [],
        },
        limits: [
          limitVersion(1, {
            charts: {
              ...base.charts,
              I: {
                lower: { value: -0.25, steps: '-250/1' },
                centre: { value: 2.0000000000000004, steps: '2000/1' },
                upper: { value: 3.381333333333333, steps: '10144/3' },
              },
            },
            capability: { sigma: { value: 0.43, steps: '430/1' }, cpu: 1.005, cpk: 1.005 },
          }),
        ],
      }),
    });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    const app = await renderApp('/quality/spc/leak-rate');
    await app.open();
    await screen.findByTestId('spc-chart-page');
    const valueCell = (table: string, row = 0) =>
      within(screen.getByTestId(table)).getAllByRole('row')[row + 1]?.querySelectorAll('td')[2]
        ?.textContent;
    // Readings and ranges at the resolution's decimals (0.001 → 3).
    expect(valueCell('spc-signal-points-I')).toBe('3.381');
    fireEvent.click(screen.getByTestId('spc-values-toggle-I'));
    expect(valueCell('spc-values-I', 0)).toBe('2.100');
    expect(valueCell('spc-values-I', 1)).toBe('3.381');
    fireEvent.click(screen.getByTestId('spc-values-toggle-MR'));
    expect(valueCell('spc-values-MR')).toBe('0.300');
    // X̄ points, centre lines and limits are statistics: one decimal more.
    fireEvent.click(screen.getByTestId('spc-values-toggle-Xbar'));
    expect(valueCell('spc-values-Xbar')).toBe('3.3812');
    const limits = screen.getByTestId('limit-version-1').querySelectorAll('td');
    expect(limits[4]?.textContent).toBe('-0.2500 / 2.0000 / 3.3813');
    expect(limits[5]?.textContent).toBe('1.4200 / 2.0000 / 2.5800');
    expect(limits[6]?.textContent).toBe('1.6300 / 2.1100');
    // Cpk two decimals, half-up on its decimal value (1.005.toFixed(2) would say 1.00).
    expect(screen.getByTestId('limit-cpk').textContent).toBe('1.01');
    expect(screen.getByTestId('spc-chart-page').textContent).not.toMatch(/\d\.\d{7,}/);
  });

  it('reads the chart again on a characteristic push, with If-None-Match (304 keeps it)', async () => {
    const state = qualityState();
    const server = qualityMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate');
    await app.open();
    await screen.findByTestId('spc-chart-page');
    const before = server.reads('/api/v1/quality/characteristics/leak-rate/chart').length;
    await app.push({
      type: 'spc-characteristic',
      event: 'readings',
      characteristic: characteristic(),
    });
    await waitFor(() => {
      expect(server.reads('/api/v1/quality/characteristics/leak-rate/chart').length).toBe(
        before + 1,
      );
    });
    expect(
      server.reads('/api/v1/quality/characteristics/leak-rate/chart').at(-1)?.ifNoneMatch,
    ).toBe('"rev-1"');
    expect(screen.getByTestId('spc-summary-I').textContent).toContain('2 points');
    // A new derivation answers a new body.
    state.etag = '"rev-2"';
    state.chart = chart({
      points: {
        ...state.chart.points,
        I: [
          ...state.chart.points.I,
          ...state.chart.points.I.slice(0, 1).map((p) => ({
            ...p,
            partId: 103,
            seq: 103,
            at: '2026-10-15T05:43:00.000Z',
          })),
        ],
      },
    });
    await app.push({
      type: 'spc-characteristic',
      event: 'readings',
      characteristic: characteristic(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('spc-summary-I').textContent).toContain('3 points');
    });
  });

  it('changes the window by the URL: every reading, or a plant-time range', async () => {
    const state = qualityState();
    const server = qualityMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate');
    await screen.findByTestId('spc-chart-page');
    fireEvent.change(screen.getByTestId('chart-window-mode'), { target: { value: 'all' } });
    await waitFor(() => {
      expect(app.history.location.search).toContain('all=true');
    });
    await waitFor(() => {
      expect(server.reads('/api/v1/quality/characteristics/leak-rate/chart?all=true').length).toBe(
        1,
      );
    });
    fireEvent.click(screen.getByTestId('chart-window-apply'));
    expect(screen.getByTestId('chart-window-problem')).toBeTruthy();
    fireEvent.change(screen.getByTestId('chart-window-from'), {
      target: { value: '2026-10-15T07:00:00' },
    });
    fireEvent.click(screen.getByTestId('chart-window-apply'));
    await waitFor(() => {
      expect(
        server.reads(
          '/api/v1/quality/characteristics/leak-rate/chart?from=2026-10-15T04%3A00%3A00.000Z',
        ).length,
      ).toBe(1);
    });
  });

  it('acknowledges an episode with a comment; a push that moves it makes the draft stale', async () => {
    const state = qualityState();
    const write: Write = (_method, path, body) => {
      if (path === '/api/v1/quality/signals/2/ack') {
        const request = body as { version: number; comment: string };
        if (request.version !== 1) {
          return problem(409, 'Conflict', 'stale', path, PROBLEM_TYPES.signalStale);
        }
        return json(
          signal(2, {
            rowVersion: 2,
            acknowledged: {
              by: 'quinn',
              at: '2026-10-15T06:00:00.000Z',
              plantAt: null,
              comment: request.comment,
            },
          }),
        );
      }
      return problem(404, 'Not Found', 'no route', path);
    };
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate', { session: QUALITY });
    await app.open();
    await screen.findByTestId('signal-row-2');
    fireEvent.click(screen.getByTestId('ack-2'));
    // A comment is required.
    fireEvent.click(screen.getByTestId('ack-submit'));
    expect(screen.getByTestId('ack-invalid')).toBeTruthy();
    expect(server.posts()).toEqual([]);
    fireEvent.change(screen.getByTestId('ack-comment'), { target: { value: 'checked the jig' } });
    // The episode moves on (final) while the form is open: stale, nothing sent.
    await app.push({
      type: 'spc-signal',
      event: 'final',
      signal: signal(2, { status: 'final', rowVersion: 3 }),
    });
    expect(screen.getByTestId('ack-stale').dataset.version).toBe('3');
    expect(screen.getByTestId<HTMLButtonElement>('ack-submit').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ack-restart'));
    expect(screen.getByTestId('ack-form').dataset.version).toBe('3');
    expect(screen.getByTestId<HTMLTextAreaElement>('ack-comment').value).toBe('checked the jig');
    // The MES refuses version 3 as stale (the fake knows 1 only): the chart is read again.
    const reads = server.reads('/api/v1/quality/characteristics/leak-rate/chart').length;
    fireEvent.click(screen.getByTestId('ack-submit'));
    const message = await screen.findByTestId('ack-message');
    expect(message.dataset.kind).toBe('stale');
    expect(message.dataset.type).toBe(PROBLEM_TYPES.signalStale);
    await waitFor(() => {
      expect(
        server.reads('/api/v1/quality/characteristics/leak-rate/chart').length,
      ).toBeGreaterThan(reads);
    });
    expect(server.posts().map((p) => p.body)).toEqual([{ version: 3, comment: 'checked the jig' }]);
  });

  it('acknowledges once and shows who acknowledged it', async () => {
    const state = qualityState();
    const write: Write = (_method, path, body) =>
      json(
        signal(1, {
          status: 'final',
          rowVersion: 2,
          extentFinal: true,
          closedBy: signal(1).last,
          acknowledged: {
            by: 'quinn',
            // A wall time a week after the plant clock, as in the demo (#295).
            at: '2026-10-22T07:12:03.000Z',
            plantAt: '2026-10-15T06:00:00.000Z',
            comment: (body as { comment: string }).comment,
          },
        }),
      );
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate', { session: QUALITY });
    await app.open();
    await screen.findByTestId('signal-row-1');
    fireEvent.click(screen.getByTestId('ack-1'));
    fireEvent.change(screen.getByTestId('ack-comment'), { target: { value: 'in control' } });
    fireEvent.click(screen.getByTestId('ack-submit'));
    expect(await screen.findByTestId('ack-done')).toBeTruthy();
    expect(screen.getByTestId('signal-row-1').dataset.acknowledged).toBe('true');
    expect(within(screen.getByTestId('signal-row-1')).getByTestId('signal-ack').textContent).toBe(
      'quinn, Thu 22 Oct, 10:12:03 (wall time) (plant Thu 15 Oct, 09:00:00): “in control”',
    );
    expect(screen.queryByTestId('ack-1')).toBeNull();
    expect(server.posts()[0]?.path).toBe('/api/v1/quality/signals/1/ack');
  });

  it('hides the writes a role lacks: an operator sees no acknowledgement, limits or hold link', async () => {
    const state = qualityState();
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp('/quality/spc/leak-rate', { session: sessionOf(['operator']) });
    await screen.findByTestId('signal-row-2');
    expect(screen.queryByTestId('ack-2')).toBeNull();
    expect(screen.queryByTestId('hold-from-2')).toBeNull();
    expect(screen.queryByTestId('limits-create')).toBeNull();
    expect(screen.queryByTestId('limits-end-1')).toBeNull();
  });

  it('a supervisor acknowledges and holds from an episode, but sets no limits', async () => {
    const state = qualityState();
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp('/quality/spc/leak-rate');
    await screen.findByTestId('signal-row-2');
    expect(screen.getByTestId('ack-2')).toBeTruthy();
    expect(screen.getByTestId('hold-from-2').getAttribute('href')).toBe(
      '/quality/holds/new?signal=2',
    );
    expect(screen.queryByTestId('limits-create')).toBeNull();
  });

  it('estimates a new limit version from the baseline-changed notice; a stale characteristic is refused', async () => {
    const state = qualityState({
      chart: chart({
        characteristic: characteristic({
          notice: {
            kind: 'baseline-changed',
            at: '2026-10-15T06:00:00.000Z',
            detail: 'A late reading lies inside version 1’s window.',
          },
        }),
      }),
    });
    let refuse = true;
    const write: Write = (_method, path, body) => {
      if (path === '/api/v1/quality/characteristics/leak-rate/limits') {
        if (refuse) {
          refuse = false;
          return problem(409, 'Conflict', 'stale', path, PROBLEM_TYPES.limitsStale);
        }
        const request = body as { version: number };
        return json({
          characteristic: characteristic({ version: request.version + 1, currentLimits: 2 }),
          limits: limitVersion(2),
        });
      }
      return problem(404, 'Not Found', 'no route', path);
    };
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/spc/leak-rate', { session: QUALITY });
    await app.open();
    const notice = await screen.findByTestId('spc-notice');
    expect(notice.textContent).toContain('A late reading');
    // When the MES noticed it is a wall time (#295).
    expect(notice.textContent).toContain('(noticed Thu 15 Oct, 09:00:00 (wall time)).');
    fireEvent.click(screen.getByTestId('notice-estimate'));
    const form = screen.getByTestId('limits-form');
    expect(form.dataset.version).toBe('2');
    // Offered: the final first-pass points shown (one here), in plant time (UTC+3).
    expect(screen.getByTestId<HTMLInputElement>('limits-from').value).toBe('2026-10-15T08:41');
    fireEvent.click(screen.getByTestId('limits-submit'));
    expect(screen.getByTestId('limits-invalid').textContent).toContain('comment is required');
    fireEvent.change(screen.getByTestId('limits-to'), { target: { value: '2026-10-15T08:00:00' } });
    fireEvent.change(screen.getByTestId('limits-comment'), { target: { value: 'new jig' } });
    fireEvent.click(screen.getByTestId('limits-submit'));
    expect(screen.getByTestId('limits-invalid').textContent).toContain('must not be after');
    fireEvent.change(screen.getByTestId('limits-to'), { target: { value: '2026-10-15T09:00:00' } });
    // Final points only (102 is provisional); the window starts inside what is shown.
    expect(screen.getByTestId('limits-window-points').dataset.final).toBe('1');
    expect(screen.getByTestId('limits-window-points').dataset.beyondShown).toBe('false');
    fireEvent.click(screen.getByTestId('limits-submit'));
    const message = await screen.findByTestId('limits-message');
    expect(message.dataset.kind).toBe('stale');
    // The characteristic moved on meanwhile (a push): the draft is stale until started again.
    await app.push({
      type: 'spc-characteristic',
      event: 'limits',
      characteristic: characteristic({ version: 4, notice: null }),
    });
    expect(screen.getByTestId('limits-stale').dataset.version).toBe('4');
    fireEvent.click(screen.getByTestId('limits-restart'));
    fireEvent.click(screen.getByTestId('limits-submit'));
    expect(await screen.findByTestId('limits-done')).toBeTruthy();
    expect(server.posts().map((p) => p.body)).toEqual([
      {
        version: 2,
        from: '2026-10-15T05:41:00.000Z',
        to: '2026-10-15T06:00:00.000Z',
        comment: 'new jig',
      },
      {
        version: 4,
        from: '2026-10-15T05:41:00.000Z',
        to: '2026-10-15T06:00:00.000Z',
        comment: 'new jig',
      },
    ]);
  });

  it('ends a limit version with a comment', async () => {
    const state = qualityState();
    const write: Write = (_method, path) =>
      path === '/api/v1/quality/characteristics/leak-rate/limits/1/end'
        ? json({
            characteristic: characteristic({ version: 3 }),
            limits: limitVersion(1, { endedAt: '2026-10-15T06:00:00.000Z', endedBy: 'quinn' }),
          })
        : problem(409, 'Conflict', 'ended', path, PROBLEM_TYPES.limitsEnded);
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/quality/spc/leak-rate', { session: QUALITY });
    fireEvent.click(await screen.findByTestId('limits-end-1'));
    expect(screen.getByTestId('limits-end-form')).toBeTruthy();
    fireEvent.change(screen.getByTestId('limits-comment'), {
      target: { value: 'tester replaced' },
    });
    fireEvent.click(screen.getByTestId('limits-submit'));
    expect((await screen.findByTestId('limits-done')).textContent).toContain('ended');
    expect(server.posts()[0]?.body).toEqual({ version: 2, comment: 'tester replaced' });
  });

  it('answers an unknown characteristic', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/spc/torque');
    expect(await screen.findByTestId('spc-missing')).toBeTruthy();
    await settle(() => undefined);
  });
});
