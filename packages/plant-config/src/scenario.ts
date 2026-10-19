/**
 * Scenarios (#235, Phase 9 plan "Scenario playback", ADR-0037): one schema for a golden
 * `scenario.json` and a timeline of `config/scenarios/<name>.yaml`, and the run plan both map
 * onto. A scenario names a seed, a start, a span and a configuration, and either the golden keys
 * (`injections`, `dispatches`, `actions`) or a `timeline` of entries `{ at, action, … }`.
 *
 * The plan keeps the golden mapping unchanged: dispatches (given after `line.start`), then the
 * injections (failures and drifts in list order, one numbering), then the console actions (their
 * own numbering). A timeline's entries go to the same three lists in timeline order, and its
 * infrastructure entries (`opcua-offline`, `modbus-silent`, `speed`, `pause`) to a fourth that
 * only a live run plays: they don't touch the plant model, so the event log is the same without
 * them.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { checkActions, shiftStart, type ActionSpec } from './actions.ts';
import { checkInjections, type InjectionSpec } from './injections.ts';
import type { PlantConfig } from './schema.ts';

/** The live pacer's speed range (`apps/simulator` `MIN_SPEED`/`MAX_SPEED`, asserted equal). */
export const TIMELINE_SPEED = { min: 0.5, max: 60 } as const;

/**
 * The most entries a timeline (or each golden list) may have (#235 review): loading and the
 * progress view stay well under a millisecond per entry.
 */
export const MAX_TIMELINE_ENTRIES = 1_000;

/**
 * The most entries each list of a recorded run may have (#236 review): a recording (a document
 * with `configSha256`) is written by a live run, not by hand, and a long run with the MES
 * dispatching every order passes 1,000 jobs. `GET /scenario/recorded` refuses a run past it (413).
 */
export const MAX_RECORDED_ENTRIES = 100_000;

/** The kinds `inputOrder` interleaves (#236 review): an injection (failure or drift) or an action. */
export const INPUT_KINDS = ['injection', 'action'] as const;

export const SCENARIO_PRODUCTION_MODES = ['schedule', 'orders'] as const;

/** ISO 8601 with an offset or Z, as integer ms; undefined when it is not one. */
export function instantMs(value: string): number | undefined {
  try {
    return Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    return undefined;
  }
}

/** Whether an ISO 8601 instant has a fraction finer than a millisecond (the simulation's unit). */
const subMillisecond = (value: string): boolean => {
  try {
    return Temporal.Instant.from(value).epochNanoseconds % 1_000_000n !== 0n;
  } catch {
    return false;
  }
};

const instant = z
  .string()
  .refine((value) => instantMs(value) !== undefined, 'expected ISO 8601 with an offset or Z')
  .refine(
    (value) => !subMillisecond(value),
    'expected whole milliseconds (the simulation has no finer time)',
  );
const text = z.string().min(1);
const quantity = z.number().int().positive();

const failureInjection = z.strictObject({
  kind: z.undefined().optional(),
  at: instant,
  machine: text,
  code: text,
  repairMs: z.number().optional(),
});
const driftInjection = z.strictObject({
  kind: z.literal('leak-drift'),
  at: instant,
  until: instant,
  machine: text,
  shift: z.number(),
});
const dispatchFields = {
  commandId: text,
  machine: text,
  orderId: text,
  product: text,
  quantity,
  notBefore: instant,
  /**
   * A dispatch recorded live (#236, `GET /scenario/recorded`): the simulation time it was accepted
   * at, with `afterEvents`. Both or neither; without them it is given at the start time.
   */
  acceptedAt: instant.optional(),
  /** The number of events the run had processed when it was accepted (#236), with `acceptedAt`. */
  afterEvents: z.number().int().min(0).optional(),
};
const actionItem = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['lot-block', 'lot-release']), at: instant, lot: text }),
  z.strictObject({ kind: z.literal('tool-breakage'), at: instant, machine: text }),
  z.strictObject({
    kind: z.literal('operators-absent'),
    shift: text,
    operators: z.array(text),
  }),
]);

