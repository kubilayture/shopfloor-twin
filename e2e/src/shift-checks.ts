/**
 * A completed shift's answers against the simulator's live ground truth, shared by the
 * reconciliation (#100, #120, #142, #144, #147; e2e/src/reconcile.ts) and the resilience suite
 * (#243, e2e/src/resilience.ts): time per state, OEE per machine and work center, alarm KPIs per
 * scope (shift and hours) and the shift report, each final and equal. Every function reports a
 * failure through `fail` and returns what it found; none widens a tolerance.
 */
import {
  alarmKpiListSchema,
  shiftReportSchema,
  type AlarmKpiBucketDto,
} from '@shopfloor/contracts/mes-api';
import type { GroundTruth, MesClient } from './clients.ts';
import {
  differences,
  formatDifferences,
  jsonDifferences,
  mesTotals,
  type StateMs,
  type TotalsRow,
} from './compare.ts';
import { until } from './orders-pass.ts';

/** How long the MES may take to report a shift's buckets final after the drain (refresh debounce). */
export const FINAL_WAIT_MS = 30_000;

/** A shift bucket of the calendar: its key (`2026-10-12/A`) and span. */
export interface ShiftSpan {
  readonly key: string;
  readonly from: number;
  readonly to: number;
}

type Fail = (message: string) => void;

export type MachineStatesReport = Record<
  string,
  {
    truthMs: StateMs;
    equal: boolean;
    provisionalMs: number;
    revision: number;
    incidents: number;
    totalMs: number;
  }
>;

/**
 * Time per state of a completed shift (#100, #113): per machine equal to the ground truth to the
 * millisecond, covering the whole shift, final (`provisionalMs = 0`, `revision = 0`,
 * `incidents = 0`), and no row of another epoch or machine.
 */
export function checkShiftStates(
  totals: readonly TotalsRow[],
  truth: GroundTruth,
  machines: readonly string[],
  shift: ShiftSpan,
  fail: Fail,
): { machines: MachineStatesReport; expected: Record<string, StateMs> } {
  const expected = Object.fromEntries(
    machines.map((id) => [id, truth.machines[id]?.byShift[shift.key] ?? {}]),
  );
  const recorded = mesTotals(totals, truth.epoch, machines);
  const diffs = differences(expected, recorded.byMachine);
  const report: MachineStatesReport = Object.fromEntries(
    machines.map((id) => {
      const truthMs = expected[id] ?? {};
      return [
        id,
        {
          truthMs,
          equal: diffs.every((d) => d.machine !== id),
          provisionalMs: recorded.provisionalMs[id] ?? 0,
          revision: recorded.revision[id] ?? 0,
          incidents: recorded.incidents[id] ?? 0,
          totalMs: Object.values(truthMs).reduce((a, b) => a + b, 0),
        },
      ];
    }),
  );
  if (diffs.length > 0) {
    fail(
      `time per state in ${shift.key} differs from the ground truth:\n${formatDifferences(diffs)}`,
    );
  }
  if (recorded.unexpected.length > 0) {
    fail(
      `unexpected MES totals (other epochs or unknown machines): ${JSON.stringify(recorded.unexpected)}`,
    );
  }
  for (const [id, machine] of Object.entries(report)) {
    if (machine.totalMs !== shift.to - shift.from)
      fail(`${id}: ground truth covers ${String(machine.totalMs)} ms`);
    // #113: the completed shift is final, unchanged since, and had no gap.
    if (machine.provisionalMs !== 0 || machine.revision !== 0 || machine.incidents !== 0) {
      fail(
        `${id}: ${shift.key} not final (provisionalMs ${String(machine.provisionalMs)}, revision ${String(machine.revision)}, incidents ${String(machine.incidents)})`,
      );
    }
  }
  return { machines: report, expected };
}

interface BucketReport {
  equal: boolean;
  final: boolean;
  provisionalMs: number;
  revision: number;
  incidents: number;
  oee: string | null;
  differences: string[];
}

