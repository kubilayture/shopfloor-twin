/**
 * Probe P4's search (#208, Phase 8 plan "Golden scenario `quality-01`"): runs a golden scenario
 * with its `leak-drift` moved to each start in a range, and reports for each what exit criterion 3
 * rests on: the first-pass readings in the scenario's first shift and after the drift's start
 * inside it, the drift's first episode and its latency, and whether the counterfactual readings
 * signal inside the window (40 before, 20 after; `--before 20` for the plan's fallback).
 *
 *   node src/headless/drift-search.ts quality-01 --from 2026-10-12T08:17:00Z \
 *     --to 2026-10-12T09:40:00Z --step 60 [--until 2026-10-12T10:50:00Z] [--before 40]
 *
 * The draws of the leak tester are one stream, so a drift changes nothing before its start; a
 * start moves which first-pass readings the window holds, and the drift's reworks move the line
 * after it.
 */
import { parseArgs } from 'node:util';
import type { InjectionSpec } from '@shopfloor/plant-config';
import { shiftSegments } from '@shopfloor/shift-calendar';
import { scenarioOptions } from './golden.ts';
import { runHeadless } from './run.ts';
import { DETECTION_READINGS, analyseDrifts, type DriftWindow } from './trace-truth.ts';
import { isoTime } from './serialize.ts';

export interface SearchRow {
  readonly at: string;
  readonly until: string;
  /** First-pass readings in the run's first shift. */
  readonly inShift: number;
  /** First-pass readings before the drift's start (whole run). */
  readonly before: number;
  /** First-pass readings from the start to the end of the first shift. */
  readonly afterInShift: number;
  readonly latency: number | null;
  readonly firstEpisode: string | null;
  /** Counterfactual points inside the window on which a rule fires. */
  readonly counterfactualSignals: number;
  readonly counterfactualEpisodes: number;
  /** The window is complete and clean, and the drift is detected within 20 readings. */
  readonly fits: boolean;
}

export interface SearchOptions {
  readonly from: number;
  readonly to: number;
  readonly stepMs: number;
  /** The drift's end; the scenario's own `until` when left out. */
  readonly until?: number;
  readonly window: DriftWindow;
  /** First-pass readings the plan needs after the start inside the first shift (40). */
  readonly afterNeeded?: number;
  /** The baseline's first-pass readings, which the start must follow (100). */
  readonly baseline?: number;
}

/** Runs `name` once per start in [from, to] with its (single) `leak-drift` moved there. */
export async function searchDriftStarts(name: string, search: SearchOptions): Promise<SearchRow[]> {
  const options = await scenarioOptions(name);
  const drifts = (options.injections ?? []).filter((i) => i.kind === 'leak-drift');
  const [drift] = drifts;
  if (drift?.kind !== 'leak-drift' || drifts.length !== 1) {
    throw new RangeError(`${name} must have exactly one leak-drift injection`);
  }
  const [shift] = shiftSegments(options.config.shifts, options.start, options.end).filter(
    (segment) => segment.key !== 'no-shift',
  );
  if (!shift) throw new RangeError(`${name} has no shift`);
  const rows: SearchRow[] = [];
  for (let at = search.from; at <= search.to; at += search.stepMs) {
    const until = search.until ?? drift.until;
    const injections = (options.injections ?? []).map((i): InjectionSpec =>
      i === drift ? { ...drift, at, until } : i,
    );
    const result = runHeadless({ ...options, injections }, () => undefined);
    const [analysis] = analyseDrifts(result.trace, search.window);
    if (!analysis) throw new RangeError(`the drift at ${isoTime(at)} was never applied`);
    const firstPass = result.trace.trace.spc.chart.firstPass;
    const inShift = (index: number): boolean => {
      const reading = firstPass[index];
      return reading !== undefined && reading.at >= shift.from && reading.at < shift.to;
    };
    const indices = firstPass.map((_, i) => i);
    const afterInShift = indices.filter((i) => i >= analysis.startIndex && inShift(i)).length;
    const latency = analysis.latency;
    const complete =
      analysis.window.before === search.window.before &&
      analysis.window.after === search.window.after;
    rows.push({
      at: isoTime(at),
      until: isoTime(until),
      inShift: indices.filter(inShift).length,
      before: analysis.startIndex,
      afterInShift,
      latency,
      firstEpisode:
        analysis.firstEpisode === null
          ? null
          : `${analysis.firstEpisode.chart} rule ${String(analysis.firstEpisode.rule)}`,
      counterfactualSignals: analysis.counterfactualSignals.length,
      counterfactualEpisodes: analysis.counterfactualEpisodes.length,
      fits:
        complete &&
        analysis.counterfactualSignals.length === 0 &&
        latency !== null &&
        latency <= DETECTION_READINGS &&
        afterInShift >= (search.afterNeeded ?? 40) &&
        analysis.startIndex >= (search.baseline ?? 100),
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      step: { type: 'string', default: '60' },
      until: { type: 'string' },
      before: { type: 'string', default: '40' },
    },
  });
  const [name] = positionals;
  if (name === undefined || values.from === undefined || values.to === undefined) {
    throw new Error(
      'usage: drift-search NAME --from ISO --to ISO [--step SECONDS] [--until ISO] [--before N]',
    );
  }
  const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;
  const rows = await searchDriftStarts(name, {
    from: instant(values.from),
    to: instant(values.to),
    stepMs: Number(values.step) * 1000,
    ...(values.until === undefined ? {} : { until: instant(values.until) }),
    window: { before: Number(values.before), after: 20 },
  });
  for (const row of rows) {
    console.log(
      [
        row.at,
        `until ${row.until}`,
        `shift ${String(row.inShift)}`,
        `before ${String(row.before)}`,
        `after-in-shift ${String(row.afterInShift)}`,
        `latency ${String(row.latency)} (${String(row.firstEpisode)})`,
        `counterfactual signals ${String(row.counterfactualSignals)}`,
        row.fits ? 'fits' : '',
      ].join('  '),
    );
  }
  const fitting = rows.filter((row) => row.fits).length;
  console.log(`${String(fitting)} of ${String(rows.length)} starts fit`);
}

if (import.meta.main) {
  await main();
}
