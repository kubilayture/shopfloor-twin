/**
 * Exit criterion 3 (#100): the overview shows each machine's latest state within 2 s. At 60×,
 * intermediate states may be skipped (a 10 s stop lasts about 170 ms of wall time), so the rule is:
 * when the truth changes at wall time t to state s_i, the page must show s_i, or a state the
 * truth took later (s_j, j > i, already taken at that moment), at some time in [t, t + limit].
 * Pure, so it is unit tested; the browser test feeds it.
 */

/** A state the truth took, at wall time `at` (ms since the epoch). */
export interface Change {
  readonly at: number;
  readonly state: string;
}

export interface Measured {
  readonly machine: string;
  readonly at: number;
  readonly state: string;
  /** Wall ms until the page showed it or a later state; undefined when it never did. */
  readonly latencyMs: number | undefined;
}

export interface LatencyResult {
  readonly measured: readonly Measured[];
  /** Changes the page didn't show (nor a later state) within the limit. */
  readonly violations: readonly Measured[];
  /** Changes too close to the end of sampling to judge. */
  readonly unjudged: number;
}

/** The state the page showed at `at`: the last sample at or before it. */
function shownAt(page: readonly Change[], at: number): string | undefined {
  let shown: string | undefined;
  for (const sample of page) {
    if (sample.at > at) break;
    shown = sample.state;
  }
  return shown;
}

/**
 * Judges every truth change of every machine. `truth` and `page` are per machine, in time order;
 * `page` holds a sample whenever the shown state changed (and one at the start). Changes later
 * than `until - limitMs` are not judged, since sampling ended before their deadline.
 */
export function judgeLatency(
  truth: ReadonlyMap<string, readonly Change[]>,
  page: ReadonlyMap<string, readonly Change[]>,
  until: number,
  limitMs: number,
): LatencyResult {
  const measured: Measured[] = [];
  const violations: Measured[] = [];
  let unjudged = 0;
  for (const [machine, changes] of truth) {
    const shown = page.get(machine) ?? [];
    changes.forEach((change, i) => {
      const deadline = change.at + limitMs;
      if (deadline > until) {
        unjudged++;
        return;
      }
      const later = changes.slice(i);
      // The page's state can only become acceptable when it changes, or when the truth reaches a
      // state the page already shows.
      const moments = [
        change.at,
        ...shown.filter((s) => s.at > change.at).map((s) => s.at),
        ...later.slice(1).map((c) => c.at),
      ]
        .filter((at) => at <= deadline)
        .sort((a, b) => a - b);
      const hit = moments.find((at) => {
        const state = shownAt(shown, at);
        return later.some((c) => c.at <= at && c.state === state);
      });
      const result: Measured = {
        machine,
        at: change.at,
        state: change.state,
        latencyMs: hit === undefined ? undefined : hit - change.at,
      };
      measured.push(result);
      if (hit === undefined) violations.push(result);
    });
  }
  return { measured, violations, unjudged };
}

/**
 * Guards against a frozen page: a page that never updates can still match a judged change when
 * the truth returns to the state it shows (Running → 170 ms Stopped → Running). The page must
 * really change: at least half as many transitions as judged changes in all, and at least one on
 * every machine with a judged change. `page` holds the initial sample plus one per transition.
 * Returns the problems found; empty when the page was live.
 */
export function pageActivityProblems(
  measured: readonly Measured[],
  page: ReadonlyMap<string, readonly Change[]>,
): string[] {
  const transitions = (machine: string) => Math.max(0, (page.get(machine)?.length ?? 0) - 1);
  const problems: string[] = [];
  const machines = [...new Set(measured.map((m) => m.machine))].sort();
  const total = [...page.keys()].reduce((sum, machine) => sum + transitions(machine), 0);
  if (total * 2 < measured.length) {
    problems.push(
      `the page changed state ${String(total)} times for ${String(measured.length)} judged changes`,
    );
  }
  for (const machine of machines) {
    if (transitions(machine) === 0) {
      problems.push(`${machine}: the page never changed state, the truth did`);
    }
  }
  return problems;
}
