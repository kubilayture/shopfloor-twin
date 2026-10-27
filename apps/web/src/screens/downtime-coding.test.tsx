import type { DowntimeRecordDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EQUIPMENT, PLANT, json, problem, sessionOf } from '../test/fixtures.ts';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openRecord() {
  const row = await screen.findByTestId(`downtime-row-${UNCODED.id}`);
  fireEvent.click(within(row).getByRole('button', { name: /^(Code|View) / }));
  return screen.findByTestId('coding-panel');
}

describe('downtime coding', () => {
  it('lists uncoded records first and codes a split with a reason and a comment', async () => {
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
    // The history from the audit; a legacy entry written before login says so.
    const entry = await within(panel).findByTestId('audit-entry');
    expect(entry.textContent).toContain('Mehmet (not authenticated)');

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
    // No name to type: the MES records the session's user (#170).
    expect(within(panel).queryByTestId('coded-by')).toBeNull();
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
      version: 3,
    });
    expect(put?.body).not.toHaveProperty('codedBy');
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
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    fireEvent.change(within(panel).getByTestId('segment-comment'), {
      target: { value: 'y'.repeat(501) },
    });
    fireEvent.click(within(panel).getByTestId('save-coding'));
    expect(within(panel).getByTestId('coding-errors').textContent).toContain('500 characters');
    fireEvent.change(within(panel).getByTestId('split-at'), { target: { value: '09:00' } });
    fireEvent.click(within(panel).getByTestId('split'));
    expect(within(panel).getByText(/inside the record/)).toBeTruthy();
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('on 409 reads the records again and says the codings changed', async () => {
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
    fireEvent.keyDown(within(panel).getByTestId('reason-picker'), { key: 'Escape' });
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
    expect(screen.getByText('No uncoded downtime in this shift')).toBeTruthy();
  });

  it.each([
    ['admin', sessionOf(['admin'])],
    ['quality', sessionOf(['quality'])],
  ])('shows the record and its history but no coding form to a %s', async (_role, session) => {
    const server = mes(
      () => json({}),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime', { session });
    const panel = await openRecord();
    expect(within(panel).getByTestId('coding-not-allowed').textContent).toContain(
      'cannot code downtime',
    );
    expect(await within(panel).findByTestId('audit-entry')).toBeTruthy();
    expect(within(panel).queryByTestId('save-coding')).toBeNull();
    expect(within(panel).queryByTestId('reason-picker')).toBeNull();
    expect(within(panel).queryByTestId('split')).toBeNull();
  });

  it('shows no "(not authenticated)" for a coding written with a session', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED],
    );
    const legacy = server.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await legacy(input, init);
      if (!requestUrl(input).endsWith('/audit')) return response;
      const body = (await response.json()) as { entries: { authenticated: boolean }[] };
      return json({
        ...body,
        entries: body.entries.map((entry) => ({ ...entry, authenticated: true })),
      });
    });
    await renderApp('/downtime');
    const panel = await openRecord();
    const entry = await within(panel).findByTestId('audit-entry');
    expect(entry.textContent).toContain('by Mehmet at');
    expect(entry.textContent).not.toContain('not authenticated');
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

