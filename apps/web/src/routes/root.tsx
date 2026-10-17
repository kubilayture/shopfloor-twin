import { createRootRoute } from '@tanstack/react-router';
import { AuthProvider } from '../auth/auth.tsx';
import { Shell } from '../auth/shell.tsx';
import { NotFound } from '../screens/root-layout.tsx';

/**
 * The root of every route (ADR-0020, code-based). Identity (#170) wraps it: `/login` is shown
 * alone; every other screen only with a session whose password needs no change, inside the app's
 * layout (header, navigation, live connection).
 */
export const rootRoute = createRootRoute({
  component: () => (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  ),
  notFoundComponent: NotFound,
});
