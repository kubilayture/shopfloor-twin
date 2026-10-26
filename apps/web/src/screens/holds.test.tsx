import { PROBLEM_TYPES, type HoldDto, type HoldOpenRequest } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, sessionOf } from '../test/fixtures.ts';
import { HOLD_ID, HOLD_ID_2, at, hold, holdDetail, suggestion } from '../test/quality-fixtures.ts';
import { qualityMes, qualityState, type Write } from '../test/quality-mes.ts';
import { renderApp, settle } from '../test/render-app.tsx';

vi.mock('../chart/echarts-view.tsx', () => ({ EChartsView: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const QUALITY = sessionOf(['quality'], { username: 'quinn' });

describe('quality hold list', () => {
  it('lists holds with filters and follows pushes by id', async () => {
    const released = hold({
      id: HOLD_ID_2,
      subject: { kind: 'order', id: 'PO-1002' },
      state: 'released',
      openedAt: '2026-10-15T05:00:00.000Z',
      version: 2,
    });
    const state = qualityState({ holds: [hold(), released] });
    const server = qualityMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/holds');
    await app.open();
    const row = await screen.findByTestId(`hold-row-${HOLD_ID}`);
    expect(row.dataset.state).toBe('open');
    expect(within(row).getByTestId('hold-subject').getAttribute('href')).toBe('/trace/lots/K1');
    expect(
      within(screen.getByTestId(`hold-row-${HOLD_ID_2}`))
        .getByTestId('hold-subject')
        .getAttribute('href'),
    ).toBe('/orders/PO-1002');
    expect(screen.getByTestId('hold-open-link')).toBeTruthy();
    // A scope change pushed at the same version applies; an older version does not.
    await app.push({
      type: 'quality-hold',
      event: 'scope',
      hold: hold({ scope: { units: 5, cartons: 2, orders: 1 } }),
    });
    expect(screen.getByTestId(`hold-row-${HOLD_ID}`).dataset.units).toBe('5');
    // A hold opened elsewhere appears.
    const third = '0f0e0d0c-0b0a-4900-8800-000000000003';
    await app.push({
      type: 'quality-hold',
      event: 'opened',
      hold: hold({ id: third, subject: { kind: 'carton', id: 'PO-1001-C01' } }),
    });
    expect(screen.getByTestId(`hold-row-${third}`)).toBeTruthy();
    // The state filter goes to the MES and applies to pushed holds.
    fireEvent.change(screen.getByTestId('hold-filter-state'), { target: { value: 'released' } });
    await waitFor(() => {
      expect(screen.getByTestId('hold-list').dataset.count).toBe('1');
    });
    expect(server.calls.some((c) => c.path === '/api/v1/quality/holds?state=released')).toBe(true);
    // The subject filter.
    fireEvent.change(screen.getByTestId('hold-filter-kind'), { target: { value: 'order' } });
    fireEvent.change(screen.getByTestId('hold-filter-id'), { target: { value: 'no such id!' } });
    fireEvent.click(screen.getByTestId('hold-filter-apply'));
    expect(screen.getByTestId('hold-filter-problem')).toBeTruthy();
    fireEvent.change(screen.getByTestId('hold-filter-id'), { target: { value: 'PO-1002' } });
    fireEvent.click(screen.getByTestId('hold-filter-apply'));
    await waitFor(() => {
      expect(
        server.calls.some(
          (c) =>
            c.path === '/api/v1/quality/holds?state=released&subjectKind=order&subjectId=PO-1002',
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByTestId('hold-filter-clear'));
    await waitFor(() => {
      expect(app.history.location.search).not.toContain('kind');
    });
  });

  it('says when no hold matches, and shows no open link to an operator', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds', { session: sessionOf(['operator']) });
    expect(await screen.findByTestId('holds-empty')).toBeTruthy();
    expect(screen.queryByTestId('hold-open-link')).toBeNull();
  });
});

describe('opening a hold', () => {
  it('opens a hold on a subject from the URL and goes to its detail', async () => {
    const opened = hold({
      subject: { kind: 'serial', id: 'VB-100-000007' },
      scope: { units: 1, cartons: 0, orders: 1 },
    });
    const state = qualityState({ details: { [HOLD_ID]: holdDetail(opened) } });
    const write: Write = (_method, path, body) => {
      if (path === '/api/v1/quality/holds') {
        state.holds = [opened];
        return json({ ...opened, subject: (body as HoldOpenRequest).subject });
      }
      return problem(404, 'Not Found', 'no route', path);
    };
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/holds/new?kind=serial&id=VB-100-000007');
    await screen.findByTestId('hold-open-form');
    expect(screen.getByTestId<HTMLSelectElement>('open-kind').value).toBe('serial');
    expect(screen.getByTestId<HTMLInputElement>('open-id').value).toBe('VB-100-000007');
    await waitFor(() => {
      expect(screen.getByTestId<HTMLSelectElement>('open-reason').value).toBe('SUSPECT-LOT');
    });
    fireEvent.change(screen.getByTestId('open-comment'), { target: { value: 'scratched' } });
    fireEvent.click(screen.getByTestId('open-submit'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe(`/quality/holds/${HOLD_ID}`);
    });
    expect(server.posts().map((p) => p.body)).toEqual([
      {
        subject: { kind: 'serial', id: 'VB-100-000007' },
        reason: 'SUSPECT-LOT',
        comment: 'scratched',
      },
    ]);
    expect(await screen.findByTestId('hold-detail')).toBeTruthy();
  });

  it('checks the subject before sending, and shows a refusal', async () => {
    const write: Write = (_method, path) =>
      problem(404, 'Not Found', 'no lot K9 imported from the ERP', path);
    const server = qualityMes(qualityState(), write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/quality/holds/new', { session: QUALITY });
    await screen.findByTestId('hold-open-form');
    fireEvent.click(screen.getByTestId('open-submit'));
    expect(screen.getByTestId('open-invalid').textContent).toContain('valid id');
    expect(server.posts()).toEqual([]);
    fireEvent.change(screen.getByTestId('open-id'), { target: { value: 'K9' } });
    fireEvent.click(screen.getByTestId('open-submit'));
    const result = await screen.findByTestId('open-result-lot-K9');
    expect(result.dataset.kind).toBe('invalid');
    expect(within(result).getByTestId('open-message').textContent).toContain('no lot K9');
  });

  it('holds subjects from a signal’s suggested scope, one hold each; a resubmit never holds one twice', async () => {
    const state = qualityState({ suggestions: { 2: suggestion() } });
    let n = 0;
    let refuseCarton = true;
    const write: Write = (_method, _path, body) => {
      n += 1;
      const request = body as HoldOpenRequest;
      if (request.subject.kind === 'carton' && refuseCarton) {
        refuseCarton = false;
        return problem(409, 'Conflict', 'busy', '/api/v1/quality/holds');
      }
      const opened = hold({
        id: `0f0e0d0c-0b0a-4900-8800-00000000010${String(n)}`,
        subject: request.subject,
        reason: request.reason,
      });
      state.holds = [...state.holds, opened];
      return json(opened);
    };
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/quality/holds/new?signal=2', { session: QUALITY });
    const panel = await screen.findByTestId('hold-suggestion');
    expect(panel.dataset.final).toBe('false');
    expect(screen.getByTestId('hold-suggestion-provisional')).toBeTruthy();
    expect(screen.getByTestId('hold-suggestion-from').textContent).not.toBe('');
    // No subject chosen: nothing is sent.
    fireEvent.click(screen.getByTestId('open-submit'));
    expect(screen.getByTestId('open-invalid').textContent).toContain('at least one');
    fireEvent.click(screen.getByTestId('suggest-order-PO-1001'));
    fireEvent.click(screen.getByTestId('suggest-carton-PO-1001-C02'));
    fireEvent.click(screen.getByTestId('suggest-serial-VB-100-000102'));
    fireEvent.click(screen.getByTestId('suggest-serial-VB-100-000102'));
    expect(screen.getByTestId('open-submit').textContent).toBe('Open 2 holds');
    fireEvent.change(screen.getByTestId('open-reason'), { target: { value: 'SPC-SIGNAL' } });
    fireEvent.click(screen.getByTestId('open-submit'));
    expect((await screen.findByTestId('open-result-order-PO-1001')).dataset.kind).toBe('opened');
    expect(screen.getByTestId('open-result-carton-PO-1001-C02').dataset.kind).toBe('conflict');
    expect(server.posts().map((p) => p.body)).toEqual([
      { subject: { kind: 'order', id: 'PO-1001' }, reason: 'SPC-SIGNAL' },
      { subject: { kind: 'carton', id: 'PO-1001-C02' }, reason: 'SPC-SIGNAL' },
    ]);
    // The order opened: it is no longer chosen, so sending again retries only the carton.
    expect(screen.getByTestId<HTMLInputElement>('suggest-order-PO-1001').checked).toBe(false);
    expect(screen.getByTestId('open-submit').textContent).toBe('Open 1 hold');
    fireEvent.click(screen.getByTestId('open-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('open-result-carton-PO-1001-C02').dataset.kind).toBe('opened');
    });
    expect(server.posts().map((p) => p.body)).toHaveLength(3);
    expect(server.posts()[2]?.body).toEqual({
      subject: { kind: 'carton', id: 'PO-1001-C02' },
      reason: 'SPC-SIGNAL',
    });
    // Chosen again by hand, the order already has an open hold: skipped until confirmed.
    fireEvent.click(screen.getByTestId('suggest-order-PO-1001'));
    fireEvent.click(screen.getByTestId('open-submit'));
    expect(await screen.findByTestId('open-existing-order-PO-1001')).toBeTruthy();
    expect(server.posts()).toHaveLength(3);
    fireEvent.click(screen.getByTestId('open-skip'));
    expect(screen.queryByTestId('open-existing')).toBeNull();
    fireEvent.click(screen.getByTestId('open-submit'));
    fireEvent.click(await screen.findByTestId('open-confirm'));
    await waitFor(() => {
      expect(server.posts()).toHaveLength(4);
    });
    expect(server.posts()[3]?.body).toEqual({
      subject: { kind: 'order', id: 'PO-1001' },
      reason: 'SPC-SIGNAL',
    });
  });

  it('shows the hold that exists already when the MES refuses a duplicate (409 hold-exists)', async () => {
    const write: Write = (_method, path) =>
      new Response(
        JSON.stringify({
          type: PROBLEM_TYPES.holdExists,
          title: 'Conflict',
          status: 409,
          detail: 'an open hold exists already',
          instance: path,
          holds: [HOLD_ID],
        }),
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      );
    vi.stubGlobal('fetch', qualityMes(qualityState(), write).fetch);
    await renderApp('/quality/holds/new?kind=lot&id=K1', { session: QUALITY });
    await screen.findByTestId('hold-open-form');
    fireEvent.click(screen.getByTestId('open-submit'));
    const result = await screen.findByTestId('open-result-lot-K1');
    expect(result.dataset.kind).toBe('exists');
    expect(
      within(result).getByTestId('open-message-holds').querySelector('a')?.getAttribute('href'),
    ).toBe(`/quality/holds/${HOLD_ID}`);
  });

  it('says when the signal suggests nothing (unknown or withdrawn)', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds/new?signal=9', { session: QUALITY });
    expect(await screen.findByTestId('hold-suggestion-missing')).toBeTruthy();
  });

  it('refuses the form to a role without quality:hold', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds/new?kind=lot&id=K1', { session: sessionOf(['operator']) });
    expect(await screen.findByTestId('hold-open-forbidden')).toBeTruthy();
  });
});

describe('a hold’s wall-clock times (#295)', () => {
  // Wall times a week after the plant clock, as in the demo: never written like plant time.
  const WALL = '2026-10-22T07:12:03.000Z';
  const DECIDED = '2026-10-22T08:00:00.000Z';

  it('labels opened, decided, transitions and units as wall time, the plant clock beside', async () => {
    const decided = hold({
      state: 'released',
      openedAt: WALL,
      decidedBy: 'quinn',
      decidedAt: DECIDED,
      decidedPlantAt: at(130),
      decisionReason: 'CONFORMS',
    });
    const state = qualityState({ details: { [HOLD_ID]: holdDetail(decided) } });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    const app = await renderApp(`/quality/holds/${HOLD_ID}`);
    await app.open();
    await screen.findByTestId('hold-summary');
    expect(screen.getByTestId('hold-opened').textContent).toBe(
      'quinn, Thu 22 Oct, 10:12:03 (wall time)',
    );
    expect(screen.getByTestId('hold-decided').textContent).toBe(
      'quinn, Thu 22 Oct, 11:00:00 (wall time) (plant Thu 15 Oct, 09:10:00) (CONFORMS)',
    );
    expect(screen.getByTestId('hold-transition-at').textContent).toBe(
      'Thu 22 Oct, 10:12:03 (wall time) (plant Thu 15 Oct, 08:50:00)',
    );
    expect(screen.getByTestId('hold-unit-1-7').textContent).toContain(
      'Thu 15 Oct, 08:50:00 (wall time)',
    );
  });

  it('lists a hold at its plant time, or at its wall time, labelled, without one', async () => {
    const state = qualityState({
      holds: [hold({ openedAt: WALL, openedPlantAt: null })],
    });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    const app = await renderApp('/quality/holds');
    await app.open();
    const row = await screen.findByTestId(`hold-row-${HOLD_ID}`);
    expect(row.textContent).toContain('quinn, Thu 22 Oct, 10:12:03 (wall time)');
  });
});

describe('a hold’s detail', () => {
  it('shows scope, transitions with notifications and incidents, live', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    const server = qualityMes(state);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/quality/holds/${HOLD_ID}`);
    await app.open();
    const summary = await screen.findByTestId('hold-summary');
    expect(summary.dataset.state).toBe('open');
    expect(screen.getByTestId('hold-scope-counts').dataset.units).toBe('2');
    expect(screen.getByTestId('hold-unit-1-7')).toBeTruthy();
    expect(screen.getByTestId('hold-transition-1').dataset.notification).toBe('sent');
    expect(screen.getByTestId('hold-incident-4')).toBeTruthy();
    // Detected is a wall-clock time: labelled so (#295 review).
    expect(screen.getByTestId('hold-incident-4').textContent).toContain(
      'Thu 15 Oct, 08:51:00 (wall time)',
    );
    expect(screen.getByTestId('hold-consumed').textContent).toBe('0');
    // A scope push applies at once and reads the detail again.
    const reads = server.reads(`/api/v1/quality/holds/${HOLD_ID}`).length;
    state.details[HOLD_ID] = {
      ...holdDetail(hold({ scope: { units: 3, cartons: 1, orders: 1 } })),
    };
    await app.push({
      type: 'quality-hold',
      event: 'scope',
      hold: hold({ scope: { units: 3, cartons: 1, orders: 1 } }),
    });
    expect(screen.getByTestId('hold-scope-counts').dataset.units).toBe('3');
    await waitFor(() => {
      expect(server.reads(`/api/v1/quality/holds/${HOLD_ID}`).length).toBeGreaterThan(reads);
    });
    // A supervisor comments but cannot release or reject.
    expect(screen.getByTestId('hold-action-comment')).toBeTruthy();
    expect(screen.queryByTestId('hold-action-release')).toBeNull();
  });

  it('releases with a reason and the version read; a push that moves the hold makes the draft stale', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    const write: Write = (_method, path, body) => {
      const request = body as { version: number; reason: string };
      if (request.version !== 2) {
        return problem(409, 'Conflict', 'stale', path, PROBLEM_TYPES.holdStale);
      }
      const answer: HoldDto = hold({
        state: 'released',
        version: 3,
        decidedBy: 'quinn',
        decidedAt: '2026-10-15T06:00:00.000Z',
        decisionReason: request.reason,
        transitions: 3,
      });
      state.details[HOLD_ID] = holdDetail(answer);
      return json(answer);
    };
    const server = qualityMes(state, write);
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/quality/holds/${HOLD_ID}`, { session: QUALITY });
    await app.open();
    fireEvent.click(await screen.findByTestId('hold-action-release'));
    const form = screen.getByTestId('hold-form-release');
    expect(form.dataset.version).toBe('1');
    await waitFor(() => {
      expect(screen.getByTestId<HTMLSelectElement>('hold-reason').value).toBe('CONFORMS');
    });
    // Someone comments meanwhile: version 2.
    await app.push({
      type: 'quality-hold',
      event: 'commented',
      hold: hold({ version: 2, transitions: 2 }),
    });
    expect(screen.getByTestId('hold-stale').dataset.version).toBe('2');
    expect(screen.getByTestId<HTMLButtonElement>('hold-submit').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('hold-restart'));
    fireEvent.change(screen.getByTestId('hold-comment'), { target: { value: 'retested fine' } });
    fireEvent.click(screen.getByTestId('hold-submit'));
    expect((await screen.findByTestId('hold-done')).textContent).toContain('released');
    expect(screen.getByTestId('hold-summary').dataset.state).toBe('released');
    expect(screen.queryByTestId('hold-action-release')).toBeNull();
    expect(server.posts().map((p) => [p.path, p.body])).toEqual([
      [
        `/api/v1/quality/holds/${HOLD_ID}/release`,
        { version: 2, reason: 'CONFORMS', comment: 'retested fine' },
      ],
    ]);
  });

  it('shows a decision refused because the hold was decided meanwhile, and reads it again', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    const write: Write = (_method, path) => {
      state.details[HOLD_ID] = holdDetail(
        hold({ state: 'rejected', version: 2, decisionReason: 'NONCONFORMING' }),
      );
      return problem(409, 'Conflict', 'decided', path, PROBLEM_TYPES.holdDecided);
    };
    vi.stubGlobal('fetch', qualityMes(state, write).fetch);
    await renderApp(`/quality/holds/${HOLD_ID}`, { session: QUALITY });
    fireEvent.click(await screen.findByTestId('hold-action-reject'));
    fireEvent.click(screen.getByTestId('hold-submit'));
    const message = await screen.findByTestId('hold-message');
    expect(message.dataset.kind).toBe('decided');
    await waitFor(() => {
      expect(screen.getByTestId('hold-summary').dataset.state).toBe('rejected');
    });
    expect(screen.getByTestId('hold-stale')).toBeTruthy();
  });

  it('needs a comment for a comment', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    const server = qualityMes(state, () => json(hold({ version: 2, transitions: 2 })));
    vi.stubGlobal('fetch', server.fetch);
    await renderApp(`/quality/holds/${HOLD_ID}`, { session: QUALITY });
    fireEvent.click(await screen.findByTestId('hold-action-comment'));
    fireEvent.click(screen.getByTestId('hold-submit'));
    expect(screen.getByTestId('hold-invalid')).toBeTruthy();
    fireEvent.change(screen.getByTestId('hold-comment'), { target: { value: 'sorting started' } });
    fireEvent.click(screen.getByTestId('hold-submit'));
    expect(await screen.findByTestId('hold-done')).toBeTruthy();
    expect(server.posts()[0]?.body).toEqual({ version: 1, comment: 'sorting started' });
  });

  it('is read-only for an operator and answers an unknown hold', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    const app = await renderApp(`/quality/holds/${HOLD_ID}`, { session: sessionOf(['operator']) });
    expect(await screen.findByTestId('hold-read-only')).toBeTruthy();
    await settle(() => {
      app.history.push(`/quality/holds/${HOLD_ID_2}`);
    });
    expect(await screen.findByTestId('hold-missing')).toBeTruthy();
    await settle(() => {
      app.history.push('/quality/holds/not-a-hold');
    });
    expect(await screen.findByTestId('hold-missing')).toBeTruthy();
  });
});