export interface ShiftOeeReport {
  waitedMs: number;
  /** Buckets compared with the ground truth: six machines and two work centers. */
  compared: number;
  machines: Record<string, BucketReport>;
  workCenters: Record<string, BucketReport>;
}

/**
 * A completed shift's OEE (#120): final for every machine and work center (waited for up to
 * `FINAL_WAIT_MS`) and equal to the live ground truth exactly (inputs, fractions, four-decimal
 * strings, totals, losses, `unplanned`); the comparison count (six machines and two work centers)
 * asserted.
 */
export async function checkShiftOee(
  mes: MesClient,
  truth: GroundTruth,
  machines: readonly string[],
  workCenterIds: readonly string[],
  shiftKey: string,
  fail: Fail,
): Promise<ShiftOeeReport> {
  const oeeFrom = Date.now();
  let shiftOee = await mes.shiftOee(shiftKey);
  const allFinal = () =>
    machines.every((id) => shiftOee.equipment.find((b) => b.id === id)?.final === true);
  await until(
    `${shiftKey} OEE final for every machine`,
    async () => {
      shiftOee = await mes.shiftOee(shiftKey);
      return allFinal();
    },
    FINAL_WAIT_MS,
  ).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
  const report: ShiftOeeReport = {
    waitedMs: Date.now() - oeeFrom,
    compared: 0,
    machines: {},
    workCenters: {},
  };
  // Exactly the plant's machines and work centers, on both sides.
  const ids = (list: readonly { id: string }[]) =>
    list
      .map((b) => b.id)
      .sort()
      .join(', ');
  for (const [what, actual, expected] of [
    ['MES machines', ids(shiftOee.equipment), machines.join(', ')],
    ['MES work centers', ids(shiftOee.workCenters), workCenterIds.join(', ')],
    [
      'ground-truth work centers',
      Object.keys(truth.oee.workCenters).sort().join(', '),
      workCenterIds.join(', '),
    ],
  ] as const) {
    if (actual !== expected) fail(`${shiftKey} OEE: ${what} are ${actual}, not ${expected}`);
  }
  const notFinal = (
    id: string,
    bucket:
      { final: boolean; provisionalMs: number; revision: number; incidents: number } | undefined,
  ) => {
    if (
      !bucket?.final ||
      bucket.provisionalMs !== 0 ||
      bucket.revision !== 0 ||
      bucket.incidents !== 0
    ) {
      fail(
        `${id}: ${shiftKey} OEE not final (final ${String(bucket?.final)}, provisionalMs ${String(bucket?.provisionalMs)}, revision ${String(bucket?.revision)}, incidents ${String(bucket?.incidents)})`,
      );
    }
  };
  for (const id of machines) {
    const bucket = shiftOee.equipment.find((b) => b.id === id);
    const expectedOee = truth.oee.machines[id]?.shifts[shiftKey];
    const diffs = jsonDifferences(
      expectedOee ?? null,
      bucket
        ? {
            inputs: { stateMs: bucket.inputs.stateMs, cycles: bucket.inputs.cycles },
            result: bucket.result,
          }
        : null,
    );
    if (expectedOee && bucket) report.compared++;
    report.machines[id] = {
      equal: diffs.length === 0,
      final: bucket?.final ?? false,
      provisionalMs: bucket?.provisionalMs ?? -1,
      revision: bucket?.revision ?? -1,
      incidents: bucket?.incidents ?? -1,
      oee: bucket?.result.oee?.decimal ?? null,
      differences: diffs,
    };
    if (diffs.length > 0) {
      fail(`${id}: ${shiftKey} OEE differs from the ground truth:\n  ${diffs.join('\n  ')}`);
    }
    notFinal(id, bucket);
  }
  for (const id of workCenterIds) {
    const bucket = shiftOee.workCenters.find((b) => b.id === id);
    const expectedOee = truth.oee.workCenters[id]?.shifts[shiftKey];
    // A work center's inputs are its machines' sums, compared above; here its result.
    const diffs = jsonDifferences(expectedOee ?? null, bucket?.result ?? null);
    if (expectedOee && bucket) report.compared++;
    report.workCenters[id] = {
      equal: diffs.length === 0,
      final: bucket?.final ?? false,
      provisionalMs: bucket?.provisionalMs ?? -1,
      revision: bucket?.revision ?? -1,
      incidents: bucket?.incidents ?? -1,
      oee: bucket?.result.oee?.decimal ?? null,
      differences: diffs,
    };
    if (diffs.length > 0) {
      fail(`${id}: ${shiftKey} OEE differs from the ground truth:\n  ${diffs.join('\n  ')}`);
    }
    notFinal(id, bucket);
  }
  // Every bucket compared: six machines and two work centers in the golden plant.
  const comparisons = machines.length + workCenterIds.length;
  if (report.compared !== comparisons || comparisons !== 8) {
    fail(
      `${shiftKey} OEE: ${String(report.compared)} buckets compared, not ${String(comparisons)} (6 machines and 2 work centers)`,
    );
  }
  return report;
}

