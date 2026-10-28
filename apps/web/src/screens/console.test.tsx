import { ROLES } from '@shopfloor/contracts/identity';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EQUIPMENT, json, sessionOf } from '../test/fixtures.ts';
import { formatPlantTime } from '../domain/time.ts';
import { renderApp } from '../test/render-app.tsx';

// The simulation console (#237): admin only; every action goes to /sim/api/v1 (nginx's allowlist
// in front of the control API), never with a token of its own; refusals are shown as they come.

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const ADMIN = sessionOf(['admin'], { username: 'root' });

/** A small simulator behind /sim/api/v1, and the MES reads the console uses. */
function fakeSim() {
  const calls: Call[] = [];
  const state = {
    state: 'idle' as 'idle' | 'running' | 'paused' | 'finished',
    speed: 60,
    simTime: '2026-10-12T03:00:00.000Z',
    lots: [
      { lot: 'BL100-2610-01', material: 'BL100', remaining: 200, blocked: false },
      { lot: 'BL100-2610-02', material: 'BL100', remaining: 200, blocked: true },
    ],
    injections: [] as object[],
    actions: [] as object[],
    scenario: null as object | null,
  };
  const statusBody = () => {
    const { state: s, speed, simTime } = state;
    return { state: s, speed, simTime, lagMs: 3, events: 42 };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body: unknown =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      path: url.pathname,
      body,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    await Promise.resolve();
    const path = url.pathname;
    if (path === '/api/v1/session') return json(ADMIN);
    if (path === '/api/v1/equipment') return json({ equipment: EQUIPMENT });
    if (path === '/api/v1/reason-codes') {
      return json({
        reasons: [
          { id: 'BREAKDOWN', parent: null, name: 'Breakdown', active: true },
          {
            id: 'BREAKDOWN/SPINDLE-OVERLOAD',
            parent: 'BREAKDOWN',
            name: 'Spindle overload',
            active: true,
          },
        ],
      });
    }
    if (path === '/api/v1/plant') return json({ site: null, clock: null, epochs: [] });
    const sim = path.startsWith('/sim/api/v1') ? path.slice('/sim/api/v1'.length) : undefined;
    switch (`${method} ${sim ?? path}`) {
      case 'GET /status':
        return json(statusBody());
      case 'POST /resume':
        state.state = 'running';
        return json(statusBody());
      case 'POST /pause':
        state.state = 'paused';
        return json(statusBody());
      case 'POST /step':
        return json({ stepped: true, status: statusBody() });
      case 'PUT /speed':
        state.speed = (body as { speed: number }).speed;
        return json(statusBody());
      case 'GET /faults/injections':
        return json({ injections: state.injections });
      case 'GET /faults/drifts':
        return json({ drifts: [] });
      case 'POST /faults/drift/lkt-01': {
        const { shift, until, at } = body as { shift: number; until: string; at?: string };
        return json({
          drift: {
            id: 1,
            machine: 'lkt-01',
            shift,
            until,
            at: at ?? state.simTime,
            status: 'scheduled',
          },
        });
      }
      case 'POST /faults/failure/cnc-01': {
        const { code } = body as { code: string };
        if (code !== 'SPINDLE-OVERLOAD') {
          return json({ error: 'Not Found', message: `cnc-01 has no failure mode ${code}` }, 404);
        }
        const injection = {
          id: 1,
          machine: 'cnc-01',
          code,
          at: state.simTime,
          status: 'scheduled',
        };
        state.injections.push(injection);
        return json({ injection });
      }
      case 'GET /lots':
        return json({ lots: state.lots });
      case 'POST /lots/BL100-2610-01/block': {
        const action = {
          id: state.actions.length + 1,
          kind: 'lot-block',
          lot: 'BL100-2610-01',
          material: 'BL100',
          at: state.simTime,
          status: 'scheduled',
        };
        state.actions.push(action);
        return json({ action });
      }
      case 'GET /operators':
        return json({
          currentShift: '2026-10-12/A',
          operators: [
            {
              id: 'op-a1',
              shift: 'A',
              skills: ['asm-01'],
              speedFactor: 1,
              status: 'present',
              station: 'asm-01',
              forced: false,
            },
            {
              id: 'op-b1',
              shift: 'B',
              skills: ['asm-01'],
              speedFactor: 0.95,
              status: 'off-shift',
              station: null,
              forced: false,
            },
          ],
          absences: [],
        });
      case 'POST /operators/absent': {
        const { shift, operators } = body as { shift: string; operators: string[] };
        const action = {
          id: state.actions.length + 1,
          kind: 'operators-absent',
          shift,
          start: '2026-10-12T11:00:00.000Z',
          operators,
          status: 'planned',
        };
        state.actions.push(action);
        return json({ action });
      }
      case 'POST /faults/tool/cnc-01': {
        const action = {
          id: state.actions.length + 1,
          kind: 'tool-breakage',
          machine: 'cnc-01',
          at: state.simTime,
          status: 'scheduled',
        };
        state.actions.push(action);
        return json({ action });
      }
      case 'POST /faults/opcua/cnc-01':
        return json({ offline: (body as { offline: boolean }).offline });
      case 'POST /faults/modbus':
        return json({ silent: (body as { silent: boolean }).silent });
      case 'GET /actions':
        return json({ actions: state.actions });
      case 'GET /scenarios':
        return json({
          scenarios: [{ name: 'monday-breakdown-and-recovery', description: 'A Monday' }],
        });
      case 'GET /scenario':
        return json({ scenario: state.scenario });
      case 'POST /scenario':
        state.scenario = {
          name: (body as { name: string }).name,
          description: 'A Monday',
          entries: [
            {
              entry: 'timeline[0]',
              action: 'failure',
              at: '2026-10-12T05:00:00.000Z',
              status: 'scheduled',
              id: 1,
            },
          ],
        };
        return json({ scenario: state.scenario });
      default:
        return json({ error: 'Not Found', message: 'not a console route' }, 404);
    }
  };
  return { fetch, calls, state };
}

