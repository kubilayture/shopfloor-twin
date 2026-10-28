import { PASSWORD_LENGTH } from '@shopfloor/contracts/identity';
import type { SessionDto } from '@shopfloor/contracts/mes-api';
import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError } from '../api/client.ts';
import { changePassword, getSession, login } from '../api/identity.ts';
import { useAuth } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Code } from '../components/ui/code.tsx';
import { controlClass, Field, type FieldIds } from '../components/ui/field.tsx';
import { Icon } from '../components/ui/icons.tsx';
import { PRODUCT_NAME } from '../components/ui/use-page-title.ts';
import {
  loginFailure,
  passwordChangeFailure,
  passwordFormProblems,
  type PasswordField,
  type PasswordProblem,
} from '../domain/identity.ts';
import type { LoginReason } from '../routes/identity.ts';

/** The login shows its form at the latest this long after the read of the session began. */
export const SESSION_CHECK_MAX_MS = 3_000;

const REASON_TEXT: Readonly<Record<LoginReason, string>> = {
  ended: 'Your session ended. Log in again to carry on.',
  idle: 'You were logged out after a while without use. Log in again to carry on.',
  logout: 'You are logged out.',
};

/** The ids a control is described by, without the empty ones; undefined when none is left. */
const joinIds = (...ids: (string | undefined)[]): string | undefined =>
  ids.filter((id) => id !== undefined && id !== '').join(' ') || undefined;

/** Focuses the first of `fields` that is marked invalid, once the render that marks it is done. */
function useFocusFirstInvalid(): (fields: readonly RefObject<HTMLInputElement | null>[]) => void {
  const pending = useRef<readonly RefObject<HTMLInputElement | null>[] | undefined>(undefined);
  useEffect(() => {
    const fields = pending.current;
    if (!fields) return;
    pending.current = undefined;
    fields
      .find((field) => field.current?.getAttribute('aria-invalid') === 'true')
      ?.current?.focus();
  });
  return (fields) => {
    pending.current = fields;
  };
}

type LoginField = 'username' | 'password';

/**
 * User name and password (#170): `POST /api/v1/session` sets the `HttpOnly` cookie. With
 * `fixedUsername` it logs the same user in again (the re-login over a page with unsaved input).
 *
 * A field left empty is marked under itself; a login the MES refuses as wrong (401: it never says
 * which part, ADR-0026) marks both fields invalid and ties them to the message (L-01), while a
 * throttled or unreachable login leaves the fields alone: they are not what is wrong. The focus
 * goes to the first field marked.
 */
