import { randomBytes, scrypt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHENTICATED,
  type Permission,
  type Role,
} from '@shopfloor/contracts/identity';
import { PROBLEM_TYPES, sessionSchema } from '@shopfloor/contracts/mes-api';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
import { freshDatabase, ownerOf } from './modules/equipment/test-support.ts';
import {
  IDENTITY_LIMITS,
  Identity,
  IdentityError,
  LOGIN_FAILED,
  SCRYPT_MAXMEM,
  SCRYPT_PARAMS,
  Semaphore,
  hashPassword,
  needsRehash,
  parseHash,
  parseToken,
  verifyPassword,
} from './modules/identity/index.ts';
import { WS_PATH, cookieValue } from './modules/realtime/index.ts';
import { OPENAPI_FILE } from './openapi.ts';
import { startDatabase } from './testing.ts';
import {
  parseUserCreateArgs,
  parseUserDisableArgs,
  passwordFromStdin,
  userCreate,
  userDisable,
} from './user-cli.ts';

const MINUTE = 60_000;
const REPO = resolve(import.meta.dirname, '../../..');
/** A fresh random password per call: no password is written to the repository. */
const secret = (): string => randomBytes(15).toString('base64url');

let container: StartedTestContainer;
let serverUrl: string;
let db: Kysely<Database>;
/** The identity module's wall clock: tests move it. */
let clock = Date.now();
const now = (): Date => new Date(clock);
let identity: Identity;
const warnings: string[] = [];
/** Everything logged: the identity module's lines and, in the HTTP tests, Fastify's. */
const logs: string[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  db = await freshDatabase(serverUrl, 'identity');
  identity = new Identity({
    db,
    now,
    sweepMs: 0,
    log: {
      info: (object, message) => logs.push(JSON.stringify({ ...object, msg: message })),
      warn: (object, message) => {
        warnings.push(message);
        logs.push(JSON.stringify({ ...object, msg: message }));
      },
      error: (object, message) => logs.push(JSON.stringify({ ...object, msg: message })),
    },
  });
}, 180_000);

afterAll(async () => {
  identity.stop();
  await db.destroy();
  await container.stop();
});

const tokenOf = (token: string): Buffer => {
  const parsed = parseToken(token);
  if (!parsed) throw new Error('not a token');
  return parsed;
};

async function user(name: string, roles: Role[], password = secret()) {
  await identity.createUser(
    { username: name, roles, password, mustChangePassword: false },
    { system: 'test' },
  );
  return password;
}

/** A user's failed-login state. */
const account = (username: string) =>
  db
    .selectFrom('identity.user_account')
    .select(['failed_logins', 'locked_until', 'next_attempt_at'])
    .where('username', '=', username)
    .executeTakeFirstOrThrow();

const failureReasons = async (username: string): Promise<string[]> =>
  (await identity.auditOf('user', username))
    .filter((r) => r.action === 'session.login-failed')
    .map((r) => (r.after as { reason: string }).reason);

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A request over real HTTP (not inject), with any headers, for the Upgrade-header cases. */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // A fresh connection each (no keep-alive agent: an upgrade may leave its socket closed).
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, body: '' });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function failedLogin(username: string, password: string): Promise<IdentityError> {
  const error = await identity.login({ username, password, kind: 'desk' }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdentityError);
  expect((error as IdentityError).message).toBe(LOGIN_FAILED);
  expect((error as IdentityError).type).toBe(PROBLEM_TYPES.unauthenticated);
  return error as IdentityError;
}

describe('passwords (scrypt, ADR-0026)', () => {
  it('stores scrypt$N$r$p$salt$hash with N = 2^15, r = 8, p = 3 and verifies in constant time', async () => {
    const password = secret();
    const stored = await hashPassword(password);
    expect(stored).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(parseHash(stored)?.params).toEqual(SCRYPT_PARAMS);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword(`${password}x`, stored)).toBe(false);
    expect(await verifyPassword(password, 'scrypt$1$2')).toBe(false);
    expect(needsRehash(stored)).toBe(false);
    expect(needsRehash(await hashPassword(password, { N: 1024, r: 8, p: 1 }))).toBe(true);
    // Two hashes of one password differ (a fresh salt each time).
    expect(await hashPassword(password)).not.toBe(stored);
  });

  it("needs the explicit maxmem: Node's default 32 MiB refuses these parameters", async () => {
    const run = (maxmem?: number) =>
      new Promise<void>((resolve, reject) => {
        scrypt(
          'x',
          'salt',
          32,
          { ...SCRYPT_PARAMS, ...(maxmem === undefined ? {} : { maxmem }) },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
    await expect(run()).rejects.toThrow(/memory limit/i);
    await expect(run(SCRYPT_MAXMEM)).resolves.toBeUndefined();
    expect(SCRYPT_MAXMEM).toBe(64 * 1024 * 1024);
  });

  it('runs at most two hashes at a time', async () => {
    const gate = new Semaphore(2);
    let running = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate.run(async () => {
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 10));
          running--;
        }),
      ),
    );
    expect(most).toBe(2);
    expect(gate.active).toBe(0);
  });
});

