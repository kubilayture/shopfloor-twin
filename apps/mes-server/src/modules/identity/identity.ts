import { createHash, randomBytes } from 'node:crypto';
import {
  PASSWORD_LENGTH,
  ROLES,
  USERNAME_PATTERN,
  passwordLength,
  permissionsOf,
  type Permission,
  type Role,
  type SessionKind,
} from '@shopfloor/contracts/identity';
import { PROBLEM_TYPES, type ProblemType } from '@shopfloor/contracts/mes-api';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/database.ts';
import {
  SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParams,
} from './password.ts';
import type { SessionEndReason } from './tables.ts';

const MINUTE = 60_000;

/** Session lifetimes and the failed-login rules (Phase 7 plan, "Identity"). */
export const IDENTITY_LIMITS = {
  /** Idle timeout per session kind. */
  idleMs: { desk: 60 * MINUTE, terminal: 15 * MINUTE } as Readonly<Record<SessionKind, number>>,
  /** Absolute lifetime of a session. */
  absoluteMs: 12 * 60 * MINUTE,
  /** A session's last use is written at most this often (its idle expiry moves with it). */
  touchMs: MINUTE,
  /** Consecutive failures that lock a normal account, and for how long. */
  lockAfter: 5,
  lockMs: 15 * MINUTE,
  /** An admin is delayed instead: 1 s after the fifth failure, doubling, at most 5 min. */
  adminDelayBaseMs: 1_000,
  adminDelayMaxMs: 5 * MINUTE,
  /** Ended or expired sessions are deleted this long after they ended. */
  keepEndedMs: 24 * 60 * MINUTE,
} as const;

export type IdentityErrorKind = 'unauthenticated' | 'not-found' | 'conflict' | 'invalid';

/** A refused identity operation; `realtime` maps the kind to 401, 404, 409 or 422. */
export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;
  readonly type: ProblemType | undefined;

  constructor(kind: IdentityErrorKind, message: string, type?: ProblemType) {
    super(message);
    this.kind = kind;
    this.type = type;
  }
}

/** The one answer to every failed login, whatever failed (no user, wrong password, locked). */
export const LOGIN_FAILED = 'invalid user name or password';

export interface SessionInfo {
  /** The token's SHA-256 in hex: names the session (sockets, tests); never the token itself. */
  readonly id: string;
  readonly kind: SessionKind;
  readonly createdAt: Date;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
}

/** The authenticated caller: user, roles and session. */
export interface Principal {
  readonly userId: number;
  readonly username: string;
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  readonly mustChangePassword: boolean;
  readonly session: SessionInfo;
}

/** Who acts in an audited change: a principal, or the system (bootstrap, the CLI). */
export type Actor = Pick<Principal, 'userId' | 'username' | 'roles'> | { readonly system: string };

