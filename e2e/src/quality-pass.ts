/**
 * The quality pass of the reconciliation (#204, Phase 8 exit criterion 5): what reconcile.ts
 * checks around the live quality-01 shift A beyond the comparisons it shares with the other passes.
 *
 * The time cut (plan "Ground truth for traceability and SPC", review round 2 HIGH B): three
 * projections of shift A at T = Monday 14:00 Istanbul, each through `trace-core`'s `traceAsOf`,
 * must be equal:
 * - the reference truth: a headless quality-01 run with `end` at T (`--end`), whose event log is a
 *   prefix of the full run's and whose trace equals `traceAsOf(full, T)` (both asserted by
 *   apps/simulator/src/headless/quality-01.test.ts); its `trace.json` section is taken as it is;
 * - the live truth: `GET /ground-truth?asOf=T` (control API 1.6), cut on the server by `traceAsOf`;
 * - the MES's answers: a forward trace of every lot of the ERP mock's lot list, a backward trace of
 *   each serial those return, the orders' completion, built into a `trace-core` trace and cut by
 *   `traceAsOf(·, T)` here; plus the MES's own SPC (the chart API: limit versions, every point and
 *   episode before T) and its own cartons (members in placement order, closing time).
 * Every comparison is exact; counts are asserted so none is vacuous.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SerialTraceDto, SpcChartDto, SpcSignalDto } from '@shopfloor/contracts/mes-api';
import { CHARTS } from '@shopfloor/spc-core';
import {
  buildTrace,
  traceAsOf,
  type OrderPacking,
  type Trace,
  type TraceConfig,
  type TraceRecord,
  type UnitInput,
} from '@shopfloor/trace-core';
import type { MesClient } from './clients.ts';
import { jsonDifferences } from './compare.ts';
import type { PassContext } from './orders-pass.ts';
import { REPO } from './stack.ts';
import {
  episodeIdentity,
  sectionOf,
  sha256,
  type EpisodeJson,
  type TraceSectionJson,
} from './trace-shapes.ts';

const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');

/**
 * The shift-A reference run (Phase 8 plan, review round 1 HIGH 4): headless `quality-01` with
 * `end` at the cut, as a process. Its `trace.json` section (without `schema` and `run`) and the
 * number of event-log lines.
 */