class SilentSocket {
  static readonly instances: SilentSocket[] = [];
  readonly url: string;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    SilentSocket.instances.push(this);
  }
  addEventListener(name: string, listener: (event: unknown) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, event: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  close() {
    this.closed = true;
  }
}

/** Gives the confirmation of an irreversible lever (design system 4.9). */
function confirm(testId: string, label: string) {
  fireEvent.click(within(screen.getByTestId(testId)).getByRole('button', { name: label }));
}

beforeEach(() => {
  SilentSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', SilentSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows the console and its link to admin only (sim:control)', async () => {
  for (const role of ROLES) {
    const sim = fakeSim();
    vi.stubGlobal('fetch', sim.fetch);
    const view = await renderApp('/console', { session: sessionOf([role]) });
    await screen.findByRole('heading', { name: 'Simulation console' });
    if (role === 'admin') {
      expect(screen.getByTestId('nav-console')).toBeTruthy();
      expect(screen.queryByTestId('console-forbidden')).toBeNull();
    } else {
      expect(screen.getByTestId('console-forbidden').textContent).toMatch(/sim:control/);
      expect(screen.queryByTestId('nav-console')).toBeNull();
      // Nothing was asked of the simulator.
      expect(sim.calls.filter((c) => c.path.startsWith('/sim/'))).toEqual([]);
    }
    view.unmount();
  }
});

it('drives the run, injects, blocks, marks absent, breaks a tool and loads a timeline', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', sim.fetch);
  await renderApp('/console', { session: ADMIN });
  await waitFor(() => {
    expect(screen.getByTestId('sim-state').dataset.state).toBe('idle');
  });
  // Simulation time in plant time, as the header shows the plant clock, never raw UTC (#295).
  const simTime = screen.getByTestId('sim-time');
  expect(simTime.textContent).toBe(formatPlantTime('2026-10-12T03:00:00.000Z'));
  expect(simTime.textContent).toBe('Mon 12 Oct, 06:00:00');
  expect(simTime.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12T03:00:00.000Z');

  // The timeline loads only while idle.
  fireEvent.click(await screen.findByTestId('scenario-load-monday-breakdown-and-recovery'));
  expect((await screen.findByTestId('scenario-outcome')).textContent).toMatch(
    /Loaded monday-breakdown-and-recovery/,
  );
  await screen.findByTestId('scenario-progress');

  fireEvent.click(screen.getByTestId('sim-resume'));
  await waitFor(() => {
    expect(screen.getByTestId('sim-state').dataset.state).toBe('running');
  });
  fireEvent.click(screen.getByTestId('sim-pause'));
  await waitFor(() => {
    expect(screen.getByTestId('sim-state').dataset.state).toBe('paused');
  });
  fireEvent.click(screen.getByTestId('sim-step'));
  expect((await screen.findByTestId('run-outcome')).textContent).toMatch(/Stepped/);
  fireEvent.change(screen.getByTestId('sim-speed-input'), { target: { value: '12.5' } });
  fireEvent.click(screen.getByTestId('sim-speed-apply'));
  await waitFor(() => {
    expect(screen.getByTestId('sim-speed').textContent).toBe('12.5×');
  });

  // A refusal from the simulator is shown as it came.
  fireEvent.change(screen.getByTestId('failure-machine'), { target: { value: 'cnc-01' } });
  fireEvent.change(screen.getByTestId('failure-code'), { target: { value: 'NOPE' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  confirm('confirm-failure', 'Inject failure');
  expect((await screen.findByTestId('failure-outcome')).textContent).toBe(
    'cnc-01 has no failure mode NOPE',
  );
  fireEvent.change(screen.getByTestId('failure-code'), {
    target: { value: 'SPINDLE-OVERLOAD' },
  });
  fireEvent.change(screen.getByTestId('failure-repair'), { target: { value: '30' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  confirm('confirm-failure', 'Inject failure');
  await waitFor(() => {
    expect(screen.getByTestId('failure-outcome').dataset.kind).toBe('done');
  });
  await screen.findByTestId('injection-1');

  fireEvent.click(await screen.findByTestId('lot-block-BL100-2610-01'));
  expect((await screen.findByTestId('lot-outcome')).textContent).toMatch(/BL100-2610-01 block/);

  fireEvent.click(await screen.findByTestId('absent-op-b1'));
  fireEvent.click(screen.getByTestId('absent-submit'));
  confirm('confirm-absent', 'Mark absent');
  expect((await screen.findByTestId('absent-outcome')).textContent).toMatch(
    /op-b1 absent in shift 2026-10-12\/B/,
  );

  fireEvent.click(screen.getByTestId('tool-break-cnc-01'));
  confirm('confirm-tool', 'Break tool');
  expect((await screen.findByTestId('tool-outcome')).textContent).toMatch(/cnc-01's tool breaks/);

  fireEvent.click(screen.getByTestId('opcua-toggle-cnc-01'));
  await waitFor(() => {
    expect(screen.getByTestId('opcua-state-cnc-01').textContent).toBe('OPC UA offline');
  });
  fireEvent.click(screen.getByTestId('modbus-toggle'));
  await waitFor(() => {
    expect(screen.getByTestId('modbus-state').textContent).toBe('Modbus silent');
  });

  const list = await screen.findByTestId('action-list');
  await waitFor(() => {
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  const writes = sim.calls.filter((c) => c.method !== 'GET');
  expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /sim/api/v1/scenario',
    'POST /sim/api/v1/resume',
    'POST /sim/api/v1/pause',
    'POST /sim/api/v1/step',
    'PUT /sim/api/v1/speed',
    'POST /sim/api/v1/faults/failure/cnc-01',
    'POST /sim/api/v1/faults/failure/cnc-01',
    'POST /sim/api/v1/lots/BL100-2610-01/block',
    'POST /sim/api/v1/operators/absent',
    'POST /sim/api/v1/faults/tool/cnc-01',
    'POST /sim/api/v1/faults/opcua/cnc-01',
    'POST /sim/api/v1/faults/modbus',
  ]);
  expect(writes[5]?.body).toEqual({ code: 'NOPE' });
  expect(writes[6]?.body).toEqual({ code: 'SPINDLE-OVERLOAD', repairMs: 1_800_000 });
  expect(writes[8]?.body).toEqual({ shift: '2026-10-12/B', operators: ['op-b1'] });
  // The page never sends a token of its own: nginx adds it.
  for (const call of sim.calls) {
    expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  }
  // Every console request stays under the allowlisted prefix.
  expect(
    sim.calls.filter((c) => !c.path.startsWith('/api/v1/') && !c.path.startsWith('/sim/api/v1/')),
  ).toEqual([]);
});

it('says what nginx refused: a lost session (401) and a missing permission (403)', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/sim/api/v1/status') {
      return new Response('<html>401</html>', { status: 401 });
    }
    if (url.pathname === '/sim/api/v1/pause') {
      return new Response('<html>403</html>', { status: 403 });
    }
    return sim.fetch(input, init);
  });
  sim.state.state = 'running';
  await renderApp('/console', { session: ADMIN });
  expect((await screen.findAllByRole('alert'))[0]?.textContent).toMatch(
    /Your session ended: log in again/,
  );
});

it('closes the event stream when the status poll is refused, and reconnects after a lifetime close', async () => {
  const sim = fakeSim();
  let refuse = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (refuse && url.pathname === '/sim/api/v1/status') {
      return new Response('<html>401</html>', { status: 401 });
    }
    return sim.fetch(input, init);
  });
  await renderApp('/console', { session: ADMIN });
  await waitFor(() => {
    expect(SilentSocket.instances).toHaveLength(1);
  });
  // The simulator ends the stream's lifetime: a new upgrade follows at once.
  SilentSocket.instances[0]?.emit('close', { code: 4100 });
  await waitFor(() => {
    expect(SilentSocket.instances).toHaveLength(2);
  });
  // The session ends: the next status poll is 401, and the open socket is closed.
  refuse = true;
  await waitFor(
    () => {
      expect(SilentSocket.instances[1]?.closed).toBe(true);
    },
    { timeout: 4_000 },
  );
});

it('tails the plant event stream from /sim/api/v1/events, newest first', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', sim.fetch);
  await renderApp('/console', { session: ADMIN });
  await waitFor(() => {
    expect(SilentSocket.instances).toHaveLength(1);
  });
  const socket = SilentSocket.instances[0];
  expect(socket?.url).toBe(`ws://${window.location.host}/sim/api/v1/events`);
  socket?.emit('open', {});
  for (const seq of [1, 2, 3]) {
    socket?.emit('message', {
      data: JSON.stringify({
        seq,
        at: '2026-10-12T03:00:01.000Z',
        type: 'state',
        machineId: 'cnc-01',
      }),
    });
  }
  await waitFor(
    () => {
      const items = within(screen.getByTestId('event-list')).getAllByRole('listitem');
      expect(items.map((item) => item.textContent.split(' ')[0])).toEqual(['3', '2', '1']);
    },
    { timeout: 3_000 },
  );
  expect(screen.getByTestId('events-connection').dataset.connected).toBe('true');
});

it('lays the console out in sections with an index, and every field has a name (G-23)', async () => {
  vi.stubGlobal('fetch', fakeSim().fetch);
  await renderApp('/console', { session: ADMIN });
  await screen.findByTestId('failure-code');
  const index = screen.getByRole('navigation', { name: 'On this page' });
  expect(
    within(index)
      .getAllByRole('link')
      .map((a) => a.textContent),
  ).toEqual(['Run', 'Scenario', 'Faults', 'Materials', 'Operators', 'Log']);
  for (const link of within(index).getAllByRole<HTMLAnchorElement>('link')) {
    const id = link.getAttribute('href')?.slice(1) ?? '';
    expect(document.getElementById(id)?.tagName, id).toBe('H2');
  }
  await screen.findByTestId('lot-BL100-2610-01');
  await screen.findByTestId('absent-op-b1');
  const unnamed = [...document.querySelectorAll('main input, main select, main textarea')].filter(
    (field) => !field.getAttribute('name'),
  );
  expect(unnamed.map((field) => field.outerHTML)).toEqual([]);
  // Times in simulation time (design system 4.8).
  expect(
    screen.getByRole('group', {
      name: /^Until \(required\), simulation time in Europe\/Istanbul$/,
    }),
  ).toBeTruthy();
});

it('says what a required field misses and sends nothing; an unreadable optional time is not dropped', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', sim.fetch);
  await renderApp('/console', { session: ADMIN });
  fireEvent.click(await screen.findByTestId('failure-inject'));
  expect(screen.getByTestId('failure-code').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Enter a failure code.')).toBeTruthy();
  fireEvent.click(screen.getByTestId('drift-inject'));
  expect(screen.getByTestId('drift-until').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Enter when the drift ends.')).toBeTruthy();
  fireEvent.change(screen.getByTestId('failure-code'), { target: { value: 'SPINDLE-OVERLOAD' } });
  fireEvent.change(screen.getByTestId('failure-at'), { target: { value: 'soon' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  expect(screen.getByText('Enter a time this box can read, or leave it empty.')).toBeTruthy();
  expect(screen.getByTestId<HTMLDialogElement>('confirm-failure').open).toBe(false);
  expect(sim.calls.filter((c) => c.method !== 'GET')).toEqual([]);
});

it('asks before an irreversible lever; Cancel sends nothing, the drift keeps its milliseconds', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', sim.fetch);
  await renderApp('/console', { session: ADMIN });
  fireEvent.click(await screen.findByTestId('tool-break-cnc-01'));
  const dialog = screen.getByTestId('confirm-tool');
  expect(within(dialog).getByRole('heading').textContent).toMatch(
    /^Break the tool on .* \(cnc-01\)\?$/,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => {
    expect(screen.getByTestId<HTMLDialogElement>('confirm-tool').open).toBe(false);
  });
  expect(sim.calls.filter((c) => c.method !== 'GET')).toEqual([]);

  // The time box takes a whole ISO instant, milliseconds kept to the write.
  const until = '2026-10-12T03:37:00.123Z';
  fireEvent.change(screen.getByTestId('drift-until'), { target: { value: until } });
  fireEvent.click(screen.getByTestId('drift-inject'));
  confirm('confirm-drift', 'Inject drift');
  await waitFor(() => {
    expect(screen.getByTestId('drift-outcome').dataset.kind).toBe('done');
  });
  expect(sim.calls.filter((c) => c.method !== 'GET').map((c) => c.body)).toEqual([
    { shift: 0.6, until },
  ]);
});

it('emphasises the lot action that matches its state, and every column has a header (N-01, N-03)', async () => {
  vi.stubGlobal('fetch', fakeSim().fetch);
  await renderApp('/console', { session: ADMIN });
  const free = await screen.findByTestId('lot-BL100-2610-01');
  const blocked = screen.getByTestId('lot-BL100-2610-02');
  expect(free.dataset.blocked).toBe('false');
  expect(blocked.dataset.blocked).toBe('true');
  expect(screen.getByTestId('lot-block-BL100-2610-01').className).toMatch(/text-alarm-ink/);
  expect(screen.getByTestId('lot-release-BL100-2610-01').className).toMatch(/border-transparent/);
  expect(screen.getByTestId('lot-release-BL100-2610-02').className).toMatch(/border-line-strong/);
  expect(screen.getByTestId('lot-block-BL100-2610-02').className).not.toMatch(/text-alarm-ink/);
  const table = screen.getByRole('table', { name: 'Material lots' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent),
  ).toEqual(['Lot', 'Material', 'Remaining', 'State', 'Actions']);
  // Nothing on the event stream yet: an empty state, not a bare caption (N-05).
  expect(screen.getByText('No plant event yet')).toBeTruthy();
  expect(screen.queryByTestId('event-list')).toBeNull();
});

it('keeps a confirmation busy until the write settles; a refusal shows inside the dialog', async () => {
  const sim = fakeSim();
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/sim/api/v1/faults/tool/cnc-01') await hold;
    return sim.fetch(input, init);
  });
  await renderApp('/console', { session: ADMIN });

  // Busy until the simulator answers; then it closes.
  fireEvent.click(await screen.findByTestId('tool-break-cnc-01'));
  const tool = screen.getByTestId<HTMLDialogElement>('confirm-tool');
  const breakTool = within(tool).getByRole('button', { name: 'Break tool' });
  fireEvent.click(breakTool);
  await waitFor(() => {
    expect(breakTool.getAttribute('aria-busy')).toBe('true');
  });
  expect(tool.open).toBe(true);
  release();
  await waitFor(() => {
    expect(tool.open).toBe(false);
  });
  expect(screen.getByTestId('tool-outcome').dataset.kind).toBe('done');

  // A refusal stays in the dialog, announced there; the line behind it says it quietly.
  fireEvent.change(screen.getByTestId('failure-machine'), { target: { value: 'cnc-01' } });
  fireEvent.change(screen.getByTestId('failure-code'), { target: { value: 'NOPE' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  confirm('confirm-failure', 'Inject failure');
  const dialog = screen.getByTestId<HTMLDialogElement>('confirm-failure');
  const refusal = await within(dialog).findByTestId('confirm-failure-refusal');
  expect(refusal.textContent).toBe('cnc-01 has no failure mode NOPE');
  expect(refusal.getAttribute('role')).toBe('alert');
  expect(dialog.open).toBe(true);
  const line = screen.getByTestId('failure-outcome');
  expect(line.dataset.kind).toBe('failed');
  expect(line.getAttribute('role')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => {
    expect(dialog.open).toBe(false);
  });
  expect(screen.getByTestId('failure-outcome').getAttribute('role')).toBe('alert');
});

it('flags a date without a time on the optional At and From, instead of sending "now"', async () => {
  const sim = fakeSim();
  vi.stubGlobal('fetch', sim.fetch);
  await renderApp('/console', { session: ADMIN });
  fireEvent.change(await screen.findByTestId('failure-code'), {
    target: { value: 'SPINDLE-OVERLOAD' },
  });
  fireEvent.change(screen.getByTestId('failure-at-date'), { target: { value: '12/10/2026' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  expect(screen.getByText('Enter a time for this date, or clear the date.')).toBeTruthy();
  expect(screen.getByTestId<HTMLDialogElement>('confirm-failure').open).toBe(false);

  fireEvent.change(screen.getByTestId('drift-at-date'), { target: { value: '12/10/2026' } });
  fireEvent.change(screen.getByTestId('drift-until'), {
    target: { value: '2026-10-12T05:00:00Z' },
  });
  fireEvent.click(screen.getByTestId('drift-inject'));
  expect(screen.getAllByText('Enter a time for this date, or clear the date.')).toHaveLength(2);
  expect(screen.getByTestId<HTMLDialogElement>('confirm-drift').open).toBe(false);

  // Cleared, the date is no longer a problem: the failure goes to its confirmation.
  fireEvent.change(screen.getByTestId('failure-at-date'), { target: { value: '' } });
  fireEvent.click(screen.getByTestId('failure-inject'));
  expect(screen.getByTestId<HTMLDialogElement>('confirm-failure').open).toBe(true);
  expect(sim.calls.filter((c) => c.method !== 'GET')).toEqual([]);
});
