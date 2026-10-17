/**
 * Scrap reason codes (#175, Phase 7 plan "Scrap records"): `config/plant/scrap.yaml` holds the
 * tree an operator or quality user codes a scrap record with. The machines scrap with a coarse
 * reason (`DIMENSIONAL` at OP10, `LEAK` at the second failed leak test); each is a top-level node
 * of the tree, and a coding names that node or one below it. Coding never changes a quantity.
 *
 * Its own file, not a section of `reasons.yaml`: `reasons.yaml` is hashed into every golden
 * summary's `analysisConfigSha256`, and scrap codes shape no analysis the simulator computes.
 */
import { z } from 'zod';
import { parentReason } from './reasons.ts';

/** The reasons the machines scrap with (the cycle facts' `reason`); each must be a top node. */
export const MACHINE_SCRAP_REASONS = ['DIMENSIONAL', 'LEAK'] as const;

const segment = '[A-Z0-9]+(-[A-Z0-9]+)*';
const scrapId = z
  .string()
  .regex(new RegExp(`^${segment}(/${segment})*$`), 'upper-case code path like LEAK/POROSITY');

export const scrapSchema = z.strictObject({
  reasons: z.array(z.strictObject({ id: scrapId, name: z.string().min(1) })).min(1),
});

export type ScrapConfig = z.infer<typeof scrapSchema>;

/** The top-level node of a scrap reason: `LEAK` for `LEAK/POROSITY`. */
export const scrapRoot = (id: string): string => id.split('/')[0] ?? id;

/**
 * The cross-check of `scrap.yaml`: unique ids, parents listed before their children, and every
 * machine scrap reason a top-level node.
 */
export function checkScrap(scrap: ScrapConfig): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const known = new Set<string>();
  scrap.reasons.forEach((reason, index) => {
    const path = `reasons[${String(index)}]`;
    if (known.has(reason.id)) issues.push({ path, message: `duplicate reason "${reason.id}"` });
    const parent = parentReason(reason.id);
    if (parent !== null && !known.has(parent)) {
      issues.push({ path, message: `parent "${parent}" must be listed before "${reason.id}"` });
    }
    known.add(reason.id);
  });
  for (const machine of MACHINE_SCRAP_REASONS) {
    if (!known.has(machine)) {
      issues.push({
        path: 'reasons',
        message: `the machine scrap reason "${machine}" must be a node of the tree`,
      });
    }
  }
  return issues;
}
