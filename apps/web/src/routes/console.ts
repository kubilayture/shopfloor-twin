import { createRoute } from '@tanstack/react-router';
import { Console } from '../screens/console.tsx';
import { rootRoute } from './root.tsx';

// The simulation console (#237, Phase 9 plan "Simulation console"): admin only (`sim:control`).

export const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console',
  component: Console,
});

export const consoleRoutes = [consoleRoute] as const;
