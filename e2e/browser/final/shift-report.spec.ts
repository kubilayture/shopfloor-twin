import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROBLEM_TYPES, type HandoverNotes } from '@shopfloor/contracts/mes-api';
import { expect, test } from '@playwright/test';
import { MesClient, rawRequest } from '../../src/clients.ts';

/**
 * Phase 6 exit criteria 4 and 5, the handover part (#147): on shift A's final report, an operator
 * writes a handover note through `/shifts/{date}/{shift}` and edits it. `revision.content` rises
 * by both writes while `revision.contentAtFinal` and `revision.inputs` (0) stay, the page shows the
 * banner of a report changed after final, the note's history shows both versions, and the OEE and
 * alarm sections stay byte for byte what they were. The OEE section is the body of
 * `GET /shifts/{date}/{shift}/oee`, and each alarm scope's KPIs are `GET /alarms/kpi`'s shift
 * bucket. Note writes with a foreign Origin, without an Origin and with a form content type are
 * refused with their problem `type`. Runs after alarm-actions.spec.ts and downtime-coding.spec.ts
 * (file order), whose acknowledgements and recode already raised `revision.content`.
 */
const webUrl = process.env.RECONCILE_WEB_URL;
const results = process.env.RECONCILE_RESULTS;
const shiftKey = process.env.RECONCILE_SHIFT ?? '2026-10-12/A';
const AUTHOR = 'reconcile e2e';
const TEXT = 'Flood on Cell M1 at 08:00 handled; coolant line on CNC-01 to watch (#147).';
const EDITED = `${TEXT} Edited: the maintenance ticket is open.`;
/** Alarms of shift A acknowledged and codings saved by the `final` files before this one. */
const ACKNOWLEDGED = 14;
const CODINGS = 1;

interface RawReport {
  final: boolean;
  status: string;
  revision: { inputs: number; content: number; contentAtFinal: number | null };
  incidents: number;
  oee: unknown;
  alarms: { scopes: { scope: string; id: string; kpis: unknown }[] };
  notes: unknown[];
}

