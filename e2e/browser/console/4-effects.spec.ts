import { expect, test } from '@playwright/test';
import { account, logIn } from '../login.ts';
import {
  alarmsRaised,
  describeRecords,
  downtime,
  eventually,
  insideConsoleRun,
  mes,
  outcome,
  pause,
  resume,
  setSpeed,
  sim,
  type SimStatus,
} from './effects.ts';

/**
 * Exit criterion 4's effects (#270, P9-F3), on the run 2-actions.spec.ts left paused near Monday
 * 06:00: each action is taken through `/console` as admin, then its effect is read in the MES
 * (through nginx with admin's session), so it has crossed the whole plant path: the simulator,
 * OPC UA, the gateway, MQTT/UNS and ingest.
 *
 * - Every lot of OP10's input material blocked: an OP10 machine is then Starved with cause
 *   `MATERIAL:<material>`, in an interval that began after the block.
 * - A failure injected on PCK-01 (PRINTER-FAULT, a machine and code no other step uses): its
 *   alarm is raised in the MES at the simulation time the simulator applied the injection.
 *
 * ASM-01 `Idle` `NO-OPERATOR` at a shift start needs a shift that starts after the run's time and
 * that this run's timeline doesn't already leave unstaffed (it marks shift B absent): that check
 * runs on a second simulator run started at 13:40 (browser/console-shift, src/console-pass.ts).
 */
const BLOCK_EFFECT_MS = 90_000;
const ALARM_EFFECT_MS = 60_000;
const FAILURE = { machine: 'pck-01', code: 'PRINTER-FAULT', repairMinutes: 3 } as const;

interface Lot {
  lot: string;
  material: string;
  blocked: boolean;
}
interface Injection {
  id: number;
  machine: string;
  code: string;
  status: string;
  appliedAt?: string;
}

test.beforeAll(() => {
  test.skip(!insideConsoleRun(), 'runs inside pnpm test:console');
});

test('a blocked OP10 lot starves OP10 with MATERIAL:, an injected failure raises its alarm', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await logIn(page, account('admin'));
  await page.getByTestId('nav-console').click();
  await expect(page.getByRole('heading', { name: 'Simulation console' })).toBeVisible();
  if ((await sim<SimStatus>('/status')).state === 'running') await pause(page);
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'paused');

  // OP10's machines and the material they take, from the MES and the simulator's lots.
  const op10 = (
    await mes<{ equipment: { id: string; operation: string }[] }>(page, '/api/v1/equipment')
  ).equipment
    .filter((e) => e.operation === 'OP10')
    .map((e) => e.id);
  expect(op10.length, 'OP10 machines in the MES').toBeGreaterThan(0);
  const blockedAt = Date.parse((await sim<SimStatus>('/status')).simTime);
  // Monday's schedule starts both CNCs on VB-100, whose blank is BLANK-100 (config/plant).
  const MATERIAL = 'BLANK-100';
  const lots = (await sim<{ lots: Lot[] }>('/lots')).lots.filter((l) => l.material === MATERIAL);
  expect(lots.length, `lots of ${MATERIAL}`).toBeGreaterThan(0);

  // 1. Every lot of OP10's material blocked through the console (one lot alone would leave the
  //    other to draw from).
  for (const { lot } of lots) {
    await page.getByTestId(`lot-block-${lot}`).click();
    await outcome(page, 'lot-outcome', new RegExp(`${lot} block`));
  }

  // 2. A failure injected now, with a short repair.
  const before = (await sim<{ injections: Injection[] }>('/faults/injections')).injections.length;
  await page.getByTestId('failure-machine').selectOption(FAILURE.machine);
  await page.getByTestId('failure-code').fill(FAILURE.code);
  await page.getByTestId('failure-at').fill('');
  await page.getByTestId('failure-repair').fill(String(FAILURE.repairMinutes));
  await page.getByTestId('failure-inject').click();
  await outcome(
    page,
    'failure-outcome',
    new RegExp(`Failure ${FAILURE.code} on ${FAILURE.machine}`),
  );
  const injections = (await sim<{ injections: Injection[] }>('/faults/injections')).injections;
  expect(injections).toHaveLength(before + 1);
  const injection = injections.at(-1);
  expect(injection).toMatchObject({ machine: FAILURE.machine, code: FAILURE.code });
  const injectionId = injection?.id ?? -1;

  // The run goes on at 60×, through the console.
  await setSpeed(page, 60);
  await resume(page);

  // Effect 1: an OP10 machine Starved MATERIAL:BLANK-100 in the MES, from after the block.
  const window = { from: blockedAt - 3_600_000, to: blockedAt + 8 * 3_600_000 };
  const starved = await eventually(
    `an OP10 machine (${op10.join(', ')}) Starved with cause MATERIAL:${MATERIAL} after ${new Date(blockedAt).toISOString()}`,
    BLOCK_EFFECT_MS,
    async () => {
      const records = (await downtime(page, window.from, window.to)).filter((r) =>
        op10.includes(r.equipment),
      );
      const hit = records.find(
        (r) =>
          r.state === 'Starved' &&
          r.cause === `MATERIAL:${MATERIAL}` &&
          Date.parse(r.intervalStart) >= blockedAt,
      );
      return hit ? { found: hit } : { seen: describeRecords(records) };
    },
  );
  expect(starved.cause?.startsWith('MATERIAL:')).toBe(true);
  console.log(`OP10 starved: ${describeRecords([starved])}`);

  // Effect 2: the injection applied in the simulator, and its alarm raised in the MES at that time.
  const applied = await eventually(
    `injection ${String(injectionId)} applied in the simulator`,
    ALARM_EFFECT_MS,
    async () => {
      const found = (await sim<{ injections: Injection[] }>('/faults/injections')).injections.find(
        (i) => i.id === injectionId,
      );
      return found?.appliedAt !== undefined
        ? { found: Date.parse(found.appliedAt) }
        : { seen: JSON.stringify(found) };
    },
  );
  const alarm = await eventually(
    `alarm ${FAILURE.code} on ${FAILURE.machine} raised at ${new Date(applied).toISOString()} in the MES`,
    ALARM_EFFECT_MS,
    async () => {
      const alarms = await alarmsRaised(page, applied - 60_000, applied + 3_600_000);
      const hit = alarms.find(
        (a) =>
          a.equipment === FAILURE.machine &&
          a.code === FAILURE.code &&
          Date.parse(a.raisedAt) === applied,
      );
      return hit
        ? { found: hit }
        : {
            seen:
              alarms.map((a) => `${a.equipment} ${a.code} at ${a.raisedAt}`).join('; ') ||
              'no alarm',
          };
    },
  );
  console.log(
    `alarm raised: ${alarm.equipment} ${alarm.code} at ${alarm.raisedAt} (epoch ${String(alarm.epoch)})`,
  );
  expect(alarm.equipment).toBe(FAILURE.machine);

  // Back to a paused run with the lots free.
  await pause(page);
  for (const { lot } of lots) {
    await page.getByTestId(`lot-release-${lot}`).click();
    await outcome(page, 'lot-outcome', new RegExp(`${lot} release`));
  }
});