/** One timeline entry: `action` names what happens, `at` when (ISO 8601 with an offset or Z). */
export const timelineEntrySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('failure'),
    at: instant,
    machine: text,
    code: text,
    repairMs: z.number().optional(),
  }),
  z.strictObject({
    action: z.literal('leak-drift'),
    at: instant,
    until: instant,
    machine: text,
    shift: z.number(),
  }),
  z.strictObject({
    action: z.literal('opcua-offline'),
    at: instant,
    machine: text,
    /** Back online at `until`; offline to the end when left out. */
    until: instant.optional(),
  }),
  z.strictObject({
    action: z.literal('modbus-silent'),
    at: instant,
    /** Answering again at `until`; silent to the end when left out. */
    until: instant.optional(),
  }),
  z.strictObject({ action: z.enum(['lot-block', 'lot-release']), at: instant, lot: text }),
  z.strictObject({
    action: z.literal('operators-absent'),
    /** No `at`: applied at the start of `shift` (`YYYY-MM-DD/<shift id>`). */
    shift: text,
    operators: z.array(text),
  }),
  z.strictObject({ action: z.literal('tool-breakage'), at: instant, machine: text }),
  /**
   * Headless only: given at the run's start, as a golden scenario's `dispatches`, or at its
   * recorded point (`acceptedAt`, `afterEvents`, #236).
   */
  z.strictObject({ action: z.literal('dispatch'), ...dispatchFields }),
  z.strictObject({
    action: z.literal('speed'),
    at: instant,
    speed: z.number().min(TIMELINE_SPEED.min).max(TIMELINE_SPEED.max),
  }),
  z.strictObject({ action: z.literal('pause'), at: instant }),
]);

export type TimelineEntry = z.output<typeof timelineEntrySchema>;
export type TimelineAction = TimelineEntry['action'];

export const TIMELINE_ACTIONS = [
  'failure',
  'leak-drift',
  'opcua-offline',
  'modbus-silent',
  'lot-block',
  'lot-release',
  'operators-absent',
  'tool-breakage',
  'dispatch',
  'speed',
  'pause',
] as const satisfies readonly TimelineAction[];

