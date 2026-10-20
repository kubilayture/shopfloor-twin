import { createHash, randomBytes } from 'node:crypto';
import {
  PASSWORD_LENGTH,
  ROLES,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
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
import { BUSY, HashSlots, LoginThrottle } from './throttle.ts';

/**
 * Login hashes held at once, running or waiting (#264 re-review, N1): two run at a time, so ten
 * is about 0.7 s of queue at 140 ms a hash; at most three of them from one client address.
 */
export const LOGIN_HASH_SLOTS = { total: 10, perAddress: 3 } as const;

const MINUTE = 60_000;

/** Session lifetimes and the failed-login rules (Phase 7 plan, "Identity"). */
export const IDENTITY_LIMITS = {
  /** Idle timeout per session kind. */
  idleMs: SESSION_IDLE_MS,
  /** Absolute lifetime of a session. */
  absoluteMs: SESSION_ABSOLUTE_MS,
  /** A session's last use is written at most this often (its idle expiry moves with it). */
  touchMs: MINUTE,
  /**
   * Consecutive failures from one address that lock a normal account for that address (#242: the
   * pair (account, address), no longer the account), and for how long.
   */
  lockAfter: 5,
  lockMs: 15 * MINUTE,
  /**
   * The global delay (#242, ADR-0039): once an account has `throttleAfter` or more judged failures
   * within `throttleWindowMs` from all addresses together (n), an attempt within
   * `min(throttleBaseMs * 2^(n - throttleAfter), throttleMaxMs)` of its last failure is refused
   * with 429 before any hash. Never a lock.
   */
  throttleAfter: 10,
  throttleWindowMs: 15 * MINUTE,
  throttleBaseMs: 1_000,
  throttleMaxMs: 30_000,
  /** An admin is delayed instead: 1 s after the fifth failure, doubling, at most 5 min. */
  adminDelayBaseMs: 1_000,
  adminDelayMaxMs: 5 * MINUTE,
  /** Ended or expired sessions are deleted this long after they ended. */
  keepEndedMs: 24 * 60 * MINUTE,
} as const;

export type IdentityErrorKind =
  'unauthenticated' | 'not-found' | 'conflict' | 'invalid' | 'throttled';

/**
 * A refused identity operation; `realtime` maps the kind to 401, 404, 409, 422 or 429 (`throttled`,
 * with `retryAfterS` as `Retry-After`).
 */
export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;
  readonly type: ProblemType | undefined;
  /** For `throttled`: whole seconds until an attempt is judged again (rounded up, at least 1). */
  readonly retryAfterS: number | undefined;

  constructor(kind: IdentityErrorKind, message: string, type?: ProblemType, retryAfterS?: number) {
    super(message);
    this.kind = kind;
    this.type = type;
    this.retryAfterS = retryAfterS;
  }
}

/** The 429 of the global delay (#242): the account had too many failures just now. */
export const LOGIN_THROTTLED = 'too many failed logins for this user; try again later';
/** The 429 of the in-memory login buckets (#168 review, M2), decided under the row lock (#242). */
export const LOGIN_RATE = 'too many logins; try again';

/** The address a login is keyed by when the caller has none (module tests, the CLI). */
export const UNKNOWN_ADDRESS = 'unknown';

/**
 * The global delay after an account's last failure with n judged failures in the window (#242):
 * none below `throttleAfter`, then `min(2^(n - 10) s, 30 s)`.
 */
export function throttleWaitMs(n: number): number {
  if (n < IDENTITY_LIMITS.throttleAfter) return 0;
  return Math.min(
    IDENTITY_LIMITS.throttleBaseMs * 2 ** (n - IDENTITY_LIMITS.throttleAfter),
    IDENTITY_LIMITS.throttleMaxMs,
  );
}

/** A login address as stored: trimmed, at most 64 characters, `unknown` when empty. */
const addressKey = (address: string | undefined): string => {
  const trimmed = (address ?? '').trim().slice(0, 64);
  return trimmed === '' ? UNKNOWN_ADDRESS : trimmed;
};

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

/** A session's user, as a module write records it (#169). */
export type SessionUser = Pick<Principal, 'userId' | 'username' | 'roles'>;

