import { SESSION_IDLE_MS } from '@shopfloor/contracts/identity';
import { useState } from 'react';
import { useAuth } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { rolesText } from '../domain/identity.ts';
import { ChangePasswordForm } from './login.tsx';

const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';

const wallTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** `/account` (#170): who is logged in, with which roles and permissions, the password, logout. */
export function Account() {
  const auth = useAuth();
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const [changed, setChanged] = useState<string | undefined>(undefined);
  const { session } = auth;
  if (!session) return null;
  const { user } = session;
  return (
    <section aria-labelledby="account-title" className="max-w-2xl">
      <h1 id="account-title" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Account
      </h1>
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="font-medium">User name</dt>
        <dd data-testid="account-username">{user.username}</dd>
        <dt className="font-medium">Roles</dt>
        <dd data-testid="account-roles">{rolesText(user.roles)}</dd>
        <dt className="font-medium">May</dt>
        <dd data-testid="account-permissions" className="font-mono text-xs">
          {user.permissions.join(', ')}
        </dd>
        <dt className="font-medium">Logged in</dt>
        <dd>{wallTime(session.createdAt)}</dd>
        <dt className="font-medium">Session ends</dt>
        <dd>
          after {SESSION_IDLE_MS[session.kind] / 60_000} minutes without use, at the latest{' '}
          {wallTime(session.expiresAt)} (wall time)
        </dd>
      </dl>
      <button
        type="button"
        data-testid="account-logout"
        className={`${buttonClass} mt-4`}
        onClick={() => {
          void auth.logOut();
        }}
      >
        Log out
      </button>

      <h2 className="mt-8 text-lg font-semibold">Change password</h2>
      <p className="text-sm text-slate-700">Your other sessions (other browsers) end with it.</p>
      {changed ? (
        <p
          role="status"
          data-testid="password-changed"
          className="mt-2 rounded border border-emerald-800 bg-emerald-50 p-2 text-sm text-emerald-950"
        >
          {changed}
        </p>
      ) : null}
      <ChangePasswordForm
        onChanged={(ended) => {
          setChanged(
            `Password changed.${ended > 0 ? ` ${String(ended)} other session${ended === 1 ? '' : 's'} ended.` : ''}`,
          );
        }}
      />
    </section>
  );
}
