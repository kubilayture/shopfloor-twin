import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kpiBucket } from '../test/alarm-fixtures.ts';
import { EPOCH, problem } from '../test/fixtures.ts';
import { PREVIOUS_SHIFT, SHIFT_KEY, bucket, record, result } from '../test/oee-fixtures.ts';
import { renderApp } from '../test/render-app.tsx';
import { auditEntry, note, report, shiftRecord } from '../test/shift-fixtures.ts';
import { memoryStorage, shiftMes, shiftState } from '../test/shift-mes.ts';
import { liveKeys, type LiveShifts } from '../live/live-cache.ts';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

const PATH = '/shifts/2026-10-15/A';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const measure = (card: HTMLElement, name: string) =>
  card.querySelector<HTMLElement>(`[data-measure="${name}"]`)?.textContent;

const subscribed = (app: Awaited<ReturnType<typeof renderApp>>) =>
  app.factory.last.sent
    .filter((message) => message.type === 'subscribe')
    .map((message) => message.topic);

describe('shift report', () => {
  it('shows every section exactly as served, with n/a where there is no value', async () => {
    const state = shiftState({
      report: report({
        oee: {
          ...report().oee,
          equipment: [
            bucket('cnc-01', {}, 'equipment'),
            bucket(
              'wsh-01',
              { result: { ...result(), oee: null, availability: null } },
              'equipment',
            ),
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    await renderApp(PATH);
    const shown = await screen.findByTestId('shift-report');
    expect(shown.dataset.status).toBe('running');
    expect(shown.dataset.final).toBe('false');
    expect(screen.getByTestId('report-status').textContent).toBe('Running');
    expect(screen.getByTestId('report-finality').textContent).toContain('Provisional');
    expect(screen.getByTestId('report-revision').textContent).toBe('inputs 0, content 0');
    expect(screen.getByTestId('report-as-of').querySelector('time')?.dateTime).toBe(
      '2026-10-15T06:10:00.000Z',
    );
    expect(screen.getByTestId('report-generated-at').querySelector('time')?.dateTime).toBe(
      '2026-10-16T08:30:00.000Z',
    );
    expect(screen.queryByTestId('report-revised')).toBeNull();

    // OEE: the API's four decimals; null is n/a; a machine without a bucket is n/a too.
    expect(screen.getByTestId('report-oee-wc-cell-m1').dataset.oee).toBe('0.6300');
    const cnc = screen.getByTestId('report-oee-machine-cnc-01');
    expect(cnc.dataset.oee).toBe('0.6300');
    expect(within(cnc).getByText('63.00 %')).toBeTruthy();
    const wsh = screen.getByTestId('report-oee-machine-wsh-01');
    expect(wsh.dataset.oee).toBe('n/a');
    expect(within(wsh).getAllByText('n/a').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      expect(screen.getByTestId('report-oee-machine-asm-01').dataset.oee).toBe('n/a');
    });
    expect(screen.getByTestId('report-oee-wc-line-a1').textContent).toContain('n/a');

    // Downtime.
    expect(screen.getByTestId('report-loss-own').textContent).toBe('2.5 min');
    expect(screen.getByTestId('report-uncoded').dataset.ms).toBe('30000');
    expect(screen.getByTestId('report-pareto-STARVED').dataset.ms).toBe('50000');
    const longest = screen.getAllByTestId(/^report-longest-cnc-01/);
    expect(longest).toHaveLength(1);
    await waitFor(() => {
      expect(longest[0]?.textContent).toContain('Spindle overload');
    });

    // Production: the report's counts.
    const row = screen.getByTestId('report-production-cnc-01');
    expect([row.dataset.produced, row.dataset.good, row.dataset.scrap, row.dataset.rework]).toEqual(
      ['10', '9', '1', '0'],
    );
    expect(screen.getByTestId('report-finished').dataset.good).toBe('9');
    expect(screen.getByTestId('report-scrap-total').textContent).toBe('3');

    // Alarms: KPIs, bad actors and operator figures; Line A1 has no bucket: n/a, never 0.
    const plant = screen.getByTestId('report-alarm-scope-plant');
    expect(plant.dataset.raises).toBe('14');
    expect(measure(plant, 'raises')).toBe('14 (2 / 11 / 1)');
    expect(measure(plant, 'average-rate')).toContain('0.2917');
    // Banded with the benchmarks the MES serves (#160).
    await waitFor(() => {
      expect(measure(plant, 'average-rate')).toContain('Acceptable (≤ 1 per 10 min)');
    });
    expect(
      within(plant).getByTestId('report-bad-actor-plant-cnc-01-COOLANT-PRESSURE').dataset.raises,
    ).toBe('12');
    expect(measure(within(plant).getByTestId('report-operator-plant'), 'mean-time-to-ack')).toBe(
      '0.6 min',
    );
    const line = screen.getByTestId('report-alarm-scope-position-line-a1');
    expect(line.dataset.raises).toBe('n/a');
    expect(measure(line, 'peak10')).toBe('n/a');
    expect(measure(line, 'unacknowledged')).toBe('n/a');
    expect(screen.getByTestId('notes-empty')).toBeTruthy();
  });

  it('shows a final report and a banner when it changed after final', async () => {
    // Both note writes are audited after finalAt (the database's clock, not the MES's), but the
    // MES stored content 1 at final (#163): one change after final, not two.
    const edited = note(1, { version: 2, updatedAt: '2026-10-16T10:00:00.000Z' });
    const state = shiftState({
      report: report({
        status: 'final',
        final: true,
        finalAt: '2026-10-16T09:00:00.000Z',
        revision: { inputs: 1, content: 2, contentAtFinal: 1 },
      }),
      notes: [edited],
      history: {
        1: [auditEntry(edited), auditEntry(note(1, { updatedAt: '2026-10-16T09:00:00.001Z' }))],
      },
    });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    await renderApp(PATH);
    const shown = await screen.findByTestId('shift-report');
    expect(shown.dataset.final).toBe('true');
    expect(shown.dataset.revisionInputs).toBe('1');
    expect(shown.dataset.revisionContent).toBe('2');
    expect(screen.getByTestId('report-status').textContent).toBe('Final');
    expect(screen.getByTestId('report-finality').textContent).toContain('Final');
    const banner = screen.getByTestId('report-revised');
    expect(banner.dataset.inputs).toBe('1');
    // Content 2 less the content at final: one change after final.
    expect(banner.dataset.content).toBe('1');
    expect(banner.textContent).toContain('changed after it became final');
    expect(screen.queryByTestId('report-live-note')).toBeNull();
  });

  it('merges the live numbers while the shift runs and reads the report again when it turns final', async () => {
    const state = shiftState();
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(PATH);
    await app.open();
    await screen.findByTestId('shift-report');
    await waitFor(() => {
      expect(subscribed(app)).toEqual(
        expect.arrayContaining(['shifts', 'oee:cnc-01', 'oee:cell-m1', 'alarm-kpi:plant']),
      );
    });
    const pushedOee = bucket('cnc-01', {
      result: result({
        oee: { fraction: '7/10', decimal: '0.7000' },
        totals: { ...result().totals, produced: 12, good: 11, scrap: 1, rework: 0 },
      }),
    });
    await app.push(
      { type: 'oee', topic: 'oee:cnc-01', hour: null, shift: pushedOee },
      {
        type: 'alarm-kpi',
        topic: 'alarm-kpi:plant',
        hour: null,
        shift: kpiBucket({ raises: 20 }),
        floods: [],
      },
    );
    await waitFor(() => {
      expect(screen.getByTestId('report-oee-machine-cnc-01').dataset.oee).toBe('0.7000');
    });
    expect(screen.getByTestId('report-oee-machine-cnc-01').dataset.live).toBe('true');
    expect(screen.getByTestId('report-production-cnc-01').dataset.produced).toBe('12');
    // The total is the sum of the rows once one is live: 1 + 1 + 1.
    expect(screen.getByTestId('report-scrap-total').textContent).toBe('3');
    expect(screen.getByTestId('report-alarm-scope-plant').dataset.raises).toBe('20');
    // Another shift's bucket is ignored.
    await app.push({
      type: 'oee',
      topic: 'oee:wsh-01',
      hour: null,
      shift: bucket('wsh-01', { key: '2026-10-15/B', result: result({ oee: null }) }),
    });
    expect(screen.getByTestId('report-oee-machine-wsh-01').dataset.oee).toBe('0.6300');

    // The shift ends and its report becomes final: the instance push reads the report again.
    const reads = () => server.calls.filter((call) => call.path.endsWith('/report')).length;
    const before = reads();
    state.report = report({
      status: 'final',
      final: true,
      finalAt: '2026-10-16T09:00:00.000Z',
      revision: { inputs: 0, content: 0, contentAtFinal: 0 },
      oee: { ...report().oee, equipment: [bucket('cnc-01', { final: true }, 'equipment')] },
    });
    await app.push({
      type: 'shift',
      event: 'status',
      shift: shiftRecord({ status: 'final', final: true, finalAt: '2026-10-16T09:00:00.000Z' }),
    });
    await waitFor(() => {
      expect(screen.getByTestId('shift-report').dataset.final).toBe('true');
    });
    expect(reads()).toBe(before + 1);
    // The final REST bucket wins over the earlier push.
    expect(screen.getByTestId('report-oee-machine-cnc-01').dataset.live).toBe('false');
    expect(screen.getByTestId('report-oee-machine-cnc-01').dataset.oee).toBe('0.6300');
    // A copy behind what was read is no reason to read again.
    await app.push({ type: 'shift', event: 'revised', shift: shiftRecord() });
    expect(reads()).toBe(before + 1);
  });

  it('drops pushed copies when the screen lets go, and reads again on return (B1)', async () => {
    const state = shiftState({ notes: [note(1)] });
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(PATH);
    await app.open();
    await screen.findByTestId('note-1');
    await app.push({
      type: 'handover-note',
      event: 'created',
      note: note(2, { text: 'Pushed note' }),
    });
    expect(screen.getByTestId('note-text-2').textContent).toBe('Pushed note');

    fireEvent.click(screen.getByTestId('nav-overview'));
    await waitFor(() => {
      expect(screen.queryByTestId('shift-report')).toBeNull();
    });
    const live = app.queryClient.getQueryData<LiveShifts>(liveKeys.shifts);
    expect(live?.notes).toEqual({});
    expect(live?.instances).toEqual({});
    // Meanwhile note 1 is retracted elsewhere; no push reaches this tab.
    state.notes = [note(1, { version: 2, retracted: true }), note(2, { text: 'Pushed note' })];
    const reads = server.calls.length;
    fireEvent.click(screen.getByTestId('nav-shifts'));
    fireEvent.click(await screen.findByTestId('shift-link-2026-10-15-A'));
    await waitFor(() => {
      expect(screen.getByTestId('note-1').dataset.retracted).toBe('true');
    });
    expect(server.calls.slice(reads).some((call) => call.path.includes('/A/notes?'))).toBe(true);
  });

  it('marks what does not print and prints on request', async () => {
    vi.stubGlobal('fetch', shiftMes(shiftState({ notes: [note(1)] })).fetch);
    const print = vi.fn();
    vi.stubGlobal('print', print);
    await renderApp(PATH);
    const shown = await screen.findByTestId('shift-report');
    expect(shown.className).toContain('shift-report');
    expect(document.querySelector('header')?.className).toContain('print:hidden');
    const button = screen.getByTestId('print-report');
    expect(button.parentElement?.className).toContain('print:hidden');
    expect(screen.getByTestId('download-report').getAttribute('href')).toBe(
      `/api/v1/shifts/2026-10-15/A/report?epoch=${String(EPOCH)}`,
    );
    expect(screen.getByTestId('shift-select').closest('.print\\:hidden')).not.toBeNull();
    expect(screen.getByTestId('new-note').className).toContain('print:hidden');
    expect(screen.getByTestId('edit-note-1').parentElement?.className).toContain('print:hidden');
    // What a printout needs stays: status, revision and times, the sections and the notes.
    for (const id of [
      'report-summary',
      'report-oee',
      'report-downtime',
      'report-alarms',
      'note-1',
    ]) {
      expect(screen.getByTestId(id).closest('.print\\:hidden')).toBeNull();
    }
    fireEvent.click(button);
    expect(print).toHaveBeenCalledOnce();
  });

  it('says when the report cannot be read or the key is not a shift', async () => {
    const state = shiftState({
      reportAnswer: () =>
        problem(404, 'Not Found', 'no shift instance 2026-10-15/A (not reached)', '/x'),
    });
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    const view = await renderApp(PATH);
    const failure = await screen.findByTestId('report-error');
    expect(failure.textContent).toContain('no shift instance 2026-10-15/A');
    view.unmount();

    await renderApp('/shifts/2026-13/A!');
    expect((await screen.findByTestId('report-invalid')).textContent).toContain('not a shift key');
  });

  it('turns a row without a record into the pushed instance of the newest epoch', async () => {
    vi.stubGlobal('fetch', shiftMes(shiftState()).fetch);
    const app = await renderApp('/shifts');
    await app.open();
    const row = () => screen.getByTestId('shift-row-2026-10-14-C');
    await waitFor(() => {
      expect(row().dataset.status).toBe('none');
    });
    const created = (epoch: number) =>
      shiftRecord({
        key: PREVIOUS_SHIFT.key,
        date: PREVIOUS_SHIFT.date,
        shift: PREVIOUS_SHIFT.shift,
        start: PREVIOUS_SHIFT.start,
        end: PREVIOUS_SHIFT.end,
        epoch,
        status: epoch === EPOCH ? 'ended' : 'running',
      });
    await app.push(
      { type: 'shift', event: 'created', shift: created(EPOCH + 1) },
      { type: 'shift', event: 'status', shift: created(EPOCH) },
    );
    // The newest epoch's, as the API defaults to, not the last one pushed.
    expect(row().dataset.status).toBe('running');
  });

  it('says an ended report is as of its time and reads it again on downtime pushes', async () => {
    const state = shiftState({ report: report({ status: 'ended' }) });
    const server = shiftMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(PATH);
    await app.open();
    expect((await screen.findByTestId('report-ended-note')).textContent).toContain(
      'as of the time above',
    );
    expect(screen.queryByTestId('report-live-note')).toBeNull();
    await waitFor(() => {
      expect(subscribed(app)).toContain('downtime');
    });
    const reads = () => server.calls.filter((call) => call.path.includes('/A/report')).length;
    const before = reads();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.report = report({
        status: 'ended',
        downtime: { ...report().downtime, uncodedMs: 0 },
      });
      await app.push(
        { type: 'downtime', event: 'recoded', record: record() },
        { type: 'downtime', event: 'closed', record: record({ id: 'cnc-01~1~2' }) },
      );
      expect(reads()).toBe(before);
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => {
        expect(screen.getByTestId('report-uncoded').dataset.ms).toBe('0');
      });
      // Two pushes, one read: at most one every 5 s.
      expect(reads()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the shifts, current first, with their status, live', async () => {
    const state = shiftState();
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    const app = await renderApp('/shifts');
    await app.open();
    const rows = await screen.findAllByTestId(/^shift-row-/);
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'shift-row-2026-10-15-A',
      'shift-row-2026-10-14-C',
    ]);
    await waitFor(() => {
      expect(rows[0]?.dataset.status).toBe('running');
    });
    expect(rows[0]?.dataset.current).toBe('true');
    // Shift C of the day before has no stored instance.
    await waitFor(() => {
      expect(rows[1]?.dataset.status).toBe('none');
    });
    await app.push({
      type: 'shift',
      event: 'status',
      shift: shiftRecord({ status: 'ended' }),
    });
    expect(screen.getByTestId('shift-row-2026-10-15-A').dataset.status).toBe('ended');
    expect(
      screen.getByTestId(`shift-link-${SHIFT_KEY.replace('/', '-')}`).getAttribute('href'),
    ).toBe(PATH);
  });
});