/**
 * Who a module write is by (#169): the session's user. Since #170 the API passes nothing else (the
 * typed request fields are gone and every write needs a session); a name as typed, recorded as
 * unauthenticated, remains only for the modules' own tests, which write without the HTTP layer.
 */
export type WriteBy = SessionUser | string;

/** The name a write records: the user name, or the name as typed. */
export const nameOf = (by: WriteBy): string => (typeof by === 'string' ? by : by.username);

/** Whether a write's actor came from a session. */
export const isAuthenticated = (by: WriteBy): boolean => typeof by !== 'string';

/** The audit's actor of a write: a typed name is recorded as such, never as a user. */
export const auditActor = (by: WriteBy): AuditActor =>
  typeof by === 'string' ? { typed: by } : by;

/** An audit row's actor: an `Actor`, or a name typed without a session (module tests; legacy). */
export type AuditActor = Actor | { readonly typed: string };

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

/** One audit row (#168; other modules write theirs through `Identity.audit` from #169). */
export interface AuditEntry {
  readonly actor: AuditActor;
  readonly authenticated: boolean;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | undefined;
  readonly plantAt?: Date | undefined;
}

/** A condition on an audit row's `after` (`Identity.auditEntries`). */
export type AuditCondition =
  /** `after.<key>` equals the value. */
  | { readonly equals: { readonly key: string; readonly value: string } }
  /**
   * `[after.<fromKey>, after.<toKey>)` (ISO times; a null end: open) overlaps `[from, to)`.
   */
  | {
      readonly overlaps: {
        readonly fromKey: string;
        readonly toKey: string;
        readonly from: Date;
        readonly to: Date;
      };
    };

/** Which rows `Identity.auditEntries` reads: any of the conditions (all rows without), at most `limit`. */
export interface AuditQuery {
  readonly anyOf?: readonly AuditCondition[];
  readonly limit?: number;
}

/** An audit row as stored (`Identity.auditEntries`). */
export interface StoredAuditEntry {
  readonly id: number;
  /** Wall time. */
  readonly at: Date;
  readonly plantAt: Date | null;
  readonly userId: number | null;
  readonly username: string;
  readonly roles: readonly string[];
  readonly authenticated: boolean;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
  /** Copied from a module audit by migration 0018 (#169). */
  readonly legacy: boolean;
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
  /**
   * The pool logins and password checks run on (#264 review, F1), apart from `db`, which serves
   * the session lookup of every request: a flood of logins never starves it. Default: `db`.
   */
  readonly loginDb?: Kysely<Database>;
  /** `loginDb`'s connections: reservations at once (default 2); more wait, at most 16. */
  readonly loginPoolSize?: number;
  /** Login hashes held at once, in all and per address (default `LOGIN_HASH_SLOTS`). */
  readonly hashSlots?: { readonly total: number; readonly perAddress: number };
}

/** What ended sessions: their ids and why. */
export interface SessionsEnded {
  readonly ids: readonly string[];
  readonly reason: SessionEndReason;
}

/** What failed logins of an unknown or malformed name are audited as (never the typed name). */
export const UNKNOWN_USER = '(unknown)';

/** A user's row as a login reads it, with its roles. */
interface AccountRow {
  readonly id: number;
  readonly username: string;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly roles: Role[];
}

/** What the reserve-before-hash transaction decided (#242). */
type Reservation =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'throttled';
      readonly user: AccountRow;
      /** The wait's end (epoch ms). */
      readonly until: number;
      readonly retryAfterS: number;
      /** An admin's own delay, not the global one. */
      readonly admin: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly user: AccountRow;
      readonly reason: 'disabled' | 'locked';
      readonly until?: Date;
    }
  | {
      readonly kind: 'reserved';
      readonly user: AccountRow;
      readonly failures: number;
      readonly lockedUntil?: Date;
      readonly nextAttemptAt?: Date;
      /** The global delay this failure starts, when n reached the threshold (epoch ms). */
      readonly globalUntil?: number;
    };

/**
 * A login's decision before any hash (#264 review, F1): a reservation, a wait known from memory
 * (429, the user's delay), or the login buckets or a full queue (429).
 */
/** A decision that will be hashed holds a hash slot until `release` (#264 re-review, N1). */
type Held = Decision & { readonly release?: () => void };