export const scenarioSchema = z
  .strictObject({
    description: z.string().optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1),
    start: instant,
    days: z
      .number()
      .positive()
      .refine(
        (days) => Number.isSafeInteger(days * 86_400_000),
        'days must be a whole number of milliseconds (days × 86,400,000 an integer)',
      ),
    /**
     * An earlier end inside the span (#236), as the headless CLI's `--end`: a recording of a live
     * run ends just after the time the run had reached.
     */
    end: instant.optional(),
    /**
     * A recorded run (#236 review): the replay stops once it has processed exactly this many events,
     * where the live run stood, so the two logs are equal line for line.
     */
    endAfterEvents: z.number().int().min(0).optional(),
    /**
     * The `configSha256` of the run a recording was made from (#236 review): checked against the
     * configuration the replay loads. Its presence marks a recorded document (`MAX_RECORDED_ENTRIES`).
     */
    configSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'expected a SHA-256 in lowercase hex')
      .optional(),
    /** The configuration folder, relative to the repository root. */
    config: text,
    /** A stock file in the scenario's folder, in place of the configuration's `stock.yaml`. */
    stock: text.optional(),
    production: z.enum(SCENARIO_PRODUCTION_MODES).optional(),
    /** Not a simulation input: the ERP dataset and the orders a golden MES run releases. */
    erp: z.strictObject({ dataset: text, release: z.array(text) }).optional(),
    injections: z
      .array(z.union([failureInjection, driftInjection]))
      .max(MAX_RECORDED_ENTRIES)
      .optional(),
    dispatches: z.array(z.strictObject(dispatchFields)).max(MAX_RECORDED_ENTRIES).optional(),
    actions: z.array(actionItem).max(MAX_RECORDED_ENTRIES).optional(),
    /**
     * The order the injections and actions were accepted in, interleaved (#236 review): one kind
     * per entry, each list's entries taken in list order. Without it, every injection comes before
     * every action. Their external events share one lane in acceptance order, so an injection and
     * an action of one millisecond, or a drift's end and an action, depend on it.
     */
    inputOrder: z
      .array(z.enum(INPUT_KINDS))
      .max(2 * MAX_RECORDED_ENTRIES)
      .optional(),
    timeline: z.array(timelineEntrySchema).max(MAX_TIMELINE_ENTRIES).optional(),
  })
  .superRefine((scenario, context) => {
    // A hand-written golden list keeps the timeline's bound; a recording has its own (above).
    if (scenario.configSha256 === undefined) {
      for (const key of ['injections', 'dispatches', 'actions', 'inputOrder'] as const) {
        const length = scenario[key]?.length ?? 0;
        if (length > MAX_TIMELINE_ENTRIES) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `at most ${String(MAX_TIMELINE_ENTRIES)} entries (a recorded run, with configSha256, takes ${String(MAX_RECORDED_ENTRIES)})`,
          });
        }
      }
    }
    if (scenario.inputOrder !== undefined) {
      const count = (kind: (typeof INPUT_KINDS)[number]) =>
        scenario.inputOrder?.filter((k) => k === kind).length ?? 0;
      if (
        count('injection') !== (scenario.injections?.length ?? 0) ||
        count('action') !== (scenario.actions?.length ?? 0)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['inputOrder'],
          message: 'inputOrder must name each injection and each action once',
        });
      }
    }
    if (scenario.end !== undefined) {
      const start = instantMs(scenario.start);
      const end = instantMs(scenario.end);
      if (
        start !== undefined &&
        end !== undefined &&
        (end <= start || end > start + scenario.days * 86_400_000)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['end'],
          message: 'end must be after start and not after start + days',
        });
      }
    }
    const timed = (
      entries: readonly { acceptedAt?: string | undefined; afterEvents?: number | undefined }[],
      path: (index: number) => (string | number)[],
    ) => {
      entries.forEach((entry, index) => {
        if ((entry.acceptedAt === undefined) !== (entry.afterEvents === undefined)) {
          context.addIssue({
            code: 'custom',
            path: path(index),
            message: 'a recorded dispatch has both acceptedAt and afterEvents, or neither',
          });
        }
      });
    };
    timed(scenario.dispatches ?? [], (index) => ['dispatches', index]);
    (scenario.timeline ?? []).forEach((entry, index) => {
      if (entry.action === 'dispatch') timed([entry], () => ['timeline', index]);
    });
    if (scenario.timeline !== undefined) {
      for (const key of ['injections', 'dispatches', 'actions', 'inputOrder'] as const) {
        if (scenario[key] !== undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `a scenario with a timeline lists its ${key} in the timeline`,
          });
        }
      }
      let last = -Infinity;
      scenario.timeline.forEach((entry, index) => {
        if (!('at' in entry)) return;
        const at = instantMs(entry.at) ?? last;
        if (at < last) {
          context.addIssue({
            code: 'custom',
            path: ['timeline', index, 'at'],
            message: 'timeline entries must be in time order',
          });
        }
        last = Math.max(last, at);
      });
    }
  });

export type Scenario = z.output<typeof scenarioSchema>;

/**
 * A scenario dispatch: one `LoadOrder` at the start time, or, recorded live (#236), at the point
 * `acceptedAt` and `afterEvents` name (times in integer ms).
 */
export interface DispatchEntrySpec {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: number;
  readonly acceptedAt?: number;
  readonly afterEvents?: number;
}

/** A timeline entry outside the plant model, played by a live run only (times in integer ms). */
export type InfrastructureSpec =
  | {
      readonly kind: 'opcua-offline';
      readonly at: number;
      readonly machine: string;
      readonly until?: number | undefined;
    }
  | { readonly kind: 'modbus-silent'; readonly at: number; readonly until?: number | undefined }
  | { readonly kind: 'speed'; readonly at: number; readonly speed: number }
  | { readonly kind: 'pause'; readonly at: number };

/** Where each list item came from (`timeline[3]`, `injections[0]`), for messages. */
export interface ScenarioOrigins {
  readonly injections: readonly string[];
  readonly dispatches: readonly string[];
  readonly actions: readonly string[];
  readonly infrastructure: readonly string[];
}

/** A scenario as a run takes it: times in integer ms, entries split by how they are given. */
export interface ScenarioPlan {
  readonly seed: number;
  readonly start: number;
  readonly end: number;
  readonly production: (typeof SCENARIO_PRODUCTION_MODES)[number];
  readonly injections: readonly InjectionSpec[];
  readonly dispatches: readonly DispatchEntrySpec[];
  readonly actions: readonly ActionSpec[];
  /** Recorded (#236 review): the injections and actions interleaved in acceptance order. */
  readonly inputOrder?: readonly (typeof INPUT_KINDS)[number][];
  /** Recorded (#236 review): stop after exactly this many events. */
  readonly endAfterEvents?: number;
  /** Recorded (#236 review): the configuration hash the replay must match. */
  readonly configSha256?: string;
  readonly infrastructure: readonly InfrastructureSpec[];
  readonly origins: ScenarioOrigins;
}

