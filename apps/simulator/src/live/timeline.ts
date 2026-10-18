/**
 * Live playback of a scenario timeline (#235, Phase 9 plan "Scenario playback", ADR-0037).
 *
 * A timeline is loaded while the run is idle (`SIM_TIMELINE` at start-up, `POST /scenario`), and
 * every plant entry is accepted then, at the start time, in the order a headless run gives them:
 * the injections (failures and drifts, list order, one numbering), then the console actions. So
 * the event queue holds exactly what the headless run's holds before its first step, and pacing
 * decides only when each event is processed: the event log is the headless one at any speed.
 * The infrastructure entries (`opcua-offline`, `modbus-silent`, `speed`, `pause`) become pacer
 * cues, which never touch the event queue. `dispatch` entries are headless only and refused here:
 * in a live orders run the MES dispatches through `LoadOrder`.
 */
import { join } from 'node:path';
import {
  checkScenarioPlan,
  parseScenario,
  readScenarioFile,
  scenarioPlan,
  type InfrastructureSpec,
  type PlantConfig,
  type Scenario,
  type TimelineAction,
} from '@shopfloor/plant-config';
import type { SimTime, Simulation } from '@shopfloor/sim-core';
import { isoTime } from '../headless/serialize.ts';
import { timelineNames } from '../headless/timeline.ts';
import type { LineEvent, ProductionLine } from '../plant/line.ts';
import type { LivePacer, PacerCue } from './pacer.ts';

/** How a live run reaches its infrastructure faults; an entry needing a missing one is refused. */
export interface InfrastructureHooks {
  /** Takes a machine's OPC UA server offline or back; may resolve false for an unknown machine. */
  readonly opcuaOffline?: (machine: string, offline: boolean) => Promise<boolean> | boolean;
  readonly modbusSilent?: (silent: boolean) => void;
  /** An infrastructure fault that failed asynchronously (logged; the run goes on). */
  readonly onError?: (error: unknown) => void;
}

export type TimelineEntryStatus =
  'scheduled' | 'held' | 'applied' | 'active' | 'ended' | 'ignored' | 'planned';

/** One entry of a loaded timeline and how far it has got (`GET /scenario`). */
export interface TimelineEntryView {
  /** Where it came from: `timeline[3]` (or `injections[0]`, `actions[1]` for a `scenario.json`). */
  readonly entry: string;
  readonly action: TimelineAction;
  /** ISO 8601 UTC; absent for a forced absence (applied at its shift's start). */
  readonly at?: string;
  readonly status: TimelineEntryStatus;
  /** The injection's or console action's id, for a plant entry. */
  readonly id?: number;
}

export interface TimelineView {
  /** The committed timeline's name, or null for one posted inline. */
  readonly name: string | null;
  readonly description: string | null;
  readonly entries: readonly TimelineEntryView[];
}

export type TimelineLoadCode =
  'not-idle' | 'already-loaded' | 'dispatch' | 'mismatch' | 'invalid' | 'unsupported';

export type TimelineLoadResult =
  | { readonly ok: true; readonly timeline: TimelineView }
  | { readonly ok: false; readonly code: TimelineLoadCode; readonly reason: string };

interface Tracked {
  readonly entry: string;
  readonly action: TimelineAction;
  readonly at: SimTime | undefined;
  readonly status: () => TimelineEntryStatus;
  readonly id?: number;
}

export interface LiveTimelineContext {
  readonly config: PlantConfig;
  readonly seed: number;
  readonly start: SimTime;
  readonly line: ProductionLine;
  readonly simulation: Simulation<LineEvent>;
  readonly pacer: LivePacer<LineEvent>;
  readonly infrastructure: InfrastructureHooks;
}

/** One live run's timeline: at most one, loaded while the run is idle. */
export class LiveTimeline {
  readonly #context: LiveTimelineContext;
  #view: { name: string | null; description: string | null; entries: Tracked[] } | undefined;

  constructor(context: LiveTimelineContext) {
    this.#context = context;
  }

  /** The loaded timeline with each entry's progress, or undefined when none is loaded. */
  view(): TimelineView | undefined {
    const view = this.#view;
    if (!view) return undefined;
    return {
      name: view.name,
      description: view.description,
      entries: view.entries.map((tracked) => ({
        entry: tracked.entry,
        action: tracked.action,
        ...(tracked.at === undefined ? {} : { at: isoTime(tracked.at) }),
        status: tracked.status(),
        ...(tracked.id === undefined ? {} : { id: tracked.id }),
      })),
    };
  }

