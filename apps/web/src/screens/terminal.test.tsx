import type { Role } from '@shopfloor/contracts/identity';
import {
  PROBLEM_TYPES,
  type PauseReason,
  type SessionDto,
  type TerminalOperationDto,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import type { EquipmentDto } from '@shopfloor/contracts/mes-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { timed } from '../test/timing.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClockSeconds } from '../domain/time.ts';
import { EQUIPMENT, current, json, problem, sessionOf } from '../test/fixtures.ts';
import { network, resetNetwork } from '../test/network.ts';
import { renderApp } from '../test/render-app.tsx';
import { at, hold, signal } from '../test/quality-fixtures.ts';
import { operationOf, orderOf, viewOf, withoutCounts } from '../test/terminal-fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  resetNetwork();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

const PASSWORD = `pw-${crypto.randomUUID()}`;
const IDS: Readonly<Record<string, number>> = { olga: 21, omar: 22, ayse: 7 };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/**
 * A MES with sessions of either kind, the terminal's view of Line A1 and its writes: the view's
 * crew and operations follow the writes; `answer` may refuse a write.
 */
function terminalMes(
  options: {
    session?: SessionDto | null;
    roles?: Role[];
    /** Sessions the MES issues end this soon after the login (the idle timeout), if given. */
    idleMs?: number;
    /** The plant clock's watermark, if the plant has one. */
    watermark?: string;
    /** The plant's equipment; the fixtures' by default. */
    equipment?: EquipmentDto[];
  } = {},
) {
  let nextActivity = 500;
  let session: SessionDto | null = options.session ?? null;
  let view: TerminalViewDto = viewOf();
  const calls: Call[] = [];
  let refuse: { path: string; type: string; detail: string } | undefined;
  const op = (operation: string) =>
    view.orders[0]?.operations.find((o) => o.operation === operation);
  const setOp = (operation: TerminalOperationDto) => {
    view = {
      ...view,
      orders: view.orders.map((o) => ({
        ...o,
        operations: o.operations.map((x) =>
          x.operation === operation.operation ? { ...x, ...operation } : x,
        ),
      })),
    };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    );
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.pathname;
    calls.push({ method, path, body });
    await Promise.resolve();
    if (path === '/api/v1/session') {
      if (method === 'GET')
        return session
          ? json(session)
          : problem(401, 'Unauthorized', 'none', path, PROBLEM_TYPES.unauthenticated);
      if (method === 'DELETE') {
        const ended = session !== null;
        if (session)
          view = { ...view, crew: view.crew.filter((c) => c.username !== session?.user.username) };
        session = null;
        return json({ ended });
      }
      const login = body as { username: string; password: string; kind: 'desk' | 'terminal' };
      if (login.password !== PASSWORD)
        return problem(401, 'Unauthorized', 'failed', path, PROBLEM_TYPES.unauthenticated);
      session = {
        ...sessionOf(options.roles ?? ['operator'], { username: login.username, kind: login.kind }),
        user: {
          ...sessionOf(options.roles ?? ['operator'], { username: login.username }).user,
          id: IDS[login.username] ?? 99,
        },
        ...(options.idleMs === undefined
          ? {}
          : { idleExpiresAt: new Date(Date.now() + options.idleMs).toISOString() }),
      };
      return json(session);
    }
    if (!session) return problem(401, 'Unauthorized', 'none', path, PROBLEM_TYPES.unauthenticated);
    const user = session.user;
    if (path === refuse?.path) {
      const r = refuse;
      refuse = undefined;
      return problem(409, 'Conflict', r.detail, path, r.type);
    }
    if (path === '/api/v1/equipment') return json({ equipment: options.equipment ?? EQUIPMENT });
    if (path === '/api/v1/plant')
      return json({
        site: { id: 'gebze', name: 'Gebze', enterprise: { id: 'o', name: 'O' } },
        clock: options.watermark ? { epoch: 1, watermark: options.watermark } : null,
        epochs: options.watermark ? [{ epoch: 1, watermark: options.watermark }] : [],
      });
    if (path === '/api/v1/terminal/line-a1') return json(view);
    if (path === '/api/v1/scrap-reasons') {
      return json({
        reasons: [
          { id: 'LEAK', parent: null, name: 'Leak', active: true },
          { id: 'LEAK/POROSITY', parent: 'LEAK', name: 'Porosity', active: true },
        ],
      });
    }
    if (path === '/api/v1/terminal/line-a1/sign-on') {
      const crew = {
        id: 100 + user.id,
        userId: user.id,
        username: user.username,
        workCenter: 'line-a1',
        epoch: 1,
        shiftKey: '2026-10-15/A',
        from: '2026-10-15T04:00:00.000Z',
        fromPlant: '2026-10-15T04:00:00.000Z',
        to: null,
        toPlant: null,
        endReason: null,
      };
      view = { ...view, crew: [...view.crew.filter((c) => c.userId !== user.id), crew] };
      return json({ crew });
    }
    if (path === '/api/v1/terminal/line-a1/sign-off') {
      const mine = view.crew.find((c) => c.userId === user.id);
      if (!mine) return problem(409, 'Conflict', 'not signed on', path, PROBLEM_TYPES.notSignedOn);
      view = { ...view, crew: view.crew.filter((c) => c.userId !== user.id) };
      return json({
        crew: { ...mine, to: mine.from, toPlant: mine.fromPlant, endReason: 'sign-off' },
      });
    }
    const write =
      /^\/api\/v1\/terminal\/line-a1\/orders\/O-1\/operations\/(OP\d\d)\/(start|pause|resume|sign-off)$/.exec(
        path,
      );
    if (write) {
      const [, operation = '', action = ''] = write;
      const current = op(operation);
      if (!current) return problem(404, 'Not Found', 'no op', path);
      const request = body as { version?: number; activity?: number | null; reason?: 'break' };
      const ownId = current.activities.find((a) => a.userId === user.id)?.id ?? null;
      const stale =
        action === 'sign-off' ? request.version !== current.version : request.activity !== ownId;
      if (stale) return problem(409, 'Conflict', 'changed', path, PROBLEM_TYPES.operationStale);
      const others = current.activities.filter((a) => a.userId !== user.id);
      const activity = (kind: 'work' | 'pause') => ({
        id: (nextActivity += 1),
        orderId: 'O-1',
        operation,
        workCenter: 'line-a1',
        userId: user.id,
        username: user.username,
        kind,
        reason: kind === 'pause' ? (request.reason ?? ('other' as PauseReason)) : null,
        comment: null,
        from: '2026-10-15T04:00:00.000Z',
        fromPlant: '2026-10-15T04:00:00.000Z',
        to: null,
        toPlant: null,
        endReason: null,
      });
      const next: TerminalOperationDto = {
        ...current,
        version: current.version + 1,
        activities:
          action === 'sign-off' ? [] : [...others, activity(action === 'pause' ? 'pause' : 'work')],
        signedOff:
          action === 'sign-off'
            ? {
                username: user.username,
                at: '2026-10-15T06:00:00.000Z',
                plantAt: '2026-10-15T06:00:00.000Z',
              }
            : null,
      };
      setOp(next);
      return json({ operation: withoutCounts(op(operation) ?? next) });
    }
    if (/^\/api\/v1\/scrap-records\/\d+\/coding$/.test(path)) {
      const record = view.scrapRecords[0];
      view = { ...view, scrapRecords: [] };
      return json({
        ...record,
        codedReason: (body as { reason: string }).reason,
        codedBy: user.username,
        codedAt: '2026-10-15T06:00:00.000Z',
        version: 2,
      });
    }
    return problem(404, 'Not Found', 'no route', path);
  };
  return {
    fetch,
    calls,
    get view() {
      return view;
    },
    set view(next: TerminalViewDto) {
      view = next;
    },
    refuseNext: (path: string, type: string, detail: string) => {
      refuse = { path, type, detail };
    },
  };
}

