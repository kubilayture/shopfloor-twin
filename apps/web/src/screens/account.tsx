import { SESSION_IDLE_MS } from '@shopfloor/contracts/identity';
import { useState } from 'react';
import { useAuth } from '../auth/auth.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { Card } from '../components/ui/card.tsx';
import { Code } from '../components/ui/code.tsx';
import { DescriptionList } from '../components/ui/description-list.tsx';
import { Disclosure } from '../components/ui/disclosure.tsx';
import { WallTime } from '../components/ui/format.tsx';
import { PageHeader } from '../components/ui/page-header.tsx';
import { permissionGroups, rolesText } from '../domain/identity.ts';
import { ThemeRadioGroup } from '../theme/theme-switch.tsx';
import { ChangePasswordForm } from './login.tsx';
import { countOf } from '../domain/words.ts';

/**
 * `/account` (#170): who is logged in, with which roles and what they allow, the session's times
 * and the password. The times are wall times, labelled so (Y-01); the permissions are words
 * grouped by area in a closed disclosure, each with its id (Y-02); logging out is the top bar's
 * one "Log out", and the password form keeps a form's width (Y-03). The theme (UX-12) is chosen
 * here and in the top bar.
 */
export function Account() {
  const auth = useAuth();
  const [changed, setChanged] = useState<string | undefined>(undefined);
  const { session } = auth;
  if (!session) return null;
  const { user } = session;
  const groups = permissionGroups(user.permissions);
  const count = user.permissions.length;
  return (
    <section aria-labelledby="account-title">
      <PageHeader
        id="account-title"
        title="Account"
        description="Who you are logged in as, what your roles allow, your password and the theme."
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="Profile" as="section">
          <DescriptionList
            columns={2}
            facts={[
              {
                term: 'User name',
                detail: <span data-testid="account-username">{user.username}</span>,
              },
              {
                term: 'Roles',
                detail: <span data-testid="account-roles">{rolesText(user.roles)}</span>,
              },
              {
                term: 'Logged in',
                detail: <WallTime at={session.createdAt} className="whitespace-nowrap" />,
              },
              {
                term: 'Session ends',
                detail: (
                  <>
                    After {SESSION_IDLE_MS[session.kind] / 60_000} minutes without use, at the
                    latest <WallTime at={session.expiresAt} className="whitespace-nowrap" />
                  </>
                ),
              },
            ]}
          />
          <Disclosure
            summary={`What your roles allow (${countOf(count, 'permission')})`}
            className="mt-1 border-t border-line-subtle pt-3"
          >
            <div data-testid="account-permissions" className="flex flex-col gap-3">
              {groups.map((group) => (
                <div key={group.area}>
                  <h3 className="text-xs font-medium text-ink-secondary">{group.area}</h3>
                  <ul className="mt-1 flex flex-col gap-1">
                    {group.permissions.map((permission) => (
                      <li
                        key={permission.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-3"
                      >
                        <span className="text-ink">{permission.text}</span>
                        <span className="text-xs text-ink-secondary">
                          <Code>{permission.id}</Code>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Disclosure>
        </Card>
        <Card
          title="Change password"
          as="section"
          description="Your other sessions (other browsers) end with it."
        >
          <div className="flex max-w-md flex-col gap-4">
            {changed ? (
              <Callout tone="ok" role="status" data-testid="password-changed">
                {changed}
              </Callout>
            ) : null}
            <ChangePasswordForm
              username={user.username}
              onChanged={(ended) => {
                setChanged(
                  `Password changed.${ended > 0 ? ` ${countOf(ended, 'other session')} ended.` : ''}`,
                );
              }}
            />
          </div>
        </Card>
        <Card title="Appearance" as="section">
          <ThemeRadioGroup />
        </Card>
      </div>
    </section>
  );
}
