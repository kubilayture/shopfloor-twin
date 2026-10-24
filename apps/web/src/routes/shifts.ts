import { createRoute } from '@tanstack/react-router';
import { ShiftList } from '../screens/shift-list.tsx';
import { ShiftReport } from '../screens/shift-report.tsx';
import { rootRoute } from './root.tsx';

// Shift reports (#146): the list and one shift's report with its handover notes.

export const shiftListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shifts',
  staticData: { title: 'Shift reports' },
  component: ShiftList,
});

export interface ShiftReportSearch {
  /** The plant epoch of the instance; the newest that has the shift when absent. */
  readonly epoch?: number | undefined;
}

export const shiftReportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shifts/$date/$shift',
  validateSearch: (search: Record<string, unknown>): ShiftReportSearch => {
    const epoch = typeof search.epoch === 'string' ? Number(search.epoch) : search.epoch;
    return {
      epoch:
        typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined,
    };
  },
  staticData: { title: ({ date, shift }) => `Shift report ${date ?? ''} ${shift ?? ''}` },
  component: ShiftReport,
});

export const shiftRoutes = [shiftListRoute, shiftReportRoute] as const;
