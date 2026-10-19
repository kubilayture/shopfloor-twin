import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { account, logIn, signOnAtTerminal, type Account } from '../../login.ts';
import { MesClient, SimulatorClient } from '../../../src/clients.ts';
import type { TraceSerialCase } from '../../../src/quality-pass.ts';
import { episodeIdentity, type TraceSectionJson } from '../../../src/trace-shapes.ts';

/**
 * Phase 8 exit criterion 5, after the drain (#204), on the paused quality-01 stack:
 * 1. the trace page of a serial packed in shift A shows, per record, the machine, the lots and the
 *    reading of the truth (the MES's answer, which the reconciliation compared with the truth), and
 *    on its OP30 record the crew user signed on to Line A1 at that cycle's start (the live check's
 *    operator);
 * 2. a quality user opens a hold from the drift's SPC episode (its suggested scope: the serial of
 *    the episode's triggering unit) and a lot hold from the lot's trace page;
 * 3. the Line A1 terminal shows both holds and the episode;
 * 4. operators sign off the order the lot hold covers at both terminals; the supervisor's close is
 *    refused (`quality-hold`) through the UI; the quality user releases the lot hold; the close
 *    then succeeds.
 * The reconciliation then checks the ERP's notifications and the audit log.
 */
const mesUrl = process.env.RECONCILE_MES_URL ?? '';
const simUrl = process.env.RECONCILE_SIM_URL ?? '';
/** The control API's token (#237): the run passes it with the address. */
const simToken = process.env.RECONCILE_SIM_TOKEN ?? '';
const results = process.env.RECONCILE_RESULTS;
const traceCase = JSON.parse(process.env.RECONCILE_TRACE_CASE ?? 'null') as TraceSerialCase | null;
/** The MES's id of the drift's first episode, and the serial of its triggering unit. */
const signalId = process.env.RECONCILE_SIGNAL ?? '';
const signalSerial = process.env.RECONCILE_SIGNAL_SERIAL ?? '';
/** The lot to hold from its trace page, and the completed order it covers. */
const lot = process.env.RECONCILE_LOT_HOLD ?? '';
const closeOrder = process.env.RECONCILE_CLOSE_ORDER ?? '';
const LINE_OPERATIONS = ['OP30', 'OP40', 'OP50'];
const CELL_OPERATIONS = ['OP10', 'OP20'];

async function desk(browser: Browser, user?: Account): Promise<{ page: Page; cookie: string }> {
  const page = await (await browser.newContext()).newPage();
  const cookie = await logIn(page, user);
  return { page, cookie };
}

/** Signs off the order's operations of one work center at its terminal, then signs off there. */
async function signOffAt(page: Page, workCenter: string, operations: readonly string[]) {
  for (const operation of operations) {
    const id = `${closeOrder}-${operation}`;
    await expect(page.getByTestId(`terminal-op-state-${id}`)).toContainText('Complete', {
      timeout: 30_000,
    });
    await page.getByTestId(`terminal-sign-off-${id}`).click();
    await expect(page.getByTestId(`terminal-op-state-${id}`)).toContainText('Signed off by');
  }
  await page.getByTestId('terminal-sign-off').click();
  await expect(page.getByTestId('terminal-username')).toHaveValue('');
  return { workCenter, operations };
}

