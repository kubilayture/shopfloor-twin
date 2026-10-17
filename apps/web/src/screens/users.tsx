import { ROLES, type Role } from '@shopfloor/contracts/identity';
import type { UserDto } from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { createUser, getUsers, resetPassword, updateUser } from '../api/identity.ts';
import { useAuth, useCan, useUnsavedDraft } from '../auth/auth.tsx';
import { useHeadingFocus } from '../components/heading-focus.ts';
import { QueryError } from '../components/query-error.tsx';
import {
  ROLE_LABELS,
  rolesText,
  temporaryPassword,
  userWriteFailure,
  validUsername,
} from '../domain/identity.ts';
import type { WriteFailure } from '../domain/writes.ts';

const inputClass = 'rounded border border-slate-500 bg-white px-2 py-1 text-sm';
const buttonClass =
  'rounded border border-slate-700 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-60';
const primaryClass =
  'rounded border border-sky-900 bg-sky-800 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60';

const usersKey = ['users'] as const;

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

function MessageLine({ message, testId }: { readonly message: Message; readonly testId: string }) {
  return (
    <p
      role={message.kind === 'saved' ? 'status' : 'alert'}
      data-testid={testId}
      data-kind={message.kind}
      className={`rounded border p-2 text-sm ${
        message.kind === 'saved'
          ? 'border-emerald-800 bg-emerald-50 text-emerald-950'
          : 'border-red-800 bg-red-50 text-red-950'
      }`}
    >
      {message.text}
    </p>
  );
}

/** One checkbox per role; at least one must stay checked (the MES refuses none, 400). */
function RolePicker({
  value,
  onChange,
  name,
}: {
  readonly value: readonly Role[];
  readonly onChange: (roles: Role[]) => void;
  readonly name: string;
}) {
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
      <legend className="text-sm font-medium">Roles</legend>
      {ROLES.map((role) => (
        <label key={role} className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            data-testid={`${name}-role-${role}`}
            checked={value.includes(role)}
            onChange={(event) => {
              onChange(
                ROLES.filter((r) => (r === role ? event.target.checked : value.includes(r))),
              );
            }}
          />
          {ROLE_LABELS[role]}
        </label>
      ))}
    </fieldset>
  );
}

/** How long a temporary password stays on the screen at most (#170 review L2). */
export const HANDOVER_SHOWN_MS = 2 * 60_000;

interface Handover {
  readonly username: string;
  readonly password: string;
}

/**
 * The temporary password just set, shown until the admin hides it, for at most
 * `HANDOVER_SHOWN_MS`, and never once the session is lost (a covered page keeps its state).
 */
