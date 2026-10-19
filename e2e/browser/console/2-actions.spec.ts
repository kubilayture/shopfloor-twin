import { expect, test, type Page } from '@playwright/test';
import { account, logIn } from '../login.ts';

/**
 * Every console action through `/console` as admin (#237), each one seen where it lands: the
 * simulator's own reads through the control API with its token (the test's, not the browser's).
 * Runs after 1-refusals.spec.ts on the idle run of `pnpm test:console`: the timeline load needs a
 * run that is idle and has no action yet, so it comes first. Then start, pause, step and speed,
 * a failure injection, a leak-test drift, OPC UA offline and back, Modbus silent and back, a lot
 * blocked and released, operators absent for a later shift, a tool breakage, the action list and
 * the plant event stream through nginx. Last, an operator sees neither the console nor its link.
 */
const web = process.env.RECONCILE_WEB_URL ?? '';
const simUrl = process.env.CONSOLE_SIM_URL ?? '';
const simToken = process.env.CONSOLE_SIM_TOKEN ?? '';
const TIMELINE = 'monday-breakdown-and-recovery';

/** A read of the control API with its token: what the simulator holds now. */
async function sim<T>(path: string): Promise<T> {
  const response = await fetch(`${simUrl}/api/v1${path}`, {
    headers: { authorization: `Bearer ${simToken}` },
  });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

interface Status {
  state: string;
  speed: number;
  simTime: string;
  events: number;
}
interface Action {
  id: number;
  kind: string;
  status: string;
  lot?: string;
  machine?: string;
  shift?: string;
  operators?: string[];
}

const isoAfter = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

async function outcome(page: Page, testId: string, pattern: RegExp): Promise<void> {
  const line = page.getByTestId(testId);
  await expect(line).toHaveText(pattern);
  await expect(line).toHaveAttribute('data-kind', 'done');
}

test.beforeAll(() => {
  test.skip(web === '' || simUrl === '' || simToken === '', 'runs inside pnpm test:console');
});

test('admin drives every console action, each reaching the simulator', async ({ page }) => {
  test.setTimeout(240_000);
  await logIn(page, account('admin'));
  await page.getByTestId('nav-console').click();
  await expect(page.getByRole('heading', { name: 'Simulation console' })).toBeVisible();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'idle');

  // 1. The committed timeline, while idle and before any action; its progress list.
  await page.getByTestId(`scenario-load-${TIMELINE}`).click();
  await outcome(page, 'scenario-outcome', new RegExp(`Loaded ${TIMELINE}`));
  await expect(page.getByTestId('scenario-progress')).toBeVisible();
  const loaded = await sim<{ scenario: { name: string; entries: unknown[] } | null }>('/scenario');
  expect(loaded.scenario?.name).toBe(TIMELINE);
  await expect(page.getByTestId('scenario-progress').locator('tbody tr')).toHaveCount(
    loaded.scenario?.entries.length ?? -1,
  );

  // 2. Pacing: start, pause, one step, speed.
  await page.getByTestId('sim-resume').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'running');
  expect((await sim<Status>('/status')).state).toBe('running');
  await page.getByTestId('sim-pause').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'paused');
  const paused = await sim<Status>('/status');
  expect(paused.state).toBe('paused');
  await page.getByTestId('sim-step').click();
  await outcome(page, 'run-outcome', /Stepped to|No event left/);
  expect((await sim<Status>('/status')).events).toBeGreaterThan(paused.events);
  await page.getByTestId('sim-speed-input').fill('30');
  await page.getByTestId('sim-speed-apply').click();
  await outcome(page, 'run-outcome', /Speed 30×/);
  expect((await sim<Status>('/status')).speed).toBe(30);

  // 3. A failure injection with a repair time.
  const injectionsBefore = (await sim<{ injections: unknown[] }>('/faults/injections')).injections
    .length;
  await page.getByTestId('failure-machine').selectOption('cnc-02');
  await page.getByTestId('failure-code').fill('COOLANT-PRESSURE');
  await page.getByTestId('failure-repair').fill('12');
  await page.getByTestId('failure-inject').click();
  await outcome(page, 'failure-outcome', /Failure COOLANT-PRESSURE on cnc-02/);
  const injections = (
    await sim<{ injections: { machine: string; code: string; repairMs?: number }[] }>(
      '/faults/injections',
    )
  ).injections;
  expect(injections).toHaveLength(injectionsBefore + 1);
  expect(injections.at(-1)).toMatchObject({
    machine: 'cnc-02',
    code: 'COOLANT-PRESSURE',
    repairMs: 720_000,
  });
  // A refused one is shown as the simulator said it (an unknown code: 404).
  await page.getByTestId('failure-code').fill('NO-SUCH-CODE');
  await page.getByTestId('failure-inject').click();
  await expect(page.getByTestId('failure-outcome')).toHaveAttribute('data-kind', 'failed');

  // 4. A leak-test drift from now for 37 simulated minutes (off any calendar boundary).
  const now = (await sim<Status>('/status')).simTime;
  const until = isoAfter(now, 37 * 60_000 + 123);
  const driftsBefore = (await sim<{ drifts: unknown[] }>('/faults/drifts')).drifts.length;
  await page.getByTestId('drift-shift').fill('0.6');
  await page.getByTestId('drift-until').fill(until);
  await page.getByTestId('drift-inject').click();
  await outcome(page, 'drift-outcome', /Leak-test drift of 0.6/);
  const drifts = (await sim<{ drifts: { machine: string; until: string }[] }>('/faults/drifts'))
    .drifts;
  expect(drifts).toHaveLength(driftsBefore + 1);
  expect(drifts.at(-1)).toMatchObject({ machine: 'lkt-01', until });

  // 5. Infrastructure: CNC-02's OPC UA server offline and back, the washer silent and back.
  await page.getByTestId('opcua-toggle-cnc-02').click();
  await expect(page.getByTestId('opcua-state-cnc-02')).toHaveText('OPC UA offline');
  await page.getByTestId('opcua-toggle-cnc-02').click();
  await expect(page.getByTestId('opcua-state-cnc-02')).toHaveText('OPC UA online');
  await page.getByTestId('modbus-toggle').click();
  await expect(page.getByTestId('modbus-state')).toHaveText('Modbus silent');
  await page.getByTestId('modbus-toggle').click();
  await expect(page.getByTestId('modbus-state')).toHaveText('Modbus answering');

  // 6. A free lot blocked, then released.
  const lots = (await sim<{ lots: { lot: string; blocked: boolean }[] }>('/lots')).lots;
  // Not the timeline's lot (SK1-2610-01), so its actions are told apart below.
  const lot = lots.find((l) => !l.blocked && l.lot !== 'SK1-2610-01')?.lot;
  if (lot === undefined) throw new Error('no free lot');
  await page.getByTestId(`lot-block-${lot}`).click();
  await outcome(page, 'lot-outcome', new RegExp(`${lot} block`));
  await page.getByTestId(`lot-release-${lot}`).click();
  await outcome(page, 'lot-outcome', new RegExp(`${lot} release`));

  // 7. Both ASM-01 operators of Monday's shift C absent at its start.
  await page.getByTestId('absent-date').fill('2026-10-12');
  await page.getByTestId('absent-shift').selectOption('C');
  await page.getByTestId('absent-op-c1').check();
  await page.getByTestId('absent-op-c2').check();
  await page.getByTestId('absent-submit').click();
  await outcome(page, 'absent-outcome', /op-c1, op-c2 absent in shift 2026-10-12\/C/);

  // 8. CNC-01's tool breaks.
  await page.getByTestId('tool-break-cnc-01').click();
  await outcome(page, 'tool-outcome', /cnc-01's tool breaks/);

  // Every console action is in the simulator's list, in order, and on the page.
  const actions = (await sim<{ actions: Action[] }>('/actions')).actions;
  const mine = actions.filter(
    (a) =>
      (a.lot === lot && (a.kind === 'lot-block' || a.kind === 'lot-release')) ||
      (a.kind === 'operators-absent' && a.shift === '2026-10-12/C') ||
      (a.kind === 'tool-breakage' && a.machine === 'cnc-01'),
  );
  expect(mine.map((a) => a.kind)).toEqual([
    'lot-block',
    'lot-release',
    'operators-absent',
    'tool-breakage',
  ]);
  expect(mine[2]?.operators).toEqual(['op-c1', 'op-c2']);
  await expect(page.getByTestId('action-list').locator('li')).toHaveCount(actions.length, {
    timeout: 15_000,
  });

  // 9. The plant event stream through nginx, while the run goes on.
  await page.getByTestId('sim-resume').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('events-connection')).toHaveAttribute('data-connected', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('event-list').locator('li').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId('sim-pause').click();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'paused');
});

test('an operator sees neither the console nor its link', async ({ page }) => {
  await logIn(page, account('operator'));
  await expect(page.getByTestId('nav-console')).toHaveCount(0);
  await page.goto('/console');
  await expect(page.getByTestId('console-forbidden')).toContainText('sim:control');
});