type Decision =
  | Reservation
  | { readonly kind: 'throttled'; readonly retryAfterS: number; readonly user?: undefined }
  | { readonly kind: 'rate-limited'; readonly retryAfterS: number };

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
  readonly #loginDb: Kysely<Database>;
  readonly #throttle: LoginThrottle;
  readonly #hashes: HashSlots;
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
    this.#loginDb = options.loginDb ?? options.db;
    this.#throttle = new LoginThrottle({
      reservations: options.loginPoolSize ?? 2,
      reservationQueue: 16,
      perNameQueue: 32,
      exemptMs: IDENTITY_LIMITS.throttleWindowMs,
    });
    const slots = options.hashSlots ?? LOGIN_HASH_SLOTS;
    this.#hashes = new HashSlots(slots.total, slots.perAddress);
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
    // The dummy hash an unknown name is checked against, made now rather than at the first one.
    await this.#dummyHash();
    // The logins of the last 15 minutes exempt their addresses from the global delay (#264
    // re-review, N2): remembered across a restart, or memory would refuse what the database
    // exempts once an attack has set the delay again.
    const since = new Date(this.#now().getTime() - IDENTITY_LIMITS.throttleWindowMs);
    const successes = await this.#db
      .selectFrom('identity.login_address as a')
      .innerJoin('identity.user_account as u', 'u.id', 'a.user_id')
      .select(['u.username', 'a.address', 'a.last_success_at'])
      .where('a.last_success_at', '>', since)
      .execute();
    for (const row of successes) {
      if (row.last_success_at !== null) {
        this.#throttle.noteSuccess(row.username, row.address, row.last_success_at.getTime());
      }
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
        // idle_expires_at <= expires_at, so this covers the absolute expiry too (both indexed).
        eb.or([eb('ended_at', '<', before), eb('idle_expires_at', '<', before)]),
      )
      .executeTakeFirst();
    // Login throttling (#242): failures past the 15-minute window, and pairs a day after their
    // last failure once unlocked.
    const now = this.#now();
    await this.#db
      .deleteFrom('identity.login_failure')
      .where('at', '<=', new Date(now.getTime() - IDENTITY_LIMITS.throttleWindowMs))
      .execute();
    await this.#db
      .deleteFrom('identity.login_address')
      .where(sql<boolean>`greatest(last_failure_at, last_success_at) < ${before}`)
      .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<=', now)]))
      .execute();
    this.#throttle.prune(now.getTime());
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
    await Identity.audit(db, entry);
  }

  /**
   * Appends audit rows inside the caller's transaction (#169): the one way every module writes
   * `identity.audit_log`, so the write commits or rolls back with the change it records.
   */
  static async audit(
    db: Kysely<Database> | Transaction<Database>,
    ...entries: readonly AuditEntry[]
  ): Promise<void> {
    if (entries.length === 0) return;
    await db
      .insertInto('identity.audit_log')
      .values(
        entries.map((entry) => {
          const actor = entry.actor;
          const user = 'userId' in actor ? actor : undefined;
          const name =
            'userId' in actor ? actor.username : 'system' in actor ? actor.system : actor.typed;
          return {
            plant_at: entry.plantAt ?? null,
            user_id: user?.userId ?? null,
            username: name,
            roles: user ? [...user.roles] : [],
            authenticated: entry.authenticated,
            action: entry.action,
            entity_type: entry.entityType,
            entity_id: entry.entityId,
            before: entry.before === undefined ? null : JSON.stringify(entry.before),
            after: entry.after === undefined ? null : JSON.stringify(entry.after),
            request_id: entry.requestId ?? null,
          };
        }),
      )
      .execute();
  }

  /**
   * The audit rows of some entities of one type, newest first (#169): what the other modules'
   * history endpoints read, legacy rows (copied from the module audits by migration 0018) included.
   */
  static async auditEntries(
    db: Kysely<Database> | Transaction<Database>,
    entityType: string,
    entityIds: readonly string[],
    query: AuditQuery = {},
  ): Promise<StoredAuditEntry[]> {
    if (entityIds.length === 0) return [];
    let select = db
      .selectFrom('identity.audit_log')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('entity_id', 'in', [...entityIds]);
    const anyOf = query.anyOf;
    if (anyOf !== undefined) {
      if (anyOf.length === 0) return [];
      // In SQL, so the limit applies to the matching rows only (#185 review, M2).
      select = select.where((eb) =>
        eb.or(
          anyOf.map((condition) => {
            if ('equals' in condition) {
              return eb(
                sql<string>`after ->> ${condition.equals.key}`,
                '=',
                condition.equals.value,
              );
            }
            const { fromKey, toKey, from, to } = condition.overlaps;
            return eb.and([
              eb(sql<Date>`(after ->> ${fromKey})::timestamptz`, '<', to),
              eb.or([
                eb(sql<string>`after ->> ${toKey}`, 'is', null),
                eb(sql<Date>`(after ->> ${toKey})::timestamptz`, '>', from),
              ]),
            ]);
          }),
        ),
      );
    }
    let ordered = select.orderBy('id', 'desc');
    if (query.limit !== undefined) ordered = ordered.limit(query.limit);
    const rows = await ordered.execute();
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      plantAt: row.plant_at,
      userId: row.user_id,
      username: row.username,
      roles: row.roles,
      authenticated: row.authenticated,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before,
      after: row.after,
      requestId: row.request_id,
      legacy: row.legacy,
    }));
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
   * Reserves one attempt before any hash (#168 review, H1; #242): in one transaction on the login
   * pool it locks the user's row (`SELECT … FOR UPDATE`), reads the time once it holds the lock, and
   * then, in this order:
   *
   * 1. the global delay (#242): with n ≥ 10 judged failures in the last 15 minutes from all
   *    addresses together, an attempt within `throttleWaitMs(n)` of the last one is `throttled`
   *    (429 with the remaining wait rounded up), never hashed, never counted, unless this address
   *    logged in to the account within those 15 minutes (#264 review, F3);
   * 2. an admin within its own delay: `throttled` too (429, F3), never hashed;
   * 3. a disabled user or a locked (account, address) pair is `refused` (one dummy hash, the
   *    same 401, not counted);
   * 4. otherwise the attempt is counted as a failure in advance: one `login_failure` row (n + 1),
   *    the pair's count (the fifth locks the pair for 15 minutes; never an admin's) and, for an
   *    admin, the account's count (its next delay). A success clears them afterwards.
   *
   * An unknown user name runs a transaction of the same shape that touches no row (#264 review,
   * F9), so its answer takes as long as a known user's wrong password.
   */
  async #reserve(
    where: { readonly username: string } | { readonly id: number },
    address: string,
  ): Promise<Reservation> {
    return this.#loginDb.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom('identity.user_account as u')
        .select([
          'u.id',
          'u.username',
          'u.password_hash',
          'u.enabled',
          'u.must_change_password',
          'u.failed_logins',
          'u.next_attempt_at',
          sql<string[]>`array(SELECT r.role_id FROM identity.user_role r
            WHERE r.user_id = u.id)`.as('roles'),
        ])
        .forUpdate();
      query =
        'id' in where
          ? query.where('u.id', '=', where.id)
          : query.where('u.username', '=', where.username);
      const row = await query.executeTakeFirst();
      // The time of the decision is read once the row lock is held (#242 gate): an attempt that
      // waited for the lock behind a judged one must not measure its wait from before that one.
      const now = this.#now();
      const windowStart = new Date(now.getTime() - IDENTITY_LIMITS.throttleWindowMs);
      const userId = row?.id ?? 0;
      const recent = await trx
        .selectFrom('identity.login_failure')
        .select([sql<number>`count(*)::int`.as('n'), sql<Date | null>`max(at)`.as('last')])
        .where('user_id', '=', userId)
        .where('at', '>', windowStart)
        .executeTakeFirstOrThrow();
      const pair = await trx
        .selectFrom('identity.login_address')
        .select(['failed_logins', 'locked_until', 'last_success_at'])
        .where('user_id', '=', userId)
        .where('address', '=', address)
        .executeTakeFirst();
      if (!row) {
        // The same statements as a counted failure, touching nothing (#264 review, F9).
        await trx
          .updateTable('identity.login_address')
          .set({ last_failure_at: now })
          .where('user_id', '=', 0)
          .execute();
        await trx
          .updateTable('identity.user_account')
          .set({ next_attempt_at: null })
          .where('id', '=', 0)
          .execute();
        await sql`INSERT INTO identity.login_failure (user_id, address, at)
          SELECT 0, ${address}, ${now} WHERE false`.execute(trx);
        return { kind: 'unknown' as const };
      }
      const roles = ROLES.filter((role) => row.roles.includes(role));
      const user: AccountRow = {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        mustChangePassword: row.must_change_password,
        roles,
      };
      const admin = roles.includes('admin');
      const tooSoon = (until: number) => ({
        kind: 'throttled' as const,
        user,
        until,
        // Never more than the wait itself (the remaining time, rounded up).
        retryAfterS: Math.max(1, Math.ceil((until - now.getTime()) / 1000)),
        admin: false,
      });
      if (row.enabled) {
        // 1. The global delay, unless this address logged in within the window.
        const lastSuccess = pair?.last_success_at ?? null;
        const exempt = lastSuccess !== null && lastSuccess > windowStart;
        const wait = throttleWaitMs(recent.n);
        if (!exempt && wait > 0 && recent.last !== null) {
          // From the last failure, or from now if the clock stepped back past it (F8).
          const until = Math.min(recent.last.getTime(), now.getTime()) + wait;
          if (until > now.getTime()) return tooSoon(until);
        }
        // 2. An admin's own delay: a 429 with its remaining time (F3).
        if (admin && row.next_attempt_at !== null && row.next_attempt_at > now) {
          return { ...tooSoon(row.next_attempt_at.getTime()), admin: true };
        }
      }
      // 3. Refusals: one dummy hash each, not counted.
      if (!row.enabled) return { kind: 'refused' as const, user, reason: 'disabled' as const };
      const pairLock = admin ? null : (pair?.locked_until ?? null);
      if (pairLock !== null && pairLock > now) {
        return { kind: 'refused' as const, user, reason: 'locked' as const, until: pairLock };
      }
      // 4. Counted in advance. A pair lock that has run out starts its count anew.
      const ranOut = pairLock !== null && pairLock <= now;
      const failures = (pair === undefined || ranOut ? 0 : pair.failed_logins) + 1;
      let lockedUntil: Date | undefined;
      let nextAttemptAt: Date | undefined;
      if (admin) {
        // The account's count is an admin's only (F7).
        const accountFailures = row.failed_logins + 1;
        if (accountFailures >= IDENTITY_LIMITS.lockAfter) {
          nextAttemptAt = new Date(
            now.getTime() +
              Math.min(
                IDENTITY_LIMITS.adminDelayBaseMs *
                  2 ** (accountFailures - IDENTITY_LIMITS.lockAfter),
                IDENTITY_LIMITS.adminDelayMaxMs,
              ),
          );
        }
        await trx
          .updateTable('identity.user_account')
          .set({ failed_logins: accountFailures, next_attempt_at: nextAttemptAt ?? null })
          .where('id', '=', row.id)
          .execute();
      } else if (failures >= IDENTITY_LIMITS.lockAfter) {
        lockedUntil = new Date(now.getTime() + IDENTITY_LIMITS.lockMs);
      }
      await trx
        .insertInto('identity.login_address')
        .values({
          user_id: row.id,
          address,
          failed_logins: failures,
          locked_until: lockedUntil ?? null,
          last_failure_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'address']).doUpdateSet({
            failed_logins: failures,
            locked_until: lockedUntil ?? null,
            last_failure_at: now,
          }),
        )
        .execute();
      await trx
        .insertInto('identity.login_failure')
        .values({ user_id: row.id, address, at: now })
        .execute();
      const after = recent.n + 1;
      const globalWait = throttleWaitMs(after);
      return {
        kind: 'reserved' as const,
        user,
        failures,
        ...(lockedUntil === undefined ? {} : { lockedUntil }),
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
        ...(globalWait > 0 ? { globalUntil: now.getTime() + globalWait } : {}),
      };
    });
  }

  /**
   * A reservation as a login or a password check asks for it (#264 review, F1): first what the
   * last decisions of this name say (a known wait is a 429 without the database), then `admit`
   * (the login buckets), then the database, one decision per name at a time and a bounded number
   * at once on the login pool; what the database decided is remembered.
   */
  async #decide(
    name: string,
    address: string,
    where: { readonly username: string } | { readonly id: number },
    admit: (() => number | undefined) | undefined,
  ): Promise<Held> {
    const busy: Held = { kind: 'rate-limited', retryAfterS: 1 };
    const decided = await this.#throttle.serial(name, async (): Promise<Held> => {
      const known = this.#throttle.refusal(name, address, this.#now().getTime());
      if (known !== undefined) return { kind: 'throttled', retryAfterS: known };
      const wait = admit?.();
      if (wait !== undefined) return { kind: 'rate-limited', retryAfterS: wait };
      // A hash slot before the database (#264 re-review, N1): with none free the attempt is a
      // 429 that is neither counted nor hashed.
      const release = this.#hashes.take(address);
      if (release === undefined) return busy;
      const reserved = await this.#throttle
        .reservation(() => this.#reserve(where, address))
        .catch((error: unknown) => {
          release();
          throw error;
        });
      if (reserved === BUSY || reserved.kind === 'throttled') release();
      if (reserved === BUSY) return busy;
      if (reserved.kind === 'throttled') {
        if (reserved.admin) this.#throttle.noteAdmin(name, reserved.until);
        else this.#throttle.noteGlobal(name, reserved.until);
      } else if (reserved.kind === 'reserved') {
        if (reserved.globalUntil !== undefined) {
          this.#throttle.noteGlobal(name, reserved.globalUntil);
        }
        if (reserved.nextAttemptAt !== undefined) {
          this.#throttle.noteAdmin(name, reserved.nextAttemptAt.getTime());
        }
      }
      return reserved.kind === 'throttled' ? reserved : { ...reserved, release };
    });
    return decided === BUSY ? busy : decided;
  }

  /**
   * After a success (#242): the account's judged failures go (n resets), and its count (an admin's
   * delay); this address's pair keeps only its success, which exempts it from the global delay for
   * the window (#264 review, F3). Locks of other addresses stay until they run out.
   */
  async #clearFailures(trx: Transaction<Database>, userId: number, address: string): Promise<void> {
    const now = this.#now();
    await trx.deleteFrom('identity.login_failure').where('user_id', '=', userId).execute();
    await trx
      .insertInto('identity.login_address')
      .values({
        user_id: userId,
        address,
        failed_logins: 0,
        locked_until: null,
        last_success_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['user_id', 'address']).doUpdateSet({
          failed_logins: 0,
          locked_until: null,
          last_success_at: now,
        }),
      )
      .execute();
  }

  /** An admin's reset or the bootstrap: every failure and every pair of the account go. */
  async #clearAllFailures(trx: Transaction<Database>, userId: number): Promise<void> {
    await trx.deleteFrom('identity.login_failure').where('user_id', '=', userId).execute();
    await trx.deleteFrom('identity.login_address').where('user_id', '=', userId).execute();
  }

  /** After a failed reserved attempt: audits the lock this attempt set, if it set one. */
  async #lockedBy(
    user: AccountRow,
    reserved: { readonly failures: number; readonly lockedUntil?: Date },
    address: string,
    requestId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const extra: Record<string, unknown> = { failures: reserved.failures };
    if (reserved.lockedUntil !== undefined) {
      const until = reserved.lockedUntil.toISOString();
      extra.lockedUntil = until;
      // The lock is the pair's (#242): the account stays open from every other address.
      await this.audit(this.#loginDb, {
        actor: { system: 'identity' },
        authenticated: false,
        action: 'user.locked',
        entityType: 'user',
        entityId: user.username,
        after: { failures: reserved.failures, lockedUntil: until, address },
        requestId,
      });
      this.#log.warn({ user: user.username, until, address }, 'account locked for an address');
    }
    return extra;
  }

  /**
   * A login. Every failure (unknown or disabled user, wrong password, a lock of this address or an
   * admin's delay) throws the same `IdentityError` after one password hash, and is audited with the
   * address; an unknown or malformed name is neither logged nor audited as typed (it may be a
   * mistyped password). Refusals before any hash are neither audited nor counted (#242, #264
   * review): the user's global delay and an admin's own delay (`throttled`, 429 with
   * `retryAfterS`), `admit` (the caller's login buckets) and a full queue (429 too). A presented
   * session (`replaces`) ends: a login always gets a new token. Everything a login writes runs on
   * the login pool.
   */
  async login(input: {
    readonly username: string;
    readonly password: string;
    readonly kind: SessionKind;
    readonly requestId?: string | undefined;
    readonly replaces?: Buffer | undefined;
    /** The client's address (#242): the pair (account, address) a lock is keyed by. */
    readonly address?: string | undefined;
    /**
     * The in-memory login buckets (#168 review, M2; keyed by address since #264 review F2):
     * seconds to wait, or undefined to go on. Asked after a wait known from the last decision of
     * this name, so an attempt inside it spends no token, and before the database.
     */
    readonly admit?: (() => number | undefined) | undefined;
  }): Promise<{ readonly token: string; readonly principal: Principal }> {
    const name = input.username.trim().toLowerCase();
    const now = this.#now();
    const address = addressKey(input.address);
    const tooSoon = (retryAfterS: number, message: string): never => {
      throw new IdentityError('throttled', message, PROBLEM_TYPES.loginRate, retryAfterS);
    };
    const failed = async (
      reason: string,
      user?: AccountRow,
      extra: Record<string, unknown> = {},
    ): Promise<never> => {
      await this.audit(this.#loginDb, {
        actor: user
          ? { userId: user.id, username: user.username, roles: user.roles }
          : { system: UNKNOWN_USER },
        authenticated: false,
        action: 'session.login-failed',
        entityType: 'user',
        entityId: user ? user.username : UNKNOWN_USER,
        after: { reason, address, ...extra },
        requestId: input.requestId,
      });
      this.#log.warn(
        { ...(user ? { user: user.username } : {}), reason, address, ...extra },
        'login failed',
      );
      throw new IdentityError('unauthenticated', LOGIN_FAILED, PROBLEM_TYPES.unauthenticated);
    };
    // A malformed name runs the same decision as an unknown one (its query finds no row).
    const reserved = await this.#decide(
      name,
      address,
      { username: USERNAME_PATTERN.test(name) ? name : '' },
      input.admit,
    );
    if (reserved.kind === 'throttled') return tooSoon(reserved.retryAfterS, LOGIN_THROTTLED);
    if (reserved.kind === 'rate-limited') return tooSoon(reserved.retryAfterS, LOGIN_RATE);
    /** The one hash of this attempt; its slot is free again once it is done (N1). */
    const hashed = async (password: string, stored: string): Promise<boolean> => {
      try {
        return await verifyPassword(password, stored);
      } finally {
        reserved.release?.();
      }
    };
    if (reserved.kind === 'unknown') {
      await hashed(input.password, await this.#dummyHash());
      return failed('unknown-user');
    }
    const user = reserved.user;
    if (reserved.kind === 'refused') {
      await hashed(input.password, await this.#dummyHash());
      return failed(
        reserved.reason,
        user,
        reserved.until === undefined ? {} : { lockedUntil: reserved.until.toISOString() },
      );
    }
    if (!(await hashed(input.password, user.passwordHash))) {
      const extra = await this.#lockedBy(user, reserved, address, input.requestId);
      if (reserved.nextAttemptAt !== undefined) {
        extra.nextAttemptAt = reserved.nextAttemptAt.toISOString();
      }
      return failed('wrong-password', user, extra);
    }
    const roles = user.roles;
    const token = randomBytes(32);
    const hash = tokenHash(token);
    const session: SessionInfo = {
      id: hash.toString('hex'),
      kind: input.kind,
      createdAt: now,
      idleExpiresAt: new Date(now.getTime() + IDENTITY_LIMITS.idleMs[input.kind]),
      expiresAt: new Date(now.getTime() + IDENTITY_LIMITS.absoluteMs),
    };
    const rehash = needsRehash(user.passwordHash, this.#params)
      ? await hashPassword(input.password, this.#params)
      : undefined;
    const replaced = await this.#loginDb.transaction().execute(async (trx) => {
      await trx
        .updateTable('identity.user_account')
        .set({
          failed_logins: 0,
          next_attempt_at: null,
          ...(rehash === undefined ? {} : { password_hash: rehash }),
        })
        .where('id', '=', user.id)
        .execute();
      await this.#clearFailures(trx, user.id, address);
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
    this.#throttle.noteSuccess(name, address, this.#now().getTime());
    this.#emit({ ids: replaced, reason: 'replaced' });
    this.#log.info({ user: user.username, kind: session.kind }, 'login');
    return {
      token: token.toString('base64url'),
      principal: {
        userId: user.id,
        username: user.username,
        roles,
        permissions: permissionsOf(roles),
        mustChangePassword: user.mustChangePassword,
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
    address?: string,
  ): Promise<{ readonly endedSessions: number }> {
    const from = addressKey(address);
    // The new password's rules first: they reveal nothing about the current one.
    const problem =
      passwordProblem(next) ??
      (next === current ? 'the new password is the current one' : undefined);
    if (problem !== undefined) {
      throw new IdentityError('invalid', problem, PROBLEM_TYPES.passwordRejected);
    }
    // The current password is checked like a login (#168 review, M1): the attempt is reserved
    // first, so a mismatch counts towards the same lock or admin delay.
    const reserved = await this.#decide(
      principal.username,
      from,
      { id: principal.userId },
      undefined,
    );
    if (reserved.kind === 'throttled' || reserved.kind === 'rate-limited') {
      throw new IdentityError(
        'throttled',
        LOGIN_THROTTLED,
        PROBLEM_TYPES.loginRate,
        reserved.retryAfterS,
      );
    }
    const refusedOrWrong = async (
      reason: string,
      extra: Record<string, unknown>,
    ): Promise<never> => {
      await this.audit(this.#db, {
        actor: principal,
        authenticated: true,
        action: 'user.password-change-failed',
        entityType: 'user',
        entityId: principal.username,
        after: { reason, ...extra },
        requestId,
      });
      throw new IdentityError(
        'invalid',
        reason === 'wrong-current-password'
          ? 'the current password does not match'
          : 'too many failed attempts; try again later',
        PROBLEM_TYPES.passwordRejected,
      );
    };
    if (reserved.kind !== 'reserved') {
      reserved.release?.();
      return refusedOrWrong(reserved.kind === 'refused' ? reserved.reason : 'unknown-user', {});
    }
    let matches: boolean;
    try {
      matches = await verifyPassword(current, reserved.user.passwordHash);
    } finally {
      reserved.release?.();
    }
    if (!matches) {
      const extra = await this.#lockedBy(reserved.user, reserved, from, requestId);
      if (reserved.nextAttemptAt !== undefined) {
        extra.nextAttemptAt = reserved.nextAttemptAt.toISOString();
      }
      return refusedOrWrong('wrong-current-password', extra);
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
          next_attempt_at: null,
          password_changed_at: this.#now(),
          updated_at: this.#now(),
        })
        .where('id', '=', principal.userId)
        .execute();
      await this.#clearFailures(trx, principal.userId, from);
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
    this.#throttle.noteSuccess(principal.username, from, this.#now().getTime());
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
    // Locked: from at least one address (#242); the account itself is never locked.
    const locked = new Set(
      (
        await this.#db
          .selectFrom('identity.login_address')
          .select('user_id')
          .where('locked_until', '>', now)
          .execute()
      ).map((row) => row.user_id),
    );
    return rows.map((row) => {
      const held = roles.filter((r) => r.user_id === row.id).map((r) => r.role_id);
      return {
        id: row.id,
        username: row.username,
        roles: ROLES.filter((role) => held.includes(role)),
        enabled: row.enabled,
        mustChangePassword: row.must_change_password,
        locked: locked.has(row.id),
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
      // A role change resets the account's count (an admin's delay; #264 review, F7), so a
      // normal account's failures never become an admin's delay, nor the other way round.
      const rolesChanged = before.roles.join() !== after.roles.join();
      await trx
        .updateTable('identity.user_account')
        .set({
          enabled: after.enabled,
          updated_at: this.#now(),
          ...(rolesChanged ? { failed_logins: 0, next_attempt_at: null } : {}),
        })
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
    // A role change or an enable or disable changes which delay applies (#264 re-review, N3):
    // what memory holds of this name is forgotten, and the next attempt asks the database.
    if (change.roles !== undefined || change.enabled !== undefined) this.#throttle.forget(username);
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
          next_attempt_at: null,
          password_changed_at: this.#now(),
          updated_at: this.#now(),
        })
        .where('username', '=', username)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new IdentityError('not-found', `no user ${username}`);
      await this.#clearAllFailures(trx, row.id);
      this.#throttle.forget(username);
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
            next_attempt_at: null,
            updated_at: this.#now(),
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.#clearAllFailures(trx, row.id);
      this.#throttle.forget('admin');
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