function useHandover(): [Handover | undefined, (next: Handover | undefined) => void] {
  // Tied to the session it was shown in: after a lost session and a re-login it stays hidden.
  const [handover, setHandover] = useState<(Handover & { session: string }) | undefined>(undefined);
  const { session } = useAuth();
  const current = session?.createdAt;
  const shown = handover && handover.session === current ? handover : undefined;
  useEffect(() => {
    if (!handover) return undefined;
    const timer = setTimeout(() => {
      setHandover(undefined);
    }, HANDOVER_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [handover]);
  const show = (next: Handover | undefined) => {
    setHandover(next && current ? { ...next, session: current } : undefined);
  };
  return [shown, show];
}

/** The temporary password of a create or a reset: shown once, for the admin to hand over. */
function TemporaryPassword({
  handover: { username, password },
  onDone,
}: {
  readonly handover: Handover;
  readonly onDone: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="temporary-password"
      className="flex flex-wrap items-center gap-2 rounded border border-amber-700 bg-amber-50 p-2 text-sm"
    >
      <p>
        Temporary password of <span className="font-semibold">{username}</span>:{' '}
        <span className="select-all font-mono font-semibold" data-testid="temporary-password-value">
          {password}
        </span>
        . Hand it over in person; it is shown only now, for two minutes at most. {username} must
        choose a new one at the first login.
      </p>
      <button
        type="button"
        data-testid="hide-temporary-password"
        className={buttonClass}
        onClick={onDone}
      >
        Done, hide it
      </button>
    </div>
  );
}

function CreateUser() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [roles, setRoles] = useState<Role[]>(['operator']);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [handover, setHandover] = useHandover();
  const nameId = useId();
  useUnsavedDraft(username.trim() !== '');
  const create = useMutation({
    mutationFn: (password: string) => createUser({ username: username.trim(), roles, password }),
    onSuccess: (user, password) => {
      setHandover({ username: user.username, password });
      setMessage({ kind: 'saved', text: `Created ${user.username} (${rolesText(user.roles)}).` });
      setUsername('');
      setRoles(['operator']);
      void queryClient.invalidateQueries({ queryKey: usersKey });
    },
    onError: (error) => {
      setMessage(userWriteFailure(error));
    },
  });
  return (
    <form
      noValidate
      aria-label="New user"
      className="mt-3 flex flex-col gap-3 rounded border border-slate-300 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(undefined);
        setHandover(undefined);
        const name = username.trim();
        if (!validUsername(name)) {
          setMessage({
            kind: 'invalid',
            text: 'Not saved: a user name has 2–64 characters: lower-case letters, digits, “.”, “_” and “-”, starting with a letter or digit.',
          });
          return;
        }
        if (roles.length === 0) {
          setMessage({ kind: 'invalid', text: 'Not saved: give the user at least one role.' });
          return;
        }
        create.mutate(temporaryPassword());
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium">
          User name
        </label>
        <input
          id={nameId}
          data-testid="new-username"
          value={username}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
          className={`${inputClass} max-w-xs`}
        />
      </div>
      <RolePicker value={roles} onChange={setRoles} name="new" />
      <p className="text-xs text-slate-700">
        A temporary password is generated and shown once; the user chooses a new one at the first
        login.
      </p>
      {message ? <MessageLine message={message} testId="create-message" /> : null}
      {handover ? (
        <TemporaryPassword
          handover={handover}
          onDone={() => {
            setHandover(undefined);
          }}
        />
      ) : null}
      <div>
        <button
          type="submit"
          data-testid="create-user"
          disabled={create.isPending}
          className={primaryClass}
        >
          Create user
        </button>
      </div>
    </form>
  );
}

function UserRow({ user, self }: { readonly user: UserDto; readonly self: boolean }) {
  const queryClient = useQueryClient();
  // The roles being edited; none while they equal what the MES holds.
  const [draft, setDraft] = useState<Role[] | undefined>(undefined);
  const roles = draft ?? [...user.roles];
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [handover, setHandover] = useHandover();
  const changedRoles =
    roles.length !== user.roles.length || roles.some((role) => !user.roles.includes(role));
  useUnsavedDraft(changedRoles);
  const done = (text: string) => {
    setMessage({ kind: 'saved', text });
    void queryClient.invalidateQueries({ queryKey: usersKey });
  };
  const update = useMutation({
    mutationFn: (body: { roles?: Role[]; enabled?: boolean }) => updateUser(user.username, body),
    onSuccess: (next, body) => {
      if (body.roles !== undefined) setDraft(undefined);
      done(
        body.enabled === undefined
          ? `Roles of ${next.username}: ${rolesText(next.roles)}.`
          : next.enabled
            ? `${next.username} may log in again.`
            : `${next.username} is disabled; their sessions ended.`,
      );
    },
    onError: (error) => {
      setMessage(userWriteFailure(error));
    },
  });
  const reset = useMutation({
    mutationFn: (password: string) => resetPassword(user.username, password),
    onSuccess: (next, password) => {
      setHandover({ username: next.username, password });
      done(`New temporary password for ${next.username}; their sessions ended.`);
    },
    onError: (error) => {
      setMessage(userWriteFailure(error));
    },
  });
  const busy = update.isPending || reset.isPending;
  return (
    <li
      data-testid={`user-${user.username}`}
      data-enabled={user.enabled}
      className="rounded border border-slate-300 bg-white p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <span className="font-semibold">{user.username}</span>
          {self ? <span className="text-sm text-slate-700"> (you)</span> : null}
          <span className="ml-2 text-sm" data-testid={`user-roles-${user.username}`}>
            {rolesText(user.roles)}
          </span>
        </p>
        <p className="flex flex-wrap gap-2 text-xs">
          {user.enabled ? null : (
            <span className="rounded bg-slate-700 px-1.5 py-0.5 text-white">Disabled</span>
          )}
          {user.locked ? (
            <span className="rounded bg-red-800 px-1.5 py-0.5 text-white">Locked</span>
          ) : null}
          {user.mustChangePassword ? (
            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-amber-950">
              Temporary password
            </span>
          ) : null}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-4">
        <RolePicker value={roles} onChange={setDraft} name={user.username} />
        <button
          type="button"
          data-testid={`save-roles-${user.username}`}
          disabled={busy || !changedRoles || roles.length === 0}
          className={buttonClass}
          onClick={() => {
            setMessage(undefined);
            update.mutate({ roles });
          }}
        >
          Save roles
        </button>
        <button
          type="button"
          data-testid={`toggle-enabled-${user.username}`}
          disabled={busy}
          className={buttonClass}
          onClick={() => {
            setMessage(undefined);
            update.mutate({ enabled: !user.enabled });
          }}
        >
          {user.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          data-testid={`reset-password-${user.username}`}
          disabled={busy}
          className={buttonClass}
          onClick={() => {
            setMessage(undefined);
            setHandover(undefined);
            reset.mutate(temporaryPassword());
          }}
        >
          Reset password
        </button>
      </div>
      {message ? (
        <div className="mt-2">
          <MessageLine message={message} testId={`user-message-${user.username}`} />
        </div>
      ) : null}
      {handover ? (
        <div className="mt-2">
          <TemporaryPassword
            handover={handover}
            onDone={() => {
              setHandover(undefined);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

/** `/admin/users` (#170, `user:admin` only): create users, change roles, disable, reset. */
export function Users() {
  const heading = useHeadingFocus<HTMLHeadingElement>();
  const allowed = useCan('user:admin');
  const { session } = useAuth();
  const users = useQuery({
    queryKey: usersKey,
    queryFn: ({ signal }) => getUsers(signal),
    enabled: allowed,
  });
  return (
    <section aria-labelledby="users-title">
      <h1 id="users-title" ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Users
      </h1>
      {!allowed ? (
        <p role="alert" data-testid="users-forbidden" className="mt-3">
          Only an admin manages users (permission <span className="font-mono">user:admin</span>).
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-700">
            Admins manage users and nothing else; someone who also works in the plant gets a second
            role. Disabling a user or resetting the password ends their sessions at once.
          </p>
          <h2 className="mt-6 text-lg font-semibold">New user</h2>
          <CreateUser />
          <h2 className="mt-6 text-lg font-semibold">All users</h2>
          {users.isError ? (
            <QueryError what="the users" error={users.error} onRetry={() => void users.refetch()} />
          ) : users.data === undefined ? (
            <p role="status">Loading the users…</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2" data-testid="user-list">
              {users.data.users.map((user) => (
                <UserRow
                  key={user.username}
                  user={user}
                  self={user.username === session?.user.username}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
