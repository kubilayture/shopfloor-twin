import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DowntimeRecordDto, Pareto } from '@shopfloor/contracts/mes-api';
import { expect, test, type Page } from '@playwright/test';
import { MesClient, rawRequest } from '../../src/clients.ts';
import { logIn, reconcileUser } from '../login.ts';

/**
 * Phase 5 exit criterion 4, the UI part (#123): after shift A is final and the MES has drained,
 * an operator recodes and splits one downtime record through `/downtime`. The audit shows the
 * write, the shift's Pareto moves exactly by the record's time, and shift A's OEE stays
 * byte-identical (`GET /shifts/{date}/A/oee`) and on the dashboard. Writes with a foreign Origin,
 * without an Origin and with a form content type are refused against the same stack.
 */
const webUrl = process.env.RECONCILE_WEB_URL;
const results = process.env.RECONCILE_RESULTS;
const shiftKey = process.env.RECONCILE_SHIFT ?? '2026-10-12/A';
/** The coding's author is the logged-in user (#170). */
const CODED_BY = reconcileUser;
/** Shortest record to split: both halves at least a few seconds, on whole plant seconds. */
const MIN_MS = 10_000;

const plantClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Reason ms per (reason, loss) of a Pareto. */
const byReason = (pareto: Pareto) =>
  Object.fromEntries(pareto.reasons.map((row) => [`${row.reason}|${row.loss}`, row.ms]));

/** Each work center card's `data-oee` on the dashboard for the shift. */
async function cardValues(page: Page, ids: readonly string[]): Promise<Record<string, string>> {
  await page.goto(`/oee?shift=${encodeURIComponent(shiftKey)}`);
  const values: Record<string, string> = {};
  for (const id of ids) {
    const card = page.getByTestId(`oee-card-${id}`);
    await expect(card).toHaveAttribute('data-final', 'true', { timeout: 30_000 });
    values[id] = (await card.getAttribute('data-oee')) ?? '';
  }
  return values;
}

