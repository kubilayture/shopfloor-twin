import { ROLES, type Role } from '@shopfloor/contracts/identity';
import type { UserDto } from '@shopfloor/contracts/mes-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { createUser, getUsers, resetPassword, updateUser } from '../api/identity.ts';
import { useAuth, useCan, useUnsavedDraft } from '../auth/auth.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Checkbox, ChoiceGroup, TextInput } from '../components/ui/controls.tsx';
import { DataTable, type Column } from '../components/ui/data-table.tsx';
import { ConfirmDialog } from '../components/ui/dialog.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { QueryError } from '../components/query-error.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { Forbidden } from '../components/ui/not-found.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { Section } from '../components/ui/section.tsx';
import {
  ROLE_LABELS,
  rolesText,
  temporaryPassword,
  userWriteFailure,
  validUsername,
} from '../domain/identity.ts';
import type { WriteFailure } from '../domain/writes.ts';

// User administration (#170, `user:admin`), on the design system (UX-10, #334): a `PageHeader`,
// the new-user form in a card, every user in one `DataTable` row with the roles as checkboxes in
// one column (U-01), and Disable and Reset password as `danger` buttons that ask first in a
// `ConfirmDialog` (U-02, G-11, design system 4.9). The temporary password is still shown once.

const usersKey = ['users'] as const;

type Message = WriteFailure | { readonly kind: 'saved'; readonly text: string };

/** A write's result: an `ok` callout (polite) when saved, an `alarm` one (announced) when not. */
function MessageLine({
  message,
  testId,
  quiet = false,
}: {
  readonly message: Message;
  readonly testId: string;
  /** Not announced: a confirmation dialog in front of it says the same (its own alert). */
  readonly quiet?: boolean;
}) {
  return (
    <Callout
      tone={message.kind === 'saved' ? 'ok' : 'alarm'}
      {...(quiet ? {} : { role: message.kind === 'saved' ? 'status' : 'alert' })}
      data-testid={testId}
      data-kind={message.kind}
    >
      {message.text}
    </Callout>
  );
}

