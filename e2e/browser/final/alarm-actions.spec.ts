import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROBLEM_TYPES,
  type AlarmOccurrenceDto,
  type OperatorBucketDto,
} from '@shopfloor/contracts/mes-api';
import { expect, test } from '@playwright/test';
import { MesClient, rawRequest } from '../../src/clients.ts';
import { logIn, reconcileUser } from '../login.ts';

/**
 * Phase 6 exit criteria 3 and 5, the operator part (#147): after shift A of `alarms-01` is final
 * and the MES has drained, an operator acknowledges one alarm, comments on another, shelves and
 * unshelves a point and acknowledges the rest in bulk, all through `/alarms`. Every injected alarm
 * of the shift cleared on repair; each occurrence's history holds its device raise and clear and
 * every MES transition with actor and request id, on the screen and in the API; the point's audit
 * holds the shelf. The reconciled alarm KPIs (`GET /alarms/kpi`) stay byte-identical, while the
 * MES-only operator measures (`GET /alarms/operator-kpi`) count the acknowledgements and their
 * time to acknowledge. Writes with a foreign Origin, without an Origin and with a form content type
 * are refused with their problem `type`.
 */
const webUrl = process.env.RECONCILE_WEB_URL;
const results = process.env.RECONCILE_RESULTS;
const shiftKey = process.env.RECONCILE_SHIFT ?? '2026-10-12/A';
/** Every write's actor is the logged-in user (#170), audited as authenticated. */
const ACTOR = reconcileUser;
const COMMENT = 'Coolant line checked after the flood (#147).';
const SHELVE_REASON = 'Known fault under repair (#147)';

/** The alarm KPIs of every scope, hour and shift buckets of the shift, as served. */
async function kpiTexts(api: MesClient, scopes: readonly string[], from: string, to: string) {
  const texts: Record<string, string> = {};
  for (const id of scopes) {
    for (const bucket of ['hour', 'shift'] as const) {
      texts[`${id}/${bucket}`] = await api.alarmKpiText(
        id === 'plant' ? 'plant' : 'position',
        id,
        bucket,
        from,
        to,
      );
    }
  }
  return texts;
}

/** The shift bucket of each scope's operator measures. */
async function operatorShift(
  api: MesClient,
  scopes: readonly string[],
  from: string,
  to: string,
): Promise<Record<string, OperatorBucketDto>> {
  const buckets: Record<string, OperatorBucketDto> = {};
  for (const id of scopes) {
    const list = await api.operatorKpi(
      id === 'plant' ? 'plant' : 'position',
      id,
      'shift',
      from,
      to,
    );
    const bucket = list.buckets.find((b) => b.key === shiftKey);
    if (!bucket) throw new Error(`${id}: no operator bucket for ${shiftKey}`);
    buckets[id] = bucket;
  }
  return buckets;
}

