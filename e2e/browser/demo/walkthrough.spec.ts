import { expect, test, type Page } from '@playwright/test';
import {
  CLOSE_AT,
  CODE_AT,
  DEMO,
  SCENES,
  plantClock,
  plantTime,
  sceneAt,
} from '../../src/demo-plan.ts';
import { episodeIdentity } from '../../src/trace-shapes.ts';
import { account } from '../login.ts';
import {
  closeDemoPage,
  eventually,
  holdView,
  insideDemoRun,
  mes,
  openDemoPage,
  probeMs,
  recordScene,
  sim,
  simStatus,
  switchTo,
  untilPlantTime,
  untilProbeEnd,
} from './demo.ts';

/**
 * The demo walkthrough (#281, Phase 10 plan "Demo scenario (P10-06)", docs/demo.md): the eight
 * scenes through the real web UI on one page, at 60×, the users changing by logout and login, each
 * scene asserting what it shows (facts, never the event log's bytes). Runs only inside `pnpm demo`
 * (src/demo.ts), on the timeline `demo-v1` with the ERP dataset config/erp/demo-v1.yaml, which the
 * harness has just started. A scene with a time (src/demo-plan.ts, `SCENES`) first waits for the
 * simulation to reach it; probe D1 measured how long before that its facts exist.
 *
 * 1. Overview: the six machines with their live states, the plant clock following the run at 60×.
 * 2. Orders: the supervisor releases and dispatches the four orders of the ERP feed; each CNC the
 *    dispatch rule chose accepts its job, before the timeline's pause (06:14).
 * 3. Console (admin): the run paused by the timeline at 06:14, its progress list, a resume, a pause
 *    and a resume (infrastructure only).
 * 4. Alarms and downtime: CNC-01's spindle overload active, acknowledged by maintenance; after its
 *    repair its breakdown record coded by maintenance.
 * 5. OEE: CNC-01's availability loss on the dashboard; the line card's bottleneck equal to the
 *    MES's derived one (`GET /api/v1/oee/line`, ASM-01, ADR-0036); the first completed order's OEE
 *    and first-pass yield on its detail, equal to the MES's.
 * 6. SPC: the leak test's chart with the drift's first episode, the simulator's.
 * 7. Hold: a quality user opens a hold on the order of the episode's last unit from its suggested
 *    scope; the holds screen shows its scope; once complete, the order's close is refused.
 * 8. Traceability: a packed serial of a closed carton traced back to its blank lot, component lots,
 *    machines, operator and leak value; its blank lot traced forward to its cartons.
 */
const SHIFT = DEMO.shift;
const LEAK = DEMO.drift.characteristic;
const QUALITY_HOLD = 'urn:shopfloor:quality-hold';

let page: Page;
/** Whether beforeAll opened the page (a skipped run never does). */
let opened = false;
/** What one scene learnt and a later one needs. */
const learnt: {
  firstCompleted?: string;
  episode?: { id: number; lastPart: number; epoch: number };
  held?: { order: string; hold: string };
} = {};

test.beforeAll(async ({ browser }) => {
  test.skip(!insideDemoRun(), 'runs inside pnpm demo');
  // One context and one page for the whole walkthrough (under `pnpm demo:record`, one video).
  page = await openDemoPage(browser);
  opened = true;
});

test.afterAll(async () => {
  if (opened) await closeDemoPage(page);
});

/** Runs one scene: waits for its plant time, runs it, records it in the scene log. */
async function scene(n: number, body: () => Promise<Record<string, unknown>>): Promise<void> {
  const meta = SCENES.find((s) => s.n === n);
  if (!meta) throw new Error(`no scene ${String(n)}`);
  const at = sceneAt(meta.id);
  if (at !== null) await untilPlantTime(at);
  const wallStart = new Date().toISOString();
  const plantStart = (await simStatus()).simTime;
  const facts = await body();
  await recordScene({
    n,
    id: meta.id,
    title: meta.title,
    wallStart,
    wallEnd: new Date().toISOString(),
    plantStart,
    plantEnd: (await simStatus()).simTime,
    facts,
  });
}

// ---- The MES's answers, as much of them as the scenes read ----

