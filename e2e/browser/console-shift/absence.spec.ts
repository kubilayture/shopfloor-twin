import { expect, test } from '@playwright/test';
import { account, logIn } from '../login.ts';
import {
  confirm,
  describeRecords,
  downtime,
  eventually,
  insideConsoleRun,
  outcome,
  pause,
  resume,
  setSpeed,
  sim,
  type SimStatus,
} from '../console/effects.ts';

/**
 * Exit criterion 4's absence effect (#270, P9-F3): both ASM-01 operators of shift B marked absent
 * through `/console` as admin leave ASM-01 `Idle` with cause `NO-OPERATOR` from that shift's start,
 * read in the MES (through nginx with admin's session).
 *
 * `pnpm test:console` runs this project on a second simulator run, started idle at Monday 13:40
 * (src/console-pass.ts recreates the simulator; a new device epoch for the MES): in the first run
 * its timeline marks shift B absent and 2-actions.spec.ts marks shift C absent, so no later Monday
 * shift is free. From 13:40 shift B is 20 simulated minutes away: 20 s at 60×. Only records of this
 * run's epoch count, so an earlier run's record of the same instant can't pass the check.
 */
const SHIFT = { date: '2026-10-12', id: 'B', start: Date.parse('2026-10-12T14:00:00+03:00') };
const OPERATORS = ['op-b1', 'op-b2'] as const;
const MACHINE = 'asm-01';
const EFFECT_MS = 120_000;

test.beforeAll(() => {
  test.skip(!insideConsoleRun(), 'runs inside pnpm test:console');
});

test('both ASM-01 operators of shift B absent: ASM-01 Idle NO-OPERATOR from its start', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await logIn(page, account('admin'));
  await page.getByTestId('nav-console').click();
  await expect(page.getByRole('heading', { name: 'Simulation console' })).toBeVisible();
  await expect(page.getByTestId('sim-state')).toHaveAttribute('data-state', 'idle');
  const startedAt = Date.parse((await sim<SimStatus>('/status')).simTime);
  expect(startedAt, 'the second run starts before shift B').toBeLessThan(SHIFT.start);
  const { epoch } = await sim<{ epoch: number }>('/ground-truth');

  // Both of shift B's ASM-01 operators absent, through the console's operator panel.
  await page.getByTestId('absent-date').fill(SHIFT.date);
  await page.getByTestId('absent-shift').selectOption(SHIFT.id);
  for (const op of OPERATORS) await page.getByTestId(`absent-${op}`).check();
  await page.getByTestId('absent-submit').click();
  await confirm(page, 'confirm-absent', 'Mark absent');
  await outcome(
    page,
    'absent-outcome',
    new RegExp(`${OPERATORS.join(', ')} absent in shift ${SHIFT.date}/${SHIFT.id}`),
  );

  // To the shift start at the console's top speed.
  await setSpeed(page, 60);
  await resume(page);

  const record = await eventually(
    `${MACHINE} Idle with cause NO-OPERATOR from ${new Date(SHIFT.start).toISOString()} in epoch ${String(epoch)} in the MES`,
    EFFECT_MS,
    async () => {
      const records = (await downtime(page, startedAt, SHIFT.start + 3_600_000)).filter(
        (r) => r.equipment === MACHINE,
      );
      const hit = records.find(
        (r) =>
          r.epoch === epoch &&
          r.state === 'Idle' &&
          r.cause === 'NO-OPERATOR' &&
          Date.parse(r.intervalStart) === SHIFT.start,
      );
      return hit ? { found: hit } : { seen: describeRecords(records) };
    },
  );
  expect(record.state).toBe('Idle');
  console.log(`ASM-01 at the shift start: ${describeRecords([record])}`);
  await pause(page);
});
