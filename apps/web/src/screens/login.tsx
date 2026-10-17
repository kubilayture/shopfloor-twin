import { PASSWORD_LENGTH } from '@shopfloor/contracts/identity';
import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { changePassword, getSession, login } from '../api/identity.ts';
import { useAuth } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { loginFailure, newPasswordProblems, passwordChangeFailure } from '../domain/identity.ts';
import type { LoginReason } from '../routes/identity.ts';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1';
const primaryClass =
  'rounded border border-sky-900 bg-sky-800 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60';

const REASON_TEXT: Readonly<Record<LoginReason, string>> = {
  ended: 'Your session ended. Log in again to carry on.',
  idle: 'You were logged out after a while without use. Log in again to carry on.',
  logout: 'You are logged out.',
};

/**
 * User name and password (#170): `POST /api/v1/session` sets the `HttpOnly` cookie. With
 * `fixedUsername` it logs the same user in again (the re-login over a page with unsaved input).
 */
export function LoginForm({
  fixedUsername,
  onLoggedIn,
}: {
  readonly fixedUsername?: string;
  readonly onLoggedIn: (session: SessionDto, password: string) => void;
}) {
  // A logout still ending at the MES would clear the cookie of this login (#170 review L3).
  const { loggingOut } = useAuth();
  const [username, setUsername] = useState(fixedUsername ?? '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const userId = useId();
  const passwordId = useId();
  const submit = useMutation({
    mutationFn: () => login({ username: username.trim(), password, kind: 'desk' }),
    meta: { auth: false },
    onSuccess: (session) => {
      onLoggedIn(session, password);
      setPassword('');
    },
    onError: (error) => {
      setMessage(loginFailure(error));
    },
  });
  return (
    <form
      noValidate
      aria-label="Log in"
      className="mt-4 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(undefined);
        if (username.trim() === '' || password === '') {
          setMessage('Enter your user name and password.');
          return;
        }
        submit.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={userId} className="text-sm font-medium">
          User name
        </label>
        <input
          id={userId}
          name="username"
          data-testid="login-username"
          value={username}
          readOnly={fixedUsername !== undefined}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
          className={`${inputClass} ${fixedUsername === undefined ? '' : 'bg-slate-100'}`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={passwordId} className="text-sm font-medium">
          Password
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          data-testid="login-password"
          value={password}
          autoComplete="current-password"
          // Only in the re-login dialog, whose name is given: straight to the password.
          autoFocus={fixedUsername !== undefined}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          className={inputClass}
        />
      </div>
      {message ? (
        <p
          role="alert"
          data-testid="login-message"
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          {message}
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="login-submit"
        disabled={submit.isPending || loggingOut}
        className={primaryClass}
      >
        {loggingOut ? 'Logging out…' : submit.isPending ? 'Logging in…' : 'Log in'}
      </button>
    </form>
  );
}

/**
 * A change of one's own password (`POST /api/v1/account/password`): the forced change after a
 * temporary password, and the account page. `current` prefills the current password when the
 * user just typed it to log in.
 */
export function ChangePasswordForm({
  current: known,
  onChanged,
}: {
  readonly current?: string | undefined;
  readonly onChanged: (endedSessions: number) => void;
}) {
  const [current, setCurrent] = useState(known ?? '');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();
  const change = useMutation({
    mutationFn: () => changePassword({ currentPassword: current, newPassword: next }),
    meta: { auth: false },
    onSuccess: (result) => {
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged(result.endedSessions);
    },
    onError: (error) => {
      setFailure(passwordChangeFailure(error).text);
    },
  });
  return (
    <form
      noValidate
      aria-label="Change password"
      className="mt-4 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(undefined);
        const found = [
          ...(current === '' ? ['Enter your current password.'] : []),
          ...newPasswordProblems(next, confirm, current),
        ];
        setProblems(found);
        if (found.length === 0) change.mutate();
      }}
    >
      {known === undefined ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={currentId} className="text-sm font-medium">
            Current password
          </label>
          <input
            id={currentId}
            type="password"
            data-testid="current-password"
            value={current}
            autoComplete="current-password"
            onChange={(event) => {
              setCurrent(event.target.value);
            }}
            className={inputClass}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={nextId} className="text-sm font-medium">
          New password
        </label>
        <input
          id={nextId}
          type="password"
          data-testid="new-password"
          value={next}
          autoComplete="new-password"
          aria-describedby={`${nextId}-hint`}
          onChange={(event) => {
            setNext(event.target.value);
          }}
          className={inputClass}
        />
        <p id={`${nextId}-hint`} className="text-xs text-slate-700">
          {PASSWORD_LENGTH.min} to {PASSWORD_LENGTH.max} characters; a few words you remember are
          fine. No other rules.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={confirmId} className="text-sm font-medium">
          New password again
        </label>
        <input
          id={confirmId}
          type="password"
          data-testid="confirm-password"
          value={confirm}
          autoComplete="new-password"
          onChange={(event) => {
            setConfirm(event.target.value);
          }}
          className={inputClass}
        />
      </div>
      {problems.length > 0 || failure ? (
        <ul
          role="alert"
          data-testid="password-problems"
          className="rounded border border-red-800 bg-red-50 p-2 text-sm text-red-950"
        >
          {[...problems, ...(failure ? [failure] : [])].map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      <button
        type="submit"
        data-testid="change-password"
        disabled={change.isPending}
        className={primaryClass}
      >
        {change.isPending ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

/** Goes on to the page the login was for (a path of this app, `safeRedirect`). */
function BackTo({ href }: { readonly href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.history.replace(href);
  }, [router, href]);
  return <p role="status">Logged in; opening the page…</p>;
}

/**
 * `/login` (#170): the login, then the forced password change of a temporary password, then back
 * to the page the user came from (`redirect`).
 */
export function Login() {
  const auth = useAuth();
  const { redirect, reason } = useSearch({ from: '/login' });
  const heading = useHeadingFocus<HTMLHeadingElement>();
  // The password just typed, so the forced change needn't ask for it again (memory only).
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const { session } = auth;
  const target = redirect ?? '/';

  if (session && !session.user.mustChangePassword) {
    return <BackTo href={target} />;
  }
  const mustChange = session?.user.mustChangePassword === true;
  return (
    <main
      id="main"
      tabIndex={-1}
      className="min-h-screen bg-slate-50 px-4 py-12 text-slate-900 focus:outline-none"
    >
      <div className="mx-auto max-w-md rounded border border-slate-300 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-slate-700">ShopFloor Twin MES</p>
        <h1 ref={heading} tabIndex={-1} className="mt-1 text-2xl font-bold">
          {mustChange ? 'Choose a new password' : 'Log in'}
        </h1>
        {mustChange ? (
          <>
            <p className="mt-2 text-sm" data-testid="must-change">
              {session.user.username}, your password is temporary. Choose your own before you
              continue; it ends your other sessions.
            </p>
            <ChangePasswordForm
              current={typed}
              onChanged={() => {
                setTyped(undefined);
                // The session now needs no change: `BackTo` takes the user on.
                void getSession().then((next) => {
                  if (next) auth.loggedIn(next);
                });
              }}
            />
            <button
              type="button"
              className="mt-4 text-sm text-sky-800 underline"
              onClick={() => {
                setTyped(undefined);
                void auth.logOut();
              }}
            >
              Log out instead
            </button>
          </>
        ) : (
          <>
            {reason ? (
              <p
                role="status"
                data-testid="login-reason"
                data-reason={reason}
                className="mt-2 rounded border border-slate-300 bg-slate-50 p-2 text-sm"
              >
                {REASON_TEXT[reason]}
              </p>
            ) : null}
            <LoginForm
              onLoggedIn={(next, password) => {
                // Without a password to change, `BackTo` takes the user on.
                if (next.user.mustChangePassword) setTyped(password);
                auth.loggedIn(next);
              }}
            />
            <p className="mt-4 text-xs text-slate-700">
              Open the app as <span className="font-mono">localhost</span> every time: the session
              belongs to the host name in the address bar, and{' '}
              <span className="font-mono">127.0.0.1</span> is another one. Ask an admin for an
              account or a new password.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
