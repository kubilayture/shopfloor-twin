/**
 * Downtime reason codes and their automatic classification (#119, ADR-0021 "Automatic
 * classification"): `config/plant/reasons.yaml` holds the reason tree, seeded into master data,
 * and an ordered list of rules from a machine's (state, cause) to a reason. The first matching
 * rule wins; no match gives UNCODED.
 */
import { MACHINE_STATES, causeVocabulary, type StateCause } from '@shopfloor/contracts';
import { z } from 'zod';

/** The reason of an interval no rule matches. */
export const UNCODED = 'UNCODED';

/**
 * States whose intervals can become downtime records (availability loss, ADR-0021); each needs a
 * rule for `cause: null`, because a snapshot (OPC UA resync, Modbus poll) opens an interval
 * without a cause in any state.
 */
export const LOSS_STATES = ['Stopped', 'Down', 'Setup', 'Idle', 'Starved', 'Blocked'] as const;

const segment = '[A-Z0-9]+(-[A-Z0-9]+)*';
/** A reason id is its path in the tree: `BREAKDOWN/SPINDLE-OVERLOAD`; the parent is the prefix. */
const reasonId = z
  .string()
  .regex(new RegExp(`^${segment}(/${segment})*$`), 'upper-case code path like BREAKDOWN/OTHER');

/**
 * A rule's cause pattern: a string matches that cause exactly, `null` an interval without a
 * cause, `{ prefix }` any cause starting with it, `{ any: true }` every cause and none.
 */
const causePattern = z.union([
  z.null(),
  z.string().min(1),
  z.strictObject({ prefix: z.string().min(1) }),
  z.strictObject({ any: z.literal(true) }),
]);

export type CausePattern = z.infer<typeof causePattern>;

export const reasonsSchema = z.strictObject({
  reasons: z.array(z.strictObject({ id: reasonId, name: z.string().min(1) })).min(1),
  rules: z.array(
    z.strictObject({ state: z.enum(MACHINE_STATES), cause: causePattern, reason: reasonId }),
  ),
});

export type ReasonsConfig = z.infer<typeof reasonsSchema>;
export type ReasonRule = ReasonsConfig['rules'][number];

/** The parent of a reason id (`BREAKDOWN` for `BREAKDOWN/SPINDLE-OVERLOAD`), or null at the top. */
export const parentReason = (id: string): string | null => {
  const at = id.lastIndexOf('/');
  return at < 0 ? null : id.slice(0, at);
};

export function matchesCause(pattern: CausePattern, cause: string | null): boolean {
  if (pattern === null) return cause === null;
  if (typeof pattern === 'string') return cause === pattern;
  if ('prefix' in pattern) return cause?.startsWith(pattern.prefix) === true;
  return true;
}

/** The reason of an interval in `state` with `cause`: the first matching rule's, else UNCODED. */
export function classifyCause(
  rules: readonly ReasonRule[],
  state: string,
  cause: string | null,
): string {
  return (
    rules.find((rule) => rule.state === state && matchesCause(rule.cause, cause))?.reason ?? UNCODED
  );
}

const describePattern = (cause: string | null): string =>
  cause === null ? 'no cause' : `"${cause}"`;

/**
 * The cross-check of `reasons.yaml` against itself and the plant's cause vocabulary: unique ids,
 * parents listed before their children, an UNCODED reason, rules naming only known reasons, a
 * `state + null` fallback for every loss state, and a reason other than UNCODED for every cause
 * the plant model can emit.
 */
export function checkReasons(
  reasons: ReasonsConfig,
  vocabulary: readonly StateCause[],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const known = new Set<string>();
  reasons.reasons.forEach((reason, index) => {
    const path = `reasons[${String(index)}]`;
    if (known.has(reason.id)) issues.push({ path, message: `duplicate reason "${reason.id}"` });
    const parent = parentReason(reason.id);
    if (parent !== null && !known.has(parent)) {
      issues.push({ path, message: `parent "${parent}" must be listed before "${reason.id}"` });
    }
    known.add(reason.id);
  });
  if (!known.has(UNCODED)) {
    issues.push({ path: 'reasons', message: `the reason "${UNCODED}" is missing` });
  }
  reasons.rules.forEach((rule, index) => {
    if (!known.has(rule.reason)) {
      issues.push({ path: `rules[${String(index)}]`, message: `unknown reason "${rule.reason}"` });
    }
  });
  const uncoded = (pair: StateCause): boolean =>
    classifyCause(reasons.rules, pair.state, pair.cause) === UNCODED;
  for (const state of LOSS_STATES) {
    if (uncoded({ state, cause: null })) {
      issues.push({ path: 'rules', message: `no rule for ${state} with no cause (a fallback)` });
    }
  }
  for (const pair of vocabulary.filter(uncoded)) {
    issues.push({
      path: 'rules',
      message: `no rule codes ${pair.state} with ${describePattern(pair.cause)}`,
    });
  }
  return issues;
}

/** The plant's cause vocabulary for a configuration (`@shopfloor/contracts`). */
export function plantCauses(config: {
  readonly failures: {
    readonly equipment: Readonly<
      Record<
        string,
        {
          readonly failureModes: readonly { readonly code: string }[];
          readonly minorStops: { readonly causes: readonly string[] };
        }
      >
    >;
  };
  readonly products: {
    readonly products: readonly {
      readonly id: string;
      readonly blank: string;
      readonly components: readonly string[];
    }[];
  };
}): StateCause[] {
  const machines = Object.values(config.failures.equipment);
  return causeVocabulary({
    failureCodes: machines.flatMap((m) => m.failureModes.map((mode) => mode.code)),
    minorStopCauses: machines.flatMap((m) => m.minorStops.causes),
    products: config.products.products.map((p) => p.id),
    materials: config.products.products.flatMap((p) => [p.blank, ...p.components]),
  });
}