  /**
   * Loads a timeline: refused unless the run is idle and has no timeline yet, when it has a
   * `dispatch` entry, when its seed, start or production mode is not the run's, when an entry
   * does not fit the configuration, or when an infrastructure entry has no hook. Nothing is
   * accepted unless everything is.
   */
  load(scenario: Scenario, name: string | null = null): TimelineLoadResult {
    const { config, seed, start, line, simulation, pacer, infrastructure } = this.#context;
    if (this.#view) {
      return { ok: false, code: 'already-loaded', reason: 'the run has a timeline already' };
    }
    if (pacer.state !== 'idle' || simulation.now !== start) {
      return {
        ok: false,
        code: 'not-idle',
        reason: `a timeline is loaded before the run starts; the run is ${pacer.state}`,
      };
    }
    const plan = scenarioPlan(scenario);
    if (plan.dispatches.length > 0) {
      return {
        ok: false,
        code: 'dispatch',
        reason: `${plan.origins.dispatches.join(', ')}: dispatch entries are headless only (a live orders run is dispatched by the MES through LoadOrder)`,
      };
    }
    const mismatch = [
      plan.seed === seed ? undefined : `seed ${String(plan.seed)} (the run's is ${String(seed)})`,
      plan.start === start
        ? undefined
        : `start ${isoTime(plan.start)} (the run's is ${isoTime(start)})`,
      plan.production === line.production
        ? undefined
        : `production ${plan.production} (the run's is ${line.production})`,
    ].filter((m): m is string => m !== undefined);
    if (mismatch.length > 0) {
      return {
        ok: false,
        code: 'mismatch',
        reason: `the timeline is for another run: ${mismatch.join(', ')}`,
      };
    }
    const issues = checkScenarioPlan(config, plan);
    plan.actions.forEach((action, index) => {
      // A first-operation machine without a tool (a CNC the schedule doesn't list).
      if (
        action.kind === 'tool-breakage' &&
        line.stations.some((s) => s.id === action.machine && !s.tool)
      ) {
        issues.push({
          path: plan.origins.actions[index] ?? '',
          message: `${action.machine} has no tool`,
        });
      }
    });
    if (issues.length > 0) {
      return {
        ok: false,
        code: 'invalid',
        reason: issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      };
    }
    const missing = plan.infrastructure.flatMap((entry, index) =>
      (entry.kind === 'opcua-offline' && !infrastructure.opcuaOffline) ||
      (entry.kind === 'modbus-silent' && !infrastructure.modbusSilent)
        ? [`${plan.origins.infrastructure[index] ?? ''}: this run has no ${entry.kind} fault`]
        : [],
    );
    if (missing.length > 0) {
      return { ok: false, code: 'unsupported', reason: missing.join('; ') };
    }

    const tracked: (Tracked & { order: number })[] = [];
    const order = (origin: string): number => Number(/\[(\d+)\]$/.exec(origin)?.[1] ?? 0);
    // Injections, then actions, each in list order: exactly the headless run's acceptance order.
    plan.injections.forEach((injection, index) => {
      const origin = plan.origins.injections[index] ?? '';
      if (injection.kind === 'leak-drift') {
        const result = line.injectLeakDrift(injection, simulation, plan.end);
        if (!result.ok) throw new Error(`${origin}: ${result.reason}`);
        const id = result.drift.id;
        tracked.push({
          entry: origin,
          order: order(origin),
          action: 'leak-drift',
          at: injection.at,
          id,
          status: () => line.drifts().find((d) => d.id === id)?.status ?? 'scheduled',
        });
      } else {
        const result = line.injectFailure(injection, simulation);
        if (!result.ok) throw new Error(`${origin}: ${result.reason}`);
        const id = result.injection.id;
        tracked.push({
          entry: origin,
          order: order(origin),
          action: 'failure',
          at: injection.at,
          id,
          status: () => line.injections().find((i) => i.id === id)?.status ?? 'scheduled',
        });
      }
    });
    plan.actions.forEach((action, index) => {
      const origin = plan.origins.actions[index] ?? '';
      const result = line.act(action, simulation);
      if (!result.ok) throw new Error(`${origin}: ${result.reason}`);
      const id = result.action.id;
      tracked.push({
        entry: origin,
        order: order(origin),
        action: action.kind,
        at: action.kind === 'operators-absent' ? undefined : action.at,
        id,
        status: () => line.actions().find((a) => a.id === id)?.status ?? 'scheduled',
      });
    });
    const applied = new Set<PacerCue>();
    pacer.onCue = (cue) => {
      applied.add(cue);
    };
    plan.infrastructure.forEach((entry, index) => {
      const origin = plan.origins.infrastructure[index] ?? '';
      const cues = this.#cues(entry);
      for (const cue of cues) pacer.cue(cue);
      tracked.push({
        entry: origin,
        order: order(origin),
        action: entry.kind,
        at: entry.at,
        status: () => {
          const done = cues.filter((cue) => applied.has(cue)).length;
          if (done === 0) return 'scheduled';
          if (done < cues.length) return 'active';
          return cues.length > 1 ? 'ended' : 'applied';
        },
      });
    });
    tracked.sort((a, b) => a.order - b.order);
    this.#view = {
      name,
      description: scenario.description ?? null,
      entries: tracked,
    };
    const view = this.view();
    if (!view) throw new Error('unreachable');
    return { ok: true, timeline: view };
  }

  /** The pacer cues of one infrastructure entry: its start, and its end when it has an `until`. */
  #cues(entry: InfrastructureSpec): PacerCue[] {
    const { infrastructure } = this.#context;
    const fault = (work: () => unknown): void => {
      try {
        const result = work();
        if (result instanceof Promise) {
          result.catch((error: unknown) => infrastructure.onError?.(error));
        }
      } catch (error) {
        infrastructure.onError?.(error);
      }
    };
    switch (entry.kind) {
      case 'pause':
        return [{ at: entry.at, kind: 'pause' }];
      case 'speed':
        return [{ at: entry.at, kind: 'speed', speed: entry.speed }];
      case 'opcua-offline': {
        const set = (offline: boolean) => () => {
          fault(() => infrastructure.opcuaOffline?.(entry.machine, offline));
        };
        return [
          { at: entry.at, kind: 'call', run: set(true) },
          ...(entry.until === undefined
            ? []
            : [{ at: entry.until, kind: 'call' as const, run: set(false) }]),
        ];
      }
      case 'modbus-silent': {
        const set = (silent: boolean) => () => {
          fault(() => infrastructure.modbusSilent?.(silent));
        };
        return [
          { at: entry.at, kind: 'call', run: set(true) },
          ...(entry.until === undefined
            ? []
            : [{ at: entry.until, kind: 'call' as const, run: set(false) }]),
        ];
      }
    }
  }
}