export async function referenceRun(
  scenario: string,
  cut: string,
): Promise<{ section: TraceSectionJson; events: number; end: string }> {
  const out = await mkdtemp(join(tmpdir(), 'reference-'));
  try {
    await promisify(execFile)(
      process.execPath,
      [HEADLESS, '--scenario', scenario, '--end', cut, '--out', out],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const [traceText, events] = await Promise.all([
      readFile(join(out, 'trace.json'), 'utf8'),
      readFile(join(out, 'events.jsonl'), 'utf8'),
    ]);
    const document = JSON.parse(traceText) as TraceSectionJson & {
      schema?: string;
      run?: { end: string };
    };
    const end = document.run?.end ?? '';
    delete document.schema;
    delete document.run;
    return { section: document, events: events.trimEnd().split('\n').length - 1, end };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** What the MES answered, built into a trace (uncut), with the raw answers the checks need. */
export interface MesTrace {
  readonly trace: Trace;
  readonly serials: readonly SerialTraceDto[];
  readonly lots: { readonly listed: number; readonly answered: number };
  readonly orders: readonly string[];
}

/**
 * The MES's genealogy through its API (review round 3, optional item adopted): a forward trace of
 * every lot of the ERP's list, then a backward trace of every serial they return; the orders'
 * completion from execution; units of the run's epoch only. Records as the truth has them: the
 * reading in whole resolution steps at the leak test, a Modbus machine's unreported lots as none.
 */
export async function mesTrace(
  ctx: PassContext,
  config: TraceConfig,
  resolution: number,
  epoch: number,
  orderIds: readonly string[],
): Promise<MesTrace> {
  const lotIds = (await ctx.erp.lots()).lots.map((l) => l.id);
  const serials = new Set<string>();
  let answered = 0;
  for (const id of lotIds) {
    const lot = await ctx.mes.traceLot(id);
    if (!lot) continue;
    answered++;
    if (lot.truncated) ctx.fail(`the forward trace of ${id} is truncated`);
    for (const unit of lot.units) {
      if (unit.epoch !== epoch) continue;
      if (unit.serial === null) ctx.fail(`unit ${String(unit.partId)} of ${id} has no serial`);
      else serials.add(unit.serial);
    }
  }
  const answers: SerialTraceDto[] = [];
  const units = new Map<number, UnitInput>();
  for (const serial of [...serials].sort()) {
    const answer = await ctx.mes.traceSerial(serial);
    answers.push(answer);
    for (const unit of answer.units) {
      if (unit.epoch !== epoch || units.has(unit.partId)) continue;
      units.set(unit.partId, {
        epoch,
        partId: unit.partId,
        serial: unit.serial ?? '',
        product: unit.product,
        orderId: unit.orderId,
        records: unit.records.map((r): TraceRecord => ({
          operation: r.operation,
          pass: r.pass,
          machine: r.equipment,
          at: Date.parse(r.at),
          seq: r.seq,
          result: r.result,
          reason: r.reason,
          lots: (r.lots ?? []).map((l) => ({ material: l.material, lot: l.lot })),
          operator: r.operator,
          reading:
            r.reading !== null && r.operation === config.spc.operation
              ? Math.round(r.reading.value / resolution)
              : null,
        })),
      });
    }
  }
  // The orders in the truth's order (cartons are listed by order as given, then number).
  const listed = (await ctx.mes.orders()).orders;
  const orders: OrderPacking[] = [];
  for (const id of orderIds) {
    const order = listed.find((o) => o.id === id);
    if (!order) {
      ctx.fail(`the MES has no order ${id}`);
      continue;
    }
    const execution = await ctx.mes.orderExecution(id);
    orders.push({
      orderId: id,
      product: order.product,
      completedAt: execution.completedAt === null ? null : Date.parse(execution.completedAt),
    });
  }
  return {
    trace: buildTrace({ config, units: [...units.values()], orders }),
    serials: answers,
    lots: { listed: lotIds.length, answered },
    orders: listed.map((o) => o.id).sort(),
  };
}

const at = (iso: string): string => new Date(iso).toISOString();

/** A limit version of the API as `trace.json` writes it (`versionJson`): positions by time. */
function versionShape(v: SpcChartDto['limits'][number]) {
  const pos = (p: { at: string } | null) => (p === null ? null : { at: at(p.at) });
  return {
    version: v.version,
    createdAt: at(v.createdAt),
    from: pos(v.from),
    until: pos(v.until),
    endedAt: v.endedAt === null ? null : at(v.endedAt),
    limits: {
      subgroupSize: v.subgroupSize,
      window: { from: { at: at(v.window.from.at) }, to: { at: at(v.window.to.at) } },
      counts: v.counts,
      statistics: {
        mean: v.statistics.mean.steps,
        movingRange: v.statistics.movingRange.steps,
        grandMean: v.statistics.grandMean.steps,
        range: v.statistics.range.steps,
      },
      charts: Object.fromEntries(
        CHARTS.map((c) => [
          c,
          {
            lower: v.charts[c].lower.steps,
            centre: v.charts[c].centre.steps,
            upper: v.charts[c].upper.steps,
          },
        ]),
      ),
    },
  };
}

/** A stored signal as `trace.json` writes an episode (`episodeJson`). */
export function signalShape(s: SpcSignalDto): EpisodeJson {
  const ref = (r: { partId: number; pass: number }) => ({ partId: r.partId, pass: r.pass });
  return {
    chart: s.chart,
    rule: s.rule as EpisodeJson['rule'],
    version: s.version,
    ...ref(s.first),
    at: at(s.first.at),
    last: ref(s.last),
    points: s.points,
    closedBy: s.closedBy === null ? null : ref(s.closedBy),
    baseline: s.baseline,
  };
}

/** What the three-way comparison found. */
export interface TraceAsOfReport {
  readonly cut: string;
  readonly reference: { readonly events: number; readonly end: string };
  readonly counts: {
    readonly units: number;
    readonly lots: number;
    readonly cartons: number;
    readonly closedCartons: number;
    readonly orders: number;
    readonly firstPass: number;
    readonly points: number;
    readonly episodes: number;
    readonly serialTraces: number;
    readonly lotsListed: number;
  };
  readonly referenceEqualsLive: boolean;
  readonly mesEqualsReference: boolean;
  readonly mesSpcEqualsReference: boolean;
  readonly mesCartonsEqual: boolean;
  readonly drift: {
    readonly start: unknown;
    readonly firstEpisode: string | null;
    readonly mesFirstEpisode: string | null;
    readonly latency: number | null;
    readonly counterfactualClean: boolean | null;
  };
  readonly finality: {
    readonly serialTracesBeforeCut: number;
    readonly notFinal: readonly string[];
    readonly pointsNotFinal: number;
    readonly episodesNotFinal: readonly string[];
  };
  readonly differences: readonly string[];
}

/**
 * Exit criterion 5's comparison at T: reference truth = live truth (every field, drifts included),
 * the MES's trace cut at T = the reference (units hashed with their count, orders, lots, cartons,
 * SPC readings, limits, points, subgroups and episodes), the MES's own SPC before T = the
 * reference's (limit versions, every point hashed per chart, every episode opened before T, in
 * full when it closed before T), its own cartons closed before T, and the drift's first episode.
 * The MES's answers must be final for shift A. Fails through `ctx.fail`; returns what it found.
 */
export async function checkTraceAsOf(
  ctx: PassContext,
  input: {
    readonly cut: number;
    readonly reference: Awaited<ReturnType<typeof referenceRun>>;
    readonly live: TraceSectionJson;
    readonly mes: MesTrace;
    readonly characteristic: string;
  },
): Promise<TraceAsOfReport> {
  const { cut, reference, live, mes } = input;
  const truth = reference.section;
  const differences: string[] = [];
  const note = (what: string, diffs: readonly string[]) => {
    for (const d of diffs) differences.push(`${what}: ${d}`);
  };

  // 1. The reference truth and the live truth, every field.
  const liveDiffs = jsonDifferences(truth, live, '', 50);
  note('live truth ≠ reference', liveDiffs);

  // 2. The MES's answers, built into a trace and cut at T, against the reference.
  const cutTrace = traceAsOf(mes.trace, cut);
  const truthSection: Partial<TraceSectionJson> = { ...truth };
  delete truthSection.drifts;
  const mesDiffs = jsonDifferences(truthSection, sectionOf(cutTrace), '', 50);
  note('MES (traceAsOf) ≠ reference', mesDiffs);

  // 3. The MES's own SPC before T (not re-derived here): limits, points, episodes.
  const chart = await ctx.mes.spcChart(input.characteristic);
  const spcDiffs: string[] = [];
  spcDiffs.push(
    ...jsonDifferences(
      truth.spc.limits,
      chart.limits.filter((v) => Date.parse(v.createdAt) < cut).map(versionShape),
      '.limits',
    ),
  );
  let points = 0;
  let pointsNotFinal = 0;
  for (const name of CHARTS) {
    const before = chart.points[name].filter((p) => Date.parse(p.at) < cut);
    pointsNotFinal += before.filter((p) => !p.final).length;
    points += before.length;
    const shaped = before.map((p) => ({
      partId: p.partId,
      pass: p.pass,
      at: at(p.at),
      segment: p.segment,
      value: p.value.steps,
      version: p.version,
      baseline: p.baseline,
      rules: p.rules,
    }));
    const expected = truth.spc.points[name];
    if (shaped.length !== expected?.count || sha256(shaped) !== expected.sha256) {
      spcDiffs.push(
        `.points.${name}: ${String(shaped.length)} points ${sha256(shaped)}, truth ${String(expected?.count)} ${String(expected?.sha256)}`,
      );
    }
  }
  const signals = chart.signals
    .filter((s) => s.status !== 'withdrawn' && Date.parse(s.first.at) < cut)
    .sort(
      (a, b) =>
        Date.parse(a.first.at) - Date.parse(b.first.at) ||
        a.first.seq - b.first.seq ||
        CHARTS.indexOf(a.chart) - CHARTS.indexOf(b.chart) ||
        a.rule - b.rule,
    );
  const withdrawn = chart.signals.filter((s) => s.status === 'withdrawn');
  if (withdrawn.length > 0) spcDiffs.push(`withdrawn signals: ${String(withdrawn.length)}`);
  spcDiffs.push(
    ...jsonDifferences(
      truth.spc.episodes.map(episodeIdentity),
      signals.map((s) => episodeIdentity(signalShape(s))),
      '.episodes(identity)',
    ),
  );
  const byIdentity = new Map(truth.spc.episodes.map((e) => [episodeIdentity(e), e]));
  for (const signal of signals) {
    const shaped = signalShape(signal);
    const expected = byIdentity.get(episodeIdentity(shaped));
    if (!expected) continue;
    if (signal.closedBy !== null && Date.parse(signal.closedBy.at) < cut) {
      // Closed before T: its whole extent stood at T.
      spcDiffs.push(...jsonDifferences(expected, shaped, `.episode ${episodeIdentity(shaped)}`));
    } else if (expected.closedBy !== null) {
      spcDiffs.push(`${episodeIdentity(shaped)}: open at T in the MES, closed in the truth`);
    }
  }
  const episodesNotFinal = signals
    .filter((s) => s.status !== 'final')
    .map((s) => `${episodeIdentity(signalShape(s))} ${s.status}`);
  note('MES SPC ≠ reference', spcDiffs);

  // 4. The MES's own cartons closed before T: members in placement order and closing time.
  const cartonDiffs: string[] = [];
  const closed = cutTrace.cartons.filter((c) => c.status === 'closed');
  for (const carton of closed) {
    const answer = await ctx.mes.traceCarton(carton.id);
    cartonDiffs.push(
      ...jsonDifferences(
        {
          status: 'closed',
          closedAt: carton.closedAt === null ? null : new Date(carton.closedAt).toISOString(),
          members: carton.members.map((m) => m.partId),
        },
        {
          status: answer.carton.status,
          closedAt: answer.carton.closedAt === null ? null : at(answer.carton.closedAt),
          members: answer.units.map((u) => u.partId),
        },
        `.carton ${carton.id}`,
      ),
    );
  }
  // And each unit's own carton as the MES placed it (placement is final once made).
  const unitCarton = new Map(
    mes.serials.flatMap((s) => s.units.map((u) => [u.partId, u.carton] as const)),
  );
  for (const unit of cutTrace.units) {
    if (unit.carton !== null && unitCarton.get(unit.partId) !== unit.carton) {
      cartonDiffs.push(
        `unit ${String(unit.partId)}: MES carton ${String(unitCarton.get(unit.partId))}, at T ${unit.carton}`,
      );
    }
  }
  note('MES cartons ≠ cut', cartonDiffs);

  // 5. The drift: the MES's first episode after its start is the truth's (point, chart, rule).
  const drift = truth.drifts?.[0];
  const start = drift?.start ?? null;
  const truthFirst = drift?.firstEpisode ? episodeIdentity(drift.firstEpisode) : null;
  const mesFirst =
    start === null
      ? null
      : (signals
          .map(signalShape)
          .filter((e) => !e.baseline && Date.parse(e.at) >= Date.parse(start.at))
          .map(episodeIdentity)[0] ?? null);
  if (drift === undefined) differences.push('the reference has no drift');
  if (truthFirst === null || mesFirst !== truthFirst) {
    differences.push(
      `the drift's first episode: MES ${String(mesFirst)}, truth ${String(truthFirst)}`,
    );
  }
  if (drift?.counterfactual.clean !== true) {
    differences.push("the reference's counterfactual window is not clean");
  }

  // 6. Final for shift A: every backward trace whose records all lie before T, every point and
  //    episode before T.
  const beforeCut = mes.serials.filter((s) =>
    s.units.every((u) => u.records.every((r) => Date.parse(r.at) < cut)),
  );
  const notFinal = beforeCut.filter((s) => !s.final).map((s) => s.serial);
  if (notFinal.length > 0) differences.push(`backward traces not final: ${notFinal.join(', ')}`);
  if (pointsNotFinal > 0) differences.push(`${String(pointsNotFinal)} points before T not final`);
  if (episodesNotFinal.length > 0) {
    differences.push(`episodes before T not final: ${episodesNotFinal.join(', ')}`);
  }

  const counts = {
    units: cutTrace.units.length,
    lots: cutTrace.lots.length,
    cartons: cutTrace.cartons.length,
    closedCartons: closed.length,
    orders: cutTrace.orders.filter((o) => o.completedAt !== null).length,
    firstPass: cutTrace.spc.chart.firstPass.length,
    points,
    episodes: signals.length,
    serialTraces: mes.serials.length,
    lotsListed: mes.lots.listed,
  };
  // Not vacuous: shift A of quality-01 has units, lots, closed cartons, completed orders, the
  // baseline and the drift's episodes.
  if (
    counts.units === 0 ||
    counts.lots === 0 ||
    counts.closedCartons === 0 ||
    counts.orders < 2 ||
    counts.firstPass < 140 ||
    counts.episodes === 0 ||
    beforeCut.length === 0
  ) {
    differences.push(`too little compared: ${JSON.stringify(counts)}`);
  }
  for (const d of differences) ctx.fail(`quality at ${new Date(cut).toISOString()}: ${d}`);
  return {
    cut: new Date(cut).toISOString(),
    reference: { events: reference.events, end: reference.end },
    counts,
    referenceEqualsLive: liveDiffs.length === 0,
    mesEqualsReference: mesDiffs.length === 0,
    mesSpcEqualsReference: spcDiffs.length === 0,
    mesCartonsEqual: cartonDiffs.length === 0,
    drift: {
      start,
      firstEpisode: truthFirst,
      mesFirstEpisode: mesFirst,
      latency: drift?.firstEpisode?.latency ?? null,
      counterfactualClean: drift?.counterfactual.clean ?? null,
    },
    finality: {
      serialTracesBeforeCut: beforeCut.length,
      notFinal,
      pointsNotFinal,
      episodesNotFinal,
    },
    differences: differences.slice(0, 50),
  };
}

/**
 * A serial for the trace page check (plan "Ground truth and reconciliation", live): a unit packed
 * before T whose OP30 pass 1 started while `operator` was signed on to Line A1 (its crew row on
 * that record), with its leak reading. Its records as the MES answered them, which step 2 of
 * `checkTraceAsOf` has shown equal to the truth's (`unitsTraceSha256`).
 */
export function traceSerialCase(mes: MesTrace, cut: number, operator: string, operation: string) {
  const cutTrace = traceAsOf(mes.trace, cut);
  const packed = new Set(cutTrace.units.filter((u) => u.status === 'packed').map((u) => u.partId));
  for (const answer of mes.serials) {
    const [unit, ...others] = answer.units;
    if (!unit || others.length > 0 || !packed.has(unit.partId)) continue;
    const op30 = unit.records.find((r) => r.operation === 'OP30' && r.pass === 1);
    const reading = unit.records.find((r) => r.operation === operation && r.reading !== null);
    if (!op30?.crew.some((c) => c.username === operator) || !reading) continue;
    return {
      serial: answer.serial,
      partId: unit.partId,
      operator,
      records: unit.records.map((r) => ({
        operation: r.operation,
        pass: r.pass,
        machine: r.equipment,
        seq: r.seq,
        lots: (r.lots ?? []).map((l) => l.lot),
        operator: r.operator,
        reading: r.reading?.value ?? null,
        crew: r.crew.map((c) => c.username),
      })),
    };
  }
  return undefined;
}

export type TraceSerialCase = NonNullable<ReturnType<typeof traceSerialCase>>;

/**
 * The quality notifications (exit criterion 5): every hold transition the MES notified (open,
 * release, reject; a comment never) was posted and is `sent`; the ERP holds each idempotency key
 * exactly once, with the hold, transition and subject the MES has, and nothing else; the ERP's
 * view of each held lot follows its holds (`blocked` while one is open).
 */
export async function checkNotifications(
  ctx: PassContext,
  holdIds: readonly string[],
): Promise<Record<string, unknown>> {
  const keys: { key: string; hold: string; transition: string }[] = [];
  const lots = new Map<string, boolean>();
  for (const id of holdIds) {
    const detail = await ctx.mes.hold(id);
    for (const t of detail.transitions) {
      if (t.notification === null) continue;
      keys.push({ key: t.notification.idempotencyKey, hold: id, transition: t.kind });
      if (t.notification.status !== 'sent') {
        ctx.fail(`hold ${id} transition ${String(t.n)}: notification ${t.notification.status}`);
      }
    }
    if (detail.hold.subject.kind === 'lot') {
      lots.set(
        detail.hold.subject.id,
        (lots.get(detail.hold.subject.id) ?? false) || detail.hold.state !== 'released',
      );
    }
  }
  const received = (await ctx.erp.qualityNotifications()).notifications;
  const counted = new Map<string, number>();
  for (const n of received) {
    counted.set(n.receipt.idempotencyKey, (counted.get(n.receipt.idempotencyKey) ?? 0) + 1);
  }
  const expected = keys.map((k) => k.key).sort();
  const got = [...counted.keys()].sort();
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    ctx.fail(`ERP notifications ${got.join(', ')}, MES ${expected.join(', ')}`);
  }
  const twice = [...counted].filter(([, n]) => n !== 1);
  if (twice.length > 0) ctx.fail(`ERP notifications held more than once: ${JSON.stringify(twice)}`);
  for (const k of keys) {
    const body = received.find((n) => n.receipt.idempotencyKey === k.key)?.body;
    if (body?.holdId !== k.hold || body.transition !== k.transition) {
      ctx.fail(`ERP notification ${k.key}: ${JSON.stringify(body)}`);
    }
  }
  const lotViews: Record<string, { blocked: boolean; holds: number }> = {};
  for (const [lot, blocked] of lots) {
    const view = await ctx.erp.lot(lot);
    lotViews[lot] = { blocked: view.blocked, holds: view.holds.length };
    if (view.blocked !== blocked) ctx.fail(`ERP lot ${lot}: blocked ${String(view.blocked)}`);
  }
  if (keys.length === 0) ctx.fail('no quality notification to check');
  return { notifications: keys, received: received.length, lotViews };
}

/** The MES client of a pass (the supervisor's), for the helpers above. */
export type { MesClient };