interface Ratio {
  readonly decimal: string;
  readonly fraction: string;
}
interface Order {
  readonly id: string;
  readonly status: string;
  readonly completedAt?: string | null;
}
interface Command {
  readonly commandId: string;
  readonly equipment: string;
  readonly confirmed: boolean;
  readonly state: string;
  readonly notBefore: string;
  readonly acceptedAt: string | null;
}
interface Alarm {
  readonly id: string;
  readonly equipment: string;
  readonly code: string;
  readonly raisedAt: string;
  readonly state: string;
  readonly acknowledged: { readonly by: string } | null;
}
interface DowntimeRecord {
  readonly id: string;
  readonly equipment: string;
  readonly start: string;
  readonly end: string | null;
  readonly state: string;
  readonly cause: string | null;
  readonly autoReason: string;
  readonly provisional: boolean;
  readonly ms: number;
  readonly segments: readonly { readonly reason: string; readonly coded: boolean }[];
}
interface OeeBucket {
  readonly id: string;
  readonly result: {
    readonly availability: Ratio | null;
    readonly losses: { readonly availability: { readonly own: { readonly down: number } } } | null;
  };
}
interface Signal {
  readonly id: number;
  readonly chart: string;
  readonly rule: number;
  readonly version: number;
  readonly baseline: boolean;
  readonly status: string;
  readonly first: {
    readonly epoch: number;
    readonly partId: number;
    readonly pass: number;
    readonly at: string;
  };
  readonly last: { readonly epoch: number; readonly partId: number; readonly pass: number };
}
interface TraceRecord {
  readonly operation: string;
  readonly pass: number;
  readonly equipment: string;
  readonly seq: number;
  readonly result: string;
  readonly lots: readonly { readonly material: string; readonly lot: string }[] | null;
  readonly operator: string | null;
  readonly reading: { readonly value: number; readonly upperLimit: number } | null;
}
interface TraceUnit {
  readonly epoch: number;
  readonly partId: number;
  readonly serial: string | null;
  readonly orderId: string | null;
  readonly status: string;
  readonly carton: string | null;
  readonly records: readonly TraceRecord[];
}

const orderOf = (id: string) =>
  mes<{ order: Order; commands: readonly Command[] }>(
    page,
    `/api/v1/orders/${encodeURIComponent(id)}`,
  );

