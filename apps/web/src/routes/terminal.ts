import { createRoute } from '@tanstack/react-router';
import { TerminalPicker, TerminalScreen } from '../screens/terminal.tsx';
import { rootRoute } from './root.tsx';

// The operator terminal (#177): the work center picker inside the app, and the tablet screen of a
// work center, which the shell shows on its own (it signs operators on itself).

export const terminalPickerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal',
  component: TerminalPicker,
});

export const terminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terminal/$workCenter',
  component: TerminalScreen,
});

export const terminalRoutes = [terminalPickerRoute, terminalRoute] as const;