export interface User {
  readonly id: number;
  readonly username: string;
  readonly roles: readonly Role[];
  readonly enabled: boolean;
  readonly mustChangePassword: boolean;
  readonly locked: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One audit row (#168; other modules write theirs through `audit` from #169). */
export interface AuditEntry {
  readonly actor: Actor;
  readonly authenticated: boolean;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | undefined;
  readonly plantAt?: Date | undefined;
}

export interface IdentityLog {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface IdentityOptions {
  readonly db: Kysely<Database>;
  readonly log?: IdentityLog;
  /** The wall clock (tests move it). */
  readonly now?: () => Date;
  /** scrypt's cost (default `SCRYPT_PARAMS`); stored hashes with other parameters are rehashed. */
  readonly hashParams?: ScryptParams;
  /** How often ended and long-expired sessions are deleted; 0 turns the sweep off. */
  readonly sweepMs?: number;
}

/** What ended sessions: their ids and why. */
export interface SessionsEnded {
  readonly ids: readonly string[];
  readonly reason: SessionEndReason;
}

const silent: IdentityLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const tokenHash = (token: Buffer): Buffer => createHash('sha256').update(token).digest();

/** The token of a cookie value: 32 bytes in base64url, else undefined. */
export function parseToken(value: string | undefined): Buffer | undefined {
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const token = Buffer.from(value, 'base64url');
  return token.length === 32 ? token : undefined;
}

/** A password's length against the policy; undefined when acceptable. */
export function passwordProblem(password: string): string | undefined {
  const length = passwordLength(password);
  if (length < PASSWORD_LENGTH.min) {
    return `a password needs at least ${String(PASSWORD_LENGTH.min)} characters`;
  }
  if (length > PASSWORD_LENGTH.max) {
    return `a password has at most ${String(PASSWORD_LENGTH.max)} characters`;
  }
  return undefined;
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

/**
 * The `identity` module (#168, ADR-0026): users, roles, scrypt password hashes, sessions whose
 * tokens live in a cookie and whose SHA-256 is stored, failed-login lockout (a delay for admins),
 * the bootstrap admin and the audit log. `realtime` asks it who a request's cookie belongs to.
 */
export class Identity {
  readonly #db: Kysely<Database>;
  readonly #log: IdentityLog;
  readonly #now: () => Date;
  readonly #params: ScryptParams;
  readonly #sweepMs: number;
  readonly #listeners = new Set<(ended: SessionsEnded) => void>();
  #dummy: Promise<string> | undefined;
  #sweep: NodeJS.Timeout | undefined;
  #started = false;

  constructor(options: IdentityOptions) {
    this.#db = options.db;
    this.#log = options.log ?? silent;
    this.#now = options.now ?? (() => new Date());
    this.#params = options.hashParams ?? SCRYPT_PARAMS;
    this.#sweepMs = options.sweepMs ?? 10 * MINUTE;
  }

  get started(): boolean {
    return this.#started;
  }

  /**
   * After the migrations: checks the role table against contracts, creates the bootstrap admin
   * when a password is given and no enabled admin exists, and starts the session sweep.
   */
  async start(options: { readonly bootstrapAdminPassword?: string | undefined } = {}): Promise<{
    readonly admin: 'exists' | 'created' | 'missing';
  }> {
    const stored = (await this.#db.selectFrom('identity.role').select('id').execute())
      .map((row) => row.id)
      .sort();
    if (stored.join() !== [...ROLES].sort().join()) {
      throw new Error(
        `identity.role holds ${stored.join(', ')}, contracts declare ${ROLES.join(', ')}`,
      );
    }
    let admin: 'exists' | 'created' | 'missing' = (await this.#enabledAdmins(this.#db))
      ? 'exists'
      : 'missing';
    if (admin === 'missing' && options.bootstrapAdminPassword !== undefined) {
      await this.#bootstrap(options.bootstrapAdminPassword);
      admin = 'created';
      this.#log.warn(
        { user: 'admin' },
        'bootstrap admin created from MES_BOOTSTRAP_ADMIN_PASSWORD; it must change its password',
      );
    } else if (admin === 'missing') {
      this.#log.warn(
        {},
        'no enabled admin: set MES_BOOTSTRAP_ADMIN_PASSWORD and restart, or run ' +
          'pnpm --filter @shopfloor/mes-server user:create --username <name> --role admin',
      );
    }
    if (this.#sweepMs > 0) {
      this.#sweep = setInterval(() => {
        this.sweep().catch((error: unknown) => {
          this.#log.error({ err: error }, 'session sweep failed');
        });
      }, this.#sweepMs);
      this.#sweep.unref();
    }
    this.#started = true;
    return { admin };
  }

  stop(): void {
    clearInterval(this.#sweep);
    this.#started = false;
  }

  /** Listens for sessions that ended before expiring (logout, password change, disabled user). */
  onSessionsEnded(listener: (ended: SessionsEnded) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Deletes sessions that ended or expired more than a day ago. */
  async sweep(): Promise<number> {
    const before = new Date(this.#now().getTime() - IDENTITY_LIMITS.keepEndedMs);
    const result = await this.#db
      .deleteFrom('identity.session')
      .where((eb) =>
        eb.or([
          eb('ended_at', '<', before),
          eb('expires_at', '<', before),
          eb('idle_expires_at', '<', before),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** A hash of a random password, so an unknown user name costs one hash like a known one. */
  #dummyHash(): Promise<string> {
    this.#dummy ??= hashPassword(randomBytes(16).toString('hex'), this.#params);
    return this.#dummy;
  }

  async #enabledAdmins(db: Kysely<Database> | Transaction<Database>): Promise<number> {
    const row = await db
      .selectFrom('identity.user_account as u')
      .innerJoin('identity.user_role as r', 'r.user_id', 'u.id')
      .where('r.role_id', '=', 'admin')
      .where('u.enabled', '=', true)
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return row.n;
  }

  async #roles(db: Kysely<Database> | Transaction<Database>, userId: number): Promise<Role[]> {
    const rows = await db
      .selectFrom('identity.user_role')
      .select('role_id')
      .where('user_id', '=', userId)
      .execute();
    const roles = rows.map((row) => row.role_id).filter(isRole);
    return ROLES.filter((role) => roles.includes(role));
  }

  /** Appends one audit row inside the caller's transaction (or on its own). */
  async audit(db: Kysely<Database> | Transaction<Database>, entry: AuditEntry): Promise<void> {
    const actor = entry.actor;
    await db
      .insertInto('identity.audit_log')
      .values({
        plant_at: entry.plantAt ?? null,
        user_id: 'system' in actor ? null : actor.userId,
        username: 'system' in actor ? actor.system : actor.username,
        roles: 'system' in actor ? [] : [...actor.roles],
        authenticated: entry.authenticated,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        before: entry.before === undefined ? null : JSON.stringify(entry.before),
        after: entry.after === undefined ? null : JSON.stringify(entry.after),
        request_id: entry.requestId ?? null,
      })
      .execute();
  }

  #emit(ended: SessionsEnded): void {
    if (ended.ids.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(ended);
      } catch (error) {
        this.#log.error({ err: error }, 'session listener failed');
      }
    }
  }

  async #endSessions(
    trx: Transaction<Database>,
    reason: SessionEndReason,
    where: { userId: number; except?: Buffer } | { hash: Buffer },
  ): Promise<string[]> {
    let query = trx
      .updateTable('identity.session')
      .set({ ended_at: this.#now(), end_reason: reason })
      .where('ended_at', 'is', null);
    if ('hash' in where) {
      query = query.where('token_hash', '=', where.hash);
    } else {
      query = query.where('user_id', '=', where.userId);
      if (where.except) query = query.where('token_hash', '!=', where.except);
    }
    const rows = await query.returning('token_hash').execute();
    return rows.map((row) => row.token_hash.toString('hex'));
  }

  /**
   * A login. Every failure (unknown or disabled user, wrong password, a lock or an admin's delay)
   * throws the same `IdentityError` after one password hash, and is audited. A presented session
   * (`replaces`) ends: a login always gets a new token.
   */
  async login(input: {
    readonly username: string;
    readonly password: string;
    readonly kind: SessionKind;
    readonly requestId?: string | undefined;
    readonly replaces?: Buffer | undefined;
  }): Promise<{ readonly token: string; readonly principal: Principal }> {
    const name = input.username.trim().toLowerCase();
    const known = USERNAME_PATTERN.test(name) ? name : '(invalid)';
    const failed = async (
      reason: string,
      user?: { id: number; roles: Role[] },
      extra: Record<string, unknown> = {},
    ): Promise<never> => {
      await this.audit(this.#db, {
        actor: user ? { userId: user.id, username: name, roles: user.roles } : { system: known },
        authenticated: false,
        action: 'session.login-failed',
        entityType: 'user',
        entityId: known,
        after: { reason, ...extra },
        requestId: input.requestId,
      });
      this.#log.warn({ user: known, reason, ...extra }, 'login failed');
      throw new IdentityError('unauthenticated', LOGIN_FAILED, PROBLEM_TYPES.unauthenticated);
    };
    const user = await this.#db
      .selectFrom('identity.user_account')
      .selectAll()
      .where('username', '=', name)
      .executeTakeFirst();
    if (!user) {
      await verifyPassword(input.password, await this.#dummyHash());
      return failed('unknown-user');
    }
    const roles = await this.#roles(this.#db, user.id);
    const who = { id: user.id, roles };
    const admin = roles.includes('admin');
    const now = this.#now();
    if (!user.enabled) {
      await verifyPassword(input.password, await this.#dummyHash());
      return failed('disabled', who);
    }
    if (!admin && user.locked_until !== null && user.locked_until > now) {
      await verifyPassword(input.password, await this.#dummyHash());
      return failed('locked', who, { lockedUntil: user.locked_until.toISOString() });
    }
    if (admin && user.next_attempt_at !== null && user.next_attempt_at > now) {
      await verifyPassword(input.password, await this.#dummyHash());
      return failed('delayed', who, { nextAttemptAt: user.next_attempt_at.toISOString() });
    }
    if (!(await verifyPassword(input.password, user.password_hash))) {
      // Atomic, so concurrent failures all count; a lock that has run out starts the count anew.
      const row = await this.#db
        .updateTable('identity.user_account')
        .set({
          failed_logins: sql<number>`CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now}
            THEN 1 ELSE failed_logins + 1 END`,
          locked_until: sql<Date | null>`CASE WHEN locked_until <= ${now} THEN NULL
            ELSE locked_until END`,
        })
        .where('id', '=', user.id)
        .returning('failed_logins')
        .executeTakeFirstOrThrow();
      const failures = row.failed_logins;
      if (failures >= IDENTITY_LIMITS.lockAfter) {
        if (admin) {
          const delay = Math.min(
            IDENTITY_LIMITS.adminDelayBaseMs * 2 ** (failures - IDENTITY_LIMITS.lockAfter),
            IDENTITY_LIMITS.adminDelayMaxMs,
          );
          const next = new Date(now.getTime() + delay);
          await this.#db
            .updateTable('identity.user_account')
            .set({ next_attempt_at: next })
            .where('id', '=', user.id)
            .execute();
          return failed('wrong-password', who, {
            failures,
            nextAttemptAt: next.toISOString(),
          });
        }
        if (failures === IDENTITY_LIMITS.lockAfter) {
          const until = new Date(now.getTime() + IDENTITY_LIMITS.lockMs);
          await this.#db.transaction().execute(async (trx) => {
            await trx
              .updateTable('identity.user_account')
              .set({ locked_until: until })
              .where('id', '=', user.id)
              .execute();
            await this.audit(trx, {
              actor: { system: 'identity' },
              authenticated: false,
              action: 'user.locked',
              entityType: 'user',
              entityId: name,
              after: { failures, lockedUntil: until.toISOString() },
              requestId: input.requestId,
            });
          });
          this.#log.warn({ user: name, until: until.toISOString() }, 'account locked');
          return failed('wrong-password', who, { failures, lockedUntil: until.toISOString() });
        }
      }
      return failed('wrong-password', who, { failures });
    }
    const token = randomBytes(32);
    const hash = tokenHash(token);
    const session: SessionInfo = {
      id: hash.toString('hex'),
      kind: input.kind,
      createdAt: now,
      idleExpiresAt: new Date(now.getTime() + IDENTITY_LIMITS.idleMs[input.kind]),
      expiresAt: new Date(now.getTime() + IDENTITY_LIMITS.absoluteMs),
    };
    const rehash = needsRehash(user.password_hash, this.#params)
      ? await hashPassword(input.password, this.#params)
      : undefined;
    const replaced = await this.#db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity.user_account')
        .set({
          failed_logins: 0,
          locked_until: null,
          next_attempt_at: null,
          ...(rehash === undefined ? {} : { password_hash: rehash }),
        })
        .where('id', '=', user.id)
        .execute();
      const ended =
        input.replaces === undefined
          ? []
          : await this.#endSessions(trx, 'replaced', { hash: tokenHash(input.replaces) });
      await trx
        .insertInto('identity.session')
        .values({
          token_hash: hash,
          user_id: user.id,
          kind: session.kind,
          created_at: now,
          last_used_at: now,
          idle_expires_at: session.idleExpiresAt,
          expires_at: session.expiresAt,
        })
        .execute();
      await this.audit(trx, {
        actor: { userId: user.id, username: user.username, roles },
        authenticated: true,
        action: 'session.login',
        entityType: 'user',
        entityId: user.username,
        after: { kind: session.kind, rehashed: rehash !== undefined },
        requestId: input.requestId,
      });
      return ended;
    });
    this.#emit({ ids: replaced, reason: 'replaced' });
    this.#log.info({ user: user.username, kind: session.kind }, 'login');
    return {
      token: token.toString('base64url'),
      principal: {
        userId: user.id,
        username: user.username,
        roles,
        permissions: permissionsOf(roles),
        mustChangePassword: user.must_change_password,
        session,
      },
    };
  }

  /**
   * The principal of a cookie's token, or undefined when it names no live session (unknown,
   * ended, idle or past its absolute expiry, or a disabled user). `touch` records the use, which
   * moves the idle expiry (written at most once a minute).
   */
  async authenticate(
    token: Buffer,
    options: { readonly touch: boolean } = { touch: true },
  ): Promise<Principal | undefined> {
    return this.#principal(tokenHash(token), options.touch);
  }

  /** Whether a session (by its id) is still live, without using it (open sockets). */
  async live(id: string): Promise<boolean> {
    return (await this.#principal(Buffer.from(id, 'hex'), false)) !== undefined;
  }

  async #principal(hash: Buffer, touch: boolean): Promise<Principal | undefined> {
    const now = this.#now();
    const row = await this.#db
      .selectFrom('identity.session as s')
      .innerJoin('identity.user_account as u', 'u.id', 's.user_id')
      .select([
        's.kind',
        's.created_at',
        's.last_used_at',
        's.idle_expires_at',
        's.expires_at',
        'u.id',
        'u.username',
        'u.must_change_password',
      ])
      .where('s.token_hash', '=', hash)
      .where('s.ended_at', 'is', null)
      .where('s.idle_expires_at', '>', now)
      .where('s.expires_at', '>', now)
      .where('u.enabled', '=', true)
      .executeTakeFirst();
    if (!row) return undefined;
    let idleExpiresAt = row.idle_expires_at;
    if (touch && now.getTime() - row.last_used_at.getTime() >= IDENTITY_LIMITS.touchMs) {
      idleExpiresAt = new Date(
        Math.min(now.getTime() + IDENTITY_LIMITS.idleMs[row.kind], row.expires_at.getTime()),
      );
      await this.#db
        .updateTable('identity.session')
        .set({ last_used_at: now, idle_expires_at: idleExpiresAt })
        .where('token_hash', '=', hash)
        .where('ended_at', 'is', null)
        .execute();
    }
    const roles = await this.#roles(this.#db, row.id);
    return {
      userId: row.id,
      username: row.username,
      roles,
      permissions: permissionsOf(roles),
      mustChangePassword: row.must_change_password,
      session: {
        id: hash.toString('hex'),
        kind: row.kind,
        createdAt: row.created_at,
        idleExpiresAt,
        expiresAt: row.expires_at,
      },
    };
  }

  /** Ends the caller's session (logout). */
  async logout(principal: Principal, requestId?: string): Promise<void> {
    const ids = await this.#db.transaction().execute(async (trx) => {
      const ended = await this.#endSessions(trx, 'logout', {
        hash: Buffer.from(principal.session.id, 'hex'),
      });
      await this.audit(trx, {
        actor: principal,
        authenticated: true,
        action: 'session.logout',
        entityType: 'user',
        entityId: principal.username,
        requestId,
      });
      return ended;
    });
    this.#emit({ ids, reason: 'logout' });
    this.#log.info({ user: principal.username }, 'logout');
  }

  /**
   * Changes the caller's own password: the current one must match (a mismatch counts as a failed
   * login), the new one meets the policy and differs. Ends the user's other sessions.
   */
  async changePassword(
    principal: Principal,
    current: string,
    next: string,
    requestId?: string,
  ): Promise<{ readonly endedSessions: number }> {
    const user = await this.#db
      .selectFrom('identity.user_account')
      .select(['password_hash'])
      .where('id', '=', principal.userId)
      .executeTakeFirstOrThrow();
    if (!(await verifyPassword(current, user.password_hash))) {
      await this.#db
        .updateTable('identity.user_account')
        .set({ failed_logins: sql<number>`failed_logins + 1` })
        .where('id', '=', principal.userId)
        .execute();
      await this.audit(this.#db, {
        actor: principal,
        authenticated: true,
        action: 'user.password-change-failed',
        entityType: 'user',
        entityId: principal.username,
        after: { reason: 'wrong-current-password' },
        requestId,
      });
      throw new IdentityError(
        'invalid',
        'the current password does not match',
        PROBLEM_TYPES.passwordRejected,
      );
    }
    const problem =
      passwordProblem(next) ??
      (next === current ? 'the new password is the current one' : undefined);
    if (problem !== undefined) {
      throw new IdentityError('invalid', problem, PROBLEM_TYPES.passwordRejected);
    }
    const hash = await hashPassword(next, this.#params);
    const self = Buffer.from(principal.session.id, 'hex');
    const ids = await this.#db.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity.user_account')
        .set({
          password_hash: hash,
          must_change_password: false,
          failed_logins: 0,
          password_changed_at: this.#now(),
          updated_at: this.#now(),
        })
        .where('id', '=', principal.userId)
        .execute();
      const ended = await this.#endSessions(trx, 'password-changed', {
        userId: principal.userId,
        except: self,
      });
      await this.audit(trx, {
        actor: principal,
        authenticated: true,
        action: 'user.password-change',
        entityType: 'user',
        entityId: principal.username,
        after: { endedSessions: ended.length },
        requestId,
      });
      return ended;
    });
    this.#emit({ ids, reason: 'password-changed' });
    return { endedSessions: ids.length };
  }

  async users(): Promise<User[]> {
    const rows = await this.#db
      .selectFrom('identity.user_account')
      .selectAll()
      .orderBy('username')
      .execute();
    const roles = await this.#db.selectFrom('identity.user_role').selectAll().execute();
    const now = this.#now();
    return rows.map((row) => {
      const held = roles.filter((r) => r.user_id === row.id).map((r) => r.role_id);
      return {
        id: row.id,
        username: row.username,
        roles: ROLES.filter((role) => held.includes(role)),
        enabled: row.enabled,
        mustChangePassword: row.must_change_password,
        locked: row.locked_until !== null && row.locked_until > now,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async user(username: string): Promise<User> {
    const user = (await this.users()).find((u) => u.username === username);
    if (!user) throw new IdentityError('not-found', `no user ${username}`);
    return user;
  }

  /** Creates a user; its password is temporary unless `mustChangePassword` is false (the CLI). */
  async createUser(
    input: {
      readonly username: string;
      readonly roles: readonly Role[];
      readonly password: string;
      readonly mustChangePassword?: boolean;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<User> {
    if (!USERNAME_PATTERN.test(input.username)) {
      throw new IdentityError('invalid', `user name not allowed: ${input.username}`);
    }
    if (input.roles.length === 0) throw new IdentityError('invalid', 'a user needs a role');
    const problem = passwordProblem(input.password);
    if (problem !== undefined) {
      throw new IdentityError('invalid', problem, PROBLEM_TYPES.passwordRejected);
    }
    const hash = await hashPassword(input.password, this.#params);
    const roles = ROLES.filter((role) => input.roles.includes(role));
    const mustChange = input.mustChangePassword ?? true;
    await this.#db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('identity.user_account')
        .values({ username: input.username, password_hash: hash, must_change_password: mustChange })
        .onConflict((oc) => oc.column('username').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!created) {
        throw new IdentityError(
          'conflict',
          `user ${input.username} exists`,
          PROBLEM_TYPES.userExists,
        );
      }
      await trx
        .insertInto('identity.user_role')
        .values(roles.map((role) => ({ user_id: created.id, role_id: role })))
        .execute();
      await this.audit(trx, {
        actor,
        authenticated: !('system' in actor),
        action: 'user.create',
        entityType: 'user',
        entityId: input.username,
        after: { username: input.username, roles, enabled: true, mustChangePassword: mustChange },
        requestId,
      });
    });
    this.#log.info({ user: input.username, roles }, 'user created');
    return this.user(input.username);
  }

  /**
   * Changes a user's roles or whether it may log in. Disabling ends every session of the user
   * (and so closes its sockets); the last enabled admin can't be disabled or lose the role.
   */
  async updateUser(
    username: string,
    change: {
      readonly roles?: readonly Role[] | undefined;
      readonly enabled?: boolean | undefined;
    },
    actor: Actor,
    requestId?: string,
  ): Promise<User> {
    const ids = await this.#db.transaction().execute(async (trx) => {
      // One admin change at a time, so two can't each leave the other as the last admin.
      await sql`SELECT pg_advisory_xact_lock(7004168)`.execute(trx);
      const row = await trx
        .selectFrom('identity.user_account')
        .select(['id', 'enabled'])
        .where('username', '=', username)
        .executeTakeFirst();
      if (!row) throw new IdentityError('not-found', `no user ${username}`);
      const before = { roles: await this.#roles(trx, row.id), enabled: row.enabled };
      const after = {
        roles: change.roles ? ROLES.filter((role) => change.roles?.includes(role)) : before.roles,
        enabled: change.enabled ?? before.enabled,
      };
      if (after.roles.length === 0) throw new IdentityError('invalid', 'a user needs a role');
      if (change.roles) {
        await trx.deleteFrom('identity.user_role').where('user_id', '=', row.id).execute();
        await trx
          .insertInto('identity.user_role')
          .values(after.roles.map((role) => ({ user_id: row.id, role_id: role })))
          .execute();
      }
      await trx
        .updateTable('identity.user_account')
        .set({ enabled: after.enabled, updated_at: this.#now() })
        .where('id', '=', row.id)
        .execute();
      if ((await this.#enabledAdmins(trx)) === 0) {
        throw new IdentityError('conflict', 'the last enabled admin must stay an enabled admin');
      }
      const ended = after.enabled
        ? []
        : await this.#endSessions(trx, 'user-disabled', { userId: row.id });
      await this.audit(trx, {
        actor,
        authenticated: !('system' in actor),
        action: 'user.update',
        entityType: 'user',
        entityId: username,
        before,
        after: { ...after, endedSessions: ended.length },
        requestId,
      });
      return ended;
    });
    this.#emit({ ids, reason: 'user-disabled' });
    return this.user(username);
  }

  /**
   * Sets a temporary password: the user must change it at the next login; a lock is cleared and
   * every session of the user ends.
   */
  async resetPassword(
    username: string,
    password: string,
    actor: Actor,
    requestId?: string,
  ): Promise<User> {
    const problem = passwordProblem(password);
    if (problem !== undefined) {
      throw new IdentityError('invalid', problem, PROBLEM_TYPES.passwordRejected);
    }
    const hash = await hashPassword(password, this.#params);
    const ids = await this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('identity.user_account')
        .set({
          password_hash: hash,
          must_change_password: true,
          failed_logins: 0,
          locked_until: null,
          next_attempt_at: null,
          password_changed_at: this.#now(),
          updated_at: this.#now(),
        })
        .where('username', '=', username)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new IdentityError('not-found', `no user ${username}`);
      const ended = await this.#endSessions(trx, 'password-reset', { userId: row.id });
      await this.audit(trx, {
        actor,
        authenticated: !('system' in actor),
        action: 'user.password-reset',
        entityType: 'user',
        entityId: username,
        after: { mustChangePassword: true, endedSessions: ended.length },
        requestId,
      });
      return ended;
    });
    this.#emit({ ids, reason: 'password-reset' });
    return this.user(username);
  }

  /**
   * The bootstrap admin (`MES_BOOTSTRAP_ADMIN_PASSWORD`): the user `admin`, enabled, with the
   * admin role and a temporary password. Only called when no enabled admin exists; an existing
   * `admin` account (disabled, or without the role) is restored that way.
   */
  async #bootstrap(password: string): Promise<void> {
    const problem = passwordProblem(password);
    if (problem !== undefined) throw new Error(`MES_BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
    const hash = await hashPassword(password, this.#params);
    await this.#db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('identity.user_account')
        .values({ username: 'admin', password_hash: hash, must_change_password: true })
        .onConflict((oc) =>
          oc.column('username').doUpdateSet({
            password_hash: hash,
            must_change_password: true,
            enabled: true,
            failed_logins: 0,
            locked_until: null,
            next_attempt_at: null,
            updated_at: this.#now(),
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('identity.user_role')
        .values({ user_id: row.id, role_id: 'admin' })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await this.audit(trx, {
        actor: { system: 'bootstrap' },
        authenticated: false,
        action: 'user.bootstrap',
        entityType: 'user',
        entityId: 'admin',
        after: { roles: await this.#roles(trx, row.id), enabled: true, mustChangePassword: true },
      });
    });
  }

  /** The audit rows of one entity, oldest first (tests; #169 serves them). */
  async auditOf(entityType: string, entityId: string) {
    return this.#db
      .selectFrom('identity.audit_log')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .orderBy('id')
      .execute();
  }
}