describe('identity module (#168)', () => {
  it('holds the five roles of contracts and starts without an admin, with a warning', async () => {
    expect(await identity.start()).toEqual({ admin: 'missing' });
    expect(warnings.at(-1)).toMatch(/no enabled admin/);
    const roles = await db.selectFrom('identity.role').select('id').execute();
    expect(roles.map((r) => r.id).sort()).toEqual([...ROLES].sort());
  });

  it('creates the bootstrap admin once, with a password it must change', async () => {
    const password = secret();
    expect(await identity.start({ bootstrapAdminPassword: password })).toEqual({
      admin: 'created',
    });
    const admin = await identity.user('admin');
    expect(admin).toMatchObject({ roles: ['admin'], enabled: true, mustChangePassword: true });
    expect(await identity.start({ bootstrapAdminPassword: secret() })).toEqual({
      admin: 'exists',
    });
    const { principal } = await identity.login({ username: 'admin', password, kind: 'desk' });
    expect(principal.mustChangePassword).toBe(true);
    expect((await identity.auditOf('user', 'admin')).map((r) => r.action)).toEqual([
      'user.bootstrap',
      'session.login',
    ]);
    identity.stop();
  });

  it('logs in, authenticates by token, and stores only the token hash', async () => {
    const password = await user('anna', ['operator', 'quality']);
    const { token, principal } = await identity.login({
      username: ' Anna ',
      password,
      kind: 'desk',
    });
    expect(principal).toMatchObject({
      username: 'anna',
      roles: ['operator', 'quality'],
      mustChangePassword: false,
    });
    expect(principal.permissions).toContain('scrap:code');
    expect(principal.permissions).not.toContain('alarm:shelve');
    const rows = await db.selectFrom('identity.session').selectAll().execute();
    expect(rows.some((r) => r.token_hash.toString('base64url') === token)).toBe(false);
    expect(rows.some((r) => r.token_hash.toString('hex') === principal.session.id)).toBe(true);
    expect((await identity.authenticate(tokenOf(token)))?.username).toBe('anna');
    expect(await identity.authenticate(randomBytes(32))).toBeUndefined();
    expect(parseToken('short')).toBeUndefined();
    const hash = await db
      .selectFrom('identity.user_account')
      .select('password_hash')
      .where('username', '=', 'anna')
      .executeTakeFirstOrThrow();
    expect(hash.password_hash.startsWith('scrypt$32768$8$3$')).toBe(true);
  });

  it('answers every failed login the same, one hash each, audited without the password', async () => {
    const password = await user('bert', ['maintenance']);
    await failedLogin('nobody', password);
    await failedLogin('bert', `${password}!`);
    await failedLogin('NOT A NAME', password);
    await identity.updateUser('bert', { enabled: false }, { system: 'test' });
    await failedLogin('bert', password);
    const audit = await identity.auditOf('user', 'bert');
    expect(audit.map((r) => [r.action, (r.after as { reason?: string } | null)?.reason])).toEqual([
      ['user.create', undefined],
      ['session.login-failed', 'wrong-password'],
      ['user.update', undefined],
      ['session.login-failed', 'disabled'],
    ]);
    // Unknown and malformed names are never stored as typed.
    expect((await identity.auditOf('user', '(unknown)')).length).toBe(2);
    expect(JSON.stringify(await identity.auditOf('user', '(unknown)'))).not.toMatch(
      /nobody|NOT A NAME/i,
    );
    const all = await db.selectFrom('identity.audit_log').selectAll().execute();
    expect(JSON.stringify(all)).not.toContain(password);
  });

  it('locks a normal account for 15 minutes after five failures in a row', async () => {
    const password = await user('carl', ['operator']);
    await identity.login({ username: 'carl', password, kind: 'desk' });
    for (let i = 0; i < 4; i++) await failedLogin('carl', 'wrong-password-x');
    // A success resets the count.
    await identity.login({ username: 'carl', password, kind: 'desk' });
    for (let i = 0; i < 5; i++) await failedLogin('carl', 'wrong-password-x');
    expect((await identity.user('carl')).locked).toBe(true);
    // The right password is refused while locked, with the same answer.
    await failedLogin('carl', password);
    clock += IDENTITY_LIMITS.lockMs - 1_000;
    await failedLogin('carl', password);
    clock += 2_000;
    expect((await identity.user('carl')).locked).toBe(false);
    await identity.login({ username: 'carl', password, kind: 'desk' });
    const actions = (await identity.auditOf('user', 'carl')).map((r) => r.action);
    expect(actions.filter((a) => a === 'user.locked')).toHaveLength(1);
    expect(
      (await identity.auditOf('user', 'carl'))
        .filter((r) => r.action === 'session.login-failed')
        .map((r) => (r.after as { reason: string }).reason),
    ).toEqual([...Array<string>(9).fill('wrong-password'), 'locked', 'locked']);
  });

  it('delays an admin instead of locking it: 1 s after the fifth failure, doubling, at most 5 min', async () => {
    const password = await user('root', ['admin']);
    const delays: number[] = [];
    for (let i = 1; i <= 14; i++) {
      await failedLogin('root', 'wrong-password-x');
      const row = await db
        .selectFrom('identity.user_account')
        .select(['next_attempt_at', 'locked_until'])
        .where('username', '=', 'root')
        .executeTakeFirstOrThrow();
      expect(row.locked_until).toBeNull();
      delays.push(row.next_attempt_at ? row.next_attempt_at.getTime() - clock : 0);
      // Within the delay even the right password is refused.
      if (row.next_attempt_at) {
        await failedLogin('root', password);
        clock = row.next_attempt_at.getTime();
      }
    }
    expect(delays).toEqual([
      0, 0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
    ]);
    expect((await identity.user('root')).locked).toBe(false);
    await identity.login({ username: 'root', password, kind: 'desk' });
    const after = await db
      .selectFrom('identity.user_account')
      .select(['failed_logins', 'next_attempt_at'])
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ failed_logins: 0, next_attempt_at: null });
  });

  it('ends sessions when idle (desk 60 min, terminal 15 min) and after 12 h whatever the use', async () => {
    const password = await user('dora', ['supervisor']);
    const desk = tokenOf(
      (await identity.login({ username: 'dora', password, kind: 'desk' })).token,
    );
    const terminal = tokenOf(
      (await identity.login({ username: 'dora', password, kind: 'terminal' })).token,
    );
    clock += 14 * MINUTE;
    expect(await identity.authenticate(terminal)).toBeDefined();
    clock += 14 * MINUTE; // 14 min after the terminal's last use
    expect(await identity.authenticate(terminal)).toBeDefined();
    clock += 16 * MINUTE;
    expect(await identity.authenticate(terminal)).toBeUndefined();
    // The desk session was last used 44 min ago... still alive, then idle.
    expect(await identity.authenticate(desk, { touch: false })).toBeDefined();
    clock += 17 * MINUTE;
    expect(await identity.authenticate(desk)).toBeUndefined();
    // Used every 50 minutes, a desk session still ends 12 h after login.
    const kept = tokenOf(
      (await identity.login({ username: 'dora', password, kind: 'desk' })).token,
    );
    const start = clock;
    while (clock - start < IDENTITY_LIMITS.absoluteMs - 50 * MINUTE) {
      clock += 50 * MINUTE;
      expect(await identity.authenticate(kept)).toBeDefined();
    }
    clock = start + IDENTITY_LIMITS.absoluteMs;
    expect(await identity.authenticate(kept)).toBeUndefined();
  });

  it('logs out, ends the other sessions on a password change, and all of them when disabled', async () => {
    const password = await user('emil', ['operator']);
    const ended: string[][] = [];
    const off = identity.onSessionsEnded((e) => ended.push([e.reason, ...e.ids]));
    const login = () => identity.login({ username: 'emil', password, kind: 'desk' });
    const a = await login();
    const b = await login();
    const c = await login();
    await identity.logout(a.principal);
    expect(await identity.authenticate(tokenOf(a.token))).toBeUndefined();
    // Wrong current password, the same password, too short: refused, nothing ends.
    for (const [current, next] of [
      ['wrong-password-x', secret()],
      [password, password],
      [password, 'short'],
    ] as const) {
      await expect(identity.changePassword(b.principal, current, next)).rejects.toMatchObject({
        kind: 'invalid',
        type: PROBLEM_TYPES.passwordRejected,
      });
    }
    const next = secret();
    expect(await identity.changePassword(b.principal, password, next)).toEqual({
      endedSessions: 1,
    });
    expect(await identity.authenticate(tokenOf(b.token))).toBeDefined();
    expect(await identity.authenticate(tokenOf(c.token))).toBeUndefined();
    await failedLogin('emil', password);
    const d = await identity.login({ username: 'emil', password: next, kind: 'terminal' });
    await identity.updateUser('emil', { enabled: false }, { system: 'test' });
    expect(await identity.authenticate(tokenOf(b.token))).toBeUndefined();
    expect(await identity.authenticate(tokenOf(d.token))).toBeUndefined();
    expect(ended.slice(0, 2)).toEqual([
      ['logout', a.principal.session.id],
      ['password-changed', c.principal.session.id],
    ]);
    expect(ended[2]?.[0]).toBe('user-disabled');
    expect(ended[2]?.slice(1).sort()).toEqual(
      [b.principal.session.id, d.principal.session.id].sort(),
    );
    off();
  });

  it('replaces the session a login presents, resets passwords and keeps one enabled admin', async () => {
    const password = await user('fay', ['quality']);
    const first = await identity.login({ username: 'fay', password, kind: 'desk' });
    const second = await identity.login({
      username: 'fay',
      password,
      kind: 'desk',
      replaces: tokenOf(first.token),
    });
    expect(await identity.authenticate(tokenOf(first.token))).toBeUndefined();
    const temporary = secret();
    const reset = await identity.resetPassword('fay', temporary, { system: 'test' });
    expect(reset.mustChangePassword).toBe(true);
    expect(await identity.authenticate(tokenOf(second.token))).toBeUndefined();
    await expect(
      identity.resetPassword('nobody', temporary, { system: 'test' }),
    ).rejects.toMatchObject({ kind: 'not-found' });
    await expect(
      identity.createUser(
        { username: 'fay', roles: ['operator'], password: secret() },
        { system: 'test' },
      ),
    ).rejects.toMatchObject({ kind: 'conflict', type: PROBLEM_TYPES.userExists });
    await expect(
      identity.createUser(
        { username: 'gus', roles: ['operator'], password: 'short' },
        { system: 'test' },
      ),
    ).rejects.toMatchObject({ kind: 'invalid', type: PROBLEM_TYPES.passwordRejected });
    // `admin` and `root` are the enabled admins: take the role from both, the second is refused.
    await identity.updateUser('admin', { roles: ['supervisor'] }, { system: 'test' });
    await expect(
      identity.updateUser('root', { enabled: false }, { system: 'test' }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect((await identity.user('root')).enabled).toBe(true);
    await identity.updateUser('admin', { roles: ['admin'] }, { system: 'test' });
  });

  it('evaluates at most five of many parallel wrong attempts, then refuses the right password (H1)', async () => {
    const password = await user('kai', ['operator']);
    const burst = Array.from({ length: 12 }, () =>
      identity.login({ username: 'kai', password: 'wrong-password-x', kind: 'desk' }).then(
        () => 'ok',
        () => 'refused',
      ),
    );
    // The attempts are reserved before their hashes (two at a time) finish.
    await waitFor(async () => (await account('kai')).failed_logins >= 5);
    await failedLogin('kai', password);
    expect(await Promise.all(burst)).toEqual(Array<string>(12).fill('refused'));
    const reasons = await failureReasons('kai');
    expect(reasons.filter((r) => r === 'wrong-password')).toHaveLength(5);
    expect(reasons.filter((r) => r === 'locked')).toHaveLength(8);
    expect((await identity.user('kai')).locked).toBe(true);
  });

  it('lets parallel attempts on an admin through one per delay (H1)', async () => {
    const password = await user('adm2', ['admin']);
    const burst = Array.from({ length: 12 }, () =>
      identity.login({ username: 'adm2', password: 'wrong-password-x', kind: 'desk' }).then(
        () => 'ok',
        () => 'refused',
      ),
    );
    await waitFor(async () => (await account('adm2')).next_attempt_at !== null);
    await failedLogin('adm2', password);
    await Promise.all(burst);
    const reasons = await failureReasons('adm2');
    expect(reasons.filter((r) => r === 'wrong-password')).toHaveLength(5);
    expect(reasons.filter((r) => r === 'delayed')).toHaveLength(8);
    clock += IDENTITY_LIMITS.adminDelayBaseMs;
    await identity.login({ username: 'adm2', password, kind: 'desk' });
    await identity.updateUser('adm2', { enabled: false }, { system: 'test' });
  });

  it('counts a wrong current password like a failed login: five lock the account (M1)', async () => {
    const password = await user('lea', ['quality']);
    const { principal } = await identity.login({ username: 'lea', password, kind: 'desk' });
    for (let i = 0; i < 5; i++) {
      await expect(
        identity.changePassword(principal, 'wrong-password-x', secret()),
      ).rejects.toMatchObject({ message: 'the current password does not match' });
    }
    await expect(identity.changePassword(principal, password, secret())).rejects.toMatchObject({
      message: 'too many failed attempts; try again later',
    });
    await failedLogin('lea', password);
    expect((await identity.user('lea')).locked).toBe(true);
    expect(
      (await identity.auditOf('user', 'lea')).filter((r) => r.action === 'user.locked'),
    ).toHaveLength(1);
    clock += IDENTITY_LIMITS.lockMs + 1_000;
    await identity.login({ username: 'lea', password, kind: 'desk' });
  });

  it('refuses one of two concurrent demotions of the last two admins (L7)', async () => {
    // `admin` and `root` are the enabled admins now (adm2 is disabled).
    const results = await Promise.allSettled([
      identity.updateUser('admin', { roles: ['supervisor'] }, { system: 'test' }),
      identity.updateUser('root', { roles: ['quality'] }, { system: 'test' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toMatchObject({ kind: 'conflict' });
    for (const name of ['admin', 'root']) {
      await identity.updateUser(name, { roles: ['admin'] }, { system: 'test' });
    }
  });

  it('rehashes at login a hash made with other parameters', async () => {
    const password = secret();
    const weak = await hashPassword(password, { N: 1024, r: 8, p: 1 });
    await identity.createUser(
      { username: 'hugo', roles: ['operator'], password: secret(), mustChangePassword: false },
      { system: 'test' },
    );
    await db
      .updateTable('identity.user_account')
      .set({ password_hash: weak })
      .where('username', '=', 'hugo')
      .execute();
    await identity.login({ username: 'hugo', password, kind: 'desk' });
    const row = await db
      .selectFrom('identity.user_account')
      .select('password_hash')
      .where('username', '=', 'hugo')
      .executeTakeFirstOrThrow();
    expect(parseHash(row.password_hash)?.params).toEqual(SCRYPT_PARAMS);
    expect(await verifyPassword(password, row.password_hash)).toBe(true);
  });

  it('keeps the audit log append-only and deletes long-ended sessions', async () => {
    // The MES (mes_app, #169) has no UPDATE, DELETE or TRUNCATE; the trigger stops anyone else,
    // the owner and a superuser included.
    const owner = await ownerOf(serverUrl, db);
    try {
      for (const statement of [
        sql`UPDATE identity.audit_log SET action = 'x.y'`,
        sql`DELETE FROM identity.audit_log`,
        sql`TRUNCATE identity.audit_log`,
      ]) {
        await expect(statement.execute(db)).rejects.toThrow(/permission denied/);
        await expect(statement.execute(owner)).rejects.toThrow(/append-only/);
      }
    } finally {
      await owner.destroy();
    }
    const before = await db.selectFrom('identity.session').select('token_hash').execute();
    clock += IDENTITY_LIMITS.absoluteMs + IDENTITY_LIMITS.keepEndedMs + MINUTE;
    expect(await identity.sweep()).toBe(before.length);
  });
});

describe('environment and secrets (#168)', () => {
  const base = { DATABASE_URL: 'postgres://u@h/d', MQTT_PASSWORD: 'x' };

  it('defaults MES_AUTH to on (#170) and MES_COOKIE_SECURE to off; the bootstrap password is optional and hidden', () => {
    const parsed = parseEnv(base);
    expect(parsed.ok && parsed.env.MES_AUTH).toBe('on');
    expect(parseEnv({ ...base, MES_AUTH: 'off' })).toMatchObject({
      ok: true,
      env: { MES_AUTH: 'off' },
    });
    expect(parsed.ok && parsed.env.MES_COOKIE_SECURE).toBe('off');
    expect(parsed.ok && parsed.env.MES_BOOTSTRAP_ADMIN_PASSWORD).toBeUndefined();
    const short = 'too-short';
    const refused = parseEnv({ ...base, MES_BOOTSTRAP_ADMIN_PASSWORD: short, MES_AUTH: 'on' });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(short);
    expect(JSON.stringify(refused)).toContain('(hidden)');
  });

  it('.env.example holds only placeholders for passwords and tokens', async () => {
    const text = await readFile(resolve(REPO, '.env.example'), 'utf8');
    const secrets = text
      .split('\n')
      .map((line) => line.replace(/^#\s*/, '').trim())
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => /_(PASSWORD|TOKEN)$/.test(m[1] ?? ''));
    expect(secrets.map((m) => m[1])).toEqual(
      expect.arrayContaining([
        'DB_PASSWORD',
        'DB_APP_PASSWORD',
        'MQTT_MES_PASSWORD',
        'MES_BOOTSTRAP_ADMIN_PASSWORD',
      ]),
    );
    for (const [, key, value] of secrets) {
      expect(['', 'change-me'], `${String(key)} must be a placeholder`).toContain(value);
    }
  });
});

describe('user:create CLI (#168)', () => {
  it('parses its arguments and creates a user with the password from stdin', async () => {
    expect(parseUserCreateArgs(['--role', 'admin'])).toBe('missing --username');
    expect(parseUserCreateArgs(['--username', 'x'])).toBe('missing --role');
    expect(parseUserCreateArgs(['--username', 'x', '--role', 'boss'])).toBe('unknown role boss');
    expect(typeof parseUserCreateArgs(['--nope'])).toBe('string');
    const args = parseUserCreateArgs(['--username', 'ivy', '--role', 'admin', '--role', 'quality']);
    expect(args).toEqual({
      username: 'ivy',
      roles: ['quality', 'admin'],
      mustChangePassword: false,
    });
    expect(passwordFromStdin('pass word\n')).toBe('pass word');
    expect(passwordFromStdin('pass word\r\n')).toBe('pass word');
    if (typeof args === 'string') throw new Error(args);
    const password = secret();
    expect(await userCreate(db, args, password)).toMatchObject({ ok: true });
    expect(await userCreate(db, args, password)).toEqual({ ok: false, message: 'user ivy exists' });
    const { principal } = await identity.login({ username: 'ivy', password, kind: 'desk' });
    expect(principal.roles).toEqual(['quality', 'admin']);
  });

  it('disables a user with --disable (#170: the stack smoke disables its per-run user)', async () => {
    expect(parseUserDisableArgs(['--disable'])).toBe('missing --username');
    expect(parseUserDisableArgs(['--username', 'x'])).toBe('missing --disable');
    expect(typeof parseUserDisableArgs(['--disable', '--username', 'x', '--role', 'admin'])).toBe(
      'string',
    );
    expect(parseUserDisableArgs(['--disable', '--username', 'smoke-1'])).toEqual({
      username: 'smoke-1',
    });
    const password = secret();
    await identity.createUser(
      { username: 'smoke-1', roles: ['operator'], password, mustChangePassword: false },
      { system: 'test' },
    );
    const { token } = await identity.login({ username: 'smoke-1', password, kind: 'desk' });
    expect(await userDisable(db, 'smoke-1')).toEqual({
      ok: true,
      message: 'disabled user smoke-1',
    });
    // Its session ended and it may not log in again.
    expect(await identity.authenticate(tokenOf(token))).toBeUndefined();
    await expect(identity.login({ username: 'smoke-1', password, kind: 'desk' })).rejects.toThrow();
    expect(await userDisable(db, 'nobody-here')).toMatchObject({ ok: false });
  });

  it('runs as a process, reading the password from stdin', async () => {
    const name = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db))
      .rows[0]?.name;
    const password = secret();
    const result = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, 'user-cli.ts'),
          '--username',
          'jon',
          '--role',
          'operator',
          '--must-change',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '',
            DATABASE_URL: serverUrl.replace(/\/shopfloor$/, `/${String(name)}`),
          },
        },
      );
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', (code) => {
        done({ code, out });
      });
      child.stdin.end(`${password}\n`);
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/created user jon with roles operator \(must change/);
    expect(result.out).not.toContain(password);
    const { principal } = await identity.login({ username: 'jon', password, kind: 'desk' });
    expect(principal.mustChangePassword).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// HTTP: authentication on every route and the WebSocket (MES_AUTH=on), and off.

/** The permission each route of the OpenAPI document needs (ADR-0026); none escapes the matrix. */
const ROUTES: Readonly<Record<string, Permission | 'session' | 'public'>> = {
  'GET /api/v1/equipment': 'read',
  'GET /api/v1/equipment/{id}': 'read',
  'GET /api/v1/equipment/{id}/intervals': 'read',
  'GET /api/v1/equipment/{id}/telemetry/metrics': 'read',
  'GET /api/v1/equipment/{id}/telemetry': 'read',
  'GET /api/v1/shifts/{date}/{shift}/totals': 'read',
  'GET /api/v1/oee': 'read',
  'GET /api/v1/shifts/{date}/{shift}/oee': 'read',
  'GET /api/v1/shifts': 'read',
  'GET /api/v1/shifts/current': 'read',
  'GET /api/v1/reason-codes': 'read',
  'GET /api/v1/downtime': 'read',
  'GET /api/v1/downtime/pareto': 'read',
  'PUT /api/v1/downtime/{id}/coding': 'downtime:code',
  'GET /api/v1/downtime/{id}/audit': 'read',
  'GET /api/v1/shifts/{date}/{shift}': 'read',
  'GET /api/v1/shifts/{date}/{shift}/report': 'read',
  'GET /api/v1/shifts/{date}/{shift}/notes': 'read',
  'POST /api/v1/shifts/{date}/{shift}/notes': 'note:write',
  'PUT /api/v1/shifts/{date}/{shift}/notes/{noteId}': 'note:write',
  'GET /api/v1/shifts/{date}/{shift}/notes/{noteId}/audit': 'read',
  'GET /api/v1/alarms': 'read',
  'GET /api/v1/alarms/scopes': 'read',
  'GET /api/v1/alarms/config': 'read',
  'GET /api/v1/alarms/kpi': 'read',
  'GET /api/v1/alarms/operator-kpi': 'read',
  'GET /api/v1/alarms/floods': 'read',
  'GET /api/v1/alarms/bad-actors': 'read',
  'GET /api/v1/alarms/{id}': 'read',
  'GET /api/v1/alarms/{id}/history': 'read',
  'POST /api/v1/alarms/ack': 'alarm:ack',
  'POST /api/v1/alarms/{id}/ack': 'alarm:ack',
  'POST /api/v1/alarms/{id}/comments': 'alarm:comment',
  'GET /api/v1/alarm-points': 'read',
  'POST /api/v1/alarm-points/{equipment}/{code}/shelve': 'alarm:shelve',
  'POST /api/v1/alarm-points/{equipment}/{code}/unshelve': 'alarm:shelve',
  'GET /api/v1/alarm-points/{equipment}/{code}/audit': 'read',
  'GET /api/v1/plant': 'read',
  'POST /api/v1/session': 'public',
  'GET /api/v1/session': 'session',
  'DELETE /api/v1/session': 'public',
  'POST /api/v1/account/password': 'session',
  'GET /api/v1/users': 'user:admin',
  'POST /api/v1/users': 'user:admin',
  'PUT /api/v1/users/{username}': 'user:admin',
  'POST /api/v1/users/{username}/password': 'user:admin',
  'GET /api/v1/orders': 'read',
  'GET /api/v1/orders/{id}': 'read',
  'GET /api/v1/order-incidents': 'read',
  'POST /api/v1/orders/{id}/release': 'order:release',
  'POST /api/v1/orders/{id}/dispatch': 'order:dispatch',
  'POST /api/v1/orders/{id}/cancel': 'order:cancel',
  'POST /api/v1/orders/{id}/redispatch': 'order:redispatch',
  'POST /api/v1/orders/{id}/close': 'order:close',
  'POST /api/v1/orders/{id}/abandon-command': 'order:abandon',
  'GET /api/v1/execution/units': 'read',
  'GET /api/v1/orders/{id}/execution': 'read',
  'GET /api/v1/scrap-records': 'read',
  'GET /api/v1/scrap-reasons': 'read',
  'GET /api/v1/execution-incidents': 'read',
  'PUT /api/v1/scrap-records/{id}/coding': 'scrap:code',
};

/** Path parameters filled in so the route matches (the handler may still answer 400 or 404). */
const PARAMS: Readonly<Record<string, string>> = {
  id: 'CNC-01',
  date: '2026-10-12',
  shift: 'A',
  noteId: '1',
  equipment: 'CNC-01',
  code: 'X',
  username: 'nobody',
};

describe('authentication on every route (MES_AUTH=on, #168)', () => {
  let app: FastifyInstance;
  let origin: string;
  let base: string;
  const passwords = new Map<string, string>();

  beforeAll(async () => {
    await identity.start();
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      logger: { level: 'trace', stream: { write: (line: string) => logs.push(line) } },
      identity,
      auth: true,
      writeRate: { perSecond: 1e6, burst: 1e6 },
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      sessionCheckMs: 50,
      loginRate: { perSecond: 1e6, burst: 1e6 },
      userLoginRate: { perSecond: 1e6, burst: 1e6 },
    });
    app = http.app;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
    base = origin.replace('http', 'ws');
    for (const role of ROLES) {
      passwords.set(`m-${role}`, await user(`m-${role}`, [role]));
    }
    passwords.set('m-new', secret());
    passwords.set('m-temp', secret());
    await identity.createUser(
      { username: 'm-temp', roles: ['operator'], password: passwords.get('m-temp') ?? '' },
      { system: 'test' },
    );
    await identity.createUser(
      { username: 'm-new', roles: ['supervisor'], password: passwords.get('m-new') ?? '' },
      { system: 'test' },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (
    method: string,
    url: string,
    options: { cookie?: string; body?: unknown; origin?: string | null } = {},
  ) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: {
        host: new URL(origin).host,
        ...(options.origin === null ? {} : { origin: options.origin ?? origin }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { payload: JSON.stringify(options.body ?? {}) }),
    });

  const login = async (username: string, kind: 'desk' | 'terminal' = 'desk') => {
    const response = await send('POST', '/api/v1/session', {
      body: { username, password: passwords.get(username), kind },
    });
    expect(response.statusCode, response.body).toBe(200);
    const header = String(response.headers['set-cookie']);
    const token = cookieValue(header.split(';')[0], 'sft_session') ?? '';
    return { cookie: `sft_session=${token}`, header, token, body: response.json<unknown>() };
  };

  it('compares the route matrix with the OpenAPI document (no route escapes it)', async () => {
    const document = JSON.parse(await readFile(OPENAPI_FILE, 'utf8')) as {
      paths: Record<string, Record<string, { description?: string }>>;
    };
    const routes = Object.entries(document.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const api = routes.filter((route) => route.includes(' /api/v1/'));
    expect(api.sort()).toEqual(Object.keys(ROUTES).sort());
    expect(api).toHaveLength(61);
    expect(routes.filter((r) => !r.includes(' /api/v1/')).sort()).toEqual([
      'GET /health/live',
      'GET /health/ready',
      'GET /metrics',
    ]);
    // The document names each route's access too.
    for (const [path, ops] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const access = ROUTES[`${method.toUpperCase()} ${path}`];
        if (access === undefined) continue;
        const text =
          access === 'public'
            ? 'Access: anyone'
            : access === 'session'
              ? 'Access: a session'
              : `permission \`${access}\``;
        expect(op.description, `${method} ${path}`).toContain(text);
      }
    }
  });

  it('answers each route for anonymous and each role as the matrix declares (401, 403 or through)', async () => {
    const cookies = new Map<string, string>();
    for (const role of ROLES) cookies.set(role, (await login(`m-${role}`)).cookie);
    let compared = 0;
    for (const [route, access] of Object.entries(ROUTES)) {
      const [method = 'GET', path = ''] = route.split(' ');
      const url = path.replace(/\{(\w+)\}/g, (_m, name: string) => PARAMS[name] ?? 'x');
      // Anonymous: 401 everywhere but the login.
      const anonymous = await send(method, url);
      if (access === 'public') expect(anonymous.statusCode, route).not.toBe(401);
      else {
        expect(anonymous.statusCode, route).toBe(401);
        expect(anonymous.json<{ type: string }>().type).toBe(PROBLEM_TYPES.unauthenticated);
      }
      compared++;
      for (const role of ROLES) {
        // A logout would end the session the next routes use: it gets a session of its own.
        const cookie =
          route === 'DELETE /api/v1/session'
            ? (await login(`m-${role}`)).cookie
            : (cookies.get(role) ?? '');
        const response = await send(method, url, { cookie });
        const allowed =
          access === 'public' || access === 'session' || ROLE_PERMISSIONS[role].includes(access);
        if (allowed) {
          expect([401, 403], `${route} as ${role}: ${response.body}`).not.toContain(
            response.statusCode,
          );
        } else {
          expect(response.statusCode, `${route} as ${role}`).toBe(403);
          expect(response.json<{ type: string }>().type).toBe(PROBLEM_TYPES.forbidden);
        }
        compared++;
      }
    }
    expect(compared).toBe(Object.keys(ROUTES).length * (ROLES.length + 1));
  });

  it('sets an HttpOnly, SameSite=Strict cookie and reports the session', async () => {
    const { header, cookie, body } = await login('m-operator', 'terminal');
    expect(header).toMatch(
      /^sft_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    const session = sessionSchema.parse(body);
    expect(session).toMatchObject({ kind: 'terminal', user: { username: 'm-operator' } });
    expect(session.user.permissions).toEqual(
      PERMISSIONS.filter((p) =>
        [
          'read',
          'downtime:code',
          'alarm:ack',
          'alarm:comment',
          'note:write',
          'terminal:operate',
          'scrap:code',
        ].includes(p),
      ),
    );
    const me = await send('GET', '/api/v1/session', { cookie });
    expect(me.statusCode).toBe(200);
    expect(sessionSchema.parse(me.json()).user.username).toBe('m-operator');
    const out = await send('DELETE', '/api/v1/session', { cookie });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ended: true });
    expect(String(out.headers['set-cookie'])).toMatch(/^sft_session=; Max-Age=0; Path=\//);
    expect((await send('GET', '/api/v1/equipment', { cookie })).statusCode).toBe(401);
  });

  it('names the cookie __Host-sft_session and marks it Secure with MES_COOKIE_SECURE=on', async () => {
    const secure = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      cookieSecure: true,
    });
    const response = await secure.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ username: 'm-quality', password: passwords.get('m-quality') }),
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toMatch(
      /^__Host-sft_session=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
    );
    await secure.app.close();
  });

  it('checks Host, Origin and the content type before the session, and the session before the rate', async () => {
    // A cross-site write learns nothing about sessions: 403 for its Origin, not 401.
    const foreign = await send('PUT', '/api/v1/downtime/x/coding', {
      origin: 'http://evil.example',
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json<{ type: string }>().type).toBe(PROBLEM_TYPES.writeOrigin);
    // The login passes the write guards too (login CSRF).
    const noOrigin = await send('POST', '/api/v1/session', {
      origin: null,
      body: { username: 'm-admin', password: passwords.get('m-admin') },
    });
    expect(noOrigin.statusCode).toBe(403);
    const form = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: new URL(origin).host, origin, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(form.statusCode).toBe(415);
    // A failed login: 401 with the one text.
    const wrong = await send('POST', '/api/v1/session', {
      body: { username: 'm-admin', password: 'wrong-password-x' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({
      type: PROBLEM_TYPES.unauthenticated,
      detail: LOGIN_FAILED,
    });
    const unknown = await send('POST', '/api/v1/session', {
      body: { username: 'm-nobody', password: 'wrong-password-x' },
    });
    expect(unknown.json<{ detail: string }>().detail).toBe(LOGIN_FAILED);
    expect(unknown.headers['set-cookie']).toBeUndefined();
    // Health and metrics stay open.
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(200);
  });

  it('lets a user with a temporary password only use the session and password routes', async () => {
    const { cookie } = await login('m-new');
    const read = await send('GET', '/api/v1/equipment', { cookie });
    expect(read.statusCode).toBe(403);
    expect(read.json<{ type: string }>().type).toBe(PROBLEM_TYPES.passwordChangeRequired);
    expect((await send('GET', '/api/v1/session', { cookie })).statusCode).toBe(200);
    const short = await send('POST', '/api/v1/account/password', {
      cookie,
      body: { currentPassword: passwords.get('m-new'), newPassword: 'short' },
    });
    expect(short.statusCode).toBe(422);
    expect(short.json<{ type: string }>().type).toBe(PROBLEM_TYPES.passwordRejected);
    const next = secret();
    const changed = await send('POST', '/api/v1/account/password', {
      cookie,
      body: { currentPassword: passwords.get('m-new'), newPassword: next },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    passwords.set('m-new', next);
    expect((await send('GET', '/api/v1/equipment', { cookie })).statusCode).not.toBe(403);
  });

  it('administers users through the API (user:admin only)', async () => {
    const { cookie } = await login('m-admin');
    const temporary = secret();
    const created = await send('POST', '/api/v1/users', {
      cookie,
      body: { username: 'm-kim', roles: ['maintenance'], password: temporary },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ username: 'm-kim', mustChangePassword: true });
    const again = await send('POST', '/api/v1/users', {
      cookie,
      body: { username: 'm-kim', roles: ['maintenance'], password: temporary },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ type: string }>().type).toBe(PROBLEM_TYPES.userExists);
    const list = await send('GET', '/api/v1/users', { cookie });
    expect(list.json<{ users: { username: string }[] }>().users.map((u) => u.username)).toContain(
      'm-kim',
    );
    const updated = await send('PUT', '/api/v1/users/m-kim', {
      cookie,
      body: { roles: ['maintenance', 'quality'] },
    });
    expect(updated.json()).toMatchObject({ roles: ['maintenance', 'quality'] });
    const reset = await send('POST', '/api/v1/users/m-kim/password', {
      cookie,
      body: { password: secret() },
    });
    expect(reset.statusCode).toBe(200);
    expect((await send('PUT', '/api/v1/users/nobody', { cookie, body: {} })).statusCode).toBe(404);
    // An admin may not write production data (separation of duties).
    const write = await send('POST', '/api/v1/alarms/ack', { cookie, body: { ids: ['x'] } });
    expect(write.statusCode).toBe(403);
  });

  it('closes an anonymous WebSocket with 4401, and a logged-in one when the session ends', async () => {
    const open = (cookie?: string) => {
      // Node's WebSocket (undici) takes request headers, as a browser sends Origin and the cookie.
      const socket = new WebSocket(`${base}${WS_PATH}`, {
        headers: { origin, ...(cookie === undefined ? {} : { cookie }) },
      });
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener('close', (event) => {
          resolve(event.code);
        });
      });
      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve();
        });
        socket.addEventListener('error', reject);
      });
      opened.catch(() => undefined);
      return { socket, closed, opened };
    };
    expect(await open().closed).toBe(WS_CLOSE_UNAUTHENTICATED);
    // Logout closes the session's sockets.
    const a = await login('m-supervisor');
    const ws = open(a.cookie);
    await ws.opened;
    expect((await send('DELETE', '/api/v1/session', { cookie: a.cookie })).statusCode).toBe(200);
    expect(await ws.closed).toBe(WS_CLOSE_UNAUTHENTICATED);
    // Disabling a user closes its sockets.
    const b = await login('m-maintenance');
    const ws2 = open(b.cookie);
    await ws2.opened;
    const admin = await login('m-admin');
    await send('PUT', '/api/v1/users/m-maintenance', {
      cookie: admin.cookie,
      body: { enabled: false },
    });
    expect(await ws2.closed).toBe(WS_CLOSE_UNAUTHENTICATED);
    // An idle session's socket closes once it expires (checked every 50 ms here).
    const c = await login('m-quality');
    const ws3 = open(c.cookie);
    await ws3.opened;
    clock += IDENTITY_LIMITS.idleMs.desk + MINUTE;
    expect(await ws3.closed).toBe(WS_CLOSE_UNAUTHENTICATED);
  });

  it('treats an Upgrade header without a real upgrade as an ordinary request (B1)', async () => {
    const port = Number(new URL(origin).port);
    const host = new URL(origin).host;
    const fake = { upgrade: 'websocket', connection: 'close' };
    // Anonymous, with an allowed Host: 401 on a read, a write and the user list.
    expect((await rawRequest(port, 'GET', '/api/v1/users', { ...fake, host })).status).toBe(401);
    expect((await rawRequest(port, 'GET', '/api/v1/equipment', { ...fake, host })).status).toBe(
      401,
    );
    const write = await rawRequest(
      port,
      'POST',
      '/api/v1/alarms/ack',
      { ...fake, host, origin, 'content-type': 'application/json' },
      '{}',
    );
    expect(write.status).toBe(401);
    // A foreign Host, or a write without Origin: 403.
    expect(
      (await rawRequest(port, 'GET', '/api/v1/users', { ...fake, host: 'evil.example' })).status,
    ).toBe(403);
    const noOrigin = await rawRequest(
      port,
      'POST',
      '/api/v1/alarms/ack',
      { ...fake, host, 'content-type': 'application/json' },
      '{}',
    );
    expect(noOrigin.status).toBe(403);
    // With a session the user list answers only for user:admin.
    const operator = (await login('m-operator')).cookie;
    expect(
      (await rawRequest(port, 'GET', '/api/v1/users', { ...fake, host, cookie: operator })).status,
    ).toBe(403);
    // A real upgrade of another route meets the same guards; of the push route with a foreign
    // Host, 403 before any upgrade.
    const realUpgrade = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    };
    // (@fastify/websocket drops a real upgrade of a route that is not a WebSocket route.)
    const other = await rawRequest(port, 'GET', '/api/v1/users', { ...realUpgrade, host }).then(
      (r) => r.status,
      () => 'closed',
    );
    expect([401, 'closed']).toContain(other);
    expect(
      (await rawRequest(port, 'GET', WS_PATH, { ...realUpgrade, host: 'evil.example' })).status,
    ).toBe(403);
    expect((await rawRequest(port, 'GET', WS_PATH, { ...realUpgrade, host })).status).toBe(101);
  });

  it('answers HEAD, OPTIONS and unknown routes only with a session (L7)', async () => {
    const host = new URL(origin).host;
    expect(
      (await app.inject({ method: 'HEAD', url: '/api/v1/equipment', headers: { host } }))
        .statusCode,
    ).toBe(401);
    const options = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/equipment',
      headers: { host, origin, 'content-type': 'application/json' },
    });
    expect(options.statusCode).toBe(401);
    expect((await send('GET', '/api/v1/nowhere')).statusCode).toBe(401);
    const { cookie } = await login('m-operator');
    expect((await send('GET', '/api/v1/nowhere', { cookie })).statusCode).toBe(404);
    const head = await app.inject({
      method: 'HEAD',
      url: '/api/v1/equipment',
      headers: { host, cookie },
    });
    expect([401, 403]).not.toContain(head.statusCode);
  });

  it('clears the cookie on logout also when the session is gone or the cookie invalid (L4)', async () => {
    for (const cookie of [
      'sft_session=garbage',
      `sft_session=${randomBytes(32).toString('base64url')}`,
    ]) {
      const out = await send('DELETE', '/api/v1/session', { cookie });
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ ended: false });
      expect(String(out.headers['set-cookie'])).toMatch(/^sft_session=; Max-Age=0;/);
    }
  });

  it('closes a socket whose session must change its password with 4403 (M4)', async () => {
    const { cookie } = await login('m-temp');
    const socket = new WebSocket(`${base}${WS_PATH}`, { headers: { origin, cookie } });
    const code = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    expect(code).toBe(WS_CLOSE_FORBIDDEN);
  });

  it('limits each user to 5 writes per second, bursts of 10, beside the global bucket', async () => {
    const limited = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      writeRate: { perSecond: 1e6, burst: 1e6 },
    });
    const headers = (cookie: string) => ({
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
      cookie,
    });
    const supervisor = (await login('m-supervisor')).cookie;
    const operator = (await login('m-operator')).cookie;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/alarms/ack',
        headers: headers(supervisor),
        payload: '{}',
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    const other = await limited.app.inject({
      method: 'POST',
      url: '/api/v1/alarms/ack',
      headers: headers(operator),
      payload: '{}',
    });
    expect(other.statusCode).not.toBe(429);
    await limited.app.close();
  });

  it('never writes a password or a token to the log', () => {
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('login failed');
    for (const password of passwords.values()) expect(text).not.toContain(password);
    expect(text).not.toMatch(/sft_session=[A-Za-z0-9_-]{43}/);
  });
});

