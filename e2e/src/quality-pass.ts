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
import type {
  LotTraceDto,
  SerialTraceDto,
  SpcChartDto,
  SpcSignalDto,
  TraceRecordDto,
} from '@shopfloor/contracts/mes-api';
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
import { listOrders, type PassContext } from './orders-pass.ts';
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
  readonly epoch: number;
  readonly trace: Trace;
  readonly serials: readonly SerialTraceDto[];
  /** Every forward-trace answer, one per lot of the ERP's list the MES answered. */
  readonly lotAnswers: readonly LotTraceDto[];
  readonly lots: { readonly listed: number; readonly answered: number };
  /** Every order the MES lists, by id. */
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
  const lotAnswers: LotTraceDto[] = [];
  for (const id of lotIds) {
    const lot = await ctx.mes.traceLot(id);
    if (!lot) continue;
    lotAnswers.push(lot);
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
  const listed = await listOrders(ctx);
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
    epoch,
    trace: buildTrace({ config, units: [...units.values()], orders }),
    serials: answers,
    lotAnswers,
    lots: { listed: lotIds.length, answered: lotAnswers.length },
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
  readonly mesLotsEqual: boolean;
  readonly lots: {
    readonly answered: number;
    readonly listed: number;
    readonly compared: number;
    readonly extraUnitsAfterT: number;
    readonly finalChecked: number;
  };
  readonly cartons: { readonly compared: number; readonly finalChecked: number };
  readonly units: { readonly cartonsCompared: number; readonly statusesCompared: number };
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

  // 2a. Every order the truth names is the MES's, and no other (review LOW 5).
  note(
    'MES orders ≠ truth',
    jsonDifferences([...truth.orders.map((o) => o.orderId)].sort(), [...mes.orders]),
  );

  // 2b. The MES's own forward traces (review HIGH 1), not only the serials they lead to: every lot
  //     of the ERP's list answers (none skipped by a 404); per lot of the cut, its units of the run
  //     that consumed it before T are the cut's, any other unit consumed it only at or after T;
  //     its orders, its cartons closed before T and its pieces consumed before T are the cut's; a
  //     lot whose units have every record before T answers final.
  const lotDiffs: string[] = [];
  const recordsOf = new Map<number, readonly TraceRecordDto[]>();
  const statusOf = new Map<number, string>();
  const cartonOf = new Map<number, string | null>();
  const orderOf = new Map<number, string | null>();
  for (const answer of mes.serials) {
    for (const unit of answer.units) {
      if (unit.epoch !== mes.epoch) continue;
      recordsOf.set(unit.partId, unit.records);
      statusOf.set(unit.partId, unit.status);
      cartonOf.set(unit.partId, unit.carton);
      orderOf.set(unit.partId, unit.orderId);
    }
  }
  /** Pieces of `lot` a unit's records consumed before T and at or after it. */
  const consumption = (partId: number, lot: string) => {
    let before = 0;
    let after = 0;
    for (const r of recordsOf.get(partId) ?? []) {
      const n = (r.lots ?? []).filter((l) => l.lot === lot).length;
      if (Date.parse(r.at) < cut) before += n;
      else after += n;
    }
    return { before, after };
  };
  if (mes.lots.answered !== mes.lots.listed) {
    lotDiffs.push(
      `${String(mes.lots.answered)} of the ERP's ${String(mes.lots.listed)} lots answered`,
    );
  }
  const closedAtT = new Set(cutTrace.cartons.filter((c) => c.status === 'closed').map((c) => c.id));
  const cutLots = new Map(cutTrace.lots.map((l) => [l.lot, l]));
  let lotsCompared = 0;
  let extraUnitsAfterT = 0;
  let lotsFinalChecked = 0;
  for (const answer of mes.lotAnswers) {
    const expected = cutLots.get(answer.lot);
    const units = answer.units.filter((u) => u.epoch === mes.epoch);
    const before: number[] = [];
    const extra: number[] = [];
    let consumedAfter = 0;
    for (const unit of units) {
      const used = consumption(unit.partId, answer.lot);
      consumedAfter += used.after;
      if (used.before > 0) before.push(unit.partId);
      else if (used.after > 0) extra.push(unit.partId);
      else
        lotDiffs.push(`${answer.lot}: unit ${String(unit.partId)} listed, no record consumed it`);
    }
    extraUnitsAfterT += extra.length;
    const ordersBefore = [...new Set(before.map((id) => orderOf.get(id) ?? null))]
      .filter((o): o is string => o !== null)
      .sort();
    const ordersExtra = new Set(extra.map((id) => orderOf.get(id) ?? null));
    lotDiffs.push(
      ...jsonDifferences(
        {
          units: expected ? expected.units.map((u) => u.partId) : [],
          orders: expected ? [...expected.orders] : [],
          cartons: expected ? expected.cartons.filter((c) => closedAtT.has(c)) : [],
          consumed: expected?.consumed ?? 0,
        },
        {
          units: [...before].sort((a, b) => a - b),
          // The answer's own orders (re-review MEDIUM): those of an order only units consuming
          // the lot after T lead to are left out, so a dropped order differs from the cut.
          orders: answer.orders
            .filter((o) => ordersBefore.includes(o) || !ordersExtra.has(o))
            .sort(),
          cartons: answer.cartons.filter((c) => closedAtT.has(c)),
          consumed: answer.consumed - consumedAfter,
        },
        `.lot ${answer.lot}`,
      ),
    );
    // The answer's unit refs agree with the backward traces (order, carton, status).
    for (const unit of units) {
      const ref = {
        orderId: unit.orderId,
        carton: unit.carton,
        status: unit.status,
      };
      const serialSide = {
        orderId: orderOf.get(unit.partId) ?? null,
        carton: cartonOf.get(unit.partId) ?? null,
        status: statusOf.get(unit.partId) ?? null,
      };
      lotDiffs.push(
        ...jsonDifferences(serialSide, ref, `.lot ${answer.lot} unit ${String(unit.partId)}`),
      );
    }
    const otherOrders = answer.orders.filter((o) => !ordersBefore.includes(o));
    const unexplained = otherOrders.filter((o) => !ordersExtra.has(o));
    if (unexplained.length > 0) {
      lotDiffs.push(`${answer.lot}: orders ${unexplained.join(', ')} of no unit of the lot`);
    }
    if (expected) lotsCompared++;
    const allBefore = units.every((u) =>
      (recordsOf.get(u.partId) ?? []).every((r) => Date.parse(r.at) < cut),
    );
    if (units.length > 0 && allBefore) {
      lotsFinalChecked++;
      if (!answer.final) lotDiffs.push(`${answer.lot}: not final (${answer.notFinal.join(', ')})`);
    }
  }
  for (const lot of cutLots.keys()) {
    if (!mes.lotAnswers.some((a) => a.lot === lot)) lotDiffs.push(`${lot}: no forward trace`);
  }
  if (lotsCompared !== cutTrace.lots.length) {
    lotDiffs.push(`${String(lotsCompared)} lots compared, ${String(cutTrace.lots.length)} cut`);
  }
  note('MES forward traces ≠ cut', lotDiffs);

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

  // 4. The MES's own cartons (review MEDIUM 5): every carton of the cut, closed before T in the
  //    MES exactly when closed at T, with its closing time and members in placement order (an open
  //    one: its members placed before T first); a carton closed before T answers final. Each unit
  //    with a pack before T has the carton the cut gives it, in both directions, and its status.
  const cartonDiffs: string[] = [];
  const closed = cutTrace.cartons.filter((c) => c.status === 'closed');
  let cartonsFinalChecked = 0;
  for (const carton of cutTrace.cartons) {
    const answer = await ctx.mes.traceCarton(carton.id);
    const closedBefore =
      answer.carton.closedAt !== null && Date.parse(answer.carton.closedAt) < cut;
    const members = answer.units.map((u) => u.partId);
    const expectedMembers = carton.members.map((m) => m.partId);
    if (closedBefore !== (carton.status === 'closed')) {
      cartonDiffs.push(
        `.carton ${carton.id}: closed at ${String(answer.carton.closedAt)} in the MES, ${carton.status} at T`,
      );
    }
    cartonDiffs.push(
      ...jsonDifferences(
        {
          closedAt:
            carton.status === 'closed' && carton.closedAt !== null
              ? new Date(carton.closedAt).toISOString()
              : null,
          members: expectedMembers,
        },
        {
          closedAt: closedBefore && answer.carton.closedAt ? at(answer.carton.closedAt) : null,
          members: carton.status === 'closed' ? members : members.slice(0, expectedMembers.length),
        },
        `.carton ${carton.id}`,
      ),
    );
    if (carton.status === 'closed') {
      cartonsFinalChecked++;
      if (!answer.final) cartonDiffs.push(`.carton ${carton.id}: not final`);
    }
  }
  const packOp = cutTrace.config.packOperation;
  const cutUnits = new Map(cutTrace.units.map((u) => [u.partId, u]));
  let cartonsCompared = 0;
  let statusesCompared = 0;
  for (const [partId, records] of recordsOf) {
    const packedBefore = records.some(
      (r) => r.operation === packOp && r.result === 'good' && Date.parse(r.at) < cut,
    );
    const cutUnit = cutUnits.get(partId);
    if (packedBefore) {
      cartonsCompared++;
      if ((cutUnit?.carton ?? null) !== (cartonOf.get(partId) ?? null)) {
        cartonDiffs.push(
          `unit ${String(partId)}: MES carton ${String(cartonOf.get(partId))}, at T ${String(cutUnit?.carton)}`,
        );
      }
    } else if ((cutUnit?.carton ?? null) !== null) {
      cartonDiffs.push(
        `unit ${String(partId)}: a carton at T (${String(cutUnit?.carton)}) without a pack`,
      );
    }
    if (!cutUnit) continue;
    statusesCompared++;
    const status = statusOf.get(partId) ?? '';
    if (cutUnit.status !== 'wip') {
      if (status !== cutUnit.status) {
        cartonDiffs.push(`unit ${String(partId)}: MES status ${status}, at T ${cutUnit.status}`);
      }
    } else if (status === 'packed' || status === 'scrapped') {
      // Packed or scrapped since: by a record at or after T.
      const decided = records.some(
        (r) =>
          Date.parse(r.at) >= cut &&
          (r.result === 'scrap' || (r.operation === packOp && r.result === 'good')),
      );
      if (!decided) cartonDiffs.push(`unit ${String(partId)}: MES ${status}, wip at T`);
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
    beforeCut.length === 0 ||
    lotsFinalChecked === 0 ||
    cartonsCompared === 0
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
    mesLotsEqual: lotDiffs.length === 0,
    lots: {
      answered: mes.lots.answered,
      listed: mes.lots.listed,
      compared: lotsCompared,
      extraUnitsAfterT,
      finalChecked: lotsFinalChecked,
    },
    cartons: { compared: cutTrace.cartons.length, finalChecked: cartonsFinalChecked },
    units: { cartonsCompared, statusesCompared },
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

/** The live check's operator at Line A1, in simulation time (review MEDIUM 2). */
export interface CrewWindow {
  readonly operator: string;
  /** Simulation time read just before the sign-on and just after the terminal showed it. */
  readonly signOn: { readonly from: string; readonly to: string };
  /** The same around the sign-off. */
  readonly signOff: { readonly from: string; readonly to: string };
}

/**
 * Margin around the sign-on and sign-off (simulation time): a record's `at` is its cycle's
 * completion, while the crew is taken at the cycle's start (an OP30 cycle lasts well under it), and
 * the MES's plant clock trails the simulator's by up to a second of wall time (a minute at 60×).
 */
export const CREW_BAND_MS = 10 * 60_000;

/**
 * The crew on the trace (review MEDIUM 2, not circular): for every unit packed before T, the live
 * check's operator is in its OP30 pass-1 record's crew exactly when that cycle ran while they were
 * signed on to Line A1 by the simulator's clock, read by the browser check itself: `inside` when
 * the record completed more than the band after the sign-on and more than the band before the
 * sign-off; `outside` when it completed before the sign-on began, or more than the band after the
 * sign-off ended; records in the bands are not judged. Then a serial for the trace page: a unit
 * `inside`, single in its serial, with its leak reading; its records as the MES answered them,
 * which `checkTraceAsOf` has shown equal to the truth's (`unitsTraceSha256`).
 */
export function checkCrew(
  ctx: Pick<PassContext, 'fail'>,
  mes: MesTrace,
  cut: number,
  window: CrewWindow,
  operation: string,
) {
  const cutTrace = traceAsOf(mes.trace, cut);
  const packed = new Set(cutTrace.units.filter((u) => u.status === 'packed').map((u) => u.partId));
  const signOnTo = Date.parse(window.signOn.to);
  const signOnFrom = Date.parse(window.signOn.from);
  const signOffFrom = Date.parse(window.signOff.from);
  const signOffTo = Date.parse(window.signOff.to);
  const mismatches: string[] = [];
  let inside = 0;
  let outside = 0;
  let banded = 0;
  let chosen: TraceSerialCase | undefined;
  for (const answer of mes.serials) {
    for (const unit of answer.units) {
      if (unit.epoch !== mes.epoch || !packed.has(unit.partId)) continue;
      const op30 = unit.records.find((r) => r.operation === 'OP30' && r.pass === 1);
      if (!op30) continue;
      const done = Date.parse(op30.at);
      const listed = op30.crew.some((c) => c.username === window.operator);
      const isInside = done - CREW_BAND_MS > signOnTo && done + CREW_BAND_MS < signOffFrom;
      const isOutside = done < signOnFrom || done - CREW_BAND_MS > signOffTo;
      if (isInside) {
        inside++;
        if (!listed)
          mismatches.push(`unit ${String(unit.partId)} (OP30 ${op30.at}): not in the crew`);
        const reading = unit.records.find((r) => r.operation === operation && r.reading !== null);
        if (listed && reading && answer.units.length === 1) {
          chosen ??= {
            serial: answer.serial,
            partId: unit.partId,
            operator: window.operator,
            records: unit.records.map((r) => ({
              operation: r.operation,
              pass: r.pass,
              machine: r.equipment,
              seq: r.seq,
              result: r.result,
              lots: (r.lots ?? []).map((l) => l.lot),
              operator: r.operator,
              reading: r.reading?.value ?? null,
              crew: r.crew.map((c) => c.username),
            })),
          };
        }
      } else if (isOutside) {
        outside++;
        if (listed) mismatches.push(`unit ${String(unit.partId)} (OP30 ${op30.at}): in the crew`);
      } else {
        banded++;
      }
    }
  }
  if (mismatches.length > 0) ctx.fail(`crew at OP30: ${mismatches.slice(0, 20).join('; ')}`);
  if (inside === 0 || outside === 0) {
    ctx.fail(`crew at OP30 judged on ${String(inside)} units inside, ${String(outside)} outside`);
  }
  if (!chosen) ctx.fail('no serial for the trace page');
  return {
    report: {
      window,
      bandMs: CREW_BAND_MS,
      inside,
      outside,
      banded,
      mismatches: mismatches.length,
    },
    traceCase: chosen,
  };
}

export interface TraceSerialCase {
  readonly serial: string;
  readonly partId: number;
  readonly operator: string;
  readonly records: readonly {
    readonly operation: string;
    readonly pass: number;
    readonly machine: string;
    readonly seq: number;
    readonly result: string;
    readonly lots: readonly string[];
    readonly operator: string | null;
    readonly reading: number | null;
    readonly crew: readonly string[];
  }[];
}

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