export type ScenarioParseResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly issues: readonly { path: string; message: string }[] };

/**
 * Parses a scenario document. An injection's unknown `kind` is named as before #235 (a failure
 * injection has no kind; a drift is `leak-drift`).
 */
export function parseScenario(raw: unknown): ScenarioParseResult {
  const injections = (raw as { injections?: unknown } | null)?.injections;
  if (Array.isArray(injections)) {
    const issues = injections.flatMap((injection: unknown, index) => {
      const kind = (injection as { kind?: unknown } | null)?.kind;
      return kind === undefined || kind === 'leak-drift'
        ? []
        : [
            {
              path: `injections[${String(index)}]`,
              message: `unknown kind ${JSON.stringify(kind)} (a failure injection has no kind; a drift is "leak-drift")`,
            },
          ];
    });
    if (issues.length > 0) return { ok: false, issues };
  }
  const result = scenarioSchema.safeParse(raw);
  if (result.success) return { ok: true, scenario: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path
        .map((part, i) =>
          typeof part === 'number' ? `[${String(part)}]` : `${i === 0 ? '' : '.'}${String(part)}`,
        )
        .join(''),
      message: issue.message,
    })),
  };
}

const ms = (iso: string): number => {
  const value = instantMs(iso);
  if (value === undefined) throw new RangeError(`invalid instant ${iso}`);
  return value;
};