/** A `POST /scenario` body: a committed timeline by name, or a timeline document inline. */
export type ScenarioRequest = { readonly name: string } | { readonly timeline: unknown };

export type ScenarioLoadAnswer =
  | TimelineLoadResult
  | { readonly ok: false; readonly code: 'unknown-name' | 'parse'; readonly reason: string };

/** What the control API's scenario routes need (#235, control API 1.9). */
export interface ScenarioControl {
  load(request: ScenarioRequest): Promise<ScenarioLoadAnswer>;
  view(): TimelineView | undefined;
  /** The committed timelines with their descriptions (null when a file doesn't parse). */
  list(): Promise<{ name: string; description: string | null }[]>;
}

/** The scenario routes of a live run whose committed timelines are in `folder`. */
export function scenarioControl(
  run: {
    loadTimeline(scenario: Scenario, name: string | null): TimelineLoadResult;
    timeline(): TimelineView | undefined;
  },
  folder: string,
): ScenarioControl {
  const file = (name: string): string => join(folder, `${name}.yaml`);
  return {
    async load(request) {
      if ('name' in request) {
        if (!timelineNames(folder).includes(request.name)) {
          return {
            ok: false,
            code: 'unknown-name',
            reason: `no committed timeline "${request.name}"`,
          };
        }
        const read = await readScenarioFile(file(request.name));
        if (!read.ok) return { ok: false, code: 'parse', reason: read.message };
        return run.loadTimeline(read.scenario, request.name);
      }
      const parsed = parseScenario(request.timeline);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'parse',
          reason: parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        };
      }
      if (parsed.scenario.stock !== undefined) {
        return {
          ok: false,
          code: 'parse',
          reason: 'stock: an inline timeline has no folder for its stock file',
        };
      }
      return run.loadTimeline(parsed.scenario, null);
    },
    view: () => run.timeline(),
    async list() {
      return Promise.all(
        timelineNames(folder).map(async (name) => {
          const read = await readScenarioFile(file(name));
          return { name, description: read.ok ? (read.scenario.description ?? null) : null };
        }),
      );
    },
  };
}