test('a handover note written and edited through the UI revises the content, not OEE or alarms', async ({
  page,
}) => {
  test.skip(!webUrl, 'runs inside pnpm test:reconcile, after the drain');
  test.setTimeout(120_000);
  const base = webUrl ?? '';
  const api = new MesClient(base);
  const [date, shiftName] = shiftKey.split('/');

  const beforeText = await api.shiftReportText(shiftKey);
  const before = JSON.parse(beforeText) as RawReport;
  expect([before.final, before.status, before.revision.inputs, before.incidents]).toEqual([
    true,
    'final',
    0,
    0,
  ]);
  expect(before.revision.contentAtFinal).not.toBeNull();
  // Changed after final, before this note (ADR-0025: one step per acknowledgement of an alarm
  // raised in the shift, one per recode inside it): the 14 alarms acknowledged by
  // alarm-actions.spec.ts and the one coding saved by downtime-coding.spec.ts.
  expect(before.revision.content - (before.revision.contentAtFinal ?? 0)).toBe(
    ACKNOWLEDGED + CODINGS,
  );
  // The OEE section is the shift's OEE byte for byte; each alarm scope is /alarms/kpi's bucket.
  const oeeText = await api.shiftOeeText(shiftKey);
  expect(JSON.stringify(before.oee)).toBe(oeeText);
  const { start, end } = await api.shiftOee(shiftKey);
  for (const scope of before.alarms.scopes) {
    const list = JSON.parse(
      await api.alarmKpiText(
        scope.scope === 'plant' ? 'plant' : 'position',
        scope.id,
        'shift',
        start,
        end,
      ),
    ) as { buckets: { key: string }[] };
    expect(JSON.stringify(scope.kpis), scope.id).toBe(
      JSON.stringify(list.buckets.find((b) => b.key === shiftKey)),
    );
  }

  await page.goto(`/shifts/${date ?? ''}/${shiftName ?? ''}`);
  const report = page.getByTestId('shift-report');
  await expect(report).toHaveAttribute('data-final', 'true', { timeout: 30_000 });
  await expect(report).toHaveAttribute('data-key', shiftKey);
  await expect(report).toHaveAttribute('data-revision-inputs', '0');

  // Write the note.
  await page.getByTestId('note-author').fill(AUTHOR);
  const form = page.getByTestId('new-note');
  await form.getByTestId('note-category').selectOption('equipment');
  await form.getByTestId('note-text-input').fill(TEXT);
  await form.getByTestId('add-note').click();
  await expect(page.getByTestId('new-note-message')).toHaveAttribute('data-kind', 'saved');
  const notes = JSON.parse(await api.text(`/api/v1/shifts/${shiftKey}/notes`)) as HandoverNotes;
  const created = notes.notes.find((n) => n.note.text === TEXT)?.note;
  if (!created) throw new Error('the note is not stored');
  const id = String(created.id);
  await expect(page.getByTestId(`note-${id}`)).toHaveAttribute('data-version', '1');

  // Edit it.
  await page.getByTestId(`edit-note-${id}`).click();
  const editor = page.getByTestId(`note-editor-${id}`);
  await expect(editor).toHaveAttribute('data-version', '1');
  await editor.getByTestId('note-text-input').fill(EDITED);
  await editor.getByTestId('save-note').click();
  await expect(page.getByTestId(`note-${id}`)).toHaveAttribute('data-version', '2');
  await expect(page.getByTestId(`note-text-${id}`)).toHaveText(EDITED);

  // Its history: both versions, on the screen and in the audit.
  await page.getByTestId(`note-history-toggle-${id}`).click();
  const history = page.getByTestId(`note-history-${id}`).getByTestId('note-history-entry');
  await expect(history).toHaveCount(2);
  expect(
    await history.evaluateAll((items) =>
      items.map((item) => [item.dataset.version, item.dataset.action]),
    ),
  ).toEqual([
    ['2', 'edited'],
    ['1', 'created'],
  ]);
  const audit = JSON.parse(await api.text(`/api/v1/shifts/${shiftKey}/notes/${id}/audit`)) as {
    entries: {
      action: string;
      actor: string;
      authenticated: boolean;
      requestId: string | null;
      version: number;
      before: { text: string } | null;
      after: { text: string };
    }[];
  };
  expect(
    audit.entries.map((e) => [e.action, e.version, e.actor, e.authenticated, e.after.text]),
  ).toEqual([
    ['edited', 2, AUTHOR, false, EDITED],
    ['created', 1, AUTHOR, false, TEXT],
  ]);
  expect(audit.entries[0]?.before?.text).toBe(TEXT);
  for (const entry of audit.entries) expect(entry.requestId).toMatch(/\S/);

  // Note writes the MES must refuse (ADR-0023), each with its problem type; nothing is stored.
  const url = `${base}/api/v1/shifts/${shiftKey}/notes`;
  const body = JSON.stringify({ author: AUTHOR, text: 'refused', category: 'general' });
  const json = { 'content-type': 'application/json' };
  const refusals: Record<string, { status: number; type: string }> = {};
  for (const [name, headers] of [
    ['foreign Origin', { origin: 'http://evil.test', ...json }],
    ['no Origin', json],
    [
      'form content type',
      { origin: new URL(base).origin, 'content-type': 'application/x-www-form-urlencoded' },
    ],
  ] as const) {
    const answer = await rawRequest('POST', url, headers, body);
    refusals[name] = {
      status: answer.status,
      type: (JSON.parse(answer.text) as { type?: string }).type ?? '',
    };
  }
  expect(refusals).toEqual({
    'foreign Origin': { status: 403, type: PROBLEM_TYPES.writeOrigin },
    'no Origin': { status: 403, type: PROBLEM_TYPES.writeOrigin },
    'form content type': { status: 415, type: PROBLEM_TYPES.writeNotJson },
  });

  // The report after: content +2, contentAtFinal and inputs unchanged, OEE and alarms byte for
  // byte, the note with its two versions.
  const afterText = await api.shiftReportText(shiftKey);
  const after = JSON.parse(afterText) as RawReport;
  expect([after.final, after.status, after.revision.inputs, after.incidents]).toEqual([
    true,
    'final',
    0,
    0,
  ]);
  expect(after.revision.content).toBe(before.revision.content + 2);
  expect(after.revision.contentAtFinal).toBe(before.revision.contentAtFinal);
  expect(JSON.stringify(after.oee)).toBe(JSON.stringify(before.oee));
  expect(JSON.stringify(after.alarms)).toBe(JSON.stringify(before.alarms));
  expect(after.notes).toHaveLength(before.notes.length + 1);

  // The page shows the revision and the banner of a report changed after final.
  const changed = after.revision.content - (after.revision.contentAtFinal ?? 0);
  await page.reload();
  await expect(report).toHaveAttribute('data-revision-content', String(after.revision.content), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('report-revised')).toHaveAttribute('data-content', String(changed));
  await expect(page.getByTestId('report-revised')).toHaveAttribute('data-inputs', '0');

  const summary = {
    shiftKey,
    note: id,
    revisionBefore: before.revision,
    revisionAfter: after.revision,
    changedAfterFinal: changed,
    oeeSectionEqualsOee: JSON.stringify(before.oee) === oeeText,
    oeeBytes: oeeText.length,
    oeeIdentical: JSON.stringify(after.oee) === JSON.stringify(before.oee),
    alarmsIdentical: JSON.stringify(after.alarms) === JSON.stringify(before.alarms),
    alarmBytes: JSON.stringify(before.alarms).length,
    historyVersions: audit.entries.map((e) => e.version),
    refusals,
  };
  console.log(`shift report: ${JSON.stringify(summary)}`);
  if (results)
    await writeFile(join(results, 'shift-report.json'), JSON.stringify(summary, null, 2));
});
