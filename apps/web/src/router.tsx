import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { alarmRoutes } from './routes/alarms.ts';
import { identityRoutes } from './routes/identity.ts';
import { oeeRoutes } from './routes/oee.ts';
import { plantRoutes } from './routes/plant.ts';
import { rootRoute } from './routes/root.tsx';
import { shiftRoutes } from './routes/shifts.ts';
import { terminalRoutes } from './routes/terminal.ts';

export type { AlarmKpiSearch, AlarmSearch } from './routes/alarms.ts';
export type { LoginSearch } from './routes/identity.ts';
export type { DowntimeSearch, OeeSearch } from './routes/oee.ts';
export type { DetailSearch } from './routes/plant.ts';
export type { ShiftReportSearch } from './routes/shifts.ts';

// Code-based routes (ADR-0020), one file per area under routes/ since #170: eleven routes now,
// fifteen with Phase 7's screens (past the "revisit past a dozen"); a generated tree isn't needed.
const routeTree = rootRoute.addChildren([
  ...plantRoutes,
  ...oeeRoutes,
  ...alarmRoutes,
  ...shiftRoutes,
  ...identityRoutes,
  ...terminalRoutes,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, ...(history ? { history } : {}), defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