/** The run plan of a parsed scenario: the golden keys, or its timeline split into four lists. */
export function scenarioPlan(scenario: Scenario): ScenarioPlan {
  const start = ms(scenario.start);
  const injections: InjectionSpec[] = [];
  const dispatches: DispatchEntrySpec[] = [];
  const actions: ActionSpec[] = [];
  const infrastructure: InfrastructureSpec[] = [];
  const origins = {
    injections: [] as string[],
    dispatches: [] as string[],
    actions: [] as string[],
    infrastructure: [] as string[],
  };
  const dispatch = (d: z.output<z.ZodObject<typeof dispatchFields>>): DispatchEntrySpec => ({
    commandId: d.commandId,
    machine: d.machine,
    orderId: d.orderId,
    product: d.product,
    quantity: d.quantity,
    notBefore: ms(d.notBefore),
    ...(d.acceptedAt === undefined || d.afterEvents === undefined
      ? {}
      : { acceptedAt: ms(d.acceptedAt), afterEvents: d.afterEvents }),
  });
  (scenario.dispatches ?? []).forEach((d, index) => {
    dispatches.push(dispatch(d));
    origins.dispatches.push(`dispatches[${String(index)}]`);
  });
  (scenario.injections ?? []).forEach((injection, index) => {
    injections.push(
      injection.kind === 'leak-drift'
        ? {
            kind: injection.kind,
            machine: injection.machine,
            shift: injection.shift,
            at: ms(injection.at),
            until: ms(injection.until),
          }
        : {
            machine: injection.machine,
            code: injection.code,
            at: ms(injection.at),
            ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
          },
    );
    origins.injections.push(`injections[${String(index)}]`);
  });
  (scenario.actions ?? []).forEach((action, index) => {
    actions.push(
      action.kind === 'operators-absent'
        ? { kind: action.kind, shift: action.shift, operators: action.operators }
        : action.kind === 'tool-breakage'
          ? { kind: action.kind, at: ms(action.at), machine: action.machine }
          : { kind: action.kind, at: ms(action.at), lot: action.lot },
    );
    origins.actions.push(`actions[${String(index)}]`);
  });
  (scenario.timeline ?? []).forEach((entry, index) => {
    const origin = `timeline[${String(index)}]`;
    switch (entry.action) {
      case 'failure':
        injections.push({
          machine: entry.machine,
          code: entry.code,
          at: ms(entry.at),
          ...(entry.repairMs === undefined ? {} : { repairMs: entry.repairMs }),
        });
        origins.injections.push(origin);
        return;
      case 'leak-drift':
        injections.push({
          kind: 'leak-drift',
          machine: entry.machine,
          shift: entry.shift,
          at: ms(entry.at),
          until: ms(entry.until),
        });
        origins.injections.push(origin);
        return;
      case 'dispatch':
        dispatches.push(dispatch(entry));
        origins.dispatches.push(origin);
        return;
      case 'lot-block':
      case 'lot-release':
        actions.push({ kind: entry.action, at: ms(entry.at), lot: entry.lot });
        origins.actions.push(origin);
        return;
      case 'tool-breakage':
        actions.push({ kind: entry.action, at: ms(entry.at), machine: entry.machine });
        origins.actions.push(origin);
        return;
      case 'operators-absent':
        actions.push({ kind: entry.action, shift: entry.shift, operators: entry.operators });
        origins.actions.push(origin);
        return;
      case 'opcua-offline':
        infrastructure.push({
          kind: entry.action,
          at: ms(entry.at),
          machine: entry.machine,
          ...(entry.until === undefined ? {} : { until: ms(entry.until) }),
        });
        origins.infrastructure.push(origin);
        return;
      case 'modbus-silent':
        infrastructure.push({
          kind: entry.action,
          at: ms(entry.at),
          ...(entry.until === undefined ? {} : { until: ms(entry.until) }),
        });
        origins.infrastructure.push(origin);
        return;
      case 'speed':
        infrastructure.push({ kind: entry.action, at: ms(entry.at), speed: entry.speed });
        origins.infrastructure.push(origin);
        return;
      case 'pause':
        infrastructure.push({ kind: entry.action, at: ms(entry.at) });
        origins.infrastructure.push(origin);
        return;
    }
  });
  return {
    seed: scenario.seed,
    start,
    end: scenario.end === undefined ? start + scenario.days * 86_400_000 : ms(scenario.end),
    production: scenario.production ?? 'schedule',
    injections,
    dispatches,
    actions,
    ...(scenario.inputOrder === undefined ? {} : { inputOrder: scenario.inputOrder }),
    ...(scenario.endAfterEvents === undefined ? {} : { endAfterEvents: scenario.endAfterEvents }),
    ...(scenario.configSha256 === undefined ? {} : { configSha256: scenario.configSha256 }),
    infrastructure,
    origins,
  };
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * Every problem of a plan under a configuration, with the entry it came from: the cross-checks
 * of `checkInjections` and `checkActions`, entries outside the run (`[start, end)`; a forced
 * absence's shift must start inside `(start, end)`), dispatches outside orders mode, and the
 * infrastructure entries (an OPC UA machine for `opcua-offline`, an `until` after `at`).
 */
export function checkScenarioPlan(
  config: Pick<
    PlantConfig,
    'plant' | 'failures' | 'shifts' | 'process' | 'products' | 'stock' | 'operators'
  >,
  plan: ScenarioPlan,
): { path: string; message: string }[] {
  const { start, end, origins } = plan;
  const remap = (paths: readonly string[], issue: { path: string; message: string }) => {
    const index = Number(/\[(\d+)\]$/.exec(issue.path)?.[1]);
    return { path: paths[index] ?? issue.path, message: issue.message };
  };
  const outside = (at: number) => `${iso(at)} is outside the run [start, end)`;
  const issues = [
    ...checkInjections(config, plan.injections, end).map((i) => remap(origins.injections, i)),
    ...plan.injections.flatMap((injection, index) =>
      injection.at >= end || injection.at < start
        ? [{ path: origins.injections[index] ?? '', message: outside(injection.at) }]
        : [],
    ),
    ...checkActions(config, plan.actions).map((i) => remap(origins.actions, i)),
    ...plan.actions.flatMap((action, index) => {
      const path = origins.actions[index] ?? '';
      if (action.kind === 'operators-absent') {
        const at = shiftStart(config, action.shift);
        return at === undefined || (at > start && at < end)
          ? []
          : [{ path, message: `shift ${action.shift} does not start inside the run (start, end)` }];
      }
      return action.at >= start && action.at < end ? [] : [{ path, message: outside(action.at) }];
    }),
  ];
  if (plan.production === 'schedule' && plan.dispatches.length > 0) {
    issues.push({
      path: origins.dispatches[0] ?? 'dispatches',
      message: 'dispatches need production mode "orders"',
    });
  }
  issues.push(...recordedDispatchIssues(plan.dispatches, start, end, origins.dispatches));
  const equipment = config.plant.areas.flatMap((area) =>
    area.workCenters.flatMap((workCenter) => workCenter.equipment),
  );
  plan.infrastructure.forEach((entry, index) => {
    const path = origins.infrastructure[index] ?? '';
    if (entry.at < start || entry.at >= end) issues.push({ path, message: outside(entry.at) });
    if (entry.kind === 'opcua-offline' || entry.kind === 'modbus-silent') {
      if (entry.until !== undefined && entry.until <= entry.at) {
        issues.push({ path, message: `until must be after at, got ${iso(entry.until)}` });
      }
    }
    if (entry.kind === 'opcua-offline') {
      const machine = equipment.find((e) => e.id === entry.machine);
      if (!machine) {
        issues.push({ path, message: `unknown machine "${entry.machine}"` });
      } else if (machine.interface !== 'opcua') {
        issues.push({ path, message: `${entry.machine} has no OPC UA server` });
      }
    }
    if (entry.kind === 'modbus-silent' && !equipment.some((e) => e.interface === 'modbus')) {
      issues.push({ path, message: 'the plant has no Modbus device' });
    }
  });
  // Fault windows of one device must not overlap: the later window's start would do nothing and
  // the earlier one's end would undo it (#235 review). A window without `until` lasts to the end.
  const windows = new Map<string, { until: number; path: string }>();
  plan.infrastructure.forEach((entry, index) => {
    if (entry.kind !== 'opcua-offline' && entry.kind !== 'modbus-silent') return;
    const device = entry.kind === 'opcua-offline' ? `opcua:${entry.machine}` : 'modbus';
    const path = origins.infrastructure[index] ?? '';
    const previous = windows.get(device);
    if (previous && entry.at < previous.until) {
      issues.push({
        path,
        message: `overlaps the ${entry.kind} window of ${previous.path} (until ${previous.until === Infinity ? 'the end' : iso(previous.until)})`,
      });
    }
    windows.set(device, { until: entry.until ?? Infinity, path });
  });
  return issues;
}

/**
 * The order rules of recorded dispatches (#236): every dispatch given at the start comes before
 * every recorded one, and recorded ones are in acceptance order (neither the time nor the event
 * count goes back) inside the run `[start, end)`. Shared with the headless run's own checks.
 */
export function recordedDispatchIssues(
  dispatches: readonly {
    readonly acceptedAt?: number | undefined;
    readonly afterEvents?: number | undefined;
  }[],
  start: number,
  end: number,
  paths: readonly string[] = [],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  let previous: { at: number; events: number } | undefined;
  dispatches.forEach((dispatch, index) => {
    const path = paths[index] ?? `dispatches[${String(index)}]`;
    const { acceptedAt, afterEvents } = dispatch;
    if (acceptedAt === undefined || afterEvents === undefined) {
      if (previous) {
        issues.push({
          path,
          message: 'a dispatch given at the start must come before every recorded dispatch',
        });
      }
      return;
    }
    if (acceptedAt < start || acceptedAt >= end) {
      issues.push({
        path,
        message: `acceptedAt ${iso(acceptedAt)} is outside the run [start, end)`,
      });
    }
    if (previous && (acceptedAt < previous.at || afterEvents < previous.events)) {
      issues.push({
        path,
        message:
          'recorded dispatches must be in acceptance order (acceptedAt and afterEvents never go back)',
      });
    }
    previous = { at: acceptedAt, events: afterEvents };
  });
  return issues;
}

export type ScenarioFileResult =
  | { readonly ok: true; readonly scenario: Scenario; readonly stock: string | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Reads a scenario file: `.yaml`/`.yml` (a timeline) or `.json` (a golden `scenario.json`), and
 * the path of its own stock file, which must be a file name in the scenario's folder.
 */
export async function readScenarioFile(path: string): Promise<ScenarioFileResult> {
  let raw: unknown;
  try {
    const source = await readFile(path, 'utf8');
    raw = extname(path) === '.json' ? JSON.parse(source) : parse(source);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseScenario(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    };
  }
  const { stock } = parsed.scenario;
  if (stock !== undefined && (basename(stock) !== stock || stock.startsWith('.'))) {
    return { ok: false, message: "stock must be a file name in the scenario's folder" };
  }
  return {
    ok: true,
    scenario: parsed.scenario,
    stock: stock === undefined ? undefined : join(dirname(path), stock),
  };
}