describe('downtime coding on the design system (UX-5a, #326)', () => {
  it('shows states and losses as badges, uncoded rows with a bar and a badge, lengths by the rule', async () => {
    const open = record({
      id: 'cnc-01~1790000000~3',
      start: '2026-10-15T05:00:00.000Z',
      end: null,
    });
    const server = mes(
      () => json({}),
      () => [{ ...UNCODED, cause: 'E-4711' }, CODED, open],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const row = await screen.findByTestId(`downtime-row-${UNCODED.id}`);
    const cell = (element: HTMLElement, name: string) =>
      element.querySelector<HTMLElement>(`[data-cell="c-${name}"]`);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Machine',
      'From',
      'Length',
      'State',
      'Loss',
      'Reason',
      'Actions',
    ]);
    // The machine names its row; times and lengths keep to one line (D-01).
    expect(within(row).getByRole('rowheader').textContent).toBe('Machine cnc-01');
    expect(cell(row, 'from')?.className).toContain('whitespace-nowrap');
    expect(cell(row, 'length')?.className).toContain('whitespace-nowrap');
    expect(cell(row, 'length')?.textContent).toBe('10 min');
    // The state is the badge every screen shows; the loss a badge too (D-02).
    expect(cell(row, 'state')?.querySelector('[data-state]')?.getAttribute('data-state')).toBe(
      'Down',
    );
    expect(cell(row, 'state')?.textContent).toBe('DownE-4711');
    expect(cell(row, 'loss')?.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('own');
    // Uncoded time: a warn bar and an "Uncoded" badge; a coded record has neither.
    expect(cell(row, 'machine')?.className).toContain('var(--color-warn-border)');
    expect(cell(row, 'reason')?.textContent).toBe('Uncoded');
    const coded = screen.getByTestId(`downtime-row-${CODED.id}`);
    expect(cell(coded, 'machine')?.className).not.toContain('var(--color-warn-border)');
    expect(cell(coded, 'reason')?.textContent).toBe('Tool change');
    // An open record says so beside its length so far.
    expect(cell(screen.getByTestId(`downtime-row-${open.id}`), 'length')?.textContent).toBe(
      '5 min (open)',
    );
  });

  it('says "View" to a role that cannot code, "Code" to one that can (D-04)', async () => {
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED],
      ).fetch,
    );
    await renderApp('/downtime', { session: sessionOf(['quality']) });
    const action = await screen.findByTestId(`code-${UNCODED.id}`);
    expect(action.textContent).toBe('View');
    expect(action.getAttribute('aria-label')).toBe('View Machine cnc-01 at 07:00:00');
    fireEvent.click(action);
    const panel = await screen.findByTestId('coding-panel');
    expect(within(panel).getByTestId('coding-not-allowed').getAttribute('role')).toBeNull();
  });

  it('labels the action "Code" with the machine and the time for a role that codes', async () => {
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED],
      ).fetch,
    );
    await renderApp('/downtime');
    const action = await screen.findByTestId(`code-${UNCODED.id}`);
    expect(action.textContent).toBe('Code');
    expect(action.getAttribute('aria-label')).toBe('Code Machine cnc-01 at 07:00:00');
  });

  it('opens a side panel from 1440 px after a skip link, the full-width table otherwise (G-26, G-33)', async () => {
    stubWidth(1440);
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [{ ...UNCODED, cause: 'E-4711' }, CODED],
      ).fetch,
    );
    await renderApp('/downtime');
    await screen.findByTestId(`downtime-row-${UNCODED.id}`);
    // Nothing chosen: no empty pane beside the table, nothing to skip to.
    expect(screen.queryByTestId('coding-panel')).toBeNull();
    expect(screen.queryByText(/Choose a record/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Skip to the details' })).toBeNull();
    const panel = await openRecord();
    expect(panel.tagName).toBe('SECTION');
    expect(panel.dataset.variant).toBe('panel');
    expect(panel.dataset.record).toBe(UNCODED.id);
    const title = within(panel).getByRole('heading', { level: 2 });
    expect(title.textContent).toBe('Machine cnc-01: Down');
    expect(document.activeElement).toBe(title);
    const skip = screen.getByRole('link', { name: 'Skip to the details' });
    expect(skip.getAttribute('href')).toBe(`#${title.id}`);
    // The skip link comes before the table, so the Tab run through its rows can be skipped.
    expect(
      skip.compareDocumentPosition(screen.getByTestId('downtime-table')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    title.blur();
    fireEvent.click(skip);
    expect(document.activeElement).toBe(title);
    // Beside the panel the loss and the cause code leave the table (the panel shows them).
    const state = screen
      .getByTestId(`downtime-row-${UNCODED.id}`)
      .querySelector<HTMLElement>('[data-cell="c-state"]');
    expect(state?.textContent).toBe('Down');
    expect(state?.className).toContain('whitespace-nowrap');
    expect(within(panel).getByText('E-4711')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).not.toContain(
      'Loss',
    );
    expect(screen.getByTestId(`downtime-row-${UNCODED.id}`).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(within(panel).getByText('Own')).toBeTruthy();
  });

  it('opens a side sheet below 1440 px (1280 included) with the same test ids', async () => {
    stubWidth(1280);
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED, CODED],
      ).fetch,
    );
    await renderApp('/downtime');
    const action = await screen.findByTestId(`code-${CODED.id}`);
    action.focus();
    fireEvent.click(action);
    const sheet = await screen.findByTestId('coding-panel');
    expect(sheet.tagName).toBe('DIALOG');
    expect(sheet.dataset.variant).toBe('sheet');
    expect(sheet.dataset.record).toBe(CODED.id);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(screen.queryByRole('link', { name: 'Skip to the details' })).toBeNull();
    expect(within(sheet).getAllByTestId('reason-picker')).toHaveLength(1);
    fireEvent.click(within(sheet).getByTestId('close-coding'));
    await waitFor(() => {
      expect(screen.queryByTestId('coding-panel')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`code-${CODED.id}`));
    });
  });

  it('stacks each record as a card with a 44 px action at 390 px', async () => {
    stubWidth(390);
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED],
      ).fetch,
    );
    await renderApp('/downtime');
    const row = await screen.findByTestId(`downtime-row-${UNCODED.id}`);
    expect(row.tagName).toBe('LI');
    expect(row.dataset.uncoded).toBe('true');
    expect(within(row).getByTestId(`code-${UNCODED.id}`).className).toContain('min-h-11');
  });

  it('splits at a plant time on PlantTimeInput: Enter splits, a time outside the record is refused', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    const time = within(panel).getByTestId<HTMLInputElement>('split-at');
    expect(time.type).toBe('text');
    expect(time.placeholder).toBe('hh:mm:ss');
    expect(within(panel).getByRole('group', { name: /^Split at, plant time in / })).toBeTruthy();
    // The record's start is not inside it: a split there would leave an empty segment.
    fireEvent.change(time, { target: { value: '07:00:00' } });
    fireEvent.click(within(panel).getByTestId('split'));
    expect(within(panel).getByText(/inside the record/)).toBeTruthy();
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(within(panel).getAllByTestId('reason-picker')).toHaveLength(1);
    // Enter in the time box splits, and does not save the form.
    fireEvent.change(time, { target: { value: '07:04:30' } });
    expect(within(panel).getByTestId('split-at-utc').textContent).toBe('= 2026-10-15 04:04:30 UTC');
    fireEvent.keyDown(time, { key: 'Enter' });
    expect(within(panel).getAllByTestId('reason-picker')).toHaveLength(2);
    expect(within(panel).getByTestId('segment-0').textContent).toContain('07:00:00 – 07:04:30');
    expect(time.value).toBe('');
    expect(within(panel).queryByText(/inside the record/)).toBeNull();
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('indents child reasons with non-breaking spaces, so the select shows the tree', async () => {
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED],
      ).fetch,
    );
    await renderApp('/downtime');
    const panel = await openRecord();
    const texts = within(within(panel).getByTestId('reason-picker'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(texts).toContain('  Tool change');
    expect(texts).toContain('Setup');
  });

  it('sends one write for two quick saves, and keeps both buttons busy meanwhile', async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = mes(
      () => json({}),
      () => [
        {
          ...UNCODED,
          codings: [
            {
              from: UNCODED.start,
              to: UNCODED.end ?? UNCODED.start,
              reason: 'SETUP',
              comment: '',
              codedBy: 'B',
              codedAt: '2026-10-16T08:00:00.000Z',
              version: 3,
            },
          ],
        },
      ],
    );
    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? (server.calls.push({ method: 'PUT', path: '', body: null }),
          new Promise<Response>((resolve) => {
            answer = resolve;
          }))
        : server.fetch(input, init);
    vi.stubGlobal('fetch', fetch);
    await renderApp('/downtime');
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    const form = within(panel).getByRole('form', { name: /^Coding of cnc-01 at / });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => {
      expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(within(panel).getByTestId('save-coding').getAttribute('aria-busy')).toBe('true');
    });
    expect(within(panel).getByTestId('clear-coding').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(panel).getByTestId('clear-coding'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    answer(json({ record: { ...UNCODED, version: 4 }, version: 4 }));
    expect(await within(panel).findByTestId('coding-message')).toBeTruthy();
  });

  it('moves the focus to the next row when the coded record left "Only uncoded" and its detail closes', async () => {
    const other = record({
      id: 'cnc-01~1790000000~9',
      start: '2026-10-15T05:00:00.000Z',
      end: '2026-10-15T05:05:00.000Z',
    });
    let records = [UNCODED, other];
    const coded = {
      ...UNCODED,
      uncoded: false,
      reason: 'SETUP',
      version: 4,
      codings: [
        {
          from: UNCODED.start,
          to: UNCODED.end ?? UNCODED.start,
          reason: 'SETUP',
          comment: '',
          codedBy: 'Ayşe K.',
          codedAt: '2026-10-16T08:00:00.000Z',
          version: 4,
        },
      ],
    };
    const server = mes(
      () => {
        records = [other];
        return json({ record: coded, version: 4 });
      },
      () => records,
    );
    vi.stubGlobal('fetch', server.fetch);
    await renderApp('/downtime?uncoded=true');
    const panel = await openRecord();
    fireEvent.change(within(panel).getByTestId('reason-picker'), { target: { value: 'SETUP' } });
    fireEvent.click(within(panel).getByTestId('save-coding'));
    expect((await within(panel).findByTestId('coding-message')).dataset.kind).toBe('saved');
    await waitFor(() => {
      expect(screen.queryByTestId(`downtime-row-${UNCODED.id}`)).toBeNull();
    });
    // The detail stays open on the coded record until it is closed.
    expect(screen.getByTestId('coding-panel').dataset.record).toBe(UNCODED.id);
    fireEvent.click(within(panel).getByTestId('close-coding'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId(`code-${other.id}`));
    });
  });

  it('says so when the record in the URL is not in the list, and closes the note', async () => {
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [UNCODED],
      ).fetch,
    );
    await renderApp('/downtime?record=cnc-01~1~1');
    const note = await screen.findByTestId('record-not-found');
    expect(note.textContent).toContain('cnc-01~1~1');
    expect(screen.queryByTestId('coding-panel')).toBeNull();
    fireEvent.click(within(note).getByRole('button', { name: 'Close the note' }));
    await waitFor(() => {
      expect(screen.queryByTestId('record-not-found')).toBeNull();
    });
  });

  it('shows the empty state instead of the table, by the filter', async () => {
    vi.stubGlobal(
      'fetch',
      mes(
        () => json({}),
        () => [],
      ).fetch,
    );
    await renderApp('/downtime');
    const empty = await screen.findByTestId('downtime-empty');
    expect(empty.textContent).toContain('No downtime in this shift');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('downtime-summary').textContent).toBe(
      '0 records, 0 with uncoded time; uncoded first',
    );
  });

  it('shows a failed read of the records in place of the table, with a retry', async () => {
    const server = mes(
      () => json({}),
      () => [UNCODED],
    );
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).includes('/api/v1/downtime?')
        ? Promise.resolve(problem(503, 'Service Unavailable', 'starting', '/api/v1/downtime'))
        : server.fetch(input, init),
    );
    await renderApp('/downtime');
    expect(await screen.findByText(/Could not load the downtime records/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