export interface AlarmKpiReport {
  waitedMs: number;
  /** Shift buckets compared: the plant and both positions. */
  compared: number;
  /** Hour buckets of the shift compared, over the plant and both positions. */
  hoursCompared: number;
  goldenEqual: boolean;
  /** Raises of the shift per scope. */
  raises: Record<string, number>;
  scopes: Record<
    string,
    {
      equal: boolean;
      final: boolean;
      revision: number;
      incidents: number;
      raises: number;
      differences: string[];
    }
  >;
}

/** A golden summary's alarm KPIs per scope (sim-summary/3). */
export type GoldenAlarmScopes = Record<
  string,
  { shifts: Record<string, unknown>; hours: Record<string, unknown> }
>;

/**
 * A completed shift's alarm KPIs (#142, #147): the plant and each position, per shift and per
 * hour, final (`provisional` false, revision 0, incidents 0) and equal to the live ground truth and
 * to the scenario's golden summary exactly; three scopes compared. Resolves with what it found and
 * the MES's shift buckets per scope.
 */
export async function checkAlarmKpis(
  mes: MesClient,
  truth: GroundTruth,
  golden: GoldenAlarmScopes,
  goldenName: string,
  shift: ShiftSpan,
  fail: Fail,
): Promise<{ report: AlarmKpiReport; buckets: Record<string, AlarmKpiBucketDto | undefined> }> {
  const shiftKey = shift.key;
  const alarmFrom = Date.now();
  const alarmScopes = Object.keys(truth.alarms.scopes).sort();
  const readAlarms = () =>
    Promise.all(
      alarmScopes.map(async (id) => {
        const scope = id === 'plant' ? 'plant' : 'position';
        const [shifts, hours] = await Promise.all([
          mes.alarmShifts(scope, id, shift.from, shift.to),
          mes
            .alarmKpiText(scope, id, 'hour', shift.from, shift.to)
            .then((text) => alarmKpiListSchema.parse(JSON.parse(text))),
        ]);
        return {
          id,
          bucket: shifts.buckets.find((b) => b.key === shiftKey),
          hours: hours.buckets.filter(
            (b) => Date.parse(b.from) >= shift.from && Date.parse(b.to) <= shift.to,
          ),
        };
      }),
    );
  let alarmBuckets = await readAlarms();
  await until(
    `${shiftKey} alarm KPIs final for the plant and every position, per shift and hour`,
    async () => {
      alarmBuckets = await readAlarms();
      return alarmBuckets.every(
        ({ bucket, hours }) => bucket?.final === true && hours.every((h) => h.final),
      );
    },
    FINAL_WAIT_MS,
  ).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
  const report: AlarmKpiReport = {
    waitedMs: Date.now() - alarmFrom,
    compared: 0,
    hoursCompared: 0,
    goldenEqual: true,
    raises: {},
    scopes: {},
  };
  const notFinal = (b: AlarmKpiBucketDto | undefined) =>
    !b?.final || b.provisional || b.revision !== 0 || b.incidents !== 0;
  for (const { id, bucket, hours } of alarmBuckets) {
    const scopeTruth = truth.alarms.scopes[id];
    const scopeGolden = golden[id];
    const expected = scopeTruth?.shifts[shiftKey];
    const diffs = jsonDifferences(expected ?? null, bucket ? alarmTruthShape(bucket) : null);
    const goldenDiffs = jsonDifferences(scopeGolden?.shifts[shiftKey] ?? null, expected ?? null);
    if (expected && bucket) report.compared++;
    // Hours of the shift: the same hours listed (where something happened), each equal.
    const truthHours = Object.keys(scopeTruth?.hours ?? {})
      .filter((h) => Date.parse(h) >= shift.from && Date.parse(h) < shift.to)
      .sort();
    const mesHours = hours.map((h) => h.key).sort();
    if (JSON.stringify(truthHours) !== JSON.stringify(mesHours)) {
      diffs.push(`hours: MES ${mesHours.join(', ')}, truth ${truthHours.join(', ')}`);
    }
    const goldenHours = Object.keys(scopeGolden?.hours ?? {})
      .filter((h) => Date.parse(h) >= shift.from && Date.parse(h) < shift.to)
      .sort();
    if (JSON.stringify(goldenHours) !== JSON.stringify(mesHours)) {
      goldenDiffs.push(`hours: golden ${goldenHours.join(', ')}, MES ${mesHours.join(', ')}`);
    }
    for (const hour of hours) {
      const truthHour = scopeTruth?.hours[hour.key];
      if (truthHour === undefined) continue;
      report.hoursCompared++;
      for (const d of jsonDifferences(truthHour, alarmTruthShape(hour))) {
        diffs.push(`${hour.key}: ${d}`);
      }
      for (const d of jsonDifferences(scopeGolden?.hours[hour.key] ?? null, truthHour)) {
        goldenDiffs.push(`${hour.key}: ${d}`);
      }
      if (notFinal(hour)) {
        diffs.push(
          `${hour.key} not final (final ${String(hour.final)}, provisional ${String(hour.provisional)}, revision ${String(hour.revision)}, incidents ${String(hour.incidents)})`,
        );
      }
    }
    if (goldenDiffs.length > 0) report.goldenEqual = false;
    report.raises[id] = bucket?.raises ?? -1;
    report.scopes[id] = {
      equal: diffs.length === 0,
      final: bucket?.final ?? false,
      revision: bucket?.revision ?? -1,
      incidents: bucket?.incidents ?? -1,
      raises: bucket?.raises ?? -1,
      differences: diffs,
    };
    if (diffs.length > 0) {
      fail(`${id}: ${shiftKey} alarm KPIs differ from the ground truth:\n  ${diffs.join('\n  ')}`);
    }
    if (goldenDiffs.length > 0) {
      fail(
        `${id}: the live ground truth's ${shiftKey} alarm KPIs differ from ${goldenName}'s:\n  ${goldenDiffs.join('\n  ')}`,
      );
    }
    if (notFinal(bucket)) {
      fail(
        `${id}: ${shiftKey} alarm KPIs not final (final ${String(bucket?.final)}, provisional ${String(bucket?.provisional)}, revision ${String(bucket?.revision)}, incidents ${String(bucket?.incidents)})`,
      );
    }
  }
  if (report.compared !== 3 || alarmScopes.length !== 3) {
    fail(
      `${shiftKey} alarm KPIs: ${String(report.compared)} buckets compared, not 3 (the plant and 2 positions)`,
    );
  }
  return {
    report,
    buckets: Object.fromEntries(alarmBuckets.map(({ id, bucket }) => [id, bucket])),
  };
}