test('a serial traces back with its crew; holds from an SPC episode and a lot; the close is refused while held and allowed after release', async ({
  browser,
}) => {
  test.skip(mesUrl === '', 'runs inside pnpm test:reconcile');
  test.setTimeout(300_000);
  expect(traceCase).not.toBeNull();
  if (!traceCase) return;
  expect([simUrl, signalId, signalSerial, lot, closeOrder].every((v) => v !== '')).toBe(true);
  const quality = account('quality');
  const operator = account('operator');

  // 1. The serial's trace page: machines, lots, readings, and the crew at its OP30 cycle.
  const q = await desk(browser, quality);
  await q.page.goto(`/trace/serials/${encodeURIComponent(traceCase.serial)}`);
  await expect(q.page.getByTestId('trace-serial')).toHaveAttribute(
    'data-serial',
    traceCase.serial,
    {
      timeout: 30_000,
    },
  );
  await expect(q.page.getByTestId('trace-finality')).toHaveAttribute('data-final', 'true');
  await expect(q.page.getByTestId('trace-records')).toHaveAttribute(
    'data-count',
    String(traceCase.records.length),
  );
  for (const record of traceCase.records) {
    const row = q.page.getByTestId(`record-${record.operation}-${String(record.pass)}`);
    await expect(row).toHaveAttribute('data-equipment', record.machine);
    await expect(row).toHaveAttribute('data-seq', String(record.seq));
    await expect(row).toHaveAttribute('data-result', record.result);
    await expect(row.getByTestId('record-machine')).toContainText(record.machine, {
      ignoreCase: true,
    });
    // Exactly the record's lots (review LOW 1): one link each, no other.
    await expect(row.locator('[data-testid^="lot-link-"]')).toHaveCount(record.lots.length);
    for (const id of record.lots) await expect(row.getByTestId(`lot-link-${id}`)).toBeVisible();
    if (record.reading !== null) {
      await expect(row.getByTestId('record-reading')).toHaveAttribute(
        'data-value',
        String(record.reading),
      );
    }
    if (record.operator !== null) {
      await expect(row.getByTestId('record-operator')).toHaveText(record.operator);
    }
  }
  const op30 = q.page.getByTestId('record-OP30-1');
  await expect(
    op30.getByTestId('record-crew').locator(`[data-user="${traceCase.operator}"]`),
  ).toBeVisible();

  // 2a. A hold from the drift's episode: its suggested scope, the triggering unit's serial.
  await q.page.goto('/quality/spc/leak-rate');
  await q.page.getByTestId(`hold-from-${signalId}`).click();
  await expect(q.page.getByTestId('hold-suggestion')).toHaveAttribute('data-signal', signalId, {
    timeout: 30_000,
  });
  await expect(q.page.getByTestId('hold-suggestion')).toHaveAttribute('data-final', 'true');
  await q.page.getByTestId(`suggest-serial-${signalSerial}`).check();
  await q.page.getByTestId('open-submit').click();
  const opened = q.page.getByTestId(`open-result-serial-${signalSerial}`);
  await expect(opened).toHaveAttribute('data-kind', 'opened');
  const mesQ = new MesClient(mesUrl, q.cookie);
  const signalHold = (await mesQ.holds()).holds.find(
    (h) => h.subject.kind === 'serial' && h.subject.id === signalSerial && h.state === 'open',
  );
  expect(signalHold).toBeDefined();

  // 2b. A lot hold from the lot's trace page.
  await q.page.goto(`/trace/lots/${encodeURIComponent(lot)}`);
  await expect(q.page.getByTestId('trace-lot')).toHaveAttribute('data-lot', lot, {
    timeout: 30_000,
  });
  await q.page.getByTestId('trace-hold-open').click();
  await expect(q.page.getByTestId('hold-open-form')).toBeVisible();
  await expect(q.page.getByTestId('open-id')).toHaveValue(lot);
  await q.page.getByTestId('open-submit').click();
  await expect(q.page.getByTestId('hold-detail')).toBeVisible({ timeout: 30_000 });
  const lotHoldId = (await q.page.getByTestId('hold-detail').getAttribute('data-hold')) ?? '';
  await expect(q.page.getByTestId('hold-summary')).toHaveAttribute('data-state', 'open');
  const lotHold = await mesQ.hold(lotHoldId);
  expect([lotHold.hold.subject, lotHold.orders.includes(closeOrder)]).toEqual([
    { kind: 'lot', id: lot },
    true,
  ]);

  // 3. The Line A1 terminal: both holds and the episode.
  const tablet = await (await browser.newContext()).newPage();
  const tabletCookie = await signOnAtTerminal(tablet, 'line-a1', operator);
  await expect(tablet.getByTestId(`terminal-hold-${lotHoldId}`)).toHaveAttribute(
    'data-subject',
    `lot:${lot}`,
    { timeout: 30_000 },
  );
  await expect(tablet.getByTestId(`terminal-hold-${signalHold?.id ?? ''}`)).toHaveAttribute(
    'data-subject',
    `serial:${signalSerial}`,
  );
  // The episodes: the terminal's ten newest after the baseline that are open or not acknowledged
  // (TERMINAL_LIMITS.signals). The drift's first one is older than the shift's last ten, so the
  // live check judged it on the terminal while it was among them; here the list must be the ten.
  const shownSignals = (await mesQ.spcChart('leak-rate')).signals
    .filter(
      (s) =>
        s.status !== 'withdrawn' && !s.baseline && (s.closedBy === null || s.acknowledged === null),
    )
    .sort((a, b) => Date.parse(b.first.at) - Date.parse(a.first.at) || b.id - a.id)
    .slice(0, 10)
    .map((s) => String(s.id));
  expect(shownSignals.length).toBeGreaterThan(0);
  const signalRows = tablet.locator('[data-testid^="terminal-signal-"]');
  await expect(signalRows).toHaveCount(shownSignals.length);
  const terminalSignals = await signalRows.evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-testid')?.slice('terminal-signal-'.length) ?? ''),
  );
  expect([...terminalSignals].sort()).toEqual([...shownSignals].sort());
  // And the truth's ten newest episodes after the baseline (review LOW 2): none is acknowledged,
  // so the terminal's ten are the truth's by identity (newest first; among equal times the later
  // in the truth's list).
  const truthTrace = (await new SimulatorClient(simUrl, simToken).groundTruthJson())
    .trace as TraceSectionJson;
  const truthNewest = truthTrace.spc.episodes
    .map((episode, index) => ({ episode, index }))
    .filter(({ episode }) => !episode.baseline)
    .sort((a, b) => Date.parse(b.episode.at) - Date.parse(a.episode.at) || b.index - a.index)
    .slice(0, 10)
    .map(({ episode }) => episodeIdentity(episode))
    .sort();
  const identityOf = new Map(
    (await mesQ.spcChart('leak-rate')).signals.map((s) => [
      String(s.id),
      episodeIdentity({
        chart: s.chart,
        rule: s.rule,
        version: s.version,
        partId: s.first.partId,
        pass: s.first.pass,
      }),
    ]),
  );
  expect(terminalSignals.map((id) => identityOf.get(id) ?? `id ${id}`).sort()).toEqual(truthNewest);
  // The holds: exactly the open holds touching the work center's orders (review LOW 2).
  const workCenterOrders = new Set(
    (await new MesClient(mesUrl, tabletCookie).terminal('line-a1')).orders.map((o) => o.order.id),
  );
  const openHolds = (await mesQ.holds()).holds.filter((h) => h.state === 'open');
  const touching: string[] = [];
  for (const hold of openHolds) {
    const detail = await mesQ.hold(hold.id);
    if (detail.orders.some((o) => workCenterOrders.has(o))) touching.push(hold.id);
  }
  const holdRows = tablet.locator('[data-testid^="terminal-hold-"]');
  await expect(holdRows).toHaveCount(touching.length);
  const terminalHolds = await holdRows.evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-testid')?.slice('terminal-hold-'.length) ?? ''),
  );
  expect([...terminalHolds].sort()).toEqual([...touching].sort());
  const terminal = {
    holds: terminalHolds.length,
    signals: terminalSignals,
    truthNewest,
  };

  // 4. Sign-offs at both terminals, then the close: refused while held, allowed after release.
  const signedOff = [await signOffAt(tablet, 'line-a1', LINE_OPERATIONS)];
  await signOnAtTerminal(tablet, 'cell-m1', operator);
  signedOff.push(await signOffAt(tablet, 'cell-m1', CELL_OPERATIONS));
  await tablet.context().close();

  const s = await desk(browser);
  const supervisor = new MesClient(mesUrl, s.cookie);
  await s.page.goto(`/orders/${closeOrder}`);
  await expect(s.page.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
  await s.page.getByTestId('action-close').click();
  await s.page.getByTestId('action-submit').click();
  const message = s.page.getByTestId('action-message');
  await expect(message).toHaveAttribute('data-kind', 'quality-hold', { timeout: 30_000 });
  await expect(message).toHaveAttribute('data-type', 'urn:shopfloor:quality-hold');
  await expect(s.page.getByTestId(`action-hold-${lotHoldId}`)).toBeVisible();
  expect((await supervisor.order(closeOrder)).order.status).toBe('completed');

  await q.page.goto(`/quality/holds/${lotHoldId}`);
  await q.page.getByTestId('hold-action-release').click();
  await expect(q.page.getByTestId('hold-form-release')).toBeVisible();
  const reason = q.page.getByTestId('hold-reason');
  const firstReason = await reason.locator('option').first().getAttribute('value');
  await reason.selectOption(firstReason ?? '');
  await q.page.getByTestId('hold-submit').click();
  await expect(q.page.getByTestId('hold-summary')).toHaveAttribute('data-state', 'released', {
    timeout: 30_000,
  });

  await s.page.goto(`/orders/${closeOrder}`);
  await expect(s.page.getByTestId('order-status')).toHaveAttribute('data-status', 'completed');
  await s.page.getByTestId('action-close').click();
  await s.page.getByTestId('action-submit').click();
  await expect(s.page.getByTestId('order-status')).toHaveAttribute('data-status', 'closed', {
    timeout: 30_000,
  });
  const closed = (await supervisor.order(closeOrder)).order;
  expect([closed.status, closed.closedAt === null]).toEqual(['closed', false]);

  const summary = {
    trace: {
      serial: traceCase.serial,
      records: traceCase.records.length,
      crew: traceCase.operator,
    },
    signal: { id: signalId, serial: signalSerial, hold: signalHold?.id ?? null },
    lot: { id: lot, hold: lotHoldId, order: closeOrder, releasedWith: firstReason },
    terminal,
    signedOff,
    refused: 'urn:shopfloor:quality-hold',
    closed: closed.status,
    holds: [signalHold?.id ?? '', lotHoldId],
  };
  console.log(`trace, holds and close: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'quality-final.json'), JSON.stringify(summary, null, 2));
});
