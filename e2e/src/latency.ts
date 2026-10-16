/**
 * Exit criterion 3 (#100): the overview shows each machine's latest state within 2 s. At 60×,
 * intermediate states may be skipped (a 10 s stop lasts about 170 ms of wall time), so the rule is:
 * when the truth changes at wall time t to state s_i, the page must show s_i, or a state the
 * truth took later (s_j, j > i, already taken at that moment), at some time in [t, t + limit].
 * The OEE dashboard (#123, Phase 5 exit criterion 5) is judged the same way, with the API's
 * four-decimal OEE as the "state" and `observed` for values the API held only between polls.
 * Pure, so it is unit tested; the browser tests feed it.
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

/** The page's sample in effect at `at`: the last one at or before it. */
function sampleAt(page: readonly Change[], at: number): Change | undefined {
  let shown: Change | undefined;
  for (const sample of page) {
    if (sample.at > at) break;
    shown = sample;
  }
  return shown;
}

export interface JudgeOptions {
  /**
   * Every value the truth was seen to hold per key, the first one included (#123). A value the
   * page shows that is not among them is one the truth held only between two polls, so its
   * place in the truth's order is unknown: it counts for a change only when the page took it
   * after that change (it is then at most one poll interval older than the change's value).
   * Without this option such a value never counts.
   */
  readonly observed?: ReadonlyMap<string, ReadonlySet<string>>;
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
  options: JudgeOptions = {},
): LatencyResult {
  const measured: Measured[] = [];
  const violations: Measured[] = [];
  let unjudged = 0;
  for (const [machine, changes] of truth) {
    const shown = page.get(machine) ?? [];
    const observed = options.observed?.get(machine);
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
        const sample = sampleAt(shown, at);
        if (sample === undefined) return false;
        if (observed !== undefined && !observed.has(sample.state)) return sample.at > change.at;
        return later.some((c) => c.at <= at && c.state === sample.state);
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
 * really change: at least `minRatio` (default half) as many transitions as judged changes in all,
 * and at least one on every machine with a judged change. `page` holds the initial sample plus
 * one per transition. Returns the problems found; empty when the page was live.
 */
export function pageActivityProblems(
  measured: readonly Measured[],
  page: ReadonlyMap<string, readonly Change[]>,
  minRatio = 0.5,
): string[] {
  const transitions = (machine: string) => Math.max(0, (page.get(machine)?.length ?? 0) - 1);
  const problems: string[] = [];
  const machines = [...new Set(measured.map((m) => m.machine))].sort();
  const total = [...page.keys()].reduce((sum, machine) => sum + transitions(machine), 0);
  if (total < measured.length * minRatio) {
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

/** The page's values at one moment, per key (#123). */
export interface Snapshot {
  readonly at: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface Agreement {
  readonly compared: number;
  readonly matched: number;
  /** Per key, how many of its snapshot values matched. */
  readonly matchedPerKey: Readonly<Record<string, number>>;
  /** The values that matched nothing the API held around their moment (at most 20). */
  readonly mismatches: readonly string[];
}

/**
 * Whether the page showed the API's values (#123, Phase 5 exit criterion 5): each snapshot value
 * must equal a value the API held at some time in [at − beforeMs, at + afterMs], allowing for the
 * push's pacing (one delta a second) and the poll's delay. `api` is per key in time order, with
 * the value seen at the first poll; a value holds from its `at` until the next one's.
 */
export function snapshotAgreement(
  snapshots: readonly Snapshot[],
  api: ReadonlyMap<string, readonly Change[]>,
  beforeMs: number,
  afterMs: number,
): Agreement {
  let compared = 0;
  let matched = 0;
  const matchedPerKey: Record<string, number> = {};
  const mismatches: string[] = [];
  for (const snapshot of snapshots) {
    for (const [key, value] of Object.entries(snapshot.values)) {
      const values = api.get(key) ?? [];
      const from = snapshot.at - beforeMs;
      const to = snapshot.at + afterMs;
      compared++;
      const held = values.some(
        (change, i) =>
          change.state === value && change.at <= to && (values[i + 1]?.at ?? Infinity) >= from,
      );
      if (held) {
        matched++;
        matchedPerKey[key] = (matchedPerKey[key] ?? 0) + 1;
      } else if (mismatches.length < 20) {
        mismatches.push(`${key} at ${new Date(snapshot.at).toISOString()}: page ${value}`);
      }
    }
  }
  return { compared, matched, matchedPerKey, mismatches };
}