test('alarms acknowledged, commented, shelved and unshelved through the UI, audited, KPIs unchanged', async ({
  page,
}) => {
  test.skip(!webUrl, 'runs inside pnpm test:reconcile, after the drain');
  test.setTimeout(180_000);
  const base = webUrl ?? '';
  // The API as the page reads it: through nginx, same origin, with the page's session.
  const api = new MesClient(base, await logIn(page));
  const shift = await api.shiftOee(shiftKey);
  const { start, end } = shift;
  const scopes = [
    'plant',
    ...(await api.alarmScopes()).scopes
      .filter((s) => s.scope === 'position')
      .map((s) => s.id)
      .sort(),
  ];
  expect(scopes).toEqual(['plant', 'cell-m1', 'line-a1']);

  // The shift's alarms: every one cleared on repair and nobody acknowledged it yet, so each is
  // still on the Active tab (a clear does not acknowledge).
  const inShift = (o: AlarmOccurrenceDto) => o.raisedAt >= start && o.raisedAt < end;
  const active = (await api.alarms('active')).alarms;
  const shiftAlarms = active.filter(inShift).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const shiftKpi = await api.alarmShifts('plant', 'plant', Date.parse(start), Date.parse(end));
  const raises = shiftKpi.buckets.find((b) => b.key === shiftKey)?.raises ?? -1;
  expect(shiftAlarms).toHaveLength(raises);
  expect(raises).toBeGreaterThanOrEqual(14);
  for (const alarm of shiftAlarms) {
    expect([alarm.id, alarm.state, alarm.endReason, alarm.final]).toEqual([
      alarm.id,
      'unacked-cleared',
      'cleared',
      true,
    ]);
  }

  const kpiBefore = await kpiTexts(api, scopes, start, end);
  const operatorBefore = await operatorShift(api, scopes, start, end);
  for (const id of scopes) expect(operatorBefore[id]?.timeToAck.count, id).toBe(0);

  // The three to act on singly: the first raise, a CNC-01 COOLANT-PRESSURE (the chattering point)
  // to comment on, and a point of another alarm to shelve.
  const [single, ...rest] = shiftAlarms;
  if (!single) throw new Error('no alarm');
  const commented = rest.find((a) => a.code === 'COOLANT-PRESSURE') ?? rest[0];
  const shelvedPoint = rest.find(
    (a) =>
      a.id !== commented?.id && `${a.equipment}/${a.code}` !== `${single.equipment}/${single.code}`,
  );
  if (!commented || !shelvedPoint) throw new Error('too few alarms in the shift');
  const pointAlarms = active.filter(
    (a) => a.equipment === shelvedPoint.equipment && a.code === shelvedPoint.code,
  );

  await page.goto('/alarms?view=active');
  // No name to type any more (#170): the MES takes the actor from the session.
  await expect(page.getByTestId('operator-name')).toHaveCount(0);
  const list = page.getByTestId('alarm-list');
  await expect(list).toHaveAttribute('data-view', 'active');
  for (const alarm of shiftAlarms) {
    await expect(page.getByTestId(`alarm-row-${alarm.id}`)).toHaveAttribute(
      'data-state',
      'unacked-cleared',
      { timeout: 30_000 },
    );
  }

  // 1. Acknowledge one alarm from its row: cleared and acknowledged, it leaves for History.
  await page.getByTestId(`ack-${single.id}`).click();
  await expect(page.getByTestId(`alarm-row-${single.id}`)).toHaveCount(0);
  const acked = (await api.alarm(single.id)).occurrence;
  expect([acked.state, acked.acknowledged?.by]).toEqual(['closed', ACTOR]);

  // 2. Comment on another through its panel.
  await page.getByTestId(`details-${commented.id}`).click();
  const panel = page.getByTestId('alarm-panel');
  await expect(panel).toHaveAttribute('data-alarm', commented.id);
  await panel.getByTestId('comment-text').fill(COMMENT);
  await panel.getByTestId('add-comment').click();
  await expect(panel.getByTestId('comment')).toHaveCount(1);
  await expect(panel.getByTestId('comment')).toContainText(COMMENT);
  await panel.getByTestId('close-alarm').click();

  // 3. Shelve a point (15 minutes of plant time, the shortest preset), then unshelve it. Its
  //    alarms leave the Active tab for Shelved while it is shelved, and come back.
  await page.getByTestId(`details-${shelvedPoint.id}`).click();
  await expect(panel).toHaveAttribute('data-alarm', shelvedPoint.id);
  const shelfState = panel.getByTestId('shelf-state');
  await expect(shelfState).toHaveAttribute('data-shelved', 'false');
  await panel.getByTestId('shelve-reason').fill(SHELVE_REASON);
  await panel.getByTestId('shelve-duration').selectOption(String(15 * 60_000));
  await panel.getByTestId('shelve').click();
  await expect(shelfState).toHaveAttribute('data-shelved', 'true');
  await expect(page.getByTestId('tab-shelved')).toHaveAttribute(
    'data-count',
    String(pointAlarms.length),
  );
  for (const alarm of pointAlarms) {
    await expect(page.getByTestId(`alarm-row-${alarm.id}`)).toHaveCount(0);
  }
  await panel.getByTestId('unshelve').click();
  await expect(shelfState).toHaveAttribute('data-shelved', 'false');
  await expect(page.getByTestId('tab-shelved')).toHaveAttribute('data-count', '0');
  for (const alarm of pointAlarms) {
    await expect(page.getByTestId(`alarm-row-${alarm.id}`)).toBeVisible();
  }
  await panel.getByTestId('close-alarm').click();

  // 4. Acknowledge the rest in bulk: select all on the Active tab.
  const remaining = (await api.alarms('active')).alarms;
  expect(remaining.length).toBeGreaterThanOrEqual(shiftAlarms.length - 1);
  await page.getByTestId('select-all').check();
  await expect(page.getByTestId('ack-selected')).toContainText(`(${String(remaining.length)})`);
  await page.getByTestId('ack-selected').click();
  await expect(page.getByTestId('alarm-list-empty')).toBeVisible({ timeout: 30_000 });

  // Every alarm of the shift is closed, acknowledged by the operator; one has the comment.
  const after = new Map<string, AlarmOccurrenceDto>();
  for (const alarm of shiftAlarms) {
    const detail = await api.alarm(alarm.id);
    after.set(alarm.id, detail.occurrence);
    expect([detail.occurrence.state, detail.occurrence.acknowledged?.by], alarm.id).toEqual([
      'closed',
      ACTOR,
    ]);
    expect(
      detail.comments.map((c) => [c.text, c.actor]),
      alarm.id,
    ).toEqual(alarm.id === commented.id ? [[COMMENT, ACTOR]] : []);
  }

  // The history of each: the device raise and clear (seq, sourceTime, receivedAt, protocol) and
  // every MES transition with actor and request id, in time order.
  const histories: Record<string, string[]> = {};
  for (const alarm of shiftAlarms) {
    const { entries } = await api.alarmHistory(alarm.id);
    histories[alarm.id] = entries.map((e) => `${e.source}:${e.transition}`);
    const device = entries.filter((e) => e.source === 'fact');
    expect(
      device.map((e) => e.transition),
      alarm.id,
    ).toEqual(['raised', 'cleared']);
    for (const entry of device) {
      expect(entry.seq, alarm.id).not.toBeNull();
      expect(entry.receivedAt, alarm.id).not.toBeNull();
      expect(entry.protocol, alarm.id).not.toBeNull();
    }
    expect(device[0]?.at).toBe(alarm.raisedAt);
    expect(device[1]?.at).toBe(alarm.endedAt);
    const audit = entries.filter((e) => e.source === 'audit');
    expect(
      audit.map((e) => e.transition),
      alarm.id,
    ).toEqual(alarm.id === commented.id ? ['comment', 'ack'] : ['ack']);
    for (const entry of audit) {
      expect([entry.actor, entry.authenticated], alarm.id).toEqual([ACTOR, true]);
      expect(entry.requestId, alarm.id).toMatch(/\S/);
      expect(entry.recordedAt, alarm.id).not.toBeNull();
    }
  }
  // The point's audit holds the shelve and the unshelve (newest first), with actor and request id.
  const pointAudit = await api.pointAudit(shelvedPoint.equipment, shelvedPoint.code);
  const shelfEntries = pointAudit.entries.filter(
    (e) => e.action === 'shelve' || e.action === 'unshelve',
  );
  expect(shelfEntries.map((e) => [e.action, e.actor, e.authenticated, e.version])).toEqual([
    ['unshelve', ACTOR, true, 2],
    ['shelve', ACTOR, true, 1],
  ]);
  for (const entry of shelfEntries) expect(entry.requestId).toMatch(/\S/);
  expect(shelfEntries[1]?.after).toMatchObject({ reason: SHELVE_REASON, durationMs: 15 * 60_000 });

  // The same history on the screen, for the commented alarm (now in History).
  await page.goto(`/alarms?view=history&alarm=${encodeURIComponent(commented.id)}`);
  await expect(panel).toHaveAttribute('data-alarm', commented.id);
  await expect(panel.getByTestId('alarm-state')).toHaveAttribute('data-state', 'closed');
  const shown = panel.getByTestId('history-entry');
  await expect(shown).toHaveCount(histories[commented.id]?.length ?? -1);
  const shownTransitions = await shown.evaluateAll((items) =>
    items.map((item) => `${item.dataset.source ?? ''}:${item.dataset.transition ?? ''}`),
  );
  expect(shownTransitions).toEqual(histories[commented.id]);
  await expect(panel.getByTestId('alarm-history')).toContainText(`by ${ACTOR}`);

  // Writes the MES must refuse (ADR-0023), on an alarm already acknowledged: a guard that let one
  // through would answer 200 with `changed: false`, never change anything.
  const ack = `${base}/api/v1/alarms/${encodeURIComponent(single.id)}/ack`;
  const body = '{}';
  const json = { 'content-type': 'application/json' };
  const refusals: Record<string, { status: number; type: string }> = {};
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
    const answer = await rawRequest('POST', ack, headers, body);
    refusals[name] = {
      status: answer.status,
      type: (JSON.parse(answer.text) as { type?: string }).type ?? '',
    };
  }
  expect(refusals).toEqual({
    'foreign Origin': { status: 403, type: PROBLEM_TYPES.writeOrigin },
    'no Origin': { status: 403, type: PROBLEM_TYPES.writeOrigin },
    'form content type': { status: 415, type: PROBLEM_TYPES.writeNotJson },
    'no session': { status: 401, type: PROBLEM_TYPES.unauthenticated },
  });
  expect(
    (await api.alarmHistory(single.id)).entries.filter((e) => e.source === 'audit'),
  ).toHaveLength(1);

  // The reconciled KPIs did not move: no operator action changes them (ADR-0024).
  const kpiAfter = await kpiTexts(api, scopes, start, end);
  for (const key of Object.keys(kpiBefore)) expect(kpiAfter[key], key).toBe(kpiBefore[key]);

  // The operator measures did: every raise of the shift acknowledged, with its time to ack.
  const operatorAfter = await operatorShift(api, scopes, start, end);
  const scopeRaises: Record<string, number> = {};
  for (const id of scopes) {
    const kpi = JSON.parse(kpiBefore[`${id}/shift`] ?? '{}') as {
      buckets: { key: string; raises: number }[];
    };
    scopeRaises[id] = kpi.buckets.find((b) => b.key === shiftKey)?.raises ?? -1;
    const before = operatorBefore[id];
    const now = operatorAfter[id];
    expect(now?.timeToAck.count, id).toBe(scopeRaises[id]);
    expect(now?.timeToAck.sumMs ?? 0, id).toBeGreaterThan(0);
    expect(now?.timeToAck.maxMs ?? 0, id).toBeGreaterThan(0);
    // Fixed once the bucket is over, like the raises and the shelved raises (none: the point was
    // shelved after its raises).
    expect(
      [now?.raises, now?.shelvedRaises, now?.unacknowledgedAtEnd, now?.provisional],
      id,
    ).toEqual([before?.raises, before?.shelvedRaises, before?.unacknowledgedAtEnd, false]);
  }
  // And the KPI page shows them.
  await page.goto(`/alarms/kpi?shift=${encodeURIComponent(shiftKey)}&focus=plant`);
  await expect(
    page.getByTestId('kpi-operator').locator('[data-measure="acknowledged"]'),
  ).toHaveText(String(scopeRaises.plant), { timeout: 30_000 });

  const summary = {
    shiftKey,
    alarms: shiftAlarms.length,
    single: single.id,
    commented: commented.id,
    shelvedPoint: `${shelvedPoint.equipment}/${shelvedPoint.code}`,
    pointAlarms: pointAlarms.length,
    bulk: remaining.length,
    histories,
    shelfAudit: shelfEntries.map((e) => [e.action, e.version, e.requestId]),
    kpiIdentical: Object.keys(kpiBefore).every((key) => kpiAfter[key] === kpiBefore[key]),
    kpiBytes: Object.values(kpiBefore).reduce((sum, text) => sum + text.length, 0),
    operator: Object.fromEntries(
      scopes.map((id) => [
        id,
        {
          before: operatorBefore[id]?.timeToAck,
          after: operatorAfter[id]?.timeToAck,
          unacknowledgedAtEnd: operatorAfter[id]?.unacknowledgedAtEnd,
        },
      ]),
    ),
    refusals,
  };
  console.log(`alarm actions: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'alarm-actions.json'), JSON.stringify(summary, null, 2));
});
