/**
 * Packing and quality characteristics (Phase 8 plan "Genealogy" and "SPC", ADR-0032, ADR-0034):
 * `config/plant/packing.yaml` (carton capacity per product) and `config/plant/quality.yaml` (the
 * SPC characteristics). Neither is a simulation input: the simulator's trace ground truth
 * (`trace.json`, #208) and the MES's `genealogy` and `quality` modules read them, so they share
 * one definition of cartons and charts.
 */
import { z } from 'zod';

export const packingSchema = z.strictObject({
  /** The operation whose good cycles pack a unit: the routing's last. */
  operation: z.string().min(1),
  /** Units per carton, per product. */
  capacity: z.record(z.string(), z.number().int().min(1).max(10_000)),
});

export type PackingConfig = z.infer<typeof packingSchema>;

/**
 * The name the leak tester gives its measurement (`characteristic` on the cycle fact): the id of
 * the leak test's characteristic in `quality.yaml` must be this one.
 */
export const LEAK_TEST_CHARACTERISTIC = 'leak-rate';

/** The charts of a characteristic, as `spc-core` names them. */
export const SPC_CHARTS = ['I', 'MR', 'Xbar', 'R'] as const;

/** Charts of ranges: only rule 1 applies (`spc-core`'s `checkRuleSet`). */
const RANGE_CHARTS: readonly string[] = ['MR', 'R'];

const rules = z.array(z.number().int().min(1).max(8));

export const qualitySchema = z.strictObject({
  characteristics: z
    .array(
      z.strictObject({
        /** The measurement's `characteristic` on the cycle fact (`leak-rate`). */
        id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case id like leak-rate'),
        name: z.string().min(1),
        equipment: z.string().min(1),
        operation: z.string().min(1),
        /** Readings per X̄-R subgroup (2–10, the sizes `spc-core` has constants for). */
        subgroupSize: z.number().int().min(2).max(10),
        /** Complete subgroups limit version 1 is estimated from. */
        baselineSubgroups: z.number().int().min(1).max(1_000),
        /** Nelson rules enabled per chart, each once, in ascending order. */
        rules: z.strictObject({ I: rules, MR: rules, Xbar: rules, R: rules }),
      }),
    )
    .min(1),
});

export type QualityConfig = z.infer<typeof qualitySchema>;

/** The cross-check of `packing.yaml`: the routing's last operation, a capacity per product. */
export function checkPacking(
  packing: PackingConfig,
  operations: readonly string[],
  products: readonly string[],
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (packing.operation !== operations.at(-1)) {
    issues.push({
      path: 'operation',
      message: `the packing operation must be the routing's last, ${String(operations.at(-1))}`,
    });
  }
  for (const product of products) {
    if (packing.capacity[product] === undefined) {
      issues.push({ path: 'capacity', message: `no carton capacity for product "${product}"` });
    }
  }
  for (const product of Object.keys(packing.capacity)) {
    if (!products.includes(product)) {
      issues.push({ path: `capacity.${product}`, message: `unknown product "${product}"` });
    }
  }
  return issues;
}

/**
 * The cross-check of `quality.yaml`: unique ids, one characteristic per operation, the leak test's
 * operation on a machine that runs it and named as the tester names its measurement (the only
 * measured characteristic), and rules in ascending order, each once, only rule 1 on MR and R.
 */
export function checkQuality(
  quality: QualityConfig,
  measuredOperation: string,
  equipmentOperation: ReadonlyMap<string, string>,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  const operations = new Set<string>();
  quality.characteristics.forEach((characteristic, index) => {
    const path = `characteristics[${String(index)}]`;
    if (ids.has(characteristic.id)) {
      issues.push({ path, message: `duplicate characteristic "${characteristic.id}"` });
    }
    ids.add(characteristic.id);
    if (operations.has(characteristic.operation)) {
      issues.push({
        path: `${path}.operation`,
        message: `a second characteristic of ${characteristic.operation}`,
      });
    }
    operations.add(characteristic.operation);
    if (characteristic.id !== LEAK_TEST_CHARACTERISTIC) {
      issues.push({
        path: `${path}.id`,
        message: `the leak tester's measurement is "${LEAK_TEST_CHARACTERISTIC}", got "${characteristic.id}"`,
      });
    }
    if (characteristic.operation !== measuredOperation) {
      issues.push({
        path: `${path}.operation`,
        message: `only the leak test (${measuredOperation}) is measured, got "${characteristic.operation}"`,
      });
    }
    const operation = equipmentOperation.get(characteristic.equipment);
    if (operation === undefined) {
      issues.push({
        path: `${path}.equipment`,
        message: `unknown machine "${characteristic.equipment}"`,
      });
    } else if (operation !== characteristic.operation) {
      issues.push({
        path: `${path}.equipment`,
        message: `${characteristic.equipment} runs ${operation}, not ${characteristic.operation}`,
      });
    }
    for (const chart of SPC_CHARTS) {
      const list = characteristic.rules[chart];
      if (list.some((rule, i) => i > 0 && rule <= (list[i - 1] ?? 0))) {
        issues.push({
          path: `${path}.rules.${chart}`,
          message: 'rules must be listed in ascending order, each once',
        });
      }
      if (RANGE_CHARTS.includes(chart) && list.some((rule) => rule !== 1)) {
        issues.push({ path: `${path}.rules.${chart}`, message: `only rule 1 applies to ${chart}` });
      }
    }
  });
  return issues;
}