test('the demo walkthrough: eight scenes, each asserting what it shows', async () => {
  // About 7 minutes of wall time at 60×; a scene's waits are bounded on their own.
  test.setTimeout(30 * 60_000);
  await test.step('scene 1, overview: six machines live at 60×', async () => {
    await scene(1, async () => {
      await switchTo(page, account('operator'));
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
        timeout: 30_000,
      });
      await expect(page.locator('article[data-testid^="machine-"]')).toHaveCount(
        DEMO.machines.length,
      );
      const states: Record<string, string> = {};
      for (const id of DEMO.machines) {
        const badge = page.getByTestId(`state-${id}`);
        await expect(badge).not.toHaveAttribute('data-state', 'no-data');
        states[id] = (await badge.getAttribute('data-state')) ?? '';
      }
      // Live at 60×: the run goes at 60×, and the page's plant clock follows it (it moves on while
      // the run does; once the timeline's pause has stopped the run, it has reached the pause).
      const status = await simStatus();
      expect(status.speed).toBe(DEMO.speed);
      expect(['running', 'paused']).toContain(status.state);
      const clock = page.getByTestId('plant-clock').locator('time');
      const first = Date.parse((await clock.getAttribute('datetime')) ?? '');
      expect(first).toBeGreaterThanOrEqual(Date.parse(DEMO.start));
      let moved: number;
      if (status.state === 'running') {
        await expect
          .poll(async () => Date.parse((await clock.getAttribute('datetime')) ?? ''), {
            timeout: 15_000,
          })
          .toBeGreaterThan(first);
        moved = Date.parse((await clock.getAttribute('datetime')) ?? '');
      } else {
        // Already held by the timeline's pause: the page's clock has followed the run to it.
        expect(Date.parse(status.simTime)).toBe(DEMO.pauseAt);
        await expect
          .poll(async () => Date.parse((await clock.getAttribute('datetime')) ?? ''), {
            timeout: 15_000,
          })
          .toBe(DEMO.pauseAt);
        moved = DEMO.pauseAt;
      }
      await holdView(page, 1, 'overview');
      return { speed: status.speed, states, plantClock: [plantClock(first), plantClock(moved)] };
    });
  });

  await test.step('scene 2, orders: the supervisor releases and dispatches; the CNCs accept their jobs', async () => {
    await scene(2, async () => {
      await switchTo(page, account('supervisor'));
      await page.goto('/orders');
      for (const order of DEMO.orders) {
        await expect(page.getByTestId(`order-row-${order.id}`)).toHaveAttribute(
          'data-status',
          'imported',
        );
      }
      await holdView(page, 2, 'orders');
      for (const order of DEMO.orders) {
        await page.goto('/orders');
        await page.getByTestId(`order-link-${order.id}`).click();
        await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'imported');
        await page.getByTestId('action-release').click();
        await expect(page.getByTestId('action-form-release')).toBeVisible();
        await page.getByTestId('action-submit').click();
        await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'released');
      }
      for (const order of DEMO.orders) {
        await page.goto(`/orders/${order.id}`);
        await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'released');
        await page.getByTestId('action-dispatch').click();
        await expect(page.getByTestId('action-form-dispatch')).toBeVisible();
        // The dispatch rule chooses the CNC (the empty choice).
        await expect(page.getByTestId('action-cnc')).toHaveValue('');
        await page.getByTestId('action-submit').click();
        await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'dispatched');
      }
      // Each command confirmed by its `accepted` job fact on the CNC probe D1 assumes, before the
      // timeline's pause (the envelope D1 measured), to start at the planned start.
      const accepted: Record<string, { machine: string; acceptedAt: string }> = {};
      for (const order of DEMO.orders) {
        const command = await eventually(`${order.id}'s job accepted`, 90_000, async () => {
          const { commands } = await orderOf(order.id);
          const found = commands.find((c) => c.confirmed && c.state === 'accepted');
          return found
            ? { found }
            : { seen: JSON.stringify(commands.map((c) => [c.commandId, c.state, c.confirmed])) };
        });
        expect([command.commandId, command.equipment]).toEqual([
          `${order.id}~OP10~1`,
          order.machine,
        ]);
        expect(Date.parse(command.notBefore)).toBe(DEMO.plannedStart);
        expect(Date.parse(command.acceptedAt ?? '')).toBeLessThanOrEqual(DEMO.pauseAt);
        accepted[order.id] = {
          machine: command.equipment,
          acceptedAt: plantClock(Date.parse(command.acceptedAt ?? '')),
        };
      }
      for (const order of DEMO.orders) {
        await page.goto(`/orders/${order.id}`);
        const shown = page.getByTestId(`command-${order.id}~OP10~1`);
        await expect(shown).toBeVisible();
        await expect(shown.getByTestId('command-confirmed')).toBeVisible();
        await holdView(page, 2, `order-${order.id}`, { locator: shown, block: 'center' });
      }
      return { accepted };
    });
  });

  await test.step('scene 3, console: the run paused by the timeline, its progress, a resume, a pause and a resume', async () => {
    await scene(3, async () => {
      await switchTo(page, account('admin'));
      await page.getByTestId('nav-console').click();
      await expect(page.getByRole('heading', { name: 'Simulation console' })).toBeVisible();
      await expect(page.getByTestId('scenario-name')).toContainText(DEMO.timeline);
      const loaded = await sim<{ scenario: { name: string; entries: unknown[] } | null }>(
        '/scenario',
      );
      const rows = page.getByTestId('scenario-progress').locator('tbody tr');
      await expect(rows).toHaveCount(loaded.scenario?.entries.length ?? -1);
      // The timeline's own pause (infrastructure) holds the run at 06:14 until the console resumes.
      await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'paused', {
        timeout:
          Math.max(0, DEMO.pauseAt - Date.parse((await simStatus()).simTime)) / DEMO.speed + 30_000,
      });
      const paused = await simStatus();
      expect([paused.state, Date.parse(paused.simTime), paused.speed]).toEqual([
        'paused',
        DEMO.pauseAt,
        DEMO.speed,
      ]);
      const pauseRow = rows.filter({ has: page.getByRole('cell', { name: 'pause', exact: true }) });
      await expect(pauseRow).toHaveAttribute('data-status', 'applied');
      await expect(page.getByTestId('sim-speed')).toHaveText(`${String(DEMO.speed)}×`);
      const pending = await rows.evaluateAll(
        (trs) => trs.filter((tr) => tr.getAttribute('data-status') !== 'applied').length,
      );

      const states: string[] = [];
      for (const [control, state] of [
        ['sim-resume', 'running'],
        ['sim-pause', 'paused'],
        ['sim-resume', 'running'],
      ] as const) {
        await page.getByTestId(control).click();
        await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', state);
        await expect.poll(async () => (await simStatus()).state).toBe(state);
        states.push(state);
      }
      await holdView(page, 3, 'console');
      return {
        pausedAt: plantClock(DEMO.pauseAt),
        entries: loaded.scenario?.entries.length,
        pending,
        states,
      };
    });
  });

  if (probeMs > 0) {
    // The 60 s size probe of `pnpm demo:record` (#282): scenes 1 to 3, then the run until 60 s.
    await untilProbeEnd();
    return;
  }

  await test.step('scene 4, alarms and downtime: the spindle overload active, acknowledged by maintenance, its breakdown coded', async () => {
    await scene(4, async () => {
      const maintenance = account('maintenance');
      await switchTo(page, maintenance);
      const alarm = await eventually(
        `${DEMO.failure.code} on ${DEMO.failure.machine} raised at ${plantClock(DEMO.failure.at)}`,
        30_000,
        async () => {
          const { alarms } = await mes<{ alarms: Alarm[] }>(page, '/api/v1/alarms?view=active');
          const found = alarms.find(
            (a) =>
              a.equipment === DEMO.failure.machine &&
              a.code === DEMO.failure.code &&
              Date.parse(a.raisedAt) === DEMO.failure.at,
          );
          return found
            ? { found }
            : { seen: alarms.map((a) => `${a.equipment} ${a.code}`).join('; ') };
        },
      );
      await page.goto('/alarms?view=active');
      const row = page.getByTestId(`alarm-row-${alarm.id}`);
      await expect(row).toHaveAttribute('data-state', 'unacked-active');
      await expect(row).toHaveAttribute('data-code', DEMO.failure.code);
      await holdView(page, 4, 'alarm-active', { locator: row, block: 'center' });
      await page.getByTestId(`ack-${alarm.id}`).click();
      // Acknowledged while still active: it leaves Active for the Acknowledged tab.
      await expect(row).toHaveCount(0);
      await page.getByTestId('tab-acknowledged').click();
      await expect(page.getByTestId('alarm-list')).toHaveAttribute('data-view', 'acknowledged');
      await expect(row).toHaveAttribute('data-state', 'acked-active');
      const acked = await mes<{ occurrence: Alarm }>(
        page,
        `/api/v1/alarms/${encodeURIComponent(alarm.id)}`,
      );
      expect([acked.occurrence.state, acked.occurrence.acknowledged?.by]).toEqual([
        'acked-active',
        maintenance.username,
      ]);
      await holdView(page, 4, 'alarm-acknowledged', { locator: row, block: 'center' });

      // After the repair (30 minutes of plant time): the breakdown's record, closed, coded by hand.
      const repaired = DEMO.failure.at + 30 * 60_000;
      await untilPlantTime(plantTime(CODE_AT));
      const query = new URLSearchParams({
        from: new Date(DEMO.failure.at - 3_600_000).toISOString(),
        to: new Date(repaired + 3_600_000).toISOString(),
      });
      const record = await eventually('the breakdown record closed and final', 30_000, async () => {
        const { records } = await mes<{ records: DowntimeRecord[] }>(
          page,
          `/api/v1/downtime?${query.toString()}`,
        );
        const found = records.find(
          (r) =>
            r.equipment === DEMO.failure.machine &&
            r.state === 'Down' &&
            r.cause === DEMO.failure.code &&
            r.end !== null &&
            !r.provisional,
        );
        return found
          ? { found }
          : { seen: records.map((r) => `${r.equipment} ${r.state}`).join('; ') };
      });
      expect([Date.parse(record.start), Date.parse(record.end ?? ''), record.autoReason]).toEqual([
        DEMO.failure.at,
        repaired,
        `BREAKDOWN/${DEMO.failure.code}`,
      ]);
      await page.goto(`/downtime?shift=${encodeURIComponent(SHIFT)}`);
      await page.getByTestId('machine-filter').selectOption(DEMO.failure.machine);
      const downtimeRow = page.getByTestId(`downtime-row-${record.id}`);
      await expect(downtimeRow).toHaveAttribute('data-reason', record.autoReason, {
        timeout: 30_000,
      });
      await page.getByTestId(`code-${record.id}`).click();
      await expect(page.getByTestId('coding-panel')).toHaveAttribute('data-record', record.id);
      const pickers = page.getByTestId('reason-picker');
      await expect(pickers).toHaveCount(1);
      await pickers.first().selectOption(record.autoReason);
      await page
        .getByTestId('segment-comment')
        .fill('Spindle overload confirmed; bearing replaced');
      await page.getByTestId('save-coding').click();
      await expect(page.getByTestId('coding-message')).toHaveAttribute('data-kind', 'saved');
      await expect(page.getByTestId('audit-entry')).toHaveCount(1);
      await expect(page.getByTestId('audit-entry').first()).toContainText(
        `coded by ${maintenance.username}`,
      );
      const coded = (
        await mes<{ records: DowntimeRecord[] }>(page, `/api/v1/downtime?${query.toString()}`)
      ).records.find((r) => r.id === record.id);
      expect(coded?.segments.map((s) => [s.reason, s.coded])).toEqual([[record.autoReason, true]]);
      await holdView(page, 4, 'downtime-coded');
      return {
        alarm: alarm.id,
        acknowledgedBy: maintenance.username,
        record: record.id,
        downMinutes: record.ms / 60_000,
        codedAs: record.autoReason,
      };
    });
  });

  await test.step('scene 5, OEE: CNC-01’s availability loss, the line’s bottleneck, an order’s OEE and first-pass yield', async () => {
    await scene(5, async () => {
      await switchTo(page, account('supervisor'));
      const machine = DEMO.failure.machine;
      const shift = await mes<{ start: string; end: string; equipment: OeeBucket[] }>(
        page,
        `/api/v1/shifts/${SHIFT}/oee`,
      );
      const bucket = shift.equipment.find((b) => b.id === machine);
      const availability = bucket?.result.availability ?? null;
      expect(availability).not.toBeNull();
      expect(Number(availability?.decimal)).toBeLessThan(1);
      expect(bucket?.result.losses?.availability.own.down ?? 0).toBeGreaterThanOrEqual(30 * 60_000);

      await page.goto(`/oee?shift=${encodeURIComponent(SHIFT)}&focus=${machine}`);
      const machineRow = page.getByTestId(`oee-machine-${machine}`);
      await expect(machineRow).toBeVisible({ timeout: 30_000 });
      const paretoRow = page
        .getByTestId('pareto')
        .getByTestId(`pareto-BREAKDOWN/${DEMO.failure.code}`);
      await expect(paretoRow).toBeVisible({ timeout: 30_000 });
      // On the page: the breakdown's 30 minutes in CNC-01's Pareto, its availability below 1.
      await expect(paretoRow.locator('td').nth(2)).toHaveText('30.0 min');
      const shownAvailability = machineRow.locator('td').nth(1);
      await expect(shownAvailability).toHaveText(/^0\.\d{4}$/);
      await expect(shownAvailability).not.toHaveText('1.0000');

      // The line card's bottleneck per product, equal to the MES's derived one.
      const line = await mes<{ bottlenecks: { product: string; equipment: string[] }[] }>(
        page,
        `/api/v1/oee/line?${new URLSearchParams({ bucket: 'shift', from: shift.start, to: shift.end }).toString()}`,
      );
      const card = page.getByTestId('line-oee-card');
      await expect(card).toHaveAttribute('data-key', SHIFT, { timeout: 30_000 });
      await expect(card.getByTestId('line-bottlenecks')).toBeVisible();
      const shown = await card.locator('[data-testid^="line-bottleneck-"]').evaluateAll((items) =>
        items.map((item) => ({
          product: (item.getAttribute('data-testid') ?? '').slice('line-bottleneck-'.length),
          equipment: item.getAttribute('data-equipment'),
        })),
      );
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).toEqual(
        line.bottlenecks.map((b) => ({ product: b.product, equipment: b.equipment.join(',') })),
      );
      const vb100 = shown.find((b) => b.product === 'VB-100');
      expect(vb100?.equipment).toBe(DEMO.bottleneck);
      // The dashboard's three asserted views, loaded (asserted above), top to bottom.
      await holdView(page, 5, 'oee-line', { locator: page.locator('#line-title') });
      await holdView(page, 5, 'oee-machines', { locator: page.locator('#machines-title') });
      await holdView(page, 5, 'oee-pareto', { locator: page.getByTestId('pareto') });

      // The first order completed: its OEE and first-pass yield on its detail, final.
      const { orders } = await mes<{ orders: Order[] }>(page, '/api/v1/orders');
      const completed = orders.filter((o) => o.status === 'completed' || o.status === 'closed');
      expect(completed.length).toBeGreaterThan(0);
      const first = [...completed].sort((a, b) =>
        (a.completedAt ?? '').localeCompare(b.completedAt ?? ''),
      )[0];
      if (!first) throw new Error('no completed order');
      learnt.firstCompleted = first.id;
      await page.goto(`/orders/${encodeURIComponent(first.id)}`);
      const section = page.getByTestId('order-oee');
      await expect(section).toHaveAttribute('data-final', 'true', { timeout: 60_000 });
      await expect(section.getByTestId('order-fpy')).toHaveAttribute('data-final', 'true');
      const api = await mes<{
        oee: { oee: Ratio | null; availability: Ratio | null };
        firstPassYield: { firstPassGood: number; started: number; yield: Ratio | null };
      }>(page, `/api/v1/oee/orders/${encodeURIComponent(first.id)}`);
      await expect(section.getByTestId('order-oee-oee')).toHaveAttribute(
        'data-fraction',
        api.oee.oee?.fraction ?? 'n/a',
      );
      await expect(section.getByTestId('order-oee-availability')).toHaveAttribute(
        'data-fraction',
        api.oee.availability?.fraction ?? 'n/a',
      );
      await expect(section.getByTestId('order-fpy-yield')).toHaveAttribute(
        'data-fraction',
        api.firstPassYield.yield?.fraction ?? 'n/a',
      );
      await expect(section.getByTestId('order-fpy-good')).toHaveText(
        String(api.firstPassYield.firstPassGood),
      );
      await expect(section.getByTestId('order-fpy-started')).toHaveText(
        String(api.firstPassYield.started),
      );
      expect(api.oee.oee).not.toBeNull();
      expect(api.firstPassYield.yield).not.toBeNull();
      await holdView(page, 5, 'order-oee', { locator: page.getByTestId('order-oee-section') });
      return {
        machine,
        availability: availability?.decimal,
        downMinutes: (bucket?.result.losses?.availability.own.down ?? 0) / 60_000,
        bottleneck: vb100?.equipment,
        order: first.id,
        orderOee: api.oee.oee?.decimal,
        orderAvailability: api.oee.availability?.decimal,
        firstPassYield: api.firstPassYield.yield?.decimal,
      };
    });
  });

  await test.step('scene 6, SPC: the leak test’s chart with the drift’s episode', async () => {
    await scene(6, async () => {
      await switchTo(page, account('quality'));
      // The drift's first episode in the simulator's truth and in the MES.
      const truth = (
        await sim<{ trace: { drifts: { firstEpisode: Record<string, unknown> | null }[] } }>(
          '/ground-truth',
        )
      ).trace.drifts[0]?.firstEpisode as
        | {
            chart: string;
            rule: number;
            version: number;
            partId: number;
            pass: number;
            baseline: boolean;
          }
        | null
        | undefined;
      expect(truth).toBeTruthy();
      if (!truth) throw new Error('the truth has no drift episode');
      expect(truth.baseline).toBe(false);
      const signal = await eventually('the drift’s first episode in the MES', 60_000, async () => {
        const { signals } = await mes<{ signals: Signal[] }>(
          page,
          `/api/v1/quality/characteristics/${LEAK}/chart?all=true`,
        );
        const found = signals.find(
          (s) =>
            s.status !== 'withdrawn' &&
            episodeIdentity({ ...s, partId: s.first.partId, pass: s.first.pass }) ===
              episodeIdentity(truth),
        );
        return found
          ? { found }
          : { seen: signals.map((s) => `${String(s.id)} ${s.chart}`).join('; ') };
      });
      expect(signal.baseline).toBe(false);
      expect(Date.parse(signal.first.at)).toBeGreaterThanOrEqual(DEMO.drift.at);
      learnt.episode = { id: signal.id, lastPart: signal.last.partId, epoch: signal.last.epoch };

      await page.goto(`/quality/spc/${LEAK}`);
      await expect(page.getByTestId('spc-baseline')).toHaveAttribute('data-limits', '1', {
        timeout: 30_000,
      });
      const row = page.getByTestId(`signal-row-${String(signal.id)}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toHaveAttribute('data-chart', signal.chart);
      await expect(row).toHaveAttribute('data-rule', String(signal.rule));
      await expect(row).toHaveAttribute('data-baseline', 'false');
      await holdView(page, 6, 'spc-episode');
      return {
        signal: signal.id,
        chart: signal.chart,
        rule: signal.rule,
        firstAt: plantClock(Date.parse(signal.first.at)),
        identity: episodeIdentity(truth),
      };
    });
  });

  await test.step('scene 7, hold: from the episode, its scope on the holds screen, the order’s close refused', async () => {
    await scene(7, async () => {
      const episode = learnt.episode;
      if (!episode) throw new Error('scene 6 found no episode');
      // Still the quality user, on the SPC page.
      await page.goto(`/quality/spc/${LEAK}`);
      await page.getByTestId(`hold-from-${String(episode.id)}`).click();
      const suggestion = page.getByTestId('hold-suggestion');
      await expect(suggestion).toHaveAttribute('data-signal', String(episode.id), {
        timeout: 30_000,
      });
      await expect(suggestion).toHaveAttribute('data-final', 'true', { timeout: 60_000 });
      const api = await mes<{
        units: { epoch: number; partId: number; orderId: string | null }[];
        orders: string[];
      }>(page, `/api/v1/quality/signals/${String(episode.id)}/hold-suggestion`);
      const order = api.units.find(
        (u) => u.epoch === episode.epoch && u.partId === episode.lastPart,
      )?.orderId;
      expect(order).toBeTruthy();
      if (!order) throw new Error('the episode’s last unit has no order');
      expect(api.orders).toContain(order);
      await page.getByTestId(`suggest-order-${order}`).check();
      await page.getByTestId('open-reason').selectOption('SPC-SIGNAL');
      await page.getByTestId('open-submit').click();
      await expect(page.getByTestId(`open-result-order-${order}`)).toHaveAttribute(
        'data-kind',
        'opened',
        { timeout: 30_000 },
      );
      const hold = (
        await mes<{
          holds: {
            id: string;
            state: string;
            openedBy: string;
            subject: { kind: string; id: string };
          }[];
        }>(page, '/api/v1/quality/holds')
      ).holds.find(
        (h) => h.subject.kind === 'order' && h.subject.id === order && h.state === 'open',
      );
      expect(hold).toBeDefined();
      if (!hold) throw new Error('no open hold on the order');
      expect(hold.openedBy).toBe(account('quality').username);
      await holdView(page, 7, 'hold-opened', {
        locator: page.getByTestId(`open-result-order-${order}`),
        block: 'center',
      });

      // The holds screen: the hold and its scope.
      await page.goto('/quality/holds');
      const holdRow = page.getByTestId(`hold-row-${hold.id}`);
      await expect(holdRow).toHaveAttribute('data-subject', `order:${order}`, { timeout: 30_000 });
      await expect(holdRow).toHaveAttribute('data-state', 'open');
      await holdView(page, 7, 'holds-list', { locator: holdRow, block: 'center' });
      await page.getByTestId(`hold-link-${hold.id}`).click();
      await expect(page.getByTestId('hold-summary')).toHaveAttribute('data-state', 'open', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('hold-orders')).toHaveText(order);
      // The units are paged by 50 (#333): step the pager until the episode's last unit shows.
      const unitRow = page.getByTestId(
        `hold-unit-${String(episode.epoch)}-${String(episode.lastPart)}`,
      );
      const nextUnits = page
        .getByRole('navigation', { name: "Units in the hold's scope: pages" })
        .getByRole('button', { name: 'Next' });
      await expect(async () => {
        if (!(await unitRow.isVisible()) && (await nextUnits.count()) > 0) {
          if (await nextUnits.isEnabled()) await nextUnits.click();
        }
        await expect(unitRow).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      const counts = page.getByTestId('hold-scope-counts');
      await expect(counts).toHaveAttribute('data-orders', '1');
      const units = Number(await counts.getAttribute('data-units'));
      expect(units).toBeGreaterThan(0);
      await holdView(page, 7, 'hold-detail');

      // Once the order is complete, its close is refused while the hold is open.
      await untilPlantTime(plantTime(CLOSE_AT));
      await switchTo(page, account('supervisor'));
      await eventually(`${order} completed`, 60_000, async () => {
        const { order: o } = await orderOf(order);
        return o.status === 'completed' ? { found: o } : { seen: o.status };
      });
      let refusal = '';
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.goto(`/orders/${encodeURIComponent(order)}`);
        await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
        await page.getByTestId('action-close').click();
        await page.getByTestId('action-submit').click();
        const message = page.getByTestId('action-message');
        await expect(message).toBeVisible({ timeout: 30_000 });
        refusal = (await message.getAttribute('data-kind')) ?? '';
        // Genealogy a round behind the order's last facts (ADR-0035): retryable, try again.
        if (refusal !== 'genealogy-pending') break;
        await page.waitForTimeout(1_000);
      }
      expect(refusal).toBe('quality-hold');
      await expect(page.getByTestId('action-message')).toHaveAttribute('data-type', QUALITY_HOLD);
      await expect(page.getByTestId(`action-hold-${hold.id}`)).toBeVisible();
      expect((await orderOf(order)).order.status).toBe('completed');
      await holdView(page, 7, 'close-refused');
      learnt.held = { order, hold: hold.id };
      return { signal: episode.id, order, hold: hold.id, units, refused: QUALITY_HOLD };
    });
  });

  await test.step('scene 8, traceability: a packed serial back to its lots, machines, operator and leak value; its blank lot forward', async () => {
    await scene(8, async () => {
      await switchTo(page, account('quality'));
      const orderId = learnt.firstCompleted;
      if (!orderId) throw new Error('scene 5 found no completed order');
      // A closed carton of the first completed order, and a packed serial in it.
      const cartonId = `${orderId}-C01`;
      await page.goto(`/trace/cartons/${encodeURIComponent(cartonId)}`);
      const carton = page.getByTestId('trace-carton');
      await expect(carton).toHaveAttribute('data-status', 'closed', { timeout: 30_000 });
      const packed = page.locator('[data-testid^="carton-unit-"][data-status="packed"]').first();
      await expect(packed).toBeVisible();
      const serial = (await packed.getAttribute('data-serial')) ?? '';
      expect(serial).not.toBe('');
      await holdView(page, 8, 'trace-carton', { locator: packed, block: 'center' });
      await packed.locator('[data-testid^="serial-link-"]').click();

      // Back: the serial's records, as the MES holds them, and what they must be.
      await expect(page.getByTestId('trace-serial')).toHaveAttribute('data-serial', serial, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('trace-finality')).toHaveAttribute('data-final', 'true', {
        timeout: 30_000,
      });
      const answer = await mes<{ units: TraceUnit[] }>(
        page,
        `/api/v1/trace/serials/${encodeURIComponent(serial)}`,
      );
      const unit = answer.units[0];
      if (!unit) throw new Error(`no unit with serial ${serial}`);
      expect([unit.status, unit.carton, unit.orderId]).toEqual(['packed', cartonId, orderId]);
      for (const record of unit.records) {
        const row = page.getByTestId(`record-${record.operation}-${String(record.pass)}`);
        await expect(row).toHaveAttribute('data-equipment', record.equipment);
        await expect(row).toHaveAttribute('data-seq', String(record.seq));
        await expect(row.locator('[data-testid^="lot-link-"]')).toHaveCount(
          record.lots?.length ?? 0,
        );
        for (const lot of record.lots ?? []) {
          await expect(row.getByTestId(`lot-link-${lot.lot}`)).toBeVisible();
        }
        if (record.operator !== null) {
          await expect(row.getByTestId('record-operator')).toHaveText(record.operator);
        }
        if (record.reading !== null) {
          await expect(row.getByTestId('record-reading')).toHaveAttribute(
            'data-value',
            String(record.reading.value),
          );
        }
      }
      const byOperation = (op: string) =>
        unit.records.find((r) => r.operation === op && r.pass === 1);
      const op10 = byOperation('OP10');
      const op30 = byOperation('OP30');
      const op40 = byOperation('OP40');
      const op50 = byOperation('OP50');
      // The blank from a BLANK-100 lot on the CNC the order was dispatched to.
      const dispatched = (await orderOf(orderId)).commands[0]?.equipment;
      expect(op10?.equipment).toBe(dispatched);
      expect(op10?.lots?.map((l) => l.material)).toEqual([DEMO.blockedMaterial]);
      const blankLot = op10?.lots?.[0]?.lot ?? '';
      // The seal kit and the spool at assembly, by its operator.
      expect([...(op30?.lots ?? []).map((l) => l.material)].sort()).toEqual(['SK-1', 'SP-100']);
      expect(op30?.equipment).toBe('asm-01');
      expect(op30?.operator).toBeTruthy();
      // The leak value under the limit, and the packing.
      expect(op40?.equipment).toBe(DEMO.drift.machine);
      expect(op40?.reading?.value).toBeLessThanOrEqual(op40?.reading?.upperLimit ?? -1);
      expect(op50?.equipment).toBe('pck-01');
      // The simulator's truth: the unit consumed each of these lots.
      const truthLots = (
        await sim<{ trace: { lots: { lot: string; units: number[]; cartons: string[] }[] } }>(
          '/ground-truth',
        )
      ).trace.lots;
      for (const lot of unit.records.flatMap((r) => r.lots ?? [])) {
        expect(truthLots.find((l) => l.lot === lot.lot)?.units, lot.lot).toContain(unit.partId);
      }
      await holdView(page, 8, 'trace-serial', {
        locator: page.getByTestId('trace-records-section'),
      });

      // Forward: the blank lot to its cartons, the serial's among them.
      await page.getByTestId('record-OP10-1').getByTestId(`lot-link-${blankLot}`).click();
      const lotPage = page.getByTestId('trace-lot');
      await expect(lotPage).toHaveAttribute('data-lot', blankLot, { timeout: 30_000 });
      await expect(lotPage).toHaveAttribute('data-material', DEMO.blockedMaterial);
      const cartons = page.getByTestId('lot-cartons').locator('[data-testid^="trace-carton-"]');
      await expect(cartons.first()).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId('lot-cartons').getByTestId(`trace-carton-${cartonId}`),
      ).toBeVisible();
      const shownCartons = await cartons.evaluateAll((links) =>
        links.map((l) => (l.getAttribute('data-testid') ?? '').slice('trace-carton-'.length)),
      );
      const truthCartons =
        (
          await sim<{ trace: { lots: { lot: string; cartons: string[] }[] } }>('/ground-truth')
        ).trace.lots.find((l) => l.lot === blankLot)?.cartons ?? [];
      for (const id of shownCartons) expect(truthCartons, id).toContain(id);
      await holdView(page, 8, 'trace-lot', {
        locator: page.getByTestId('lot-cartons'),
        block: 'center',
      });
      return {
        carton: cartonId,
        serial,
        partId: unit.partId,
        blankLot,
        components: (op30?.lots ?? []).map((l) => l.lot),
        machines: unit.records.map((r) => `${r.operation}:${r.equipment}`),
        operator: op30?.operator,
        leak: op40?.reading?.value,
        cartonsOfLot: shownCartons.length,
      };
    });
  });
});
