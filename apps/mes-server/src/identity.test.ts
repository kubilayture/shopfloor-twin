import { createHash, randomBytes, scrypt } from 'node:crypto';
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
import { MES_API_LIMITS, PROBLEM_TYPES, sessionSchema } from '@shopfloor/contracts/mes-api';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { parseEnv } from './env.ts';
import { EdgeTrust } from './edge.ts';
import { buildMesHttp } from './http.ts';
import { freshDatabase, ownerOf } from './modules/equipment/test-support.ts';
import {
  IDENTITY_LIMITS,
  Identity,
  IdentityError,
  LOGIN_FAILED,
  LOGIN_RATE,
  LOGIN_THROTTLED,
  UNKNOWN_ADDRESS,
  SCRYPT_MAXMEM,
  SCRYPT_PARAMS,
  Semaphore,
  hashPassword,
  hashesDone,
  hashesStarted,
  LOGIN_HASH_SLOTS,
  needsRehash,
  parseHash,
  parseToken,
  throttleWaitMs,
  verifyPassword,
} from './modules/identity/index.ts';
import { WS_PATH, cookieValue } from './modules/realtime/index.ts';
import { OPENAPI_FILE } from './openapi.ts';
import { appUrl, backendPid, blockedBy, startDatabase } from './testing.ts';
import { createDatabase } from './db/database.ts';
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
    // The module tests run many attempts at once from one address; the N1 test has the real slots.
    hashSlots: { total: 64, perAddress: 64 },
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
    .select(['failed_logins', 'next_attempt_at'])
    .where('username', '=', username)
    .executeTakeFirstOrThrow();

const failureReasons = async (username: string): Promise<string[]> =>
  (await identity.auditOf('user', username))
    .filter((r) => r.action === 'session.login-failed')
    .map((r) => (r.after as { reason: string }).reason);

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
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

async function failedLogin(
  username: string,
  password: string,
  address?: string,
): Promise<IdentityError> {
  const error = await identity.login({ username, password, kind: 'desk', address }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdentityError);
  expect((error as IdentityError).message).toBe(LOGIN_FAILED);
  expect((error as IdentityError).type).toBe(PROBLEM_TYPES.unauthenticated);
  return error as IdentityError;
}