/** One checkbox per role; at least one must stay checked (the MES refuses none, 400). */
function RolePicker({
  value,
  onChange,
  name,
  legend,
  legendHidden = false,
  error,
}: {
  readonly value: readonly Role[];
  readonly onChange: (roles: Role[]) => void;
  readonly name: string;
  readonly legend: ReactNode;
  readonly legendHidden?: boolean;
  readonly error?: string | undefined;
}) {
  return (
    <ChoiceGroup legend={legend} legendHidden={legendHidden} inline error={error}>
      {ROLES.map((role) => (
        <Checkbox
          key={role}
          label={ROLE_LABELS[role]}
          name={`${name}-roles`}
          value={role}
          data-testid={`${name}-role-${role}`}
          checked={value.includes(role)}
          onChange={(event) => {
            onChange(ROLES.filter((r) => (r === role ? event.target.checked : value.includes(r))));
          }}
        />
      ))}
    </ChoiceGroup>
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

/**
 * The mutation that set a temporary password holds it in its variables (review of PR #186): once
 * the password is hidden (Done, the timer, the session), the mutation is reset and forgets it.
 */
function useForgetPassword(
  handover: Handover | undefined,
  mutation: { readonly isSuccess: boolean; readonly reset: () => void },
): void {
  const { isSuccess, reset } = mutation;
  useEffect(() => {
    if (!handover && isSuccess) reset();
  }, [handover, isSuccess, reset]);
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
      className="flex flex-col gap-3 rounded-md border border-warn-border bg-warn-soft p-3 text-sm text-warn-ink sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0">
        Temporary password of <span className="font-semibold">{username}</span>:{' '}
        <span
          className="font-mono font-semibold break-all select-all"
          data-testid="temporary-password-value"
        >
          {password}
        </span>
        . Hand it over in person; it is shown only now, for two minutes at most. {username} must
        choose a new one at the first login.
      </p>
      <Button size="sm" data-testid="hide-temporary-password" onClick={onDone} className="shrink-0">
        Done, hide it
      </Button>
    </div>
  );
}

const USERNAME_RULE =
  'A user name has 2–64 characters: lower-case letters, digits, “.”, “_” and “-”, starting with a letter or digit.';

function CreateUser() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [roles, setRoles] = useState<Role[]>(['operator']);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [invalid, setInvalid] = useState<{ name?: string | undefined; roles?: string | undefined }>(
    {},
  );
  const [handover, setHandover] = useHandover();
  useUnsavedDraft(username.trim() !== '');
  const create = useMutation({
    mutationFn: (password: string) => createUser({ username: username.trim(), roles, password }),
    // Removed from the mutation cache as soon as it is reset (it holds the password).
    gcTime: 0,
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
  useForgetPassword(handover, create);
  return (
    <Card padding="compact">
      <form
        noValidate
        aria-label="New user"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setMessage(undefined);
          setHandover(undefined);
          const name = username.trim();
          if (!validUsername(name)) {
            setInvalid({ name: USERNAME_RULE });
            setMessage({ kind: 'invalid', text: `Not saved: ${USERNAME_RULE.toLowerCase()}` });
            return;
          }
          if (roles.length === 0) {
            setInvalid({ roles: 'Give the user at least one role.' });
            setMessage({ kind: 'invalid', text: 'Not saved: give the user at least one role.' });
            return;
          }
          setInvalid({});
          create.mutate(temporaryPassword());
        }}
      >
        {message ? <MessageLine message={message} testId="create-message" /> : null}
        <TextInput
          label="User name"
          name="new-username"
          required
          data-testid="new-username"
          value={username}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          error={invalid.name}
          onChange={(event) => {
            setUsername(event.target.value);
            setInvalid((current) => ({ ...current, name: undefined }));
          }}
          className="w-full max-w-xs"
        />
        <RolePicker
          legend="Roles"
          value={roles}
          error={invalid.roles}
          onChange={(next) => {
            setRoles(next);
            setInvalid((current) => ({ ...current, roles: undefined }));
          }}
          name="new"
        />
        <p className="text-xs text-ink-secondary">
          A temporary password is generated and shown once; the user chooses a new one at the first
          login.
        </p>
        {handover ? (
          <TemporaryPassword
            handover={handover}
            onDone={() => {
              setHandover(undefined);
            }}
          />
        ) : null}
        <div>
          <Button
            type="submit"
            variant="primary"
            data-testid="create-user"
            loading={create.isPending}
          >
            Create user
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** What a destructive write asks before it is sent (design system 4.9). */
interface Asked {
  readonly kind: 'disable' | 'reset';
  readonly username: string;
}

const sameRoles = (a: readonly Role[], b: readonly Role[]) =>
  a.length === b.length && a.every((role) => b.includes(role));

function UserTable({
  users,
  self,
}: {
  readonly users: readonly UserDto[];
  readonly self: string | undefined;
}) {
  const queryClient = useQueryClient();
  // The roles being edited, per user; none while they equal what the MES holds.
  const [drafts, setDrafts] = useState<Readonly<Record<string, Role[]>>>({});
  const [message, setMessage] = useState<{ username: string; message: Message } | undefined>(
    undefined,
  );
  const [asked, setAsked] = useState<Asked | undefined>(undefined);
  // The MES's refusal of a confirmed write, shown in its dialog, which stays open.
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const ask = (next: Asked | undefined) => {
    setRefusal(undefined);
    setAsked(next);
  };
  /** The dialog stays busy until the write settles; it closes when the write is done. */
  const confirmWith = async (write: () => Promise<unknown>) => {
    setRefusal(undefined);
    try {
      await write();
      setAsked(undefined);
    } catch (error) {
      setRefusal(userWriteFailure(error).text);
    }
  };
  const refusalLine = (testId: string) =>
    refusal === undefined ? null : (
      <Callout tone="alarm" role="alert" className="mt-3" data-testid={`${testId}-refusal`}>
        {refusal}
      </Callout>
    );
  const [handover, setHandover] = useHandover();
  const rolesOf = (user: UserDto): Role[] => drafts[user.username] ?? [...user.roles];
  const changed = (user: UserDto) => !sameRoles(rolesOf(user), user.roles);
  useUnsavedDraft(users.some(changed));
  const done = (username: string, text: string) => {
    setMessage({ username, message: { kind: 'saved', text } });
    void queryClient.invalidateQueries({ queryKey: usersKey });
  };
  const update = useMutation({
    mutationFn: (args: { username: string; body: { roles?: Role[]; enabled?: boolean } }) =>
      updateUser(args.username, args.body),
    onSuccess: (next, { username, body }) => {
      if (body.roles !== undefined) {
        setDrafts((current) =>
          Object.fromEntries(Object.entries(current).filter(([name]) => name !== username)),
        );
      }
      done(
        username,
        body.enabled === undefined
          ? `Roles of ${next.username}: ${rolesText(next.roles)}.`
          : next.enabled
            ? `${next.username} may log in again.`
            : `${next.username} is disabled; their sessions ended.`,
      );
    },
    onError: (error, { username }) => {
      setMessage({ username, message: userWriteFailure(error) });
    },
  });
  const reset = useMutation({
    mutationFn: (args: { username: string; password: string }) =>
      resetPassword(args.username, args.password),
    gcTime: 0,
    onSuccess: (next, { password }) => {
      setHandover({ username: next.username, password });
      done(next.username, `New temporary password for ${next.username}; their sessions ended.`);
    },
    onError: (error, { username }) => {
      setMessage({ username, message: userWriteFailure(error) });
    },
  });
  useForgetPassword(handover, reset);
  const busy = (username: string) =>
    (update.isPending && update.variables.username === username) ||
    (reset.isPending && reset.variables.username === username);

  const columns: Column<UserDto>[] = [
    {
      key: 'user',
      header: 'User',
      rowHeader: true,
      cell: (user) => (
        <span className="flex flex-col gap-1">
          <span>
            <span className="font-semibold break-all">{user.username}</span>
            {user.username === self ? <span className="text-ink-secondary"> (you)</span> : null}
          </span>
          {!user.enabled || user.locked || user.mustChangePassword ? (
            <span className="flex flex-wrap gap-1">
              {user.enabled ? null : (
                <Badge tone="neutral" variant="solid">
                  Disabled
                </Badge>
              )}
              {user.locked ? (
                <Badge tone="alarm" icon="alert">
                  Locked
                </Badge>
              ) : null}
              {user.mustChangePassword ? (
                <Badge tone="neutral" variant="outline">
                  Temporary password
                </Badge>
              ) : null}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'roles',
      header: 'Roles',
      cell: (user) => {
        const roles = rolesOf(user);
        return (
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <RolePicker
              legendHidden
              legend={
                <>
                  Roles of {user.username}, saved:{' '}
                  <span data-testid={`user-roles-${user.username}`}>{rolesText(user.roles)}</span>
                </>
              }
              value={roles}
              onChange={(next) => {
                setDrafts((current) => ({ ...current, [user.username]: next }));
              }}
              name={user.username}
            />
            <Button
              size="sm"
              variant={changed(user) ? 'primary' : 'secondary'}
              data-testid={`save-roles-${user.username}`}
              aria-label={`Save roles of ${user.username}`}
              disabled={busy(user.username) || !changed(user) || roles.length === 0}
              onClick={() => {
                setMessage(undefined);
                update.mutate({ username: user.username, body: { roles } });
              }}
            >
              Save roles
            </Button>
          </span>
        );
      },
    },
  ];

  const askedUser = asked ? users.find((u) => u.username === asked.username) : undefined;
  return (
    <>
      {message ? (
        <div className="mb-3">
          <MessageLine
            message={message.message}
            testId={`user-message-${message.username}`}
            quiet={refusal !== undefined}
          />
        </div>
      ) : null}
      {handover ? (
        <div className="mb-3">
          <TemporaryPassword
            handover={handover}
            onDone={() => {
              setHandover(undefined);
            }}
          />
        </div>
      ) : null}
      <DataTable
        caption="All users"
        testId="user-list"
        columns={columns}
        rows={users}
        rowKey={(user) => user.username}
        rowTestId={(user) => `user-${user.username}`}
        rowProps={(user) => ({ 'data-enabled': String(user.enabled) })}
        narrow="stack"
        empty={<EmptyState title="No users" body="Create the first one above." />}
        actions={(user) => (
          <>
            <Button
              size="sm"
              variant={user.enabled ? 'danger' : 'secondary'}
              data-testid={`toggle-enabled-${user.username}`}
              aria-label={`${user.enabled ? 'Disable' : 'Enable'} ${user.username}`}
              disabled={busy(user.username)}
              onClick={() => {
                setMessage(undefined);
                // Enabling gives a login back and can be undone: no question.
                if (user.enabled) ask({ kind: 'disable', username: user.username });
                else update.mutate({ username: user.username, body: { enabled: true } });
              }}
            >
              {user.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              data-testid={`reset-password-${user.username}`}
              aria-label={`Reset password of ${user.username}`}
              disabled={busy(user.username)}
              onClick={() => {
                setMessage(undefined);
                ask({ kind: 'reset', username: user.username });
              }}
            >
              Reset password
            </Button>
          </>
        )}
      />
      <ConfirmDialog
        open={asked?.kind === 'disable' && askedUser !== undefined}
        testId="confirm-disable"
        tone="danger"
        title={`Disable user ${asked?.username ?? ''}?`}
        body={
          <>
            {`${asked?.username ?? 'The user'} can no longer log in, and their open sessions end at once. You can enable the user again later.`}
            {refusalLine('confirm-disable')}
          </>
        }
        confirmLabel="Disable user"
        onCancel={() => {
          ask(undefined);
        }}
        onConfirm={async () => {
          if (asked === undefined) return;
          const { username } = asked;
          await confirmWith(() => update.mutateAsync({ username, body: { enabled: false } }));
        }}
      />
      <ConfirmDialog
        open={asked?.kind === 'reset' && askedUser !== undefined}
        testId="confirm-reset"
        tone="danger"
        title={`Reset the password of ${asked?.username ?? ''}?`}
        body={
          <>
            {`A new temporary password is made and shown here once; the old one stops working and ${asked?.username ?? 'the user'}'s sessions end at once.`}
            {refusalLine('confirm-reset')}
          </>
        }
        confirmLabel="Reset password"
        onCancel={() => {
          ask(undefined);
        }}
        onConfirm={async () => {
          if (asked === undefined) return;
          const { username } = asked;
          setHandover(undefined);
          await confirmWith(() => reset.mutateAsync({ username, password: temporaryPassword() }));
        }}
      />
    </>
  );
}

/** `/admin/users` (#170, `user:admin` only): create users, change roles, disable, reset. */
export function Users() {
  const allowed = useCan('user:admin');
  const { session } = useAuth();
  const users = useQuery({
    queryKey: usersKey,
    queryFn: ({ signal }) => getUsers(signal),
    enabled: allowed,
  });
  return (
    <section aria-labelledby="users-title">
      <PageHeader
        id="users-title"
        title="Users"
        description={
          allowed
            ? 'Create users and set their roles. Disabling or resetting a password ends their sessions.'
            : undefined
        }
      />
      {!allowed ? (
        <Forbidden testId="users-forbidden" permission="user:admin">
          Only an admin manages users
        </Forbidden>
      ) : (
        <>
          <Section
            title="New user"
            description="Admins manage users and drive the console, nothing else: someone who also works in the plant gets a second role."
          >
            <CreateUser />
          </Section>
          <Section title="All users">
            <UsersList
              users={users.data?.users}
              isError={users.isError}
              error={users.error}
              refetch={() => void users.refetch()}
              self={session?.user.username}
            />
          </Section>
        </>
      )}
    </section>
  );
}

function UsersList({
  users,
  isError,
  error,
  refetch,
  self,
}: {
  readonly users: readonly UserDto[] | undefined;
  readonly isError: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
  readonly self: string | undefined;
}) {
  if (isError) return <QueryError what="the users" error={error} onRetry={refetch} />;
  if (users === undefined) return <Skeleton shape="table" label="Loading the users…" />;
  return <UserTable users={users} self={self} />;
}
