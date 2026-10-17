import { createRoute } from '@tanstack/react-router';
import { safeRedirect } from '../auth/redirect.ts';
import { Account } from '../screens/account.tsx';
import { Login } from '../screens/login.tsx';
import { Users } from '../screens/users.tsx';
import { rootRoute } from './root.tsx';

// Identity (#170, ADR-0026): the login with its forced password change, the account and the user
// administration.

export const LOGIN_REASONS = ['ended', 'idle', 'logout'] as const;
export type LoginReason = (typeof LOGIN_REASONS)[number];

export interface LoginSearch {
  /** Where to go after the login: a path of this app (never another origin). */
  readonly redirect?: string | undefined;
  /** Why the login is shown: the session ended, timed out here, or the user logged out. */
  readonly reason?: LoginReason | undefined;
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: safeRedirect(search.redirect),
    reason: (LOGIN_REASONS as readonly unknown[]).includes(search.reason)
      ? (search.reason as LoginReason)
      : undefined,
  }),
  component: Login,
});

export const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: Account,
});

export const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  component: Users,
});

export const identityRoutes = [loginRoute, accountRoute, usersRoute] as const;