export function LoginForm({
  fixedUsername,
  onLoggedIn,
  className,
}: {
  readonly fixedUsername?: string;
  readonly onLoggedIn: (session: SessionDto, password: string) => void;
  /** Layout classes (margins) for where the form sits. */
  readonly className?: string;
}) {
  // A logout still ending at the MES would clear the cookie of this login (#170 review L3).
  const { loggingOut } = useAuth();
  const [username, setUsername] = useState(fixedUsername ?? '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState<readonly LoginField[]>([]);
  const [refused, setRefused] = useState(false);
  const messageId = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const focusFirstInvalid = useFocusFirstInvalid();
  const submit = useMutation({
    mutationFn: () => login({ username: username.trim(), password, kind: 'desk' }),
    meta: { auth: false },
    onSuccess: (session) => {
      onLoggedIn(session, password);
      setPassword('');
    },
    onError: (error) => {
      // 401 is the MES's one answer for a wrong name or password, a locked or a disabled account.
      const wrong = error instanceof ApiError && error.status === 401;
      setRefused(wrong);
      setMessage(loginFailure(error));
      if (wrong) focusFirstInvalid([usernameRef, passwordRef]);
    },
  });
  const busy = submit.isPending || loggingOut;
  const fixed = fixedUsername !== undefined;
  /** A field's own error text: only for a field left empty (a refusal is said once, above). */
  const fieldError = (field: LoginField): string | undefined =>
    missing.includes(field)
      ? field === 'username'
        ? 'Enter your user name.'
        : 'Enter your password.'
      : undefined;
  return (
    <form
      noValidate
      aria-label="Log in"
      className={`flex flex-col gap-4${className ? ` ${className}` : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setMessage(undefined);
        setRefused(false);
        const empty: LoginField[] = [
          ...(username.trim() === '' ? (['username'] as const) : []),
          ...(password === '' ? (['password'] as const) : []),
        ];
        setMissing(empty);
        if (empty.length > 0) {
          setMessage(
            empty.length === 2
              ? 'Enter your user name and password.'
              : empty[0] === 'username'
                ? 'Enter your user name.'
                : 'Enter your password.',
          );
          focusFirstInvalid([usernameRef, passwordRef]);
          return;
        }
        submit.mutate();
      }}
    >
      {message ? (
        <Callout tone="alarm" role="alert" data-testid="login-message">
          <span id={messageId}>{message}</span>
        </Callout>
      ) : null}
      <Field label="User name" error={fieldError('username')}>
        {(ids) => {
          // The name of a re-login is given: never marked as wrong.
          const invalid = ids.invalid || (refused && !fixed);
          return (
            <input
              ref={usernameRef}
              id={ids.id}
              name="username"
              data-testid="login-username"
              value={username}
              readOnly={fixed}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={joinIds(ids.describedBy, refused && !fixed ? messageId : undefined)}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              className={`${controlClass({ size: 'lg' })} w-full read-only:bg-surface-sunken`}
            />
          );
        }}
      </Field>
      <Field label="Password" error={fieldError('password')}>
        {(ids) => (
          <input
            ref={passwordRef}
            id={ids.id}
            name="password"
            type="password"
            data-testid="login-password"
            value={password}
            autoComplete="current-password"
            // Only in the re-login dialog, whose name is given: straight to the password.
            autoFocus={fixed}
            aria-invalid={ids.invalid || refused || undefined}
            aria-describedby={joinIds(ids.describedBy, refused ? messageId : undefined)}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={`${controlClass({ size: 'lg' })} w-full`}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        data-testid="login-submit"
        loading={busy}
      >
        {loggingOut ? 'Logging out…' : 'Log in'}
      </Button>
    </form>
  );
}

/** The password inputs of the change form: one look, `type="password"`, the field's ids. */
function PasswordInput({
  inputRef,
  testId,
  autoComplete,
  value,
  onChange,
  ids,
  name,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly testId: string;
  readonly autoComplete: 'current-password' | 'new-password';
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ids: FieldIds;
  readonly name: string;
}) {
  return (
    <input
      ref={inputRef}
      id={ids.id}
      name={name}
      type="password"
      data-testid={testId}
      value={value}
      autoComplete={autoComplete}
      aria-invalid={ids.invalid || undefined}
      aria-describedby={ids.describedBy}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={`${controlClass({ size: 'lg' })} w-full`}
    />
  );
}

/**
 * A change of one's own password (`POST /api/v1/account/password`): the forced change after a
 * temporary password, and the account page. `current` prefills the current password when the
 * user just typed it to log in. The requirement is shown under the new password before anything
 * is typed; each problem found before sending is shown under its field and listed once in the
 * form's alert, and the focus goes to the first field with one.
 */
export function ChangePasswordForm({
  current: known,
  username,
  onChanged,
}: {
  readonly current?: string | undefined;
  /**
   * Whose password it is: a hidden read-only `autocomplete="username"` field, so a password manager
   * saves the new password under the right account (the form shows no user name field).
   */
  readonly username?: string | undefined;
  readonly onChanged: (endedSessions: number) => void;
}) {
  const [current, setCurrent] = useState(known ?? '');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<readonly PasswordProblem[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const focusFirstInvalid = useFocusFirstInvalid();
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
  /** The first problem of a field, shown under it; the alert lists them all. */
  const errorOf = (field: PasswordField): string | undefined =>
    problems.find((problem) => problem.field === field)?.text;
  const listed = [...problems.map((problem) => problem.text), ...(failure ? [failure] : [])];
  return (
    <form
      noValidate
      aria-label="Change password"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (change.isPending) return;
        setFailure(undefined);
        const found = passwordFormProblems(next, confirm, current);
        setProblems(found);
        if (found.length === 0) change.mutate();
        else focusFirstInvalid([currentRef, nextRef, confirmRef]);
      }}
    >
      {listed.length > 0 ? (
        <Callout tone="alarm" role="alert" data-testid="password-problems">
          <ul className="flex flex-col gap-1">
            {listed.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {username === undefined ? null : (
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={username}
          readOnly
          hidden
          data-testid="password-username"
        />
      )}
      {known === undefined ? (
        <Field label="Current password" error={errorOf('current')}>
          {(ids) => (
            <PasswordInput
              inputRef={currentRef}
              ids={ids}
              name="current-password"
              testId="current-password"
              autoComplete="current-password"
              value={current}
              onChange={setCurrent}
            />
          )}
        </Field>
      ) : null}
      <Field
        label="New password"
        hint={`${String(PASSWORD_LENGTH.min)} to ${String(PASSWORD_LENGTH.max)} characters; a few words you remember are fine. No other rules.`}
        error={errorOf('next')}
      >
        {(ids) => (
          <PasswordInput
            inputRef={nextRef}
            ids={ids}
            name="new-password"
            testId="new-password"
            autoComplete="new-password"
            value={next}
            onChange={setNext}
          />
        )}
      </Field>
      <Field label="New password again" error={errorOf('confirm')}>
        {(ids) => (
          <PasswordInput
            inputRef={confirmRef}
            ids={ids}
            name="confirm-password"
            testId="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          data-testid="change-password"
          loading={change.isPending}
        >
          Change password
        </Button>
      </div>
    </form>
  );
}

/**
 * The login page's card on the canvas (design system 3.2): the product name in a header band
 * that is the app's top bar in small (L-03), then the page's heading and content, and an optional
 * footer of small print.
 */
function LoginCard({
  heading,
  footer,
  busy = false,
  children,
}: {
  readonly heading?: ReactNode;
  readonly footer?: ReactNode;
  /** The card waits on something (`aria-busy` on `main`). */
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  const headingRef = useHeadingFocus<HTMLHeadingElement>();
  // The same card turns into the next step (the forced change after the login): its new
  // heading takes the focus, so the step is announced and the keyboard starts there.
  const shown = useRef(heading);
  useEffect(() => {
    if (shown.current === heading) return;
    shown.current = heading;
    headingRef.current?.focus();
  }, [heading, headingRef]);
  return (
    <main
      id="main"
      tabIndex={-1}
      aria-busy={busy || undefined}
      className="min-h-screen bg-canvas px-4 py-12 text-ink md:py-20"
    >
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-line bg-surface">
        <div className="bg-topbar px-6 py-4 text-topbar-ink" data-surface="dark">
          <p className="text-base font-semibold">{PRODUCT_NAME}</p>
          <p className="text-xs text-nav-heading">Manufacturing execution system</p>
        </div>
        <div className="flex flex-col gap-4 p-6">
          {heading === undefined ? null : (
            <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
              {heading}
            </h1>
          )}
          {children}
        </div>
        {footer === undefined ? null : (
          <div className="border-t border-line-subtle bg-surface-sunken px-6 py-4 text-xs text-ink-secondary">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

/** Goes on to the page the login was for (a path of this app, `safeRedirect`). */
function BackTo({ href }: { readonly href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.history.replace(href);
  }, [router, href]);
  return (
    <LoginCard>
      <p role="status" className="flex items-center gap-2 text-sm text-ink-secondary">
        <Icon name="spinner" size={16} className="motion-safe:animate-spin" />
        Logged in; opening the page…
      </p>
    </LoginCard>
  );
}

/**
 * `/login` (#170): the login, then the forced password change of a temporary password, then back
 * to the page the user came from (`redirect`).
 */
export function Login() {
  const auth = useAuth();
  const { redirect, reason } = useSearch({ from: '/login' });
  // The password just typed, so the forced change needn't ask for it again (memory only).
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const { session } = auth;
  const target = redirect ?? '/';
  // A MES that never answers the read: the form after `SESSION_CHECK_MAX_MS` all the same.
  const reading = session === undefined;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => {
      setWaited(true);
    }, SESSION_CHECK_MAX_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [reading]);

  if (session && !session.user.mustChangePassword) {
    return <BackTo href={target} />;
  }
  // While the session is read, no form: a session found takes the page on (`BackTo`) and would
  // drop what was typed (#390). A read that failed once (the MES unreachable or 5xx, before any
  // retry) or takes too long shows the form; the login then says what is wrong.
  if (reading && !auth.readFailed && !waited) {
    return (
      <LoginCard busy>
        <p role="status" className="flex items-center gap-2 text-sm text-ink-secondary">
          <Icon name="spinner" size={16} className="motion-safe:animate-spin" />
          Checking your session…
        </p>
      </LoginCard>
    );
  }
  if (session?.user.mustChangePassword === true) {
    return (
      <LoginCard
        heading="Choose a new password"
        footer={
          <Button
            variant="ghost"
            size="sm"
            // The label on the card's text edge: the ghost button's own padding to the left.
            className="-ml-2.5"
            onClick={() => {
              setTyped(undefined);
              void auth.logOut();
            }}
          >
            Log out instead
          </Button>
        }
      >
        <p className="text-sm text-ink-secondary" data-testid="must-change">
          <span className="font-semibold text-ink">{session.user.username}</span>, your password is
          temporary. Choose your own before you continue; it ends your other sessions.
        </p>
        <ChangePasswordForm
          current={typed}
          username={session.user.username}
          onChanged={() => {
            setTyped(undefined);
            // The session now needs no change: `BackTo` takes the user on.
            void getSession().then((next) => {
              if (next) auth.loggedIn(next);
            });
          }}
        />
      </LoginCard>
    );
  }
  return (
    <LoginCard
      heading="Log in"
      footer={
        <>
          <p>No account, or a forgotten password? Ask an admin.</p>
          <p className="mt-1">
            Use the same address every time (<Code>localhost</Code> is not <Code>127.0.0.1</Code>):
            the session belongs to the host name.
          </p>
        </>
      }
    >
      {reason ? (
        <Callout tone="neutral" role="status" data-testid="login-reason" data-reason={reason}>
          {REASON_TEXT[reason]}
        </Callout>
      ) : null}
      <LoginForm
        onLoggedIn={(next, password) => {
          // Without a password to change, `BackTo` takes the user on.
          if (next.user.mustChangePassword) setTyped(password);
          auth.loggedIn(next);
        }}
      />
    </LoginCard>
  );
}
