import type { BomItem, ErpOrder } from '@shopfloor/contracts/erp-api';
import type { Routing } from '../master-data/index.ts';

const bomKey = (item: BomItem): string =>
  `${item.material}@${item.operation}x${String(item.quantityPerUnit)}/${item.usage}`;

/**
 * Why the MES refuses an ERP order version at import (#174, plan "Import"), or undefined when it
 * is valid: an unknown product, or a routing (operations and work centers, in order) or BOM
 * (as a set of material, operation, quantity per unit and usage) that differs from master data.
 */
export function validateErpOrder(
  order: ErpOrder,
  routing: Routing | undefined,
): string | undefined {
  if (routing === undefined || routing.operations.length === 0) {
    return `unknown product ${order.product} (no routing in master data)`;
  }
  const operations = order.routing.map((step) => step.operation);
  const repeated = operations.filter((op, i) => operations.indexOf(op) !== i);
  if (repeated.length > 0) {
    return `routing repeats ${[...new Set(repeated)].join(', ')}`;
  }
  const expected = routing.operations.map((op) => `${op.operation}@${op.workCenter}`);
  const got = order.routing.map((step) => `${step.operation}@${step.workCenter}`);
  if (expected.join(',') !== got.join(',')) {
    return `routing differs from master data: expected ${expected.join(', ')}; got ${got.length === 0 ? 'none' : got.join(', ')}`;
  }
  const want = routing.bom.map(bomKey).sort();
  const have = order.bom.map(bomKey).sort();
  if (want.join(',') !== have.join(',')) {
    const missing = want.filter((key) => !have.includes(key));
    const extra = have.filter((key) => !want.includes(key));
    return `BOM differs from master data: missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`;
  }
  return undefined;
}