/** A login refused by the global delay (#242): 429's error, no hash; its Retry-After. */
async function throttledLogin(
  username: string,
  password: string,
  address?: string,
): Promise<number> {
  const hashes = hashesStarted();
  const error = await identity.login({ username, password, kind: 'desk', address }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdentityError);
  expect(error).toMatchObject({
    kind: 'throttled',
    message: LOGIN_THROTTLED,
    type: PROBLEM_TYPES.loginRate,
  });
  expect(hashesStarted()).toBe(hashes);
  return (error as IdentityError).retryAfterS ?? Number.NaN;
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
        .select(['next_attempt_at'])
        .where('username', '=', 'root')
        .executeTakeFirstOrThrow();
      delays.push(row.next_attempt_at ? row.next_attempt_at.getTime() - clock : 0);
      // Within the delay even the right password is refused: 429 with the remaining wait and no
      // hash (#264 review, F3; a plain 401 before), the admin's own delay or the global one.
      if (row.next_attempt_at) {
        expect(await throttledLogin('root', password)).toBe(
          Math.ceil((row.next_attempt_at.getTime() - clock) / 1000),
        );
        clock = row.next_attempt_at.getTime();
      }
    }
    // An admin has no pair lock either.
    expect(
      await db
        .selectFrom('identity.login_address')
        .selectAll()
        .where('locked_until', 'is not', null)
        .execute(),
    ).not.toContainEqual(expect.objectContaining({ user_id: (await identity.user('root')).id }));
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
    await waitFor(async () =>
      (await pairs('kai')).some((p) => p.address === UNKNOWN_ADDRESS && p.failed_logins >= 5),
    );
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
    // Within the admin's delay: 429 with Retry-After, no hash (#264 review, F3).
    expect(await throttledLogin('adm2', password)).toBe(1);
    await Promise.all(burst);
    const reasons = await failureReasons('adm2');
    expect(reasons.filter((r) => r === 'wrong-password')).toHaveLength(5);
    // The seven others of the burst were 429s: neither hashed nor audited.
    expect(reasons).toHaveLength(5);
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

  // Login throttling (#242, P9-15, checklist S5, ADR-0039 amendment).

  /** The pairs (account, address) of a user, with their counts and locks. */
  const pairs = async (username: string) =>
    db
      .selectFrom('identity.login_address as a')
      .innerJoin('identity.user_account as u', 'u.id', 'a.user_id')
      .select(['a.address', 'a.failed_logins', 'a.locked_until'])
      .where('u.username', '=', username)
      // Pairs with failures: a success keeps its pair at 0 failures (its exemption, F3).
      .where('a.failed_logins', '>', 0)
      .orderBy('a.address')
      .execute();
  /** n: the user's judged failures in the 15-minute window. */
  const judged = async (username: string): Promise<number> =>
    (
      await db
        .selectFrom('identity.login_failure as f')
        .innerJoin('identity.user_account as u', 'u.id', 'f.user_id')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('u.username', '=', username)
        .where('f.at', '>', new Date(clock - IDENTITY_LIMITS.throttleWindowMs))
        .executeTakeFirstOrThrow()
    ).n;

  it('locks a user per (account, address): five failures from one address leave every other address open (#242, S5)', async () => {
    const password = await user('pia', ['operator']);
    const a = '10.20.0.1';
    const b = '10.20.0.2';
    for (let i = 0; i < 5; i++) await failedLogin('pia', 'wrong-password-x', a);
    expect((await identity.user('pia')).locked).toBe(true);
    // From the locked address even the right password is refused, with the same answer.
    await failedLogin('pia', password, a);
    // From another address the user logs in; that success clears n and b's pair, not a's lock.
    await identity.login({ username: 'pia', password, kind: 'desk', address: b });
    await failedLogin('pia', password, a);
    expect(await pairs('pia')).toEqual([
      { address: a, failed_logins: 5, locked_until: new Date(clock + IDENTITY_LIMITS.lockMs) },
    ]);
    expect(await judged('pia')).toBe(0);
    const audit = await identity.auditOf('user', 'pia');
    expect(audit.filter((r) => r.action === 'user.locked').map((r) => r.after)).toEqual([
      {
        failures: 5,
        lockedUntil: new Date(clock + IDENTITY_LIMITS.lockMs).toISOString(),
        address: a,
      },
    ]);
    expect(await failureReasons('pia')).toEqual([
      ...Array<string>(5).fill('wrong-password'),
      'locked',
      'locked',
    ]);
    // Every failure names its address; a call without one is keyed `unknown`.
    expect(
      audit
        .filter((r) => r.action === 'session.login-failed')
        .every((r) => (r.after as { address: string }).address === a),
    ).toBe(true);
    await failedLogin('pia', 'wrong-password-x');
    expect((await pairs('pia')).map((p) => p.address)).toEqual([a, UNKNOWN_ADDRESS]);
    // The lock runs out after 15 minutes.
    clock += IDENTITY_LIMITS.lockMs + 1_000;
    expect((await identity.user('pia')).locked).toBe(false);
    await identity.login({ username: 'pia', password, kind: 'desk', address: a });
    expect((await pairs('pia')).map((p) => p.address)).toEqual([UNKNOWN_ADDRESS]);
  });

  it('delays a user globally from 10 failures in 15 minutes: min(2^(n-10) s, 30 s) after the last, 429 without a hash, never counted, never a lock (#242, S5)', async () => {
    expect([0, 9, 10, 11, 12, 13, 14, 15, 16, 40].map(throttleWaitMs)).toEqual([
      0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    const password = await user('quinn', ['operator']);
    // Every failure from an address of its own: no pair ever locks, only the global delay acts.
    let next = 0;
    const fresh = (): string => `10.30.0.${String(++next)}`;
    for (let i = 1; i <= 9; i++) {
      await failedLogin('quinn', 'wrong-password-x', fresh());
      clock += 100;
    }
    // Nine: no delay yet.
    await failedLogin('quinn', 'wrong-password-x', fresh());
    expect(await judged('quinn')).toBe(10);
    // n = 10: 1 s after the last failure, whoever asks, the right password included.
    expect(await throttledLogin('quinn', password, fresh())).toBe(1);
    clock += 400;
    expect(await throttledLogin('quinn', password, fresh())).toBe(1);
    expect(await judged('quinn')).toBe(10);
    // Once the wait is over the next attempt is judged: n = 11, a 2 s wait, and so on.
    const waits: number[] = [];
    for (let n = 11; n <= 16; n++) {
      clock += throttleWaitMs(n - 1);
      await failedLogin('quinn', 'wrong-password-x', fresh());
      expect(await judged('quinn')).toBe(n);
      waits.push(await throttledLogin('quinn', password, fresh()));
    }
    expect(waits).toEqual([2, 4, 8, 16, 30, 30]);
    // The remaining wait, rounded up.
    clock += 10_500;
    expect(await throttledLogin('quinn', password, fresh())).toBe(20);
    clock += 19_499;
    expect(await throttledLogin('quinn', password, fresh())).toBe(1);
    // None of the 429s counted.
    expect(await judged('quinn')).toBe(16);
    expect((await identity.user('quinn')).locked).toBe(false);
    // Never a lock: once the wait has passed the right password gets in, and n resets.
    clock += 1;
    await identity.login({ username: 'quinn', password, kind: 'desk', address: fresh() });
    expect(await judged('quinn')).toBe(0);
    // n falls as failures leave the window: ten, then 15 minutes later one more is judged.
    for (let i = 0; i < 10; i++) await failedLogin('quinn', 'wrong-password-x', fresh());
    expect(await throttledLogin('quinn', password, fresh())).toBe(1);
    clock += IDENTITY_LIMITS.throttleWindowMs;
    await failedLogin('quinn', 'wrong-password-x', fresh());
    expect(await judged('quinn')).toBe(1);
    // The sweep deletes failures past the window.
    clock += IDENTITY_LIMITS.throttleWindowMs;
    await identity.sweep();
    const left = await db
      .selectFrom('identity.login_failure')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('at', '<=', new Date(clock - IDENTITY_LIMITS.throttleWindowMs))
      .executeTakeFirstOrThrow();
    expect(left.n).toBe(0);
  });

  it('reads the time of a decision once it holds the row lock, never before (#242 gate: Retry-After 31)', async () => {
    await user('sol', ['operator']);
    // Another transaction holds the user's row; an attempt made now waits for it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let holderPid = 0;
    const holder = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('identity.user_account')
        .select('id')
        .where('username', '=', 'sol')
        .forUpdate()
        .execute();
      holderPid = await backendPid(trx);
      locked();
      await held;
    });
    await isLocked;
    const waiting = failedLogin('sol', 'wrong-password-x', '10.50.0.1');
    // Until the attempt waits for the row lock, not a fixed 100 ms (#347).
    await blockedBy(db, holderPid, 'the login waiting for the row lock');
    clock += 5_000;
    const decidedAt = clock;
    release();
    await holder;
    await waiting;
    const [failure] = await db
      .selectFrom('identity.login_failure as f')
      .innerJoin('identity.user_account as u', 'u.id', 'f.user_id')
      .select('f.at')
      .where('u.username', '=', 'sol')
      .execute();
    expect(failure?.at.getTime()).toBe(decidedAt);
  });

  it('applies the global delay to a password change too: 429 before the hash (#242)', async () => {
    const password = await user('ria', ['quality']);
    const { principal } = await identity.login({ username: 'ria', password, kind: 'desk' });
    for (let i = 0; i < 10; i++) {
      await failedLogin('ria', 'wrong-password-x', `10.40.0.${String(i)}`);
    }
    // From an address that never logged in (the login above, keyed `unknown`, is exempt).
    const hashes = hashesStarted();
    await expect(
      identity.changePassword(principal, password, secret(), undefined, '10.40.0.50'),
    ).rejects.toMatchObject({
      kind: 'throttled',
      retryAfterS: 1,
    });
    expect(hashesStarted()).toBe(hashes);
    clock += 1_000;
    await identity.changePassword(principal, password, secret(), undefined, '10.40.0.99');
    expect(await judged('ria')).toBe(0);
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

  it('defaults MES_AUTH to on (#170) and MES_COOKIE_SECURE to on (#241); the bootstrap password is optional and hidden', () => {
    const parsed = parseEnv(base);
    expect(parsed.ok && parsed.env.MES_AUTH).toBe('on');
    expect(parseEnv({ ...base, MES_AUTH: 'off' })).toMatchObject({
      ok: true,
      env: { MES_AUTH: 'off' },
    });
    // Secure by default (P9-14, ADR-0039): plain HTTP straight to the MES sets it off explicitly.
    expect(parsed.ok && parsed.env.MES_COOKIE_SECURE).toBe('on');
    expect(parseEnv({ ...base, MES_COOKIE_SECURE: 'off' })).toMatchObject({
      ok: true,
      env: { MES_COOKIE_SECURE: 'off' },
    });
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
  'GET /api/v1/oee/orders/{id}': 'read',
  'GET /api/v1/oee/line': 'read',
  'GET /api/v1/oee/line/orders': 'read',
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
  'GET /api/v1/trace/serials/{serial}': 'read',
  'GET /api/v1/trace/lots/{lot}': 'read',
  'GET /api/v1/trace/cartons/{carton}': 'read',
  'GET /api/v1/trace/search': 'read',
  'GET /api/v1/genealogy-incidents': 'read',
  'GET /api/v1/terminal/{workCenter}': 'read',
  'POST /api/v1/terminal/{workCenter}/sign-on': 'terminal:operate',
  'POST /api/v1/terminal/{workCenter}/sign-off': 'terminal:operate',
  'POST /api/v1/terminal/{workCenter}/orders/{id}/operations/{operation}/start': 'terminal:operate',
  'POST /api/v1/terminal/{workCenter}/orders/{id}/operations/{operation}/pause': 'terminal:operate',
  'POST /api/v1/terminal/{workCenter}/orders/{id}/operations/{operation}/resume':
    'terminal:operate',
  'POST /api/v1/terminal/{workCenter}/orders/{id}/operations/{operation}/sign-off':
    'terminal:operate',
  'GET /api/v1/quality/characteristics': 'read',
  'GET /api/v1/quality/characteristics/{id}': 'read',
  'GET /api/v1/quality/characteristics/{id}/chart': 'read',
  'GET /api/v1/quality/characteristics/{id}/measurements': 'read',
  'GET /api/v1/quality/signals': 'read',
  'POST /api/v1/quality/characteristics/{id}/limits': 'spc:limits',
  'POST /api/v1/quality/characteristics/{id}/limits/{version}/end': 'spc:limits',
  'POST /api/v1/quality/signals/{id}/ack': 'spc:ack',
  // Quality holds (#201).
  'GET /api/v1/quality/holds': 'read',
  'GET /api/v1/quality/holds/{id}': 'read',
  'GET /api/v1/quality/hold-reasons': 'read',
  'GET /api/v1/quality/hold-incidents': 'read',
  'GET /api/v1/quality/signals/{id}/hold-suggestion': 'read',
  'POST /api/v1/quality/holds': 'quality:hold',
  'POST /api/v1/quality/holds/{id}/comments': 'quality:hold',
  'POST /api/v1/quality/holds/{id}/release': 'quality:release',
  'POST /api/v1/quality/holds/{id}/reject': 'quality:release',
  // The console's permission check (#237): nginx's auth_request.
  'GET /api/v1/session/permission/{permission}': 'sim:control',
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
  workCenter: 'line-a1',
  operation: 'OP30',
  serial: 'VB-100-000001',
  lot: 'BL100-2610-01',
  carton: 'PO-2610-101-C01',
  version: '1',
  permission: 'sim:control',
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
    expect(api).toHaveLength(94);
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
    // Exit criterion 1 (#178): each user administration and the admin's login are audited with
    // the user, its roles, `authenticated` and the request id.
    const audit = await db
      .selectFrom('identity.audit_log')
      .select(['action', 'username', 'roles', 'authenticated', 'request_id', 'entity_id'])
      .where('username', '=', 'm-admin')
      .where('action', 'in', ['session.login', 'user.create', 'user.update', 'user.password-reset'])
      .orderBy('id')
      .execute();
    const forKim = audit.filter((r) => r.entity_id === 'm-kim').map((r) => r.action);
    expect(forKim).toEqual(['user.create', 'user.update', 'user.password-reset']);
    expect(audit.some((r) => r.action === 'session.login')).toBe(true);
    for (const row of audit) {
      expect([row.action, row.roles, row.authenticated]).toEqual([row.action, ['admin'], true]);
      expect(row.request_id).toMatch(/\S/);
    }
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

// ---------------------------------------------------------------------------------------------
// The console's permission check (#237): sim:control, and the session-use rule.

describe('console permission check and session use (#237)', () => {
  /** nginx's address on the `edge` network of this test, and one outside it. */
  const EDGE = '10.89.3.0/24';
  const NGINX = '::ffff:10.89.3.7';
  const OUTSIDE = '172.18.0.9';
  let app: FastifyInstance;
  let registry: { metrics(): Promise<string> };
  const host = 'localhost:8080';
  const origin = `http://${host}`;
  const passwords = new Map<string, string>();

  beforeAll(async () => {
    await identity.start();
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      loginRate: { perSecond: 1e6, burst: 1e6 },
      userLoginRate: { perSecond: 1e6, burst: 1e6 },
    });
    app = http.app;
    registry = http.registry;
    for (const role of ROLES) passwords.set(`c-${role}`, await user(`c-${role}`, [role]));
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (username: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host, origin, 'content-type': 'application/json' },
      payload: JSON.stringify({ username, password: passwords.get(username) }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const header = String(response.headers['set-cookie']);
    return `sft_session=${cookieValue(header.split(';')[0], 'sft_session') ?? ''}`;
  };

  /** nginx's subrequest: a GET with the console request's method in X-Original-Method. */
  const check = (
    cookie: string | undefined,
    options: { method?: string; from?: string; permission?: string } = {},
  ) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/session/permission/${options.permission ?? 'sim:control'}`,
      remoteAddress: options.from ?? NGINX,
      headers: {
        host,
        'x-real-ip': '127.0.0.1',
        ...(options.method === undefined ? {} : { 'x-original-method': options.method }),
        ...(cookie === undefined ? {} : { cookie }),
      },
    });

  const lastUsed = async (cookie: string): Promise<number> => {
    const token = tokenOf(cookie.split('=')[1] ?? '');
    const row = await db
      .selectFrom('identity.session')
      .select('last_used_at')
      .where('token_hash', '=', createHash('sha256').update(token).digest())
      .executeTakeFirstOrThrow();
    return row.last_used_at.getTime();
  };

  it('answers 204 for admin, 403 for every other role, 401 anonymous', async () => {
    expect((await check(undefined)).statusCode).toBe(401);
    for (const role of ROLES) {
      const response = await check(await login(`c-${role}`));
      if (role === 'admin') expect(response.statusCode, role).toBe(204);
      else {
        expect(response.statusCode, role).toBe(403);
        expect(response.json<{ type: string }>().type).toBe(PROBLEM_TYPES.forbidden);
      }
    }
    // Only sim:control is a permission this route checks.
    const admin = await login('c-admin');
    expect((await check(admin, { permission: 'user:admin' })).statusCode).toBe(400);
    expect((await check(admin, { permission: 'read' })).statusCode).toBe(400);
  });

  it('counts only a non-GET console action from the edge network as session use', async () => {
    const cookie = await login('c-admin');
    let used = await lastUsed(cookie);
    const step = async (
      options: { method?: string; from?: string },
      expected: 'touched' | 'untouched',
    ) => {
      clock += 2 * MINUTE;
      expect((await check(cookie, options)).statusCode).toBe(204);
      const after = await lastUsed(cookie);
      if (expected === 'touched') expect(after, JSON.stringify(options)).toBe(clock);
      else expect(after, JSON.stringify(options)).toBe(used);
      used = after;
    };
    // The 1 s status poll: a GET (or no method at all) never moves the idle expiry.
    await step({ method: 'GET' }, 'untouched');
    await step({ method: 'HEAD' }, 'untouched');
    await step({}, 'untouched');
    // A console action from nginx over edge does, also with an IPv4-mapped source.
    await step({ method: 'POST' }, 'touched');
    await step({ method: 'put' }, 'touched');
    await step({ method: 'POST', from: '10.89.3.7' }, 'touched');
    // The same header from outside the edge network is not believed.
    await step({ method: 'POST', from: OUTSIDE }, 'untouched');
    await step({ method: 'POST', from: '127.0.0.1' }, 'untouched');
    // Any other route keeps counting every request as use.
    clock += 2 * MINUTE;
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      remoteAddress: OUTSIDE,
      headers: { host, cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(await lastUsed(cookie)).toBe(clock);
  });

  it("refuses an Origin whose scheme isn't the front's X-Forwarded-Proto, from the edge network only (#241 review)", async () => {
    const password = passwords.get('c-operator') ?? '';
    const write = (from: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/session',
        remoteAddress: from,
        headers: { host, 'content-type': 'application/json', 'x-real-ip': '127.0.0.1', ...headers },
        payload: JSON.stringify({ username: 'c-operator', password }),
      });
    const https = `https://${host}`;
    // Through nginx: the browser's https Origin with nginx's X-Forwarded-Proto passes.
    expect((await write(NGINX, { origin: https, 'x-forwarded-proto': 'https' })).statusCode).toBe(
      200,
    );
    // The same host and port as http://, or no X-Forwarded-Proto at all: refused before the login.
    for (const headers of [
      { origin, 'x-forwarded-proto': 'https' },
      { origin: https },
      { origin: https, 'x-forwarded-proto': 'http, https' },
    ]) {
      const refused = await write(NGINX, headers);
      expect(refused.statusCode, JSON.stringify(headers)).toBe(403);
      expect(refused.json<{ type: string; detail: string }>()).toMatchObject({
        type: PROBLEM_TYPES.writeOrigin,
        detail: expect.stringMatching(/X-Forwarded-Proto/) as string,
      });
    }
    // A read carrying an Origin is held to the same rule.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      remoteAddress: NGINX,
      headers: { host, origin, 'x-forwarded-proto': 'https', 'x-real-ip': '127.0.0.1' },
    });
    expect(read.statusCode).toBe(403);
    // Outside the edge network the header isn't believed, so the scheme isn't judged (ADR-0023).
    expect((await write(OUTSIDE, { origin, 'x-forwarded-proto': 'https' })).statusCode).toBe(200);
  });

  it('refuses a WebSocket upgrade from the edge network with an http:// Origin or without X-Forwarded-Proto (403, #241 review, #242)', async () => {
    // A listening MES (an upgrade can't be injected) whose edge network holds the loopback
    // address the test connects from, so the upgrade comes "from nginx".
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      edge: new EdgeTrust('127.0.0.0/8'),
    });
    await http.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = http.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const port = address.port;
      const wsHost = `127.0.0.1:${String(port)}`;
      const upgrade = {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        host: wsHost,
        'x-real-ip': '127.0.0.1',
      };
      const status = async (headers: Record<string, string>) =>
        (await rawRequest(port, 'GET', WS_PATH, { ...upgrade, ...headers })).status;
      // The page's own https origin with nginx's X-Forwarded-Proto upgrades (and is then closed
      // with 4401: no session).
      expect(await status({ origin: `https://${wsHost}`, 'x-forwarded-proto': 'https' })).toBe(101);
      // An http:// origin of the same host and port, or no X-Forwarded-Proto at all: 403 before
      // any upgrade (`schemeRefusedUpgrades`).
      expect(await status({ origin: `http://${wsHost}`, 'x-forwarded-proto': 'https' })).toBe(403);
      expect(await status({ origin: `https://${wsHost}` })).toBe(403);
      expect(await status({ origin: `http://${wsHost}` })).toBe(403);
    } finally {
      await http.app.close();
    }
  });

  it('counts proxied requests by whether they came over the edge network', async () => {
    const before = await registry.metrics();
    const value = (text: string, trusted: string): number =>
      Number(
        new RegExp(`^mes_http_proxy_requests_total\\{trusted="${trusted}"\\} (\\d+)$`, 'm').exec(
          text,
        )?.[1] ?? 'NaN',
      );
    const cookie = await login('c-admin');
    await check(cookie, { method: 'GET' });
    await check(cookie, { method: 'GET', from: OUTSIDE });
    // Without X-Real-IP a request is not a proxied one, from wherever it comes.
    await app.inject({ method: 'GET', url: '/health/live', remoteAddress: OUTSIDE });
    const after = await registry.metrics();
    expect(value(after, 'true') - value(before, 'true')).toBe(1);
    expect(value(after, 'false') - value(before, 'false')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Login throttling over HTTP (#242, P9-15, checklist S5): the address from X-Real-IP only over
// the edge network, the pair lock, and the deterministic burst under the row lock.

describe('login throttling over HTTP (#242, S5)', () => {
  /** The edge network of this test, nginx's address on it, and a client outside it. */
  const EDGE = '10.89.5.0/24';
  const NGINX = '10.89.5.2';
  const OUTSIDE = '172.18.0.9';
  const host = 'localhost:8443';
  const origin = `https://${host}`;
  let app: FastifyInstance;
  let registry: { metrics(): Promise<string> };

  beforeAll(async () => {
    await identity.start();
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      // The login buckets run on real time; the throttling under test runs on the test's clock.
      loginRate: { perSecond: 1e6, burst: 1e6 },
      userLoginRate: { perSecond: 1e6, burst: 1e6 },
    });
    app = http.app;
    registry = http.registry;
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * A login: through nginx (from its address on edge, the client in X-Real-IP, the scheme in
   * X-Forwarded-Proto) by default, or straight from `from` with whatever headers it sends.
   */
  const attempt = (
    username: string,
    password: string,
    options: { readonly client?: string; readonly from?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      remoteAddress: options.from ?? NGINX,
      headers: {
        host,
        origin,
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        ...(options.client === undefined ? {} : { 'x-real-ip': options.client }),
      },
      payload: JSON.stringify({ username, password }),
    });

  const pairsOf = async (username: string) =>
    db
      .selectFrom('identity.login_address as a')
      .innerJoin('identity.user_account as u', 'u.id', 'a.user_id')
      .select(['a.address', 'a.failed_logins', 'a.locked_until'])
      .where('u.username', '=', username)
      // Pairs with failures: a success keeps its pair at 0 failures (its exemption, F3).
      .where('a.failed_logins', '>', 0)
      .orderBy('a.address')
      .execute();
  const nOf = async (username: string): Promise<number> =>
    (
      await db
        .selectFrom('identity.login_failure as f')
        .innerJoin('identity.user_account as u', 'u.id', 'f.user_id')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('u.username', '=', username)
        .where('f.at', '>', new Date(clock - IDENTITY_LIMITS.throttleWindowMs))
        .executeTakeFirstOrThrow()
    ).n;
  const untrusted = async (): Promise<number> =>
    Number(
      /^mes_http_proxy_requests_total\{trusted="false"\} (\d+)$/m.exec(
        await registry.metrics(),
      )?.[1] ?? 'NaN',
    );

  it('keys a login by X-Real-IP only over the edge network: a lock from one client leaves another open; a spoofed header from elsewhere is ignored', async () => {
    const password = await user('h-ana', ['operator']);
    const a = '192.168.65.11';
    const b = '192.168.65.12';
    // Client a, through nginx: five failures lock (h-ana, a).
    for (let i = 0; i < 5; i++) {
      expect((await attempt('h-ana', 'wrong-password-x', { client: a })).statusCode).toBe(401);
    }
    expect((await attempt('h-ana', password, { client: a })).statusCode).toBe(401);
    // Client b, through nginx: in.
    expect((await attempt('h-ana', password, { client: b })).statusCode).toBe(200);
    expect((await pairsOf('h-ana')).map((p) => p.address)).toEqual([a]);
    // A container on the default network sends its own X-Real-IP straight to mes:4700: not
    // believed. Its failures land on its own address, never on b's, and b stays open.
    const spoofedBefore = await untrusted();
    for (let i = 0; i < 5; i++) {
      const spoofed = await attempt('h-ana', 'wrong-password-x', { client: b, from: OUTSIDE });
      expect(spoofed.statusCode).toBe(401);
    }
    expect(await untrusted()).toBe(spoofedBefore + 5);
    expect((await pairsOf('h-ana')).map((p) => p.address)).toEqual([OUTSIDE, a]);
    expect((await attempt('h-ana', password, { client: b })).statusCode).toBe(200);
    // Nor can a spoofed header dodge the sender's own lock.
    const dodge = await attempt('h-ana', password, { client: '203.0.113.7', from: OUTSIDE });
    expect(dodge.statusCode).toBe(401);
    // Through nginx with a value that isn't an address (nginx always sets one), the connection's
    // address counts: nginx's own.
    const garbage = await attempt('h-ana', 'wrong-password-x', { client: 'not-an-ip' });
    expect(garbage.statusCode).toBe(401);
    expect((await pairsOf('h-ana')).map((p) => p.address)).toContain(NGINX);
    // An IPv4-mapped source and client are stored as IPv4.
    const mapped = await attempt('h-ana', 'wrong-password-x', {
      client: '::ffff:192.168.65.13',
      from: `::ffff:${NGINX}`,
    });
    expect(mapped.statusCode).toBe(401);
    expect((await pairsOf('h-ana')).map((p) => p.address)).toContain('192.168.65.13');
  });

  it('judges exactly one of a burst of 20 from a fresh third address once the wait of n >= 15 expires; 19 get 429 with the remaining wait rounded up, uncounted (deterministic burst)', async () => {
    const password = await user('h-ben', ['operator']);
    const [a, b, c, d] = ['192.168.70.1', '192.168.70.2', '192.168.70.3', '192.168.70.4'];
    // n to 10 from a and b (five each: both pairs lock), then to 15 from c, each judged attempt
    // once the previous wait is over: n = 15, a 30 s wait.
    for (const client of [a, b]) {
      for (let i = 0; i < 5; i++) {
        expect((await attempt('h-ben', 'wrong-password-x', { client })).statusCode).toBe(401);
      }
    }
    for (let n = 11; n <= 15; n++) {
      // Inside the wait: 429 with the remaining time, not counted.
      const early = await attempt('h-ben', 'wrong-password-x', { client: c });
      expect(early.statusCode).toBe(429);
      expect(early.headers['retry-after']).toBe(String(throttleWaitMs(n - 1) / 1000));
      clock += throttleWaitMs(n - 1);
      expect((await attempt('h-ben', 'wrong-password-x', { client: c })).statusCode).toBe(401);
    }
    expect(await nOf('h-ben')).toBe(15);
    expect(throttleWaitMs(15)).toBe(30_000);
    // Let the 30 s wait expire.
    clock += 30_000;
    // The burst: 20 at once from d, a fresh address (no pair lock applies). The user's row lock
    // serializes them: the first is judged (n = 16, a new 30 s wait), the 19 others find that wait.
    const hashes = hashesStarted();
    const burst = await Promise.all(
      Array.from({ length: 20 }, () => attempt('h-ben', 'wrong-password-x', { client: d })),
    );
    expect(burst.map((r) => r.statusCode).sort()).toEqual([401, ...Array<number>(19).fill(429)]);
    for (const refused of burst.filter((r) => r.statusCode === 429)) {
      expect(refused.headers['retry-after']).toBe('30');
      expect(refused.json<{ type: string; detail: string }>()).toMatchObject({
        type: PROBLEM_TYPES.loginRate,
        detail: LOGIN_THROTTLED,
      });
    }
    // Exactly one judged: one hash, n = 16, d's pair counts one failure.
    expect(hashesStarted() - hashes).toBe(1);
    expect(await nOf('h-ben')).toBe(16);
    expect((await pairsOf('h-ben')).find((p) => p.address === d)?.failed_logins).toBe(1);
    // Retry-After is the remaining wait rounded up: 19.5 s left answers 20.
    clock += 10_500;
    const later = await attempt('h-ben', password, { client: d });
    expect(later.statusCode).toBe(429);
    expect(later.headers['retry-after']).toBe('20');
    // Never a lock: once the wait is over, the right password from d gets in, and n resets.
    clock += 19_500;
    expect((await attempt('h-ben', password, { client: d })).statusCode).toBe(200);
    expect(await nOf('h-ben')).toBe(0);
    // a, b and c stay locked for themselves.
    expect((await attempt('h-ben', password, { client: a })).statusCode).toBe(401);
  });

  it('keeps the victim in while an attacker address hammers its name and random names (#264 review, F2)', async () => {
    const password = await user('h-dan', ['operator']);
    // The real buckets: per address 5/s (10), per (name, address) 1/s (5), ceiling 10/s (20), on
    // a clock that stands still (#347): none refills, however slowly a loaded machine answers, so
    // what they admit is exact.
    const real = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      loginClock: () => 0,
    });
    try {
      const send = (username: string, pw: string, client: string) =>
        real.app.inject({
          method: 'POST',
          url: '/api/v1/session',
          remoteAddress: NGINX,
          headers: {
            host,
            origin,
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
            'x-real-ip': client,
          },
          payload: JSON.stringify({ username, password: pw }),
        });
      const attacker = '198.51.100.66';
      const victim = '192.168.90.10';
      const answers: number[] = [];
      for (let i = 0; i < 60; i++) {
        answers.push((await send('h-dan', 'wrong-password-x', attacker)).statusCode);
        answers.push((await send(`ghost-${String(i)}`, 'wrong-password-x', attacker)).statusCode);
      }
      // The attacker's own address bucket admits its burst (10: five of h-dan, five ghosts) and
      // refuses the rest (429); its pair locks after five judged failures.
      const { loginBurst, loginCeilingBurst } = MES_API_LIMITS;
      expect(answers.filter((s) => s === 401)).toHaveLength(loginBurst);
      expect(answers.filter((s) => s === 429)).toHaveLength(120 - loginBurst);
      expect((await pairsOf('h-dan')).map((p) => p.address)).toEqual([attacker]);
      // The victim, from its own address, is in at once: its own buckets are untouched, and the
      // shared ceiling still holds what the attacker's address bucket kept from it.
      expect(loginCeilingBurst).toBeGreaterThan(loginBurst);
      expect((await send('h-dan', password, victim)).statusCode).toBe(200);
    } finally {
      await real.app.close();
    }
  });

  it('exempts an address that logged in within the window from the global delay; others wait (#264 review, F3)', async () => {
    const password = await user('h-fay', ['operator']);
    const home = '192.168.91.10';
    expect((await attempt('h-fay', password, { client: home })).statusCode).toBe(200);
    // Attackers on three addresses drive n to 10: the global delay starts.
    for (const client of ['198.51.100.1', '198.51.100.2']) {
      for (let i = 0; i < 5; i++) {
        expect((await attempt('h-fay', 'wrong-password-x', { client })).statusCode).toBe(401);
      }
    }
    expect(await nOf('h-fay')).toBe(10);
    const elsewhere = await attempt('h-fay', password, { client: '192.168.91.99' });
    expect(elsewhere.statusCode).toBe(429);
    // The address that logged in within the 15 minutes is not held up.
    expect((await attempt('h-fay', password, { client: home })).statusCode).toBe(200);
    // Past the window the exemption ends with it.
    clock += IDENTITY_LIMITS.throttleWindowMs + 1_000;
    expect((await attempt('h-fay', password, { client: home })).statusCode).toBe(200);
  });

  it("answers an admin's delay with 429 and its Retry-After, not a plain 401 (#264 review, F3)", async () => {
    const password = await user('h-gus', ['admin']);
    for (let i = 0; i < 5; i++) {
      expect(
        (await attempt('h-gus', 'wrong-password-x', { client: '198.51.100.20' })).statusCode,
      ).toBe(401);
    }
    const delayed = await attempt('h-gus', password, { client: '192.168.92.1' });
    expect(delayed.statusCode).toBe(429);
    expect(delayed.headers['retry-after']).toBe('1');
    clock += IDENTITY_LIMITS.adminDelayBaseMs;
    expect((await attempt('h-gus', password, { client: '192.168.92.1' })).statusCode).toBe(200);
    await identity.updateUser('h-gus', { enabled: false }, { system: 'test' });
  });

  it('keeps authenticated reads answered while logins hold every connection of the login pool and a flood waits (#264 review, F1)', async () => {
    // The MES's shape: two connections for sessions, two of their own for logins.
    const name = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db))
      .rows[0]?.name;
    if (name === undefined) throw new Error('no database');
    const sessionsDb = createDatabase(appUrl(serverUrl, name), 2);
    const loginsDb = createDatabase(appUrl(serverUrl, name), 2);
    const flooded = new Identity({
      db: sessionsDb,
      loginDb: loginsDb,
      loginPoolSize: 2,
      now,
      sweepMs: 0,
    });
    await flooded.start();
    const http = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: flooded,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      // The real buckets on a clock that stands still (#347).
      loginClock: () => 0,
    });
    // Four users whose rows another transaction holds: a login of each waits for that lock
    // inside its reservation, on a connection of the login pool, for as long as the test says.
    const blockers = ['h-hal-a', 'h-hal-b', 'h-hal-c', 'h-hal-d'];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding: (pid: number) => void = () => undefined;
    const holderPid = new Promise<number>((resolve) => (holding = resolve));
    let holder: Promise<void> | undefined;
    const pending: Promise<number>[] = [];
    try {
      const password = await user('h-hal', ['operator']);
      for (const blocker of blockers) await user(blocker, ['operator']);
      const loginAs = (username: string, pw: string, client: string) =>
        http.app.inject({
          method: 'POST',
          url: '/api/v1/session',
          remoteAddress: NGINX,
          headers: {
            host,
            origin,
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
            'x-real-ip': client,
          },
          payload: JSON.stringify({ username, password: pw }),
        });
      const ok = await loginAs('h-hal', password, '192.168.93.1');
      expect(ok.statusCode).toBe(200);
      const cookie = String(ok.headers['set-cookie']).split(';')[0] ?? '';
      const read = async (): Promise<number> =>
        (
          await http.app.inject({
            method: 'GET',
            url: '/api/v1/session',
            remoteAddress: NGINX,
            headers: { host, cookie, 'x-real-ip': '192.168.93.1', 'x-forwarded-proto': 'https' },
          })
        ).statusCode;
      holder = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('identity.user_account')
          .select('id')
          .where('username', 'in', blockers)
          .forUpdate()
          .execute();
        holding(await backendPid(trx));
        await held;
      });
      const pid = await holderPid;
      const waitingOnHolder = async (): Promise<number> =>
        (
          await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`.execute(db)
        ).rows[0]?.n ?? 0;
      blockers.forEach((blocker, i) => {
        pending.push(
          loginAs(blocker, 'wrong-password-x', `10.78.0.${String(i + 1)}`).then(
            (r) => r.statusCode,
          ),
        );
      });
      // Both connections of the login pool wait for the lock; the other two wait for a connection.
      await waitFor(async () => (await waitingOnHolder()) === 2);
      // The flood: 300 logins at once from 300 addresses, most of them unknown names, a third the
      // victim's with a wrong password. What the ceiling and the hash slots admit queues for the
      // login pool too; the rest is refused (429) without waiting for a connection.
      const flood = Array.from({ length: 300 }, (_, i) =>
        loginAs(
          i % 3 === 0 ? 'h-hal' : `flood-${String(i)}`,
          'wrong-password-x',
          `10.77.${String(i >> 8)}.${String(i & 255)}`,
        ).then((r) => r.statusCode),
      );
      pending.push(...flood);
      // Reads go on: they never need a connection of the login pool. (Sharing it, they would wait
      // here until the test's timeout: the review measured 54–83 ms per read with the pool merely
      // busy.)
      const reads: number[] = [];
      for (let i = 0; i < 20; i++) reads.push(await read());
      expect(reads).toEqual(Array<number>(20).fill(200));
      // ...all of them while the login pool was still held.
      expect(await waitingOnHolder()).toBe(2);
      release();
      await holder;
      const answers = await Promise.all(pending);
      // The two that held the pool's connections were judged once the lock was gone; the flood's
      // overflow got 429s.
      expect(
        answers.slice(0, blockers.length).filter((s) => s === 401).length,
      ).toBeGreaterThanOrEqual(2);
      expect(answers.filter((s) => s === 429).length).toBeGreaterThan(0);
      expect(answers.every((s) => s === 401 || s === 429)).toBe(true);
    } finally {
      release();
      await holder;
      await Promise.allSettled(pending);
      await http.app.close();
      flooded.stop();
      await sessionsDb.destroy();
      await loginsDb.destroy();
    }
  });

  it('keeps a login answered within 10 hash times (at least 1 s) while open-loop attacks from 4 and 8 addresses run, never more hashes in flight than slots, every refusal a 429 (#264 re-review, N1)', async ({
    task,
  }) => {
    const password = await user('h-lea', ['operator']);
    // The real buckets, ceiling and hash slots; real scrypt hashes (two at a time, ~0.1 s each).
    const slotted = new Identity({ db, now, sweepMs: 0 });
    await slotted.start();
    const real = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: slotted,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
    });
    const send = (username: string, pw: string, client: string) =>
      real.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        remoteAddress: NGINX,
        headers: {
          host,
          origin,
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
          'x-real-ip': client,
        },
        payload: JSON.stringify({ username, password: pw }),
      });
    const p95 = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
    try {
      for (const attackers of [4, 8]) {
        const attack: Promise<number>[] = [];
        let n = 0;
        // Hashes asked for and not finished, at most: each holds a hash slot until it is done.
        let inFlight = 0;
        const hashesBefore = hashesDone();
        // Open loop: each attacker address sends 5 logins a second of unknown names, never
        // waiting for an answer.
        const timer = setInterval(() => {
          inFlight = Math.max(inFlight, hashesStarted() - hashesDone().count);
          for (let a = 0; a < attackers; a++) {
            n++;
            attack.push(
              send(`ghost-${String(n)}`, 'wrong-password-x', `198.51.100.${String(100 + a)}`).then(
                (r) => r.statusCode,
              ),
            );
          }
        }, 200);
        const latencies: number[] = [];
        const statuses: number[] = [];
        try {
          for (let i = 0; i < 8; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const started = performance.now();
            const response = await send('h-lea', password, '192.168.94.1');
            latencies.push(performance.now() - started);
            statuses.push(response.statusCode);
          }
        } finally {
          clearInterval(timer);
        }
        const answers = await Promise.all(attack);
        // The budget is in hash times, what one hash cost meanwhile under whatever else the
        // machine runs (#347: 1080 ms against a fixed 1 s on a loaded host). The victim waits for
        // at most the 9 other slots' hashes, two at a time (5 hash times), and its own (6); 10
        // leaves 4 for the database and the event loop, and the review's 1 s stays the floor.
        // Without the slots the queue, and the wait in hash times, grows for as long as the attack
        // outruns the hashes; the hashes in flight say so directly.
        const hashed = hashesDone();
        const hashMs =
          (hashed.ms - hashesBefore.ms) / Math.max(1, hashed.count - hashesBefore.count);
        const budget = Math.max(1_000, 10 * hashMs);
        const summary = `${String(attackers)} attackers: victim ${statuses.join(',')}, ${latencies.map((l) => Math.round(l)).join(',')} ms; a hash ${String(Math.round(hashMs))} ms, budget ${String(Math.round(budget))} ms, at most ${String(inFlight)} hashes in flight`;
        // The measurements, in the JSON report's meta of this test.
        Object.assign(task.meta, {
          [`n1-${String(attackers)}`]: { latencies, hashMs, budget, inFlight },
        });
        expect(p95(latencies), summary).toBeLessThanOrEqual(budget);
        expect(inFlight, summary).toBeLessThanOrEqual(LOGIN_HASH_SLOTS.total);
        // Every refusal of the victim is a 429 (a bucket, the ceiling or no hash slot).
        expect(
          statuses.every((s) => s === 200 || s === 429),
          summary,
        ).toBe(true);
        expect(new Set(answers), summary).toEqual(new Set([401, 429]));
      }
    } finally {
      await real.app.close();
      slotted.stop();
    }
  }, 120_000);

  it('remembers the logins of the window across a restart: the exemption holds against memory (#264 re-review, N2)', async () => {
    const password = await user('h-ivy', ['operator']);
    const home = '192.168.95.10';
    expect((await attempt('h-ivy', password, { client: home })).statusCode).toBe(200);
    for (const client of ['198.51.100.31', '198.51.100.32']) {
      for (let i = 0; i < 5; i++) {
        expect((await attempt('h-ivy', 'wrong-password-x', { client })).statusCode).toBe(401);
      }
    }
    // The MES restarts: a new identity module on the same database, its memory empty.
    const restarted = new Identity({ db, now, sweepMs: 0 });
    await restarted.start();
    const after = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: restarted,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      loginRate: { perSecond: 1e6, burst: 1e6 },
      userLoginRate: { perSecond: 1e6, burst: 1e6 },
    });
    try {
      const send = (pw: string, client: string) =>
        after.app.inject({
          method: 'POST',
          url: '/api/v1/session',
          remoteAddress: NGINX,
          headers: {
            host,
            origin,
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
            'x-real-ip': client,
          },
          payload: JSON.stringify({ username: 'h-ivy', password: pw }),
        });
      // An attacker's attempt sets the delay in the new memory first...
      expect((await send('wrong-password-x', '198.51.100.33')).statusCode).toBe(429);
      // ...and the address that logged in before the restart is still exempt.
      expect((await send(password, home)).statusCode).toBe(200);
    } finally {
      await after.app.close();
      restarted.stop();
    }
  });

  it("forgets a user's remembered delay when its roles change or it is disabled (#264 re-review, N3)", async () => {
    const password = await user('h-jon', ['admin']);
    for (let i = 0; i < 5; i++) {
      expect(
        (await attempt('h-jon', 'wrong-password-x', { client: '198.51.100.40' })).statusCode,
      ).toBe(401);
    }
    expect((await attempt('h-jon', password, { client: '192.168.96.1' })).statusCode).toBe(429);
    // No longer an admin: the admin's delay is gone with the role, in the database and in memory.
    await identity.updateUser('h-jon', { roles: ['operator'] }, { system: 'test' });
    expect((await attempt('h-jon', password, { client: '192.168.96.1' })).statusCode).toBe(200);
    // An admin again, delayed again; disabled now: the answer is the disabled user's 401, not a
    // remembered 429.
    await identity.updateUser('h-jon', { roles: ['admin'] }, { system: 'test' });
    for (let i = 0; i < 5; i++) {
      expect(
        (await attempt('h-jon', 'wrong-password-x', { client: '198.51.100.41' })).statusCode,
      ).toBe(401);
    }
    expect((await attempt('h-jon', password, { client: '192.168.96.2' })).statusCode).toBe(429);
    await identity.updateUser('h-jon', { enabled: false }, { system: 'test' });
    expect((await attempt('h-jon', password, { client: '192.168.96.2' })).statusCode).toBe(401);
  });

  it('lets a home address with a recent login in on every try while 2 and 4 attacker addresses fill the ceiling (#264 round 3, R1)', async () => {
    const password = await user('h-moe', ['operator']);
    const slotted = new Identity({ db, now, sweepMs: 0 });
    await slotted.start();
    // The real buckets, ceiling and hash slots; the buckets' clock moves only when the test moves
    // it (#347), so how full the ceiling is doesn't depend on how fast the machine answers.
    let bucketMs = 0;
    const real = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity: slotted,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      loginClock: () => bucketMs,
    });
    const send = (username: string, pw: string, client: string) =>
      real.app.inject({
        method: 'POST',
        url: '/api/v1/session',
        remoteAddress: NGINX,
        headers: {
          host,
          origin,
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
          'x-real-ip': client,
        },
        payload: JSON.stringify({ username, password: pw }),
      });
    const home = '192.168.97.1';
    const { loginBurst, loginCeilingBurst } = MES_API_LIMITS;
    try {
      expect((await send('h-moe', password, home)).statusCode).toBe(200);
      let n = 0;
      for (const attackers of [2, 4]) {
        for (let round = 0; round < 6; round++) {
          // Ten seconds on: every bucket is full again (the ceiling 20, each address 10).
          bucketMs += 10_000;
          // Each attacker address sends its whole burst at once: together at least the ceiling's.
          const attack = await Promise.all(
            Array.from({ length: attackers * loginBurst }, (_, i) => {
              n++;
              return send(
                `raider-${String(n)}`,
                'wrong-password-x',
                `198.51.100.${String(150 + (i % attackers))}`,
              ).then((r) => r.statusCode);
            }),
          );
          const what = `${String(attackers)} attackers, round ${String(round)}`;
          expect(
            attack.every((s) => s === 401 || s === 429),
            what,
          ).toBe(true);
          // What the ceiling refused beyond its burst (the hash slots refuse more, also 429).
          expect(attack.filter((s) => s === 429).length, what).toBeGreaterThanOrEqual(
            attackers * loginBurst - loginCeilingBurst,
          );
          // The ceiling is empty: a fresh address, with full buckets of its own, is refused...
          const probe = await send(`probe-${String(n)}`, 'wrong-password-x', '192.168.98.1');
          expect(probe.statusCode, what).toBe(429);
          expect(probe.json<{ detail: string }>().detail, what).toBe(LOGIN_RATE);
          // ...and the home address, which logged in within the window, is in.
          expect((await send('h-moe', password, home)).statusCode, what).toBe(200);
        }
      }
    } finally {
      await real.app.close();
      slotted.stop();
    }
  });

  it('asks the login buckets only for an attempt the global delay let through', async () => {
    const password = await user('h-cem', ['operator']);
    const tight = await buildMesHttp({
      ready: () => Promise.resolve(true),
      identity,
      auth: true,
      allowedHosts: ['localhost'],
      edge: new EdgeTrust(EDGE),
      loginRate: { perSecond: 1e6, burst: 1e6 },
      // One token for the name, never refilled: the buckets' clock stands still (#347).
      userLoginRate: { perSecond: 0.001, burst: 1 },
      loginClock: () => 0,
    });
    try {
      for (let i = 0; i < 10; i++) {
        await failedLogin('h-cem', 'wrong-password-x', `192.168.80.${String(i)}`);
      }
      const send = () =>
        tight.app.inject({
          method: 'POST',
          url: '/api/v1/session',
          remoteAddress: NGINX,
          headers: {
            host,
            origin,
            'content-type': 'application/json',
            'x-forwarded-proto': 'https',
            'x-real-ip': '192.168.80.99',
          },
          payload: JSON.stringify({ username: 'h-cem', password }),
        });
      // Within the global delay: its own 429, and the bucket's one token is still there...
      const delayed = await send();
      expect(delayed.statusCode).toBe(429);
      expect(delayed.json<{ detail: string }>().detail).toBe(LOGIN_THROTTLED);
      expect(delayed.headers['retry-after']).toBe('1');
      // ...so the first attempt after the wait passes the bucket and is judged (here: in).
      clock += 1_000;
      expect((await send()).statusCode).toBe(200);
      // The bucket is empty now: the next attempt is the bucket's 429.
      const bucket = await send();
      expect(bucket.statusCode).toBe(429);
      expect(bucket.json<{ detail: string }>().detail).toBe(LOGIN_RATE);
    } finally {
      await tight.app.close();
    }
  });
});
