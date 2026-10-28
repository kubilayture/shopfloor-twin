import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kpiBucket } from '../test/alarm-fixtures.ts';
import { EPOCH, problem } from '../test/fixtures.ts';
import {
  PREVIOUS_SHIFT,
  SHIFT_END,
  SHIFT_KEY,
  SHIFT_START,
  bucket,
  record,
  result,
} from '../test/oee-fixtures.ts';
import { renderApp } from '../test/render-app.tsx';
import { auditEntry, note, report, shiftRecord } from '../test/shift-fixtures.ts';
import { memoryStorage, shiftMes, shiftState } from '../test/shift-mes.ts';
import { liveKeys, type LiveShifts } from '../live/live-cache.ts';
import { expectDecimals } from '../test/decimals.ts';
import { NA_REASON } from '../components/oee-ui.tsx';
import type { CURRENT_SHIFT } from '../test/oee-fixtures.ts';

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
  it('shows every section exactly as served, with a dash and its reason where there is no value', async () => {
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
    expect(screen.getByTestId('report-status').dataset.status).toBe('running');
    expect(screen.getByTestId('report-finality').textContent).toContain('Provisional');
    // R-05: the plant epoch is on screen, never printed.
    expect(screen.getByTestId('report-epoch').closest('.print\\:hidden')).not.toBeNull();
    // The filter bar's "Shift [select]" (design system 3.3), on the token Select.
    expect(screen.getByRole('combobox', { name: 'Shift' })).toBe(
      screen.getByTestId('shift-select'),
    );
    // R-01: the in-page index links to every section's heading.
    const index = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(index)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '#report-oee-title',
      '#report-production-title',
      '#report-downtime-title',
      '#report-alarms-title',
      '#report-crew-title',
      '#handover-title',
    ]);
    for (const link of within(index).getAllByRole('link')) {
      expect(document.getElementById(link.getAttribute('href')?.slice(1) ?? '')).not.toBeNull();
    }
    expect(screen.getByTestId('report-revision').textContent).toBe('inputs 0, content 0');
    expect(screen.getByTestId('report-as-of').querySelector('time')?.dateTime).toBe(
      '2026-10-15T06:10:00.000Z',
    );
    expect(screen.getByTestId('report-generated-at').querySelector('time')?.dateTime).toBe(
      '2026-10-16T08:30:00.000Z',
    );
    expect(screen.queryByTestId('report-revised')).toBeNull();

    // OEE: percentages, the API's four decimals in data-oee and data-decimal (R-02); null is a
    // dash with its reason; a machine without a bucket says it has no data.
    expect(screen.getByTestId('report-oee-wc-cell-m1').dataset.oee).toBe('0.6300');
    const cnc = screen.getByTestId('report-oee-machine-cnc-01');
    expect(cnc.dataset.oee).toBe('0.6300');
    expect(within(cnc).getByText('63.00 %')).toBeTruthy();
    const wsh = screen.getByTestId('report-oee-machine-wsh-01');
    expect(wsh.dataset.oee).toBe('n/a');
    expect(wsh.textContent).not.toContain('n/a');
    expect(wsh.querySelectorAll('[data-missing]').length).toBeGreaterThanOrEqual(2);
    expect(wsh.textContent).toContain(NA_REASON.oee);
    await waitFor(() => {
      expect(screen.getByTestId('report-oee-machine-asm-01').dataset.oee).toBe('n/a');
    });
    expect(screen.getByTestId('report-oee-wc-line-a1').textContent).toContain(
      'No data for this shift',
    );

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
    expect(measure(plant, 'raises')).toBe('14');
    expect(plant.textContent).toContain('2 high · 11 medium · 1 low');
    expect(measure(plant, 'active-time')).toBeTruthy();
    expect(measure(plant, 'average-rate')).toContain('0.2917');
    // The headline is a Ratio: its raw markers beside the figure, as on Alarm KPIs.
    expect(
      plant
        .querySelector('[data-measure="average-rate"] [data-decimal]')
        ?.getAttribute('data-decimal'),
    ).toBe('0.2917');
    // R-03: named as on Alarm KPIs.
    expect(within(plant).getByRole('heading', { level: 3 }).textContent).toBe('Plant');
    expect(
      within(screen.getByTestId('report-alarm-scope-position-cell-m1')).getByRole('heading', {
        level: 3,
      }).textContent,
    ).toBe('Cell M1');
    // Banded with the benchmarks the MES serves (#160): the headline's verdict.
    await waitFor(() => {
      expect(measure(plant, 'average-rate')).toContain('Acceptable (≤ 1 per 10 min)');
    });
    expect(plant.querySelector<HTMLElement>('[data-measure="average-rate"]')?.dataset.band).toBe(
      'acceptable',
    );
    // The labels name the served window (#147), 10 minutes here.
    expect(
      plant.querySelector('[data-measure="peak10"]')?.previousElementSibling?.textContent,
    ).toBe('Peak per 10 min');
    expect(within(plant).getByText('Average per 10 min')).toBeTruthy();
    expect(
      within(plant).getByTestId('report-bad-actor-plant-cnc-01-COOLANT-PRESSURE').dataset.raises,
    ).toBe('12');
    expect(measure(within(plant).getByTestId('report-operator-plant'), 'mean-time-to-ack')).toBe(
      '0.6 min',
    );
    const line = screen.getByTestId('report-alarm-scope-position-line-a1');
    expect(line.dataset.raises).toBe('n/a');
    expect(line.textContent).toContain('No alarm KPIs for this shift');
    expect(measure(line, 'peak10')).toBeUndefined();
    expect(measure(line, 'unacknowledged')).toBeUndefined();
    expect(screen.getByTestId('notes-empty')).toBeTruthy();

    // UX-1c (#315): every ratio element carries its raw four decimals, n/a included.
    expect(within(cnc).getByText('63.00 %').dataset.decimal).toBe('0.6300');
    expect(
      [...wsh.querySelectorAll<HTMLElement>('[data-decimal]')].map((e) => e.dataset.decimal),
    ).toContain('n/a');
    const share = within(plant)
      .getByTestId('report-bad-actor-plant-cnc-01-COOLANT-PRESSURE')
      .querySelector<HTMLElement>('[data-decimal]');
    expect(share?.dataset.decimal).toMatch(/^\d\.\d{4}$/);
    expect(expectDecimals(document.body).length).toBeGreaterThanOrEqual(8);
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
    // S-01: the state and the finality each said once, never "Final Final".
    expect(screen.getByTestId('report-status').textContent).toBe('Ended');
    expect(screen.getByTestId('report-status').dataset.status).toBe('final');
    expect(screen.getByTestId('report-finality').textContent).toBe('Final');
    expect(screen.getByTestId('report-final-at').textContent).toContain('(wall time)');
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
    // A shift the MES has no report of is a NotFound with the way back, not an alert.
    const missing = await screen.findByTestId('report-missing');
    expect(missing.textContent).toContain('No shift 2026-10-15/A');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Shift 2026-10-15/A');
    // The tab keeps the route's title; the not-found header sets none of its own (#393 F2).
    expect(document.title).toBe('Shift report 2026-10-15 A · ShopFloor Twin');
    const page = missing.closest('section');
    expect(
      page && within(page).getByRole('link', { name: '‹ Shift reports' }).getAttribute('href'),
    ).toBe('/shifts');
    view.unmount();

    const failing = shiftState({
      reportAnswer: () => problem(503, 'Service Unavailable', 'shifts are not available', '/x'),
    });
    vi.stubGlobal('fetch', shiftMes(failing).fetch);
    const again = await renderApp(PATH);
    const failure = await screen.findByTestId('report-error', {}, { timeout: 5_000 });
    expect(failure.textContent).toContain('Could not load the shift report');
    // The picker is a control: never printed, in this state too.
    expect(screen.getByTestId('shift-select').closest('.print\\:hidden')).not.toBeNull();
    // The page keeps its h1, named after the shift asked for.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Shift report: Thu 15 Oct, shift A',
    );
    again.unmount();

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

  it('lists the shifts as a table: state and finality said once, the revision only above 0 (S-01)', async () => {
    const state = shiftState();
    vi.stubGlobal('fetch', shiftMes(state).fetch);
    const app = await renderApp('/shifts');
    await app.open();
    const table = await screen.findByRole('table', { name: /Shifts of the last 7 days/ });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Shift', 'Time', 'State', 'Report']);
    const row = await screen.findByTestId('shift-row-2026-10-15-A');
    // The shift names the row and links to its report; the current one says so.
    const header = within(row).getByRole('rowheader');
    expect(within(header).getByRole('link').textContent).toBe('Thu 15 Oct, shift A');
    expect(header.textContent).toContain('Current');
    await waitFor(() => {
      expect(row.textContent).toContain('Running');
    });
    expect(row.textContent).toContain('Provisional');
    expect(row.textContent).toContain('06:00 – 14:00');
    expect(screen.getByTestId('shift-list-summary').textContent).toBe('2 shifts · 1 not final yet');
    // G-33 (UX-F1): a link before the list past the shifts to the note under it.
    const skip = screen.getByRole('link', { name: 'Skip past the shifts' });
    expect(skip.getAttribute('href')).toBe('#shift-list-note');
    expect(skip.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const note = screen.getByText(/A report is final once every input/);
    expect(note.id).toBe('shift-list-note');
    fireEvent.click(skip);
    expect(document.activeElement).toBe(note);

    // Final: "Ended" and "Final", never "Final Final"; a revision adds its column.
    await app.push({
      type: 'shift',
      event: 'revised',
      shift: shiftRecord({
        status: 'final',
        final: true,
        finalAt: '2026-10-16T09:00:00.000Z',
        revision: { inputs: 1, content: 2, contentAtFinal: 1 },
      }),
    });
    await waitFor(() => {
      expect(row.textContent).toContain('inputs 1, content 2');
    });
    expect(row.textContent).toContain('Ended');
    expect(row.textContent.match(/Final/g)).toHaveLength(1);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Shift', 'Time', 'State', 'Report', 'Revision']);
    // The row without a record says so, and why, in words.
    expect(screen.getByTestId('shift-row-2026-10-14-C').textContent).toContain('No record');
  });

  it('says when there is no shift yet', async () => {
    const state = shiftState();
    const server = shiftMes(state);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
      if (url.pathname === '/api/v1/shifts') {
        return Promise.resolve(
          new Response(JSON.stringify({ from: SHIFT_START, to: SHIFT_END, shifts: [] }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.pathname === '/api/v1/shifts/current') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clock: { epoch: EPOCH, watermark: SHIFT_START },
              shiftKey: null,
              shift: null,
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      return server.fetch(input, init);
    });
    await renderApp('/shifts');
    const empty = await screen.findByTestId('shift-list-empty');
    expect(empty.textContent).toContain('No shift yet');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the list loading, not "No shift yet", while the shifts are on their way (#339)', async () => {
    const server = shiftMes(shiftState());
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname ===
      '/api/v1/shifts'
        ? new Promise<Response>(() => undefined)
        : server.fetch(input, init),
    );
    await renderApp('/shifts');
    expect(await screen.findByText('Loading shifts…')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('shift-list-empty')).toBeNull();
  });

  it('keeps the table while a later plant hour reads the list again (#393 review F1)', async () => {
    const server = shiftMes(shiftState());
    let hold = false;
    const reads: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
      if (url.pathname === '/api/v1/shifts') {
        reads.push(url.search);
        if (hold) return new Promise<Response>(() => undefined);
      }
      return server.fetch(input, init);
    });
    const app = await renderApp('/shifts');
    expect(await screen.findByTestId('shift-list')).toBeTruthy();
    // The plant clock crosses the next full hour: the list's key moves and it is read again,
    // held here; the table stays, with no skeleton in its place.
    hold = true;
    const now = app.queryClient.getQueryData<typeof CURRENT_SHIFT>(['shifts', 'current']);
    const later = new Date(Date.parse(now?.clock.watermark ?? '') + 3_600_000).toISOString();
    await act(async () => {
      app.queryClient.setQueryData(['shifts', 'current'], {
        ...now,
        clock: { ...now?.clock, watermark: later },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(reads).toHaveLength(2);
    expect(screen.getByTestId('shift-list')).toBeTruthy();
    expect(screen.queryByText('Loading shifts…')).toBeNull();
  });
});
