/**
 * Alarm definitions and KPI configuration (#139, ADR-0024): `config/plant/alarms.yaml` holds the
 * KPI thresholds read by `alarm-core`, the operator positions, the shelving limit, benchmarks for
 * colouring, and one definition per (equipment, code) with its priority and operator text. It is
 * not a simulation input, so the simulator's config hash leaves it out (`SIMULATION_FILES`).
 */
import { alarmVocabulary, type AlarmPoint } from '@shopfloor/contracts';
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case kebab-case id');
const code = z.string().regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'upper-case code');
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const percent = z.number().int().min(0).max(100);

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export const alarmsSchema = z.strictObject({
  kpi: z.strictObject({
    floodThreshold: count,
    windowMs: count,
    chatterCount: count,
    chatterWindowMs: count,
    fleetingMs: count,
    standingMs: count,
  }),
  maxShelveMs: count,
  benchmarks: z.strictObject({
    acceptablePer10Min: count,
    manageablePer10Min: count,
    floodWindowsPercent: percent,
    topTenSharePercent: percent,
  }),
  positions: z
    .array(z.strictObject({ id, name: z.string().min(1), workCenters: z.array(id).min(1) }))
    .min(1),
  definitions: z.array(
    z.strictObject({
      equipment: id,
      code,
      priority: z.enum(['high', 'medium', 'low']),
      text: z.string().min(1),
      consequence: z.string().min(1).optional(),
      response: z.string().min(1).optional(),
    }),
  ),
});

export type AlarmsConfig = z.infer<typeof alarmsSchema>;

/** The plant's alarm vocabulary for a configuration (`@shopfloor/contracts`). */
export function plantAlarms(config: {
  readonly failures: {
    readonly equipment: Readonly<
      Record<string, { readonly failureModes: readonly { readonly code: string }[] }>
    >;
  };
  readonly plant: {
    readonly areas: readonly {
      readonly workCenters: readonly {
        readonly equipment: readonly { readonly id: string; readonly operation: string }[];
      }[];
    }[];
  };
  readonly process: { readonly leakTest: { readonly operation: string } };
}): AlarmPoint[] {
  const equipment = config.plant.areas.flatMap((area) =>
    area.workCenters.flatMap((workCenter) => workCenter.equipment),
  );
  return alarmVocabulary({
    failureCodes: Object.fromEntries(
      Object.entries(config.failures.equipment).map(([key, item]) => [
        key,
        item.failureModes.map((mode) => mode.code),
      ]),
    ),
    leakTesters: equipment
      .filter((item) => item.operation === config.process.leakTest.operation)
      .map((item) => item.id),
  });
}

/**
 * The cross-check of `alarms.yaml`: thresholds that `alarm-core` can use (a window that divides an
 * hour, a shelving limit of at least a minute), positions over known work centers that cover each
 * work center once, unique definitions on known equipment, and a definition for every alarm the
 * plant can raise.
 */
export function checkAlarms(
  alarms: AlarmsConfig,
  workCenters: ReadonlyMap<string, readonly string[]>,
  vocabulary: readonly AlarmPoint[],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (HOUR_MS % alarms.kpi.windowMs !== 0) {
    issues.push({ path: 'kpi.windowMs', message: 'the window must divide an hour' });
  }
  if (alarms.maxShelveMs < MINUTE_MS) {
    issues.push({ path: 'maxShelveMs', message: 'shelving must allow at least one minute' });
  }
  if (alarms.benchmarks.manageablePer10Min < alarms.benchmarks.acceptablePer10Min) {
    issues.push({
      path: 'benchmarks.manageablePer10Min',
      message: 'the manageable rate is below the acceptable rate',
    });
  }

  const positionIds = new Set<string>();
  const covered = new Map<string, string>();
  alarms.positions.forEach((position, index) => {
    const path = `positions[${String(index)}]`;
    if (position.id === 'plant' || positionIds.has(position.id)) {
      issues.push({ path, message: `position id "${position.id}" is reserved or duplicate` });
    }
    positionIds.add(position.id);
    for (const workCenter of position.workCenters) {
      if (!workCenters.has(workCenter)) {
        issues.push({ path, message: `unknown work center "${workCenter}"` });
      } else if (covered.has(workCenter)) {
        issues.push({
          path,
          message: `work center "${workCenter}" is already in position "${String(covered.get(workCenter))}"`,
        });
      } else {
        covered.set(workCenter, position.id);
      }
    }
  });
  for (const workCenter of workCenters.keys()) {
    if (!covered.has(workCenter)) {
      issues.push({ path: 'positions', message: `work center "${workCenter}" is in no position` });
    }
  }

  const equipment = new Set([...workCenters.values()].flat());
  const defined = new Set<string>();
  alarms.definitions.forEach((definition, index) => {
    const path = `definitions[${String(index)}]`;
    const key = `${definition.equipment}/${definition.code}`;
    if (!equipment.has(definition.equipment)) {
      issues.push({ path, message: `unknown equipment "${definition.equipment}"` });
    }
    if (defined.has(key)) {
      issues.push({ path, message: `duplicate definition for ${key}` });
    }
    defined.add(key);
  });
  for (const point of vocabulary) {
    if (!defined.has(`${point.equipment}/${point.code}`)) {
      issues.push({
        path: 'definitions',
        message: `no definition for ${point.equipment}/${point.code}, which the plant can raise`,
      });
    }
  }
  return issues;
}