test('a recode and a split through the UI change the Pareto and the audit, not OEE', async ({
  page,
}) => {
  test.skip(!webUrl, 'runs inside pnpm test:reconcile, after the drain');
  test.setTimeout(120_000);
  const base = webUrl ?? '';
  // The API as the page reads it: through nginx, same origin, with the page's session.
  const api = new MesClient(base, await logIn(page));

  const shift = await api.shiftOee(shiftKey);
  expect(shift.equipment.every((bucket) => bucket.final)).toBe(true);
  const oeeBefore = await api.shiftOeeText(shiftKey);
  const workCenters = shift.workCenters.map((bucket) => bucket.id).sort();
  const apiCards = Object.fromEntries(
    shift.workCenters.map((bucket) => [bucket.id, bucket.result.oee?.decimal ?? 'n/a']),
  );
  const cardsBefore = await cardValues(page, workCenters);
  expect(cardsBefore).toEqual(apiCards);

  // A closed, final record of the shift that nobody coded (the golden week has no UNCODED
  // record, exit criterion 4: every cause is matched by an auto-rule), the longest one.
  const list = await api.downtime(shift.start, shift.end);
  const candidates = list.records
    .filter(
      (r) =>
        r.shiftKey === shiftKey &&
        r.end !== null &&
        !r.provisional &&
        r.codings.length === 0 &&
        r.ms >= MIN_MS,
    )
    .sort((a, b) => b.ms - a.ms || a.id.localeCompare(b.id));
  const record: DowntimeRecordDto | undefined = candidates[0];
  if (!record) throw new Error(`no closed, final, uncoded record of ${shiftKey}`);
  const start = Date.parse(record.start);
  const end = Date.parse(record.end ?? '');

  // Two leaf reasons other than the automatic one, preferably ones the machine's Pareto lacks.
  const paretoBefore = await api.pareto('equipment', record.equipment, shift.start, shift.end);
  const reasons = (await api.reasonCodes()).reasons;
  const leaves = reasons.filter(
    (r) =>
      r.active &&
      r.id !== 'UNCODED' &&
      r.id !== record.autoReason &&
      !reasons.some((child) => child.parent === r.id),
  );
  const present = new Set(paretoBefore.reasons.map((row) => row.reason));
  leaves.sort((a, b) => Number(present.has(a.id)) - Number(present.has(b.id)));
  const [first, second] = leaves.map((r) => r.id);
  if (first === undefined || second === undefined) throw new Error('fewer than two reasons');
  // So the dashboard's Pareto row below can only come from this coding.
  if (present.has(first)) throw new Error(`every candidate reason is already in the Pareto`);

  // Split on a whole plant second near the middle.
  const split = Math.floor((start + end) / 2_000) * 1_000;
  expect(split).toBeGreaterThan(start);
  expect(split).toBeLessThan(end);

  await page.goto(`/downtime?shift=${encodeURIComponent(shiftKey)}`);
  await page.getByTestId('machine-filter').selectOption(record.equipment);
  const row = page.getByTestId(`downtime-row-${record.id}`);
  await expect(row).toHaveAttribute('data-reason', record.autoReason, { timeout: 30_000 });
  await page.getByTestId(`code-${record.id}`).click();
  await expect(page.getByTestId('coding-panel')).toHaveAttribute('data-record', record.id);
  await page.getByTestId('split-at').fill(plantClock.format(split));
  await page.getByTestId('split').click();
  const pickers = page.getByTestId('reason-picker');
  await expect(pickers).toHaveCount(2);
  await pickers.nth(0).selectOption(first);
  await pickers.nth(1).selectOption(second);
  // No name to type any more (#170): the MES takes it from the session.
  await expect(page.getByTestId('coded-by')).toHaveCount(0);
  await page.getByTestId('save-coding').click();
  await expect(page.getByTestId('coding-message')).toHaveAttribute('data-kind', 'saved');
  await expect(page.getByTestId('draft-conflict')).toHaveCount(0);

  // The audit: one `coded` entry by this actor, shown on the screen and in the API.
  const entries = page.getByTestId('audit-entry');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText(`coded by ${CODED_BY}`);
  const audit = await api.audit(record.id);
  expect(audit.entries).toHaveLength(1);
  const entry = audit.entries[0];
  expect(entry?.action).toBe('coded');
  expect(entry?.actor).toBe(CODED_BY);
  expect(entry?.before).toEqual([]);
  expect(
    entry?.after.map((c) => [Date.parse(c.from), Date.parse(c.to), c.reason, c.codedBy]),
  ).toEqual([
    [start, split, first, CODED_BY],
    [split, end, second, CODED_BY],
  ]);

  // The record carries both codings; the row shows the reason in effect over most of it.
  const coded = (await api.downtime(record.start, record.end ?? '')).records.find(
    (r) => r.id === record.id,
  );
  expect(coded?.segments.map((s) => [s.reason, s.coded])).toEqual([
    [first, true],
    [second, true],
  ]);
  await expect(row).toHaveAttribute('data-reason', coded?.reason ?? '');

  // The Pareto moved exactly by the record: its time left the automatic reason and went to the
  // two coded ones; the availability losses and micro-stops are unchanged.
  const paretoAfter = await api.pareto('equipment', record.equipment, shift.start, shift.end);
  const expected = new Map(Object.entries(byReason(paretoBefore)));
  const add = (reason: string, ms: number) => {
    const key = `${reason}|${record.loss}`;
    expected.set(key, (expected.get(key) ?? 0) + ms);
  };
  add(record.autoReason, -(end - start));
  add(first, split - start);
  add(second, end - split);
  expect(byReason(paretoAfter)).toEqual(
    Object.fromEntries([...expected].filter(([, ms]) => ms !== 0)),
  );
  expect(paretoAfter.availability).toEqual(paretoBefore.availability);
  expect(paretoAfter.microStops).toEqual(paretoBefore.microStops);

  // The dashboard's Pareto for the machine shows the new reason.
  await page.goto(
    `/oee?shift=${encodeURIComponent(shiftKey)}&focus=${encodeURIComponent(record.equipment)}`,
  );
  const paretoRow = page.getByTestId('pareto').getByTestId(`pareto-${first}`);
  await expect(paretoRow).toBeVisible({ timeout: 30_000 });
  await expect(paretoRow).toHaveCount(1);

  // Writes the MES must refuse (ADR-0023), against a version no write can have: a guard that let
  // one through would answer 422, never code the record.
  const coding = `${base}/api/v1/downtime/${encodeURIComponent(record.id)}/coding`;
  const body = JSON.stringify({ segments: [], version: -1 });
  const json = { 'content-type': 'application/json' };
  const refusals: Record<string, number> = {};
  for (const [name, headers] of [
    ['foreign Origin', { origin: 'http://evil.test', ...json }],
    ['no Origin', json],
    [
      'form content type',
      { origin: new URL(base).origin, 'content-type': 'application/x-www-form-urlencoded' },
    ],
    // The page's own origin and JSON, but no session (#170).
    ['no session', { origin: new URL(base).origin, ...json }],
  ] as const) {
    refusals[name] = (await rawRequest('PUT', coding, headers, body)).status;
  }
  expect(refusals).toEqual({
    'foreign Origin': 403,
    'no Origin': 403,
    'form content type': 415,
    'no session': 401,
  });
  expect((await api.audit(record.id)).entries).toHaveLength(1);

  // OEE unchanged: byte for byte in the API, and on the dashboard's cards.
  const oeeAfter = await api.shiftOeeText(shiftKey);
  expect(oeeAfter).toBe(oeeBefore);
  const cardsAfter = await cardValues(page, workCenters);
  expect(cardsAfter).toEqual(cardsBefore);

  const summary = {
    shiftKey,
    record: {
      id: record.id,
      ms: end - start,
      autoReason: record.autoReason,
      loss: record.loss,
      split: new Date(split).toISOString(),
    },
    reasons: [first, second],
    auditEntries: audit.entries.length,
    paretoBefore: byReason(paretoBefore),
    paretoAfter: byReason(paretoAfter),
    oeeBytes: oeeBefore.length,
    oeeIdentical: oeeAfter === oeeBefore,
    cards: cardsAfter,
    refusals,
  };
  console.log(`downtime coding: ${JSON.stringify(summary)}`);
  if (results) {
    await writeFile(join(results, 'downtime-coding.json'), JSON.stringify(summary, null, 2));
  }
});
