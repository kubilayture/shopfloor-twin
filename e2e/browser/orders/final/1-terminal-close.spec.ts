import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { account, logIn, signOnAtTerminal } from '../../login.ts';
import { MesClient } from '../../../src/clients.ts';

/**
 * Phase 7 exit criterion 5, after shift A (#178): the reconciliation has drained shift A and then
 * stepped the paused simulator on to the first machine scrap of orders-01 (CNC-01, PO-2610-007,
 * Tuesday's shift A), so a scrap record waits at Cell M1. On one shared tablet page:
 * 1. the operator signs on at Line A1 and signs off the completed order's operations there
 *    (OP30–OP50), then signs off at the terminal;
 * 2. the operator signs on at Cell M1, starts coding the scrap record (a reason chosen, a comment
 *    typed) and signs off without saving: a draft;
 * 3. a second operator signs on at the same page and sees none of it (no reason chosen, an empty
 *    comment), codes the scrap record, signs off the order's OP10 and OP20 at Cell M1 and signs off;
 * then the supervisor closes the order through `/orders/<id>` (every operation is signed off at
 * both work centers). The reconciliation checks the ERP's `closed` and the audit log.
 */
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const results = process.env.RECONCILE_RESULTS;
/** A completed order of shift A to sign off and close (orders-01: PO-2610-001). */
const closeOrder = process.env.RECONCILE_CLOSE_ORDER ?? 'PO-2610-001';
/** The order whose scrap record waits at Cell M1 (orders-01: PO-2610-007). */
const scrapOrder = process.env.RECONCILE_SCRAP_ORDER ?? 'PO-2610-007';
/** The routing's operations per work center: the CNCs and the washer at Cell M1, the rest Line A1. */
const LINE_OPERATIONS = ['OP30', 'OP40', 'OP50'];
const CELL_OPERATIONS = ['OP10', 'OP20'];
const DRAFT_COMMENT = 'draft of the first operator, never saved';

test('operators sign off a completed order at both terminals, a second operator sees none of the first one’s drafts and codes the scrap, the supervisor closes', async ({
  browser,
}) => {
  test.skip(mesUrl === '', 'runs inside pnpm test:reconcile');
  test.setTimeout(240_000);
  const first = account('operator');
  const second = account('operator2');
  const tablet = await (await browser.newContext()).newPage();

  // 1. Line A1: the completed order's operations there, signed off.
  await signOnAtTerminal(tablet, 'line-a1', first);
  await expect(tablet.getByTestId(`terminal-order-${closeOrder}`)).toBeVisible({ timeout: 30_000 });
  for (const operation of LINE_OPERATIONS) {
    const id = `${closeOrder}-${operation}`;
    await expect(tablet.getByTestId(`terminal-op-state-${id}`)).toContainText('Complete');
    await tablet.getByTestId(`terminal-sign-off-${id}`).click();
    await expect(tablet.getByTestId(`terminal-op-state-${id}`)).toContainText(
      `Signed off by ${first.username}`,
    );
  }
  await tablet.getByTestId('terminal-sign-off').click();
  await expect(tablet.getByTestId('terminal-username')).toHaveValue('');

  // 2. Cell M1: a draft of a scrap coding, then sign-off without saving it.
  const cellCookie = await signOnAtTerminal(tablet, 'cell-m1', first);
  const records = (await new MesClient(mesUrl, cellCookie).scrapRecords(scrapOrder)).records.filter(
    (r) => r.codedReason === null,
  );
  expect(records.length).toBeGreaterThanOrEqual(1);
  const record = records[0];
  if (!record) throw new Error('no scrap record');
  const scrapId = String(record.id);
  const reasons = tablet.locator(`[data-testid^="terminal-scrap-reason-${scrapId}-"]`);
  await expect(reasons.first()).toBeVisible({ timeout: 30_000 });
  const choice = reasons.nth((await reasons.count()) > 1 ? 1 : 0);
  const reason = ((await choice.getAttribute('data-testid')) ?? '').slice(
    `terminal-scrap-reason-${scrapId}-`.length,
  );
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await tablet.getByTestId(`terminal-scrap-comment-${scrapId}`).fill(DRAFT_COMMENT);
  await tablet.getByTestId('terminal-sign-off').click();
  await expect(tablet.getByTestId('terminal-username')).toHaveValue('');
  await expect(tablet.getByTestId('terminal-password')).toHaveValue('');

  // 3. The second operator on the same page: none of the draft, then the coding, OP10 and OP20.
  const secondCookie = await signOnAtTerminal(tablet, 'cell-m1', second);
  await expect(tablet.getByTestId(`terminal-scrap-${scrapId}`)).toBeVisible({ timeout: 30_000 });
  await expect(tablet.getByTestId(`terminal-scrap-comment-${scrapId}`)).toHaveValue('');
  await expect(
    tablet.locator(`[data-testid^="terminal-scrap-reason-${scrapId}-"][aria-pressed="true"]`),
  ).toHaveCount(0);
  await expect(tablet.getByText(DRAFT_COMMENT)).toHaveCount(0);
  await tablet.getByTestId(`terminal-scrap-reason-${scrapId}-${reason}`).click();
  await tablet
    .getByTestId(`terminal-scrap-comment-${scrapId}`)
    .fill('coded at the Cell M1 terminal');
  await tablet.getByTestId(`terminal-scrap-code-${scrapId}`).click();
  await expect(tablet.getByTestId(`terminal-scrap-${scrapId}`)).toHaveCount(0);
  const coded = (await new MesClient(mesUrl, secondCookie).scrapRecords(scrapOrder)).records.find(
    (r) => r.id === record.id,
  );
  expect([coded?.codedReason, coded?.codedBy]).toEqual([reason, second.username]);
  for (const operation of CELL_OPERATIONS) {
    const id = `${closeOrder}-${operation}`;
    await expect(tablet.getByTestId(`terminal-op-state-${id}`)).toContainText('Complete');
    await tablet.getByTestId(`terminal-sign-off-${id}`).click();
    await expect(tablet.getByTestId(`terminal-op-state-${id}`)).toContainText(
      `Signed off by ${second.username}`,
    );
  }
  await tablet.getByTestId('terminal-sign-off').click();
  await expect(tablet.getByTestId('terminal-username')).toHaveValue('');
  await tablet.context().close();

  // The supervisor closes the order (every operation signed off at both work centers).
  const desk = await (await browser.newContext()).newPage();
  const supervisor = new MesClient(mesUrl, await logIn(desk));
  await desk.goto(`/orders/${closeOrder}`);
  await expect(desk.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
  await desk.getByTestId('action-close').click();
  await expect(desk.getByTestId('action-form-close')).toBeVisible();
  await desk.getByTestId('action-submit').click();
  await expect(desk.getByTestId('order-status')).toHaveAttribute('data-status', 'closed');
  const closed = (await supervisor.order(closeOrder)).order;
  expect([closed.status, closed.closedAt === null]).toEqual(['closed', false]);
  await desk.context().close();

  const summary = {
    closeOrder,
    signedOff: { [first.username]: LINE_OPERATIONS, [second.username]: CELL_OPERATIONS },
    scrap: { id: record.id, order: scrapOrder, reason, codedBy: second.username },
    draftSeenBySecond: false,
  };
  console.log(`terminal and close: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'terminal-close.json'), JSON.stringify(summary, null, 2));
});
