import type { ShiftRecordDto } from '@shopfloor/contracts/mes-api';
import { Badge } from './ui/badge.tsx';

/**
 * Where a shift is (S-01): Running, or Ended once the plant clock has passed it. Whether its report
 * may still change is the finality badge beside it, so a final shift never reads "Final Final".
 * Neutral: neither is abnormal. `data-status` carries the raw status.
 */
export function ShiftStateBadge({ status }: { readonly status: ShiftRecordDto['status'] }) {
  return (
    <Badge tone="neutral" variant="outline" data-status={status}>
      {status === 'running' ? 'Running' : 'Ended'}
    </Badge>
  );
}