describe('MES_AUTH=off (diagnosis only, #170)', () => {
  it('serves reads and the WebSocket without a session; every write needs a session and its permission; the session routes still need one', async () => {
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), identity });
    const { app } = http;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const host = `127.0.0.1:${String(address.port)}`;
    // Not attached: a read passes authentication and gets the module's 503.
    expect((await app.inject({ url: '/api/v1/equipment', headers: { host } })).statusCode).toBe(
      503,
    );
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/json' };
    const ack = (cookie?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/alarms/ack',
        headers: cookie === undefined ? headers : { ...headers, cookie },
        payload: JSON.stringify({ ids: ['1'] }),
      });
    // A write without a session: 401, whatever the route.
    const anonymous = await ack();
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ type: string }>().type).toBe(PROBLEM_TYPES.unauthenticated);
    for (const [method, url] of [
      ['PUT', '/api/v1/downtime/cnc-01~1~1/coding'],
      ['POST', '/api/v1/shifts/2026-10-12/A/notes'],
      ['POST', '/api/v1/alarm-points/CNC-01/X/shelve'],
    ] as const) {
      const response = await app.inject({ method, url, headers, payload: '{}' });
      expect([method, url, response.statusCode]).toEqual([method, url, 401]);
    }
    // A session without the permission (admin holds no alarm:ack): 403.
    const sessionOf = async (username: string, roles: Role[]) => {
      const password = await user(username, roles);
      const { token } = await identity.login({ username, password, kind: 'desk' });
      return `sft_session=${token}`;
    };
    const admin = await ack(await sessionOf('off-admin', ['admin']));
    expect([admin.statusCode, admin.json<{ type: string }>().type]).toEqual([
      403,
      PROBLEM_TYPES.forbidden,
    ]);
    // A session with it: through to the handler (its validation or the 503 of a module not
    // attached), never 401/403.
    const operator = await ack(await sessionOf('off-operator', ['operator']));
    expect([400, 503]).toContain(operator.statusCode);
    expect((await app.inject({ url: '/api/v1/session', headers: { host } })).statusCode).toBe(401);
    const socket = new WebSocket(`ws://${host}${WS_PATH}`);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    socket.close();
    await app.close();
  });

  it('treats an Upgrade header as an ordinary request with MES_AUTH=off too (B1)', async () => {
    const http = await buildMesHttp({ ready: () => Promise.resolve(true), identity });
    await http.app.listen({ host: '127.0.0.1', port: 0 });
    const address = http.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const port = address.port;
    const fake = { upgrade: 'websocket', connection: 'close' };
    expect(
      (await rawRequest(port, 'GET', '/api/v1/users', { ...fake, host: 'evil.example' })).status,
    ).toBe(403);
    expect(
      (await rawRequest(port, 'GET', '/api/v1/equipment', { ...fake, host: 'evil.example' }))
        .status,
    ).toBe(403);
    const noOrigin = await rawRequest(
      port,
      'POST',
      '/api/v1/alarms/ack',
      { ...fake, host: `127.0.0.1:${String(port)}`, 'content-type': 'application/json' },
      '{}',
    );
    expect(noOrigin.status).toBe(403);
    // With MES_AUTH=off the reads need no session, but none answers a foreign Host or a write
    // without Origin (before the session check), Upgrade header or not.
    await http.app.close();
  });

  it('keeps login, logout and the password change open with MES_WRITES=off (M3)', async () => {
    const password = await user('nia', ['operator']);
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      writes: false,
    });
    const headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    const login = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: JSON.stringify({ username: 'nia', password }),
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const change = await http.app.inject({
      method: 'POST',
      url: '/api/v1/account/password',
      headers: { ...headers, cookie },
      payload: JSON.stringify({ currentPassword: password, newPassword: 'short' }),
    });
    expect(change.statusCode).toBe(422);
    const write = await http.app.inject({
      method: 'POST',
      url: '/api/v1/alarms/ack',
      headers: { ...headers, cookie },
      payload: '{}',
    });
    expect(write.statusCode).toBe(405);
    // The Origin guard still holds for the open ones.
    const foreign = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { ...headers, origin: 'http://evil.example' },
      payload: JSON.stringify({ username: 'nia', password }),
    });
    expect(foreign.statusCode).toBe(403);
    const out = await http.app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { ...headers, cookie },
      payload: '{}',
    });
    expect(out.json()).toEqual({ ended: true });
    await http.app.close();
  });

  it('limits logins in buckets of their own, never the write bucket (M2)', async () => {
    const password = await user('ola', ['supervisor']);
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      writeRate: { perSecond: 0.001, burst: 1 },
      userWriteRate: { perSecond: 1e6, burst: 1e6 },
      loginRate: { perSecond: 0.001, burst: 4 },
      userLoginRate: { perSecond: 0.001, burst: 2 },
    });
    const headers = {
      host: 'localhost',
      origin: 'http://localhost',
      'content-type': 'application/json',
    };
    const attempt = (username: string, pw = 'wrong-password-x') =>
      http.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        headers,
        payload: JSON.stringify({ username, password: pw }),
      });
    // Per user name: the third attempt for one name is refused, another name goes on.
    expect((await attempt('ghost-a')).statusCode).toBe(401);
    expect((await attempt('ghost-a')).statusCode).toBe(401);
    const third = await attempt('ghost-a');
    expect(third.statusCode).toBe(429);
    expect(third.json<{ type: string }>().type).toBe(PROBLEM_TYPES.loginRate);
    expect(third.headers['retry-after']).toBeDefined();
    // All logins together: four were taken (two failures, then ghost-b and ola).
    expect((await attempt('ghost-b')).statusCode).toBe(401);
    const ok = await attempt('ola', password);
    expect(ok.statusCode).toBe(200);
    expect((await attempt('ghost-c')).statusCode).toBe(429);
    // The write bucket (one token) was never touched by the logins.
    const cookie = String(ok.headers['set-cookie']).split(';')[0] ?? '';
    const write = await http.app.inject({
      method: 'POST',
      url: '/api/v1/alarms/ack',
      headers: { ...headers, cookie },
      payload: '{}',
    });
    expect(write.statusCode).not.toBe(429);
    await http.app.close();
  });

  it('answers 503 on the session routes until identity has started', async () => {
    const idle = new Identity({ db, sweepMs: 0 });
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: idle,
      auth: true,
    });
    const response = await http.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ username: 'x', password: 'y' }),
    });
    expect(response.statusCode).toBe(503);
    expect(
      (await http.app.inject({ url: '/api/v1/equipment', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(503);
    await http.app.close();
  });
});