/** An alarm KPI bucket of the MES in the ground truth's shape (`AlarmKpisJson`, sim-summary/3). */
export function alarmTruthShape(bucket: AlarmKpiBucketDto): Record<string, unknown> {
  return {
    from: bucket.from,
    to: bucket.to,
    raises: bucket.raises,
    byPriority: bucket.byPriority,
    averageRate: bucket.averageRate,
    windows: bucket.windows,
    peak10: bucket.peak10,
    floodWindows: bucket.floodWindows,
    floods: bucket.floods,
    floodMs: bucket.floodMs,
    activeAtEnd: bucket.activeAtEnd,
    standing: bucket.standing.map(({ equipment, code, raisedAt }) => ({
      equipment,
      code,
      raisedAt,
    })),
    chatteringRaises: bucket.chatteringRaises,
    chatteringPoints: bucket.chatteringPoints,
    fleeting: bucket.fleeting,
    fleetingUndecided: bucket.fleetingUndecided,
    activeMs: bucket.activeMs,
    provisional: bucket.provisional,
  };
}

export interface ShiftReportCheck {
  waitedMs: number;
  final: boolean;
  revision: { inputs: number; content: number; contentAtFinal: number | null };
  incidents: number;
  oeeSectionIdentical: boolean;
  alarmScopesCompared: number;
  productionCompared: number;
  finished: { equipment: string | null; good: number };
  paretoMs: number;
  availabilityLossMs: number;
  instance: { start: string; end: string; breaks: number; calendarEqual: boolean };
  failures: string[];
}