describe('the holds screens on the design system (UX-9b, #333)', () => {
  it('heads the list with its primary action, labelled filters and a count; Enter applies the subject', async () => {
    const server = qualityMes(
      qualityState({
        holds: [hold(), hold({ id: HOLD_ID_2, state: 'released', version: 2 })],
      }),
    );
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp('/quality/holds', { session: QUALITY });
    await screen.findByTestId(`hold-row-${HOLD_ID}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Quality holds' })).toBeTruthy();
    // H-01: "Open a hold" is the page's one primary action.
    const open = screen.getByRole('link', { name: 'Open a hold' });
    expect(open.getAttribute('href')).toBe('/quality/holds/new');
    expect(open.className).toContain('bg-accent');
    expect(screen.getByText('2 holds')).toBeTruthy();
    // An open hold blocks: its row has the alarm bar; a released one has none.
    const bar = (id: string) =>
      screen.getByTestId(`hold-row-${id}`).querySelector('[data-cell="c-subject"]')?.className;
    expect(bar(HOLD_ID)).toContain('inset_3px_0_0_var(--color-alarm-border)');
    expect(bar(HOLD_ID_2)).not.toContain('inset_3px');
    // Each row's link names its hold.
    expect(
      within(screen.getByTestId(`hold-row-${HOLD_ID}`)).getByRole('link', {
        name: 'Details of the hold on Lot K1',
      }),
    ).toBe(screen.getByTestId(`hold-link-${HOLD_ID}`));
    // H-02: the filters are inline label and control pairs.
    expect(screen.getByLabelText('State')).toBe(screen.getByTestId('hold-filter-state'));
    expect(screen.getByLabelText('Subject')).toBe(screen.getByTestId('hold-filter-kind'));
    expect(screen.getByLabelText('Subject id')).toBe(screen.getByTestId('hold-filter-id'));
    // The subject filter is a search form: Enter in the id applies it.
    fireEvent.change(screen.getByTestId('hold-filter-id'), { target: { value: 'K1' } });
    fireEvent.submit(screen.getByRole('search', { name: 'One subject’s holds' }));
    await waitFor(() => {
      expect(app.history.location.search).toContain('id=K1');
    });
    // A bad id is said once, tied to the field.
    fireEvent.change(screen.getByTestId('hold-filter-id'), { target: { value: 'no such id!' } });
    fireEvent.submit(screen.getByRole('search', { name: 'One subject’s holds' }));
    const problem = screen.getByTestId('hold-filter-problem');
    expect(problem.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('hold-filter-id').getAttribute('aria-describedby')).toContain(
      problem.id,
    );
  });

  it('gives the empty list its action: open a hold, or show every hold when filtered', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds', { session: QUALITY });
    const empty = await screen.findByTestId('holds-empty');
    expect(empty.textContent).toContain('No quality hold yet');
    expect(within(empty).getByRole('link', { name: 'Open a hold' }).getAttribute('href')).toBe(
      '/quality/holds/new',
    );
  });

  it('clears the filters from the empty state of a filtered list', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    const app = await renderApp('/quality/holds?state=rejected');
    const empty = await screen.findByTestId('holds-empty');
    expect(empty.textContent).toContain('No hold matches these filters');
    fireEvent.click(within(empty).getByRole('link', { name: 'Show every hold' }));
    await waitFor(() => {
      expect(app.history.location.search).toBe('');
    });
  });

  it('puts the new-hold form on fields with the reasons in full (H-05)', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds/new?kind=lot&id=K1', { session: QUALITY });
    await screen.findByTestId('hold-open-form');
    expect(screen.getByRole('heading', { level: 1, name: 'Open a quality hold' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '‹ All holds' }).getAttribute('href')).toBe(
      '/quality/holds',
    );
    const reason = screen.getByLabelText<HTMLSelectElement>('Reason');
    expect(reason).toBe(screen.getByTestId('open-reason'));
    await waitFor(() => {
      expect([...reason.options].map((o) => o.textContent)).toEqual([
        'Suspect lot (SUSPECT-LOT)',
        'SPC signal (SPC-SIGNAL)',
      ]);
    });
    // No width cap that cuts the option text.
    expect(reason.className).not.toContain('max-w-md');
    expect(screen.getByLabelText('Lot id')).toBe(screen.getByTestId('open-id'));
    expect(screen.getByLabelText('Comment')).toBe(screen.getByTestId('open-comment'));
    // Every control has a name (G-23).
    expect(screen.getByTestId('open-id').getAttribute('name')).toBe('id');
    expect(reason.getAttribute('name')).toBe('reason');
  });

  it('refuses the form under its header, naming the permission', async () => {
    vi.stubGlobal('fetch', qualityMes(qualityState()).fetch);
    await renderApp('/quality/holds/new', { session: sessionOf(['operator']) });
    const forbidden = await screen.findByTestId('hold-open-forbidden');
    expect(forbidden.textContent).toContain('quality:hold');
    expect(screen.getByRole('heading', { level: 1, name: 'Open a quality hold' })).toBeTruthy();
    expect(screen.queryByTestId('hold-open-form')).toBeNull();
  });

  it('heads the detail with the subject, its state, the way back and the actions in order', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp(`/quality/holds/${HOLD_ID}`, { session: QUALITY });
    await screen.findByTestId('hold-summary');
    expect(screen.getByRole('heading', { level: 1, name: 'Hold on Lot K1' })).toBeTruthy();
    expect(document.title).toBe('Hold on Lot K1 · ShopFloor Twin');
    // H-04: the way back to the list.
    expect(screen.getByRole('link', { name: '‹ All holds' }).getAttribute('href')).toBe(
      '/quality/holds',
    );
    const detail = screen.getByTestId('hold-detail');
    expect([detail.dataset.state, detail.dataset.subject]).toEqual(['open', 'lot:K1']);
    // Comment, then the decisions, release (the primary) last.
    const actions = screen
      .getAllByRole('button')
      .filter((b) => b.dataset.testid?.startsWith('hold-action-'));
    expect(actions.map((b) => b.textContent)).toEqual(['Comment', 'Reject', 'Release']);
    expect(screen.getByTestId('hold-action-release').className).toContain('bg-accent');
    expect(screen.getByTestId('hold-action-reject').className).toContain('alarm');
    // The page's sections, with an index to them; the units, the longest, last.
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '#hold-scope-title',
      '#hold-history-title',
      '#hold-incidents-title',
      '#hold-units-title',
    ]);
    const headings = within(detail)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Scope',
      'Transitions and comments',
      'Held material consumed',
      'Units in the scope',
    ]);
  });

  it('shows the scope counts as figures and links each order and carton once', async () => {
    const state = qualityState({
      details: { [HOLD_ID]: holdDetail(hold({ heldMaterialConsumed: 3 })) },
    });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp(`/quality/holds/${HOLD_ID}`);
    const counts = await screen.findByTestId('hold-scope-counts');
    const figures = [...counts.querySelectorAll('dl')].map((dl) => [
      dl.querySelector('dt')?.textContent,
      dl.querySelector('[data-value]')?.getAttribute('data-value'),
    ]);
    expect(figures).toEqual([
      ['Units', '2'],
      ['Cartons', '1'],
      ['Orders', '1'],
      ['Held material consumed', '3'],
    ]);
    // A consumed held lot is the one abnormal figure; the counts stay neutral.
    expect(screen.getByTestId('hold-consumed').className).toContain('text-warn-ink');
    expect(within(counts).getByText('2').className).not.toContain('text-warn-ink');
    expect(screen.getByTestId('hold-orders').textContent).toBe('PO-1001');
    expect(within(screen.getByTestId('hold-orders')).getByRole('link').getAttribute('href')).toBe(
      '/orders/PO-1001',
    );
    // One link per unit row, its serial; the order and carton are linked once, above (G-33).
    const row = screen.getByTestId('hold-unit-1-7');
    expect(
      within(row)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['VB-100-000007']);
    expect(row.textContent).toContain('PO-1001-C01');
    // A unit with no serial yet says why, not a bare dash.
    expect(within(screen.getByTestId('hold-unit-1-8')).getByText('No serial yet')).toBeTruthy();
  });

  it('closes an action form with Escape or Cancel, the focus back on its button', async () => {
    const state = qualityState({ details: { [HOLD_ID]: holdDetail() } });
    vi.stubGlobal('fetch', qualityMes(state).fetch);
    await renderApp(`/quality/holds/${HOLD_ID}`, { session: QUALITY });
    fireEvent.click(await screen.findByTestId('hold-action-reject'));
    const form = screen.getByTestId('hold-form-reject');
    expect(document.activeElement).toBe(form);
    expect(within(form).getByRole('heading', { level: 2, name: 'Reject' })).toBeTruthy();
    expect(screen.getByTestId('hold-submit').className).toContain('alarm');
    // The buttons give way to the form while it is open.
    expect(screen.queryByTestId('hold-action-release')).toBeNull();
    fireEvent.keyDown(form, { key: 'Escape' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('hold-action-reject'));
    });
    fireEvent.click(screen.getByTestId('hold-action-comment'));
    fireEvent.click(screen.getByTestId('hold-cancel'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('hold-action-comment'));
    });
  });

  it('answers an unknown hold and an id that cannot be one with the not-found page (G-21)', async () => {
    const server = qualityMes(qualityState());
    vi.stubGlobal('fetch', server.fetch);
    const app = await renderApp(`/quality/holds/${HOLD_ID_2}`);
    const missing = await screen.findByTestId('hold-missing');
    expect(missing.textContent).toContain('The MES has no hold with this id.');
    expect(screen.getByRole('heading', { level: 1, name: `Hold ${HOLD_ID_2}` })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All holds' }).getAttribute('href')).toBe(
      '/quality/holds',
    );
    await settle(() => {
      app.history.push('/quality/holds/not-a-hold');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Hold not-a-hold' })).toBeTruthy();
    expect(screen.getByTestId('hold-missing')).toBeTruthy();
    // An id that cannot be a hold is never asked for.
    expect(server.reads('/api/v1/quality/holds/not-a-hold')).toEqual([]);
  });
});
