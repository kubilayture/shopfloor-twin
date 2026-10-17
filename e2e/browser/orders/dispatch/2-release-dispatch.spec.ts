import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { logIn } from '../../login.ts';
import { MesClient } from '../../../src/clients.ts';

/**
 * Phase 7 exit criterion 4, the dispatch (#178, ADR-0030 B3): while the simulator is attached and
 * idle at the start time, the supervisor releases orders-01's released orders through
 * `/orders/<id>` (in the scenario's `erp.release` order), then dispatches each through the same
 * screen with the dispatch rule's choice, in the order of the scenario's `dispatches`, and waits
 * until its command is confirmed by its device fact before the next one. So the devices accept the
 * jobs in exactly the order the headless run applies them, and the live run equals the headless one.
 * The reconciliation then compares the commands with `dispatches` and the CNC queues with the
 * golden ground truth's jobs.
 */
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const results = process.env.RECONCILE_RESULTS;
const release = JSON.parse(process.env.RECONCILE_RELEASE ?? '[]') as string[];
const dispatches = JSON.parse(process.env.RECONCILE_DISPATCHES ?? '[]') as {
  commandId: string;
  orderId: string;
  machine: string;
}[];
/** How long one command may take from the click to its confirming device fact. */
const CONFIRM_MS = 60_000;

test('a supervisor releases and dispatches orders-01 through the UI, each command confirmed by its device fact', async ({
  page,
}) => {
  test.skip(mesUrl === '', 'runs inside pnpm test:reconcile, which starts the stack');
  expect(release.length).toBeGreaterThan(0);
  expect(dispatches.length).toBeGreaterThan(0);
  test.setTimeout(60_000 + release.length * 15_000 + dispatches.length * (CONFIRM_MS + 15_000));
  const mes = new MesClient(mesUrl, await logIn(page));
  const timings: { orderId: string; commandId: string; machine: string; confirmedMs: number }[] =
    [];

  for (const id of release) {
    await page.goto(`/orders/${id}`);
    await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'imported');
    await page.getByTestId('action-release').click();
    await expect(page.getByTestId('action-form-release')).toBeVisible();
    await page.getByTestId('action-submit').click();
    await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'released');
    await expect(page.getByTestId('action-done')).toBeVisible();
  }

  for (const dispatch of dispatches) {
    const clicked = Date.now();
    await page.goto(`/orders/${dispatch.orderId}`);
    await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'released');
    await page.getByTestId('action-dispatch').click();
    await expect(page.getByTestId('action-form-dispatch')).toBeVisible();
    // The dispatch rule chooses the CNC (the empty choice): the MES must make orders-01's choice.
    await expect(page.getByTestId('action-cnc')).toHaveValue('');
    await page.getByTestId('action-submit').click();
    await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'dispatched');
    // Confirmed by its `accepted` job fact (not only the gateway's cmd-res) before the next one.
    await expect
      .poll(
        async () => {
          const { commands } = await mes.order(dispatch.orderId);
          return commands.map((c) => [c.commandId, c.equipment, c.confirmed, c.state]);
        },
        { timeout: CONFIRM_MS, intervals: [250] },
      )
      .toEqual([[dispatch.commandId, dispatch.machine, true, 'accepted']]);
    await expect(page.getByTestId(`command-${dispatch.commandId}`)).toBeVisible();
    timings.push({ ...dispatch, confirmedMs: Date.now() - clicked });
  }

  const summary = { released: release, dispatched: timings };
  console.log(`release and dispatch: ${JSON.stringify(summary)}`);
  if (results) await writeFile(join(results, 'dispatch.json'), JSON.stringify(summary, null, 2));
});