/**
 * A shift's report (#144; exit criterion 4, #147): waits until it is final, then checks it is
 * `final` with `revision.inputs = 0` and no incident; its OEE section is `GET /shifts/{date}/{shift}/oee`
 * byte for byte; each alarm scope's KPIs are `GET /alarms/kpi`'s shift bucket and the ground
 * truth's; production per machine equals the OEE inputs and the ground truth's cycles, finished
 * parts PCK-01's good cycles; the downtime Pareto sums to the availability loss; and its instance
 * has the calendar's start, end and breaks. Returns what it found, with the failures.
 */
export async function checkShiftReport(
  mes: MesClient,
  truth: GroundTruth,
  shiftKey: string,
  shift: { from: number; to: number },
  machines: readonly string[],
): Promise<ShiftReportCheck> {
  const failures: string[] = [];
  const from = Date.now();
  let text = await mes.shiftReportText(shiftKey);
  await until(
    `${shiftKey} report final`,
    async () => {
      text = await mes.shiftReportText(shiftKey);
      return shiftReportSchema.parse(JSON.parse(text)).final;
    },
    FINAL_WAIT_MS,
  ).catch((error: unknown) => {
    failures.push(error instanceof Error ? error.message : String(error));
  });
  const waitedMs = Date.now() - from;
  const raw = JSON.parse(text) as { oee: unknown; alarms: { scopes: { kpis: unknown }[] } };
  const parsed = shiftReportSchema.parse(raw);
  if (!parsed.final || parsed.status !== 'final') {
    failures.push(`not final (status ${parsed.status})`);
  }
  if (parsed.revision.inputs !== 0 || parsed.incidents !== 0) {
    failures.push(
      `revision.inputs ${String(parsed.revision.inputs)}, incidents ${String(parsed.incidents)}`,
    );
  }
  if (parsed.revision.contentAtFinal === null) failures.push('no contentAtFinal');

  // OEE: the body of GET /shifts/{date}/{shift}/oee, byte for byte.
  const oeeText = await mes.shiftOeeText(shiftKey);
  const oeeSectionIdentical = JSON.stringify(raw.oee) === oeeText;
  if (!oeeSectionIdentical) failures.push('the OEE section is not GET …/oee byte for byte');

  // Alarms: per scope the shift bucket of GET /alarms/kpi (byte for byte) and the ground truth.
  let alarmScopesCompared = 0;
  for (const [n, scope] of parsed.alarms.scopes.entries()) {
    const kind = scope.scope === 'plant' ? 'plant' : 'position';
    const list = JSON.parse(
      await mes.alarmKpiText(kind, scope.id, 'shift', shift.from, shift.to),
    ) as { buckets: { key: string }[] };
    const served = list.buckets.find((b) => b.key === shiftKey);
    if (JSON.stringify(raw.alarms.scopes[n]?.kpis) !== JSON.stringify(served)) {
      failures.push(`${scope.id}: the alarm section is not GET /alarms/kpi's shift bucket`);
    }
    const diffs = jsonDifferences(
      truth.alarms.scopes[scope.id]?.shifts[shiftKey] ?? null,
      scope.kpis ? alarmTruthShape(scope.kpis) : null,
    );
    if (diffs.length > 0) {
      failures.push(
        `${scope.id}: the alarm section differs from the ground truth: ${diffs.join('; ')}`,
      );
    }
    if (scope.kpis) alarmScopesCompared++;
  }
  if (alarmScopesCompared !== 3) {
    failures.push(`${String(alarmScopesCompared)} alarm scopes compared, not 3`);
  }

  // Production: per machine the OEE inputs and the ground truth's cycles.
  const count = (cycles: readonly { result: string; count: number }[], result?: string) =>
    cycles
      .filter((c) => result === undefined || c.result === result)
      .reduce((a, c) => a + c.count, 0);
  let productionCompared = 0;
  for (const id of machines) {
    const row = parsed.production.machines.find((m) => m.equipment === id);
    const inputs = parsed.oee.equipment.find((b) => b.id === id)?.inputs.cycles;
    const truthCycles = truth.oee.machines[id]?.shifts[shiftKey]?.inputs.cycles;
    if (!row || !inputs || !truthCycles) {
      failures.push(`${id}: no production row, OEE inputs or truth cycles`);
      continue;
    }
    const actual = [row.produced, row.good, row.scrap, row.rework];
    for (const [what, cycles] of [
      ['OEE inputs', inputs],
      ['ground truth', truthCycles],
    ] as const) {
      const expected = [
        count(cycles),
        count(cycles, 'good'),
        count(cycles, 'scrap'),
        count(cycles, 'rework'),
      ];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(
          `${id}: produced/good/scrap/rework ${actual.join('/')}, ${what} ${expected.join('/')}`,
        );
      }
    }
    productionCompared++;
  }
  if (productionCompared !== machines.length) {
    failures.push(`${String(productionCompared)} machines' production compared`);
  }
  const finished = parsed.production.finished;
  const pckGood = parsed.production.machines.find((m) => m.equipment === 'pck-01')?.good;
  if (finished.equipment !== 'pck-01' || finished.good !== pckGood) {
    failures.push(`finished parts ${JSON.stringify(finished)}, PCK-01 good ${String(pckGood)}`);
  }
  const scrap = parsed.production.machines.reduce((a, m) => a + m.scrap, 0);
  if (parsed.production.scrap !== scrap) {
    failures.push(`total scrap ${String(parsed.production.scrap)}, rows ${String(scrap)}`);
  }

  // Downtime: the Pareto by reason sums to the own plus external availability loss.
  const paretoMs = parsed.downtime.reasons.reduce((a, r) => a + r.ms, 0);
  const availabilityLossMs =
    parsed.downtime.availability.own + parsed.downtime.availability.external;
  if (paretoMs <= 0) failures.push('the Pareto is empty: nothing to compare');
  if (paretoMs !== availabilityLossMs) {
    failures.push(
      `Pareto ${String(paretoMs)} ms, availability loss ${String(availabilityLossMs)} ms`,
    );
  }

  // The instance: the calendar's start, end and breaks.
  const record = await mes.shiftRecord(shiftKey);
  const calendar = (await mes.shifts(shift.from, shift.to)).shifts.find((s) => s.key === shiftKey);
  const calendarEqual =
    calendar !== undefined &&
    JSON.stringify([record.start, record.end, record.breaks]) ===
      JSON.stringify([calendar.start, calendar.end, calendar.breaks]) &&
    Date.parse(record.start) === shift.from &&
    Date.parse(record.end) === shift.to &&
    record.epoch === truth.epoch;
  if (!calendarEqual) {
    failures.push(
      `instance ${JSON.stringify(record)} is not the calendar's ${JSON.stringify(calendar)}`,
    );
  }

  return {
    waitedMs,
    final: parsed.final,
    revision: parsed.revision,
    incidents: parsed.incidents,
    oeeSectionIdentical,
    alarmScopesCompared,
    productionCompared,
    finished,
    paretoMs,
    availabilityLossMs,
    instance: {
      start: record.start,
      end: record.end,
      breaks: record.breaks.length,
      calendarEqual,
    },
    failures,
  };
}