async function signOnAs(username: string) {
  fireEvent.change(await screen.findByTestId('terminal-username'), { target: { value: username } });
  fireEvent.change(screen.getByTestId('terminal-password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByTestId('terminal-sign-on'));
  await screen.findByTestId('terminal-title');
}

describe('the operator terminal (#177)', () => {
  it('signs an operator on with a terminal session and shows the work center: machines, crew, orders, queue, scrap', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    // No session: the terminal's own sign-on, not the app's login.
    expect(await screen.findByRole('heading', { name: 'Sign on' })).toBeDefined();
    expect(app.history.location.pathname).toBe('/terminal/line-a1');
    expect(screen.getByRole('banner').dataset.surface).toBe('dark');
    await signOnAs('olga');
    const login = mes.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/session');
    expect(login?.body).toEqual({ username: 'olga', password: PASSWORD, kind: 'terminal' });
    // Signed on before the screen read the view.
    const order = mes.calls.findIndex((c) => c.path === '/api/v1/terminal/line-a1/sign-on');
    const read = mes.calls.findIndex((c) => c.path === '/api/v1/terminal/line-a1');
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(read);
    expect(screen.getByTestId('terminal-title').textContent).toBe('Line A1');
    expect(screen.getByTestId('terminal-user').textContent).toBe('olga');
    expect(within(screen.getByTestId('terminal-crew')).getByText('olga')).toBeDefined();
    expect(screen.getByTestId('terminal-state-asm-01').dataset.state).toBe('Running');
    expect(screen.getByTestId('terminal-job-asm-01').textContent).toBe('Orders here: O-1');
    expect(screen.getByTestId('terminal-wip-O-1').textContent).toBe('2');
    // The status in the desk's words, the raw value in `data-status` (UX-7 review M1).
    const status = screen.getByTestId('terminal-order-status-O-1');
    expect([status.textContent, status.dataset.status]).toEqual(['In progress', 'in-progress']);
    expect(screen.getByTestId('terminal-counts-O-1-OP30').textContent).toBe(
      'in 2 · good 2 · scrap 0 · rework 0',
    );
    expect(screen.getByTestId('terminal-queue').textContent).toContain('O-2');
    expect(screen.getByTestId('terminal-scrap-11').textContent).toContain('LEAK');
    // The live topic of this work center.
    await app.open();
    expect(app.factory.last.sent).toContainEqual({ type: 'subscribe', topic: 'terminal:line-a1' });
  });

  it('starts, pauses with a reason and resumes; says why a write was refused; signs off a complete operation', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    fireEvent.click(screen.getByTestId('terminal-start-O-1-OP30'));
    await screen.findByTestId('terminal-pause-O-1-OP30');
    const start = mes.calls.find((c) => c.path.endsWith('/OP30/start'));
    expect(start?.body).toEqual({ activity: null });
    expect(screen.getByTestId('terminal-op-state-O-1-OP30').textContent).toContain('You: working');
    fireEvent.click(screen.getByTestId('terminal-pause-O-1-OP30'));
    const confirm = screen.getByTestId('terminal-pause-confirm-O-1-OP30');
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('terminal-reason-O-1-OP30-material'));
    fireEvent.click(confirm);
    await screen.findByTestId('terminal-resume-O-1-OP30');
    expect(mes.calls.find((c) => c.path.endsWith('/OP30/pause'))?.body).toEqual({
      activity: 501,
      reason: 'material',
    });
    expect(screen.getByTestId('terminal-op-state-O-1-OP30').textContent).toContain('paused');
    // A refusal is said in the row, with the MES's reason for a state conflict.
    mes.refuseNext(
      '/api/v1/terminal/line-a1/orders/O-1/operations/OP30/resume',
      PROBLEM_TYPES.operationStale,
      'changed',
    );
    fireEvent.click(screen.getByTestId('terminal-resume-O-1-OP30'));
    expect((await screen.findByTestId('terminal-op-message-O-1-OP30')).textContent).toMatch(
      /Not resumed: someone changed this operation/,
    );
    fireEvent.click(screen.getByTestId('terminal-resume-O-1-OP30'));
    await screen.findByTestId('terminal-pause-O-1-OP30');
  });

  it('follows the pushed view and codes a scrap record with a reason from the tree', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    await app.open();
    const pushed = viewOf({
      crew: mes.view.crew,
      orders: [
        {
          order: mes.view.orders[0]?.order ?? orderOf('O-1'),
          operations: [
            {
              ...operationOf('OP30'),
              counts: { operation: 'OP30', in: 5, good: 4, scrap: 1, rework: 0 },
            },
            {
              ...operationOf('OP50', { complete: true }),
              counts: { operation: 'OP50', in: 3, good: 3, scrap: 0, rework: 0 },
            },
          ],
          wip: 3,
        },
      ],
    });
    await app.push({ type: 'terminal', topic: 'terminal:line-a1', view: pushed });
    expect(screen.getByTestId('terminal-counts-O-1-OP30').textContent).toBe(
      'in 5 · good 4 · scrap 1 · rework 0',
    );
    expect(screen.getByTestId('terminal-wip-O-1').textContent).toBe('3');
    // Signing off an operation cannot be undone at the terminal: a confirmation first (UX-7).
    const signOffOp = screen.getByTestId('terminal-sign-off-O-1-OP50');
    signOffOp.focus();
    fireEvent.click(signOffOp);
    const dialog = screen.getByRole('dialog', { name: 'Sign off OP50 of order O-1?' });
    expect(dialog.dataset.testid).toBe('terminal-confirm-sign-off-O-1-OP50');
    expect(
      document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/cannot be reopened at the terminal/);
    // Cancel sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Sign off OP50 of order O-1?' })).toBeNull();
    });
    expect(mes.calls.some((c) => c.path.endsWith('/OP50/sign-off'))).toBe(false);
    fireEvent.click(screen.getByTestId('terminal-sign-off-O-1-OP50'));
    const confirm = within(
      screen.getByRole('dialog', { name: 'Sign off OP50 of order O-1?' }),
    ).getByRole('button', {
      name: 'Sign off operation',
    });
    // 56 px, as every terminal target.
    expect(confirm.className).toContain('min-h-14');
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByTestId('terminal-op-state-O-1-OP50').textContent).toMatch(
        /Signed off by olga/,
      );
    });
    expect(mes.calls.filter((c) => c.path.endsWith('/OP50/sign-off'))).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Sign off OP50 of order O-1?' })).toBeNull();
    });
    // The button that opened it is gone: the operation's state takes the focus.
    expect(document.activeElement).toBe(screen.getByTestId('terminal-op-state-O-1-OP50'));
    // Scrap coding: a reason below the machine reason, a comment.
    fireEvent.click(await screen.findByTestId('terminal-scrap-reason-11-LEAK/POROSITY'));
    fireEvent.change(screen.getByTestId('terminal-scrap-comment-11'), {
      target: { value: 'pores at the seam' },
    });
    fireEvent.click(screen.getByTestId('terminal-scrap-code-11'));
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-scrap-11')).toBeNull();
    });
    expect(mes.calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/v1/scrap-records/11/coding',
      body: { version: 1, reason: 'LEAK/POROSITY', comment: 'pores at the seam' },
    });
  });

  it('shows quality banners from the view, read-only, and follows them live (#203)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    await app.open();
    // Nothing to say: no banner, but the live lists are mounted already (#203 final review), so
    // the first hold or signal is announced: a live region inserted with its content is not.
    const holdList = screen.getByTestId('terminal-holds');
    const signalList = screen.getByTestId('terminal-signals');
    for (const list of [holdList, signalList]) {
      expect([list.getAttribute('aria-live'), list.children.length]).toEqual(['polite', 0]);
      // Never hidden while empty (#204 review): a live region with `display: none` is not one.
      expect(list.className.split(/\s+/).filter((c) => /(^|:)hidden$/.test(c))).toEqual([]);
      expect(list.hidden).toBe(false);
    }
    expect(screen.getByTestId('terminal-quality').dataset.empty).toBe('true');
    expect(screen.queryByTestId('terminal-lots')).toBeNull();
    // Opened without a plant clock: its wall time, labelled (#295).
    const held = hold({
      subject: { kind: 'lot', id: 'K1' },
      openedAt: '2026-10-22T07:12:03.000Z',
      openedPlantAt: null,
    });
    const view = viewOf({
      crew: mes.view.crew,
      quality: {
        holds: [{ hold: held, orders: ['O-1'] }],
        signals: [
          signal(4, { status: 'final' }),
          signal(3, {
            closedBy: signal(3).last,
            acknowledged: { by: 'quinn', at: at(120), plantAt: null, comment: 'ok' },
          }),
        ],
        lots: [
          {
            equipment: 'asm-01',
            operation: 'OP30',
            epoch: 1,
            partId: 7,
            serial: 'VB-100-000007',
            pass: 1,
            at: at(105),
            lots: [
              { lot: 'K1', material: 'SK-1', held: true },
              { lot: 'P1', material: 'SP-100', held: false },
            ],
          },
        ],
        truncated: true,
      },
    });
    await app.push({ type: 'terminal', topic: 'terminal:line-a1', view });
    const banner = screen.getByTestId(`terminal-hold-${held.id}`);
    expect(banner.textContent).toContain('opened by quinn Thu 22 Oct, 10:12:03 (wall time)');
    // Into the same live regions, not new ones.
    expect(screen.getByTestId('terminal-holds')).toBe(holdList);
    expect(screen.getByTestId('terminal-signals')).toBe(signalList);
    expect(holdList.contains(banner)).toBe(true);
    expect(signalList.children).toHaveLength(2);
    expect(banner.dataset.subject).toBe('lot:K1');
    expect(banner.textContent).toContain('orders here: O-1');
    const open = screen.getByTestId('terminal-signal-4');
    expect([open.dataset.status, open.dataset.open, open.dataset.acknowledged]).toEqual([
      'final',
      'true',
      'false',
    ]);
    expect(screen.getByTestId('terminal-signal-3').dataset.acknowledged).toBe('true');
    expect(screen.getByTestId('terminal-lots-asm-01').textContent).toContain('VB-100-000007');
    // Beside the work, under its own heading, after the orders in reading order (review L1).
    const lotsCard = screen.getByTestId('terminal-lots');
    expect(screen.getByTestId('terminal-quality').contains(lotsCard)).toBe(false);
    expect(lotsCard.closest('section')?.getAttribute('aria-labelledby')).toBe(
      'terminal-lots-title',
    );
    expect(
      screen.getByTestId('terminal-order-O-1').compareDocumentPosition(lotsCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('terminal-lot-K1').dataset.held).toBe('true');
    expect(screen.getByTestId('terminal-lot-P1').dataset.held).toBe('false');
    expect(screen.getByTestId('terminal-quality-truncated')).toBeTruthy();
    // Read-only: no write control in the banners.
    expect(within(screen.getByTestId('terminal-quality')).queryAllByRole('button')).toEqual([]);
    // The hold is released: the next view drops it.
    await app.push({
      type: 'terminal',
      topic: 'terminal:line-a1',
      view: { ...view, quality: { ...view.quality, holds: [] } },
    });
    expect(screen.queryByTestId(`terminal-hold-${held.id}`)).toBeNull();
    // The emptied list stays mounted for the next hold.
    expect(screen.getByTestId('terminal-holds')).toBe(holdList);
    expect(holdList.children).toHaveLength(0);
  });

  it('on sign-off ends the session and forgets everything: the next operator sees none of the drafts', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    // Olga's drafts: a pause reason picked, a scrap comment typed, none sent.
    fireEvent.click(screen.getByTestId('terminal-start-O-1-OP30'));
    fireEvent.click(await screen.findByTestId('terminal-pause-O-1-OP30'));
    fireEvent.click(screen.getByTestId('terminal-reason-O-1-OP30-break'));
    fireEvent.change(await screen.findByTestId('terminal-scrap-comment-11'), {
      target: { value: 'olga’s note' },
    });
    fireEvent.click(screen.getByTestId('terminal-sign-off'));
    await screen.findByRole('heading', { name: 'Sign on' });
    expect(mes.calls.some((c) => c.path === '/api/v1/terminal/line-a1/sign-off')).toBe(true);
    expect(mes.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/session')).toBe(true);
    // Nothing of olga's is cached.
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['terminal'] })).toEqual([]);
    expect(app.queryClient.getMutationCache().getAll()).toEqual([]);
    const readsBefore = mes.calls.filter((c) => c.path === '/api/v1/terminal/line-a1').length;
    await signOnAs('omar');
    expect(screen.getByTestId('terminal-user').textContent).toBe('omar');
    // Omar's screen read the view afresh and holds none of olga's input.
    expect(mes.calls.filter((c) => c.path === '/api/v1/terminal/line-a1').length).toBeGreaterThan(
      readsBefore,
    );
    expect(screen.queryByTestId('terminal-pause-reasons-O-1-OP30')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('terminal-scrap-comment-11').value).toBe('');
    // Olga's work interval is hers: omar may start his own.
    expect(screen.getByTestId('terminal-start-O-1-OP30')).toBeDefined();
    expect(screen.getByTestId('terminal-op-state-O-1-OP30').textContent).toContain('olga working');
  });

  it('asks a desk session to sign on at the terminal, and links terminals from the app for operators', async () => {
    const desk = sessionOf(['operator'], { username: 'ayse' });
    const mes = terminalMes({ session: desk });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/', { session: desk });
    fireEvent.click(await screen.findByTestId('nav-terminal'));
    fireEvent.click(await screen.findByTestId('terminal-link-line-a1'));
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/terminal/line-a1');
    });
    expect((await screen.findByTestId('terminal-desk-session')).textContent).toMatch(
      /ayse is logged in at a desk/,
    );
  });

  it('shows the plant clock and no connection state before sign-on, also with a desk session (#311)', async () => {
    const desk = sessionOf(['operator'], { username: 'ayse' });
    const mes = terminalMes({ session: desk, watermark: '2026-10-15T06:20:00.000Z' });
    vi.stubGlobal('fetch', mes.fetch);
    // As in the browser, where this route never starts the live client for a desk session: the
    // client stays stopped, and the header must not call that "Offline".
    const app = await renderApp('/terminal/line-a1', { session: desk, live: 'stopped' });
    await screen.findByTestId('terminal-desk-session');
    await waitFor(() => {
      expect(screen.getByTestId('terminal-clock').textContent).toMatch(/^Plant time /);
    });
    expect(app.live.status).toBe('stopped');
    expect(screen.queryByTestId('connection-status')).toBeNull();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('shows no connection state on the sign-on page without a session, and "Live" once signed on (#311)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await screen.findByRole('heading', { name: 'Sign on' });
    expect(screen.getByTestId('terminal-clock').textContent).toBe('No plant time yet');
    expect(screen.queryByTestId('connection-status')).toBeNull();
    await signOnAs('olga');
    await app.open();
    const status = screen.getByTestId('connection-status');
    expect(status.dataset.status).toBe('open');
    expect(status.textContent).toBe('Live');
  });

  it('starts the live client for a terminal opened or reloaded while signed on, and stops it at sign-off (#311)', async () => {
    const held = { ...sessionOf(['operator'], { username: 'olga', kind: 'terminal' }) };
    const signedOn = { ...held, user: { ...held.user, id: IDS.olga ?? 0 } };
    const mes = terminalMes({ session: signedOn });
    vi.stubGlobal('fetch', mes.fetch);
    // A reload: the session is read from the MES, and nothing has started the client yet.
    const app = await renderApp('/terminal/line-a1', { session: 'fetch', live: 'stopped' });
    await screen.findByTestId('terminal-title');
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(1);
    });
    await app.open();
    const status = screen.getByTestId('connection-status');
    expect(status.dataset.status).toBe('open');
    expect(status.textContent).toBe('Live');
    expect(app.factory.last.sent).toContainEqual({ type: 'subscribe', topic: 'terminal:line-a1' });
    // Started once: a running client is not started again.
    expect(app.factory.sockets).toHaveLength(1);
    // Sign-off ends the session and stops the client; the sign-on page shows no state.
    fireEvent.click(screen.getByTestId('terminal-sign-off'));
    await screen.findByRole('heading', { name: 'Sign on' });
    expect(app.live.status).toBe('stopped');
    expect(screen.queryByTestId('connection-status')).toBeNull();
    expect(app.factory.sockets).toHaveLength(1);
  });

  it('shows no connection state and starts no client for a terminal session that must change its password (#311)', async () => {
    const held = sessionOf(['operator'], {
      username: 'olga',
      kind: 'terminal',
      mustChangePassword: true,
    });
    const mes = terminalMes({ session: held, watermark: '2026-10-15T06:20:00.000Z' });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch', live: 'stopped' });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-clock').textContent).toMatch(/^Plant time /);
    });
    expect(screen.queryByTestId('connection-status')).toBeNull();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(app.live.status).toBe('stopped');
    expect(app.factory.sockets).toHaveLength(0);
  });

  it('shows a lost connection after sign-on as reconnecting (#311)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    await app.open();
    expect(screen.getByTestId('connection-status').dataset.status).toBe('open');
    await app.drop();
    const status = screen.getByTestId('connection-status');
    expect(status.dataset.status).toBe('reconnecting');
    expect(status.textContent).toBe('Reconnecting…');
  });

  it('says why a sign-on was refused when no shift is running', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    mes.refuseNext('/api/v1/terminal/line-a1/sign-on', PROBLEM_TYPES.noShift, 'no shift');
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    expect(screen.getByTestId('terminal-user').parentElement?.textContent).toMatch(
      /not signed on here/,
    );
    // The refusal of the sign-on with the login is said on the screen that follows.
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Logged in, but not signed on: no shift is running/,
    );
    // Not signed on: no scrap coding offered either.
    expect(screen.queryByTestId('terminal-scrap-code-11')).toBeNull();
    mes.refuseNext('/api/v1/terminal/line-a1/sign-on', PROBLEM_TYPES.noShift, 'no shift');
    fireEvent.click(screen.getByTestId('terminal-join'));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/^Not signed on: no shift is running/);
    });
    // Not signed on: no operation write is offered.
    expect(screen.queryByTestId('terminal-start-O-1-OP30')).toBeNull();
    // A shift runs again: signed on, and the refusal kept from the login is gone.
    fireEvent.click(screen.getByTestId('terminal-join'));
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-join')).toBeNull();
    });
    expect(
      app.queryClient.getQueryData(['terminal', 'olga', 'line-a1', 'refusal']),
    ).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the sign-off dialog busy until the answer; a refusal is said in the row, focus back (review L2)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    await app.open();
    await app.push({
      type: 'terminal',
      topic: 'terminal:line-a1',
      view: viewOf({
        crew: mes.view.crew,
        orders: [
          {
            order: mes.view.orders[0]?.order ?? orderOf('O-1'),
            operations: [operationOf('OP50', { complete: true })],
            wip: 0,
          },
        ],
      }),
    });
    mes.refuseNext(
      '/api/v1/terminal/line-a1/orders/O-1/operations/OP50/sign-off',
      PROBLEM_TYPES.operationStale,
      'changed',
    );
    const trigger = screen.getByTestId('terminal-sign-off-O-1-OP50');
    trigger.focus();
    fireEvent.click(trigger);
    const name = 'Sign off OP50 of order O-1?';
    const confirm = within(screen.getByRole('dialog', { name })).getByRole('button', {
      name: 'Sign off operation',
    });
    // Two taps in a row: the dialog is busy from the first, so one write goes out.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect((await screen.findByTestId('terminal-op-message-O-1-OP50')).textContent).toMatch(
      /^Not signed off: someone changed this operation/,
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name })).toBeNull();
    });
    expect(mes.calls.filter((c) => c.path.endsWith('/OP50/sign-off'))).toHaveLength(1);
    // Not signed off: the button is still there and has the focus again.
    expect(document.activeElement).toBe(screen.getByTestId('terminal-sign-off-O-1-OP50'));
    expect(screen.getByTestId('terminal-op-state-O-1-OP50').textContent).toBe(
      'Complete: ready to sign off',
    );
  });

  it('starts the live client again after a 4403 close when the session read then is still valid (#341 review)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    await app.open();
    expect(app.factory.sockets).toHaveLength(1);
    // The MES closes the socket for the session (4403): the client stops and the session is read
    // again. Read back unchanged (the same object, by structural sharing), it may still read, so
    // the client starts again instead of staying "Offline" (UX-7 review M2).
    const before = app.queryClient.getQueryData(['session']);
    await app.drop(4403);
    await waitFor(() => {
      expect(app.factory.sockets).toHaveLength(2);
    });
    expect(app.queryClient.getQueryData(['session'])).toBe(before);
    await app.open();
    expect(screen.getByTestId('connection-status').dataset.status).toBe('open');
    expect(app.factory.last.sent).toContainEqual({ type: 'subscribe', topic: 'terminal:line-a1' });
    expect(screen.getByTestId('terminal-user').textContent).toBe('olga');
  });

  it('shows its own offline bar once signed on, saying since when the screen stopped updating (#312, UX-7)', async () => {
    const watermark = '2026-10-15T06:20:00.000Z';
    const mes = terminalMes({ watermark });
    const net = network(mes.fetch);
    vi.stubGlobal('fetch', net.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await screen.findByRole('heading', { name: 'Sign on' });
    // The sign-on page starts no live client and shows no connection state, offline or not.
    await net.cut();
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    await net.restore();
    await signOnAs('olga');
    await app.open();
    await waitFor(() => {
      expect(screen.getByTestId('terminal-clock').textContent).toMatch(/^Plant time /);
    });
    expect(screen.queryByTestId('offline-bar')).toBeNull();
    await net.cut();
    const bar = screen.getByTestId('offline-bar');
    expect([bar.getAttribute('role'), bar.dataset.variant, bar.dataset.reason]).toEqual([
      'alert',
      'terminal',
      'offline',
    ]);
    expect(bar.textContent).toContain(
      `Offline: this screen stopped updating at ${formatClockSeconds(watermark)} plant time.`,
    );
    expect(bar.textContent).toContain('a start, pause or scrap code sent meanwhile is not saved');
    // Under the terminal's top bar, on its widths.
    expect(bar.firstElementChild?.className).toMatch(/max-w-6xl .*px-4 .*md:px-6/);
    expect(screen.getByTestId('connection-status').textContent).toBe('Offline');
    // The screen stays: the operator's view is kept while the network is gone.
    expect(screen.getByTestId('terminal-title').textContent).toBe('Line A1');
    await net.restore();
    await app.open();
    await waitFor(() => {
      expect(screen.queryByTestId('offline-bar')).toBeNull();
    });
  });

  it('names the work center in its top bar, with its id, and leads back to the picker (X-02, X-04)', async () => {
    const desk = sessionOf(['operator'], { username: 'ayse' });
    const mes = terminalMes({ session: desk });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: desk, live: 'stopped' });
    const banner = screen.getByRole('banner');
    await waitFor(() => {
      expect(within(banner).getByTestId('terminal-work-center').textContent).toBe('Line A1');
    });
    expect(within(banner).getByText('line-a1').tagName).toBe('CODE');
    expect(document.title).toBe('Terminal Line A1 · ShopFloor Twin');
    const back = within(banner).getByRole('link', { name: 'Change work center' });
    expect(back.getAttribute('href')).toBe('/terminal');
    fireEvent.click(back);
    await waitFor(() => {
      expect(app.history.location.pathname).toBe('/terminal');
    });
    expect(await screen.findByTestId('terminal-link-line-a1')).toBeDefined();
  });

  it('offers each work center as a tile to choose by: machines, crew, order in progress, abnormal state (X-01)', async () => {
    const desk = sessionOf(['supervisor'], { username: 'ayse' });
    const mes = terminalMes({
      session: desk,
      equipment: EQUIPMENT.map((e) =>
        e.id === 'cnc-01' ? { ...e, current: current({ state: 'Down' }) } : e,
      ),
    });
    mes.view = viewOf({
      crew: [
        {
          id: 121,
          userId: 21,
          username: 'olga',
          workCenter: 'line-a1',
          epoch: 1,
          shiftKey: '2026-10-15/A',
          from: '2026-10-15T04:00:00.000Z',
          fromPlant: '2026-10-15T04:00:00.000Z',
          to: null,
          toPlant: null,
          endReason: null,
        },
      ],
    });
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/terminal', { session: desk });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Operator terminal' }),
    ).toBeDefined();
    const line = await screen.findByTestId('terminal-link-line-a1');
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tile-crew-line-a1').textContent).toBe('Signed on: olga');
    });
    expect(screen.getByTestId('terminal-tile-order-line-a1').textContent).toBe(
      'In progress: O-1 · VB-100',
    );
    expect(line.getAttribute('href')).toBe('/terminal/line-a1');
    // Named by the work center; the area, machines, crew and order describe it (review L3).
    expect(screen.getByRole('link', { name: 'Line A1' })).toBe(line);
    const described = (line.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described).toEqual([
      'Assembly · line-a1',
      'Machine asm-01 No data',
      'Signed on: olga',
      'In progress: O-1 · VB-100',
    ]);
    expect(line.dataset.tone).toBe('normal');
    expect(line.className).not.toContain('border-l-4');
    // A machine down in Cell M1: its tile carries the alarm bar and the state's word (line order).
    const cell = screen.getByTestId('terminal-link-cell-m1');
    expect(cell.dataset.tone).toBe('alarm');
    expect(cell.className).toContain('border-l-alarm-border');
    expect(
      within(screen.getByTestId('terminal-tile-machines-cell-m1'))
        .getAllByText(/Down|Idle/)
        .map((e) => e.textContent),
    ).toEqual(['Down', 'Idle']);
    // Its view could not be read: the tile says so and still leads to its terminal.
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tile-crew-cell-m1').textContent).toMatch(
        /could not be read/,
      );
    });
    expect(cell.getAttribute('href')).toBe('/terminal/cell-m1');
  });

  it('draws every control 56 px high, on the shared buttons and fields with the token focus ring (X-05)', async () => {
    const mes = terminalMes();
    vi.stubGlobal('fetch', mes.fetch);
    await renderApp('/terminal/line-a1', { session: 'fetch' });
    await screen.findByRole('heading', { name: 'Sign on' });
    const minHeight = (element: HTMLElement) =>
      element.className.split(/\s+/).find((c) => c.startsWith('min-h-'));
    expect(
      [
        screen.getByTestId('terminal-username'),
        screen.getByTestId('terminal-password'),
        screen.getByTestId('terminal-sign-on'),
      ].map(minHeight),
    ).toEqual(['min-h-14', 'min-h-14', 'min-h-14']);
    expect(screen.getByRole('textbox', { name: 'User name' })).toBe(
      screen.getByTestId('terminal-username'),
    );
    await signOnAs('olga');
    fireEvent.click(screen.getByTestId('terminal-start-O-1-OP30'));
    fireEvent.click(await screen.findByTestId('terminal-pause-O-1-OP30'));
    const controls = [
      ...screen.getAllByRole('button').filter((b) => b.closest('[data-testid="terminal-screen"]')),
      screen.getByTestId('terminal-scrap-comment-11'),
    ];
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      expect(minHeight(control), control.textContent).toBe('min-h-14');
      // No outline of its own: the global 2 px `focus` ring (design system 7) draws the focus.
      expect(control.className, control.textContent).not.toMatch(/outline|sky-/);
    }
  });

  it('when operator A idles out, operator B signs on to a screen with none of A’s drafts or reads', async () => {
    const mes = terminalMes({ idleMs: 1_500 });
    vi.stubGlobal('fetch', mes.fetch);
    const app = await renderApp('/terminal/line-a1', { session: 'fetch' });
    await signOnAs('olga');
    fireEvent.change(await screen.findByTestId('terminal-scrap-comment-11'), {
      target: { value: 'olga’s unsent note' },
    });
    fireEvent.click(screen.getByTestId('terminal-start-O-1-OP30'));
    fireEvent.click(await screen.findByTestId('terminal-pause-O-1-OP30'));
    fireEvent.click(screen.getByTestId('terminal-reason-O-1-OP30-quality'));
    // Nobody touches the screen: the session times out here and at the MES, within about 3 s of
    // the last touch (1.5 s idle) plus measured scheduler lag; a long deadline only to wait (#212).
    const idle = await timed(() =>
      screen.findByRole('heading', { name: 'Sign on' }, { timeout: 15_000 }),
    );
    expect(idle.elapsedMs).toBeLessThan(3_000 + idle.maxLagMs);
    await waitFor(() => {
      expect(mes.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/session')).toBe(
        true,
      );
    });
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['terminal'] })).toEqual([]);
    expect(app.queryClient.getQueryCache().findAll({ queryKey: ['live', 'terminal'] })).toEqual([]);
    expect(app.queryClient.getMutationCache().getAll()).toEqual([]);
    expect(screen.queryByText('olga’s unsent note')).toBeNull();
    await signOnAs('omar');
    expect(screen.getByTestId('terminal-user').textContent).toBe('omar');
    expect(screen.getByTestId<HTMLInputElement>('terminal-scrap-comment-11').value).toBe('');
    expect(screen.queryByTestId('terminal-pause-reasons-O-1-OP30')).toBeNull();
  }, 15_000);
});
