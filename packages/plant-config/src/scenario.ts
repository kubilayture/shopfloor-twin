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

export const SCENARIO_PRODUCTION_MODES = ['schedule', 'orders'] as const;

/** ISO 8601 with an offset or Z, as integer ms; undefined when it is not one. */
export function instantMs(value: string): number | undefined {
  try {
    return Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    return undefined;
  }
}

const instant = z
  .string()
  .refine((value) => instantMs(value) !== undefined, 'expected ISO 8601 with an offset or Z');
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
  /** Headless only: given at the run's start, as a golden scenario's `dispatches`. */
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
    days: z.number().positive(),
    /** The configuration folder, relative to the repository root. */
    config: text,
    /** A stock file in the scenario's folder, in place of the configuration's `stock.yaml`. */
    stock: text.optional(),
    production: z.enum(SCENARIO_PRODUCTION_MODES).optional(),
    /** Not a simulation input: the ERP dataset and the orders a golden MES run releases. */
    erp: z.strictObject({ dataset: text, release: z.array(text) }).optional(),
    injections: z.array(z.union([failureInjection, driftInjection])).optional(),
    dispatches: z.array(z.strictObject(dispatchFields)).optional(),
    actions: z.array(actionItem).optional(),
    timeline: z.array(timelineEntrySchema).optional(),
  })
  .superRefine((scenario, context) => {
    if (scenario.timeline !== undefined) {
      for (const key of ['injections', 'dispatches', 'actions'] as const) {
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

/** A scenario dispatch: one `LoadOrder` at the start time (times in integer ms). */
export interface DispatchEntrySpec {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: number;
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
    end: start + scenario.days * 86_400_000,
    production: scenario.production ?? 'schedule',
    injections,
    dispatches,
    actions,
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
