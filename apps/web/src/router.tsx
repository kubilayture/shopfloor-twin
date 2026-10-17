import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { alarmRoutes } from './routes/alarms.ts';
import { identityRoutes } from './routes/identity.ts';
import { oeeRoutes } from './routes/oee.ts';
import { orderRoutes } from './routes/orders.ts';
import { plantRoutes } from './routes/plant.ts';
import { rootRoute } from './routes/root.tsx';
import { shiftRoutes } from './routes/shifts.ts';
import { terminalRoutes } from './routes/terminal.ts';
import { traceRoutes } from './routes/trace.ts';

export type { AlarmKpiSearch, AlarmSearch } from './routes/alarms.ts';
export type { LoginSearch } from './routes/identity.ts';
export type { DowntimeSearch, OeeSearch } from './routes/oee.ts';
export type { OrderListSearch } from './routes/orders.ts';
export type { DetailSearch } from './routes/plant.ts';
export type { ShiftReportSearch } from './routes/shifts.ts';
export type { SerialSearch, TraceSearchParams } from './routes/trace.ts';

// Code-based routes (ADR-0020), one file per area under routes/ since #170: thirteen routes with
// the orders (#176), fifteen with the terminal (past the "revisit past a dozen"), nineteen with the
// trace pages (#202); a generated tree isn't needed.
const routeTree = rootRoute.addChildren([
  ...plantRoutes,
  ...oeeRoutes,
  ...alarmRoutes,
  ...shiftRoutes,
  ...orderRoutes,
  ...identityRoutes,
  ...terminalRoutes,
  ...traceRoutes,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
