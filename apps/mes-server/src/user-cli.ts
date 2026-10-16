import { parseArgs } from 'node:util';
import { ROLES, type Role } from '@shopfloor/contracts/identity';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createDatabase, type Database } from './db/database.ts';
import { Identity, IdentityError } from './modules/identity/index.ts';

/**
 * `pnpm --filter @shopfloor/mes-server user:create --username <name> --role <role> [--role …]
 * [--must-change]` (#168, ADR-0026): creates a user, the password read from stdin so it never
 * appears in a process list or a shell history. In the stack:
 * `docker compose exec -T mes node apps/mes-server/src/user-cli.ts --username … --role admin`.
 */
export const USAGE =
  'usage: user:create --username <name> --role <role> [--role <role> …] [--must-change] ' +
  `(password on stdin; roles: ${ROLES.join(', ')})`;

export interface UserCreateArgs {
  readonly username: string;
  readonly roles: readonly Role[];
  readonly mustChangePassword: boolean;
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

/** The arguments, or a message saying what is wrong. */
export function parseUserCreateArgs(argv: readonly string[]): UserCreateArgs | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        username: { type: 'string' },
        role: { type: 'string', multiple: true },
        'must-change': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { username, role = [] } = parsed.values;
  if (username === undefined) return 'missing --username';
  if (role.length === 0) return 'missing --role';
  const unknown = role.filter((r) => !isRole(r));
  if (unknown.length > 0) return `unknown role ${unknown.join(', ')}`;
  return {
    username,
    roles: ROLES.filter((r) => role.includes(r)),
    mustChangePassword: parsed.values['must-change'],
  };
}

/** The password from stdin's text: one trailing line break (from `echo` or a file) is dropped. */
export function passwordFromStdin(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Creates the user; the outcome as a line for the operator (no password in it). */
export async function userCreate(
  db: Kysely<Database>,
  args: UserCreateArgs,
  password: string,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const identity = new Identity({ db, sweepMs: 0 });
  try {
    const user = await identity.createUser({ ...args, password }, { system: 'cli' });
    return {
      ok: true,
      message: `created user ${user.username} with roles ${user.roles.join(', ')}${user.mustChangePassword ? ' (must change the password at first login)' : ''}`,
    };
  } catch (error) {
    if (error instanceof IdentityError) return { ok: false, message: error.message };
    throw error;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (import.meta.main) {
  const args = parseUserCreateArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`${args}\n${USAGE}`);
    process.exit(2);
  }
  // Only the database URL: the CLI needs nothing else of the MES's environment.
  const env = z
    .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
    .safeParse(process.env);
  if (!env.success) {
    console.error('DATABASE_URL: expected a postgres:// URL (hidden)');
    process.exit(2);
  }
  if (process.stdin.isTTY) console.error('password (end with Ctrl-D):');
  const password = passwordFromStdin(await readStdin());
  const db = createDatabase(env.data.DATABASE_URL, 1);
  try {
    const result = await userCreate(db, args, password);
    (result.ok ? console.log : console.error)(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await db.destroy();
  }
}
