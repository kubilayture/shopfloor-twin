import websocket from '@fastify/websocket';
import type { IncomingHttpHeaders } from 'node:http';
import {
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_UNAUTHENTICATED,
} from '@shopfloor/contracts/identity';
import {
  PROBLEM_TYPES,
  loginRequestSchema,
  passwordChangeRequestSchema,
  passwordChangeResultSchema,
  passwordResetRequestSchema,
  sessionSchema,
  userCreateRequestSchema,
  userListSchema,
  userSchema,
  userUpdateRequestSchema,
  type ProblemType,
  type SessionDto,
  type UserDto,
} from '@shopfloor/contracts/mes-api';
import { z } from 'zod';
import { NO_SHIFT, shiftInstance, shiftInstances } from '@shopfloor/shift-calendar';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Registry } from 'prom-client';
import {
  CodingError,
  parseRecordId,
  type DowntimeCoding,
  type Equipment,
  type StoredInterval,
} from '../equipment/index.ts';
import { AlarmWriteError, type Alarms, type AlarmScope } from '../alarms/index.ts';
import {
  IdentityError,
  parseToken,
  type Identity,
  type Principal,
  type User,
  type WriteBy,
} from '../identity/index.ts';
import type { Ingest } from '../ingest/index.ts';
import type { EquipmentInfo, MasterData } from '../master-data/index.ts';
import type { Orders } from '../orders/index.ts';
import { pareto, type DowntimeFeed, type Oee, type OeeScope } from '../oee/index.ts';
import { ShiftError, type ShiftRecord, type Shifts } from '../shifts/index.ts';
import {
  alarmKpiDto,
  badActorDto,
  commentDto,
  floodEpisodeDto,
  historyDto,
  occurrenceDto,
  operatorBucketDto,
  pointDto,
  shelfDto,
  transitionDto,
} from './alarm-dto.ts';
import { bucketDto, recordDto, shiftInstanceDto } from './oee-dto.ts';
import { executionRoutes, type ExecutionApi } from './execution-routes.ts';
import { orderRoutes, type OrdersApi } from './order-routes.ts';
import {
  handoverAuditDto,
  handoverNoteDto,
  notesDto,
  shiftOeeDto,
  shiftRecordDto,
  shiftReportDto,
} from './shift-dto.ts';
import { PushHub, currentStateDto, type PushOptions } from './push.ts';
import {
  HttpProblem,
  PROBLEM_TYPE,
  getRoute,
  jsonSchema,
  problem,
  writeRoute,
  type Access,
  type RouteConfig,
} from './routes.ts';
import {
  LIMITS,
  acknowledgeRequestSchema,
  acknowledgeResultSchema,
  alarmPointAuditSchema,
  alarmPointListSchema,
  alarmPointParams,
  alarmPointsQuery,
  operatorKpiListSchema,
  operatorKpiQuery,
  bulkAcknowledgeRequestSchema,
  bulkAcknowledgeResultSchema,
  commentRequestSchema,
  commentResultSchema,
  noParams,
  shelfResultSchema,
  shelveRequestSchema,
  unshelveRequestSchema,
  alarmDetailSchema,
  alarmHistorySchema,
  alarmKpiListSchema,
  alarmKpiQuery,
  alarmListQuery,
  alarmListSchema,
  alarmParams,
  alarmRangeQuery,
  alarmConfigSchema,
  alarmScopesSchema,
  badActorListSchema,
  badActorsQuery,
  floodListSchema,
  codingRequestSchema,
  codingResultSchema,
  currentShiftSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  downtimeParams,
  downtimeQuery,
  equipmentListSchema,
  equipmentParams,
  equipmentSchema,
  intervalsQuery,
  intervalsSchema,
  metricsSchema,
  noQuery,
  oeeListSchema,
  oeeQuery,
  paretoQuery,
  paretoSchema,
  plantSchema,
  problemSchema,
  reasonCodesQuery,
  reasonCodesSchema,
  seriesSchema,
  shiftListSchema,
  shiftOeeQuery,
  shiftOeeSchema,
  shiftParams,
  shiftTotalsQuery,
  shiftTotalsSchema,
  shiftsQuery,
  telemetryQuery,
  handoverAuditSchema,
  handoverNotesSchema,
  noteCreateSchema,
  noteEditSchema,
  noteParams,
  noteResultSchema,
  shiftInstanceQuery,
  shiftRecordSchema,
  shiftReportSchema,
  type EquipmentDto,
  type IntervalDto,
} from './schemas.ts';

export const API_PREFIX = '/api/v1';
export const WS_PATH = `${API_PREFIX}/ws`;

/** What the API reads from the other modules (their `index.ts` interfaces). */
export interface ApiSources {
  readonly masterData: Pick<MasterData, 'equipment' | 'site' | 'shiftPattern' | 'reasonCodes'>;
  readonly equipment: Pick<
    Equipment,
    | 'currentStates'
    | 'currentState'
    | 'intervals'
    | 'shiftTotals'
    | 'downtimeRecords'
    | 'watermark'
    | 'watermarks'
    | 'onChange'
  >;
  readonly ingest: Pick<Ingest, 'telemetryMetrics' | 'telemetrySeries' | 'onStored'>;
  /** OEE on read (#120). */
  readonly oee: Pick<
    Oee,
    | 'buckets'
    | 'shift'
    | 'current'
    | 'members'
    | 'workCenters'
    | 'paretoInputs'
    | 'reasonCodes'
    | 'onChange'
    | 'config'
    | 'shiftPattern'
  >;
  /** Downtime record changes for the `downtime` push topic (#120). */
  readonly downtime?: Pick<DowntimeFeed, 'subscribe'>;
  /** Operator coding writes and their audit (#121). */
  readonly coding: Pick<DowntimeCoding, 'code' | 'audit'>;
  /** Alarm occurrences and KPIs (#142); the alarm routes answer 503 without it. */
  readonly alarms?: Pick<
    Alarms,
    | 'list'
    | 'occurrence'
    | 'history'
    | 'kpis'
    | 'floods'
    | 'badActors'
    | 'scopes'
    | 'scope'
    | 'settings'
    | 'definition'
    | 'current'
    | 'onChange'
    | 'acknowledge'
    | 'comment'
    | 'shelve'
    | 'unshelve'
    | 'points'
    | 'point'
    | 'shelf'
    | 'comments'
    | 'pointAudit'
    | 'operatorMeasures'
  >;
  /** Shift instances, the shift report and handover notes (#144); 503 without it. */
  readonly shifts?: Pick<
    Shifts,
    'instance' | 'report' | 'notes' | 'note' | 'noteAudit' | 'createNote' | 'editNote' | 'onChange'
  >;
  /** Production orders and their commands (#174); the order routes answer 503 without it. */
  readonly orders?: OrdersApi & Pick<Orders, 'onChange'>;
  /** Units, an order's execution and scrap records (#175); the execution routes answer 503 without it. */
  readonly execution?: ExecutionApi;
}

export interface RealtimeOptions {
  readonly registry?: Registry;
  readonly push?: Omit<PushOptions, 'registry'>;
  /** Host names the API answers (`Host` header, against DNS rebinding); `*` for any. */
  readonly allowedHosts?: readonly string[];
  /**
   * Origins a WebSocket or a write may come from besides the MES's own host (none by default).
   */
  readonly allowedOrigins?: readonly string[];
  /** `MES_WRITES`: false turns every write (non-GET request) into a 405 (ADR-0023). */
  readonly writes?: boolean;
  /** The global write rate limit (all clients together; default `LIMITS`). */
  readonly writeRate?: { readonly perSecond: number; readonly burst: number };
  /**
   * Identity (#168, ADR-0026): sessions, login and users. Without it the session and user routes
   * answer 503 (the OpenAPI generator).
   */
  readonly identity?: IdentityApi;
  /**
   * `MES_AUTH=on` (the environment's default since #170): every route but the login needs a
   * session, and the WebSocket too. Off (the default here, for tests of reads): reads and the
   * WebSocket are served without one; writes still need a session and their permission.
   */
  readonly auth?: boolean;
  /** `MES_COOKIE_SECURE=on`: `Secure` cookie named `__Host-sft_session`. */
  readonly cookieSecure?: boolean;
  /** Each user's write bucket (default `LIMITS`: 5 per second, bursts of 10). */
  readonly userWriteRate?: { readonly perSecond: number; readonly burst: number };
  /** How often open sockets' sessions are checked for expiry (default 15 s). */
  readonly sessionCheckMs?: number;
  /** All logins together (default `LIMITS`: 5 per second, bursts of 10). */
  readonly loginRate?: { readonly perSecond: number; readonly burst: number };
  /** Logins per user name (default `LIMITS`: 1 per second, bursts of 5). */
  readonly userLoginRate?: { readonly perSecond: number; readonly burst: number };
}

/** What the API uses of the identity module. */
export type IdentityApi = Pick<
  Identity,
  | 'started'
  | 'login'
  | 'authenticate'
  | 'live'
  | 'logout'
  | 'changePassword'
  | 'users'
  | 'createUser'
  | 'updateUser'
  | 'resetPassword'
  | 'onSessionsEnded'
>;

/** A token bucket: one for all writes, because behind nginx every request comes from nginx. */
export class WriteLimiter {
  readonly #perSecond: number;
  readonly #burst: number;
  #tokens: number;
  #at: number;

  constructor(perSecond: number, burst: number, now = performance.now()) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#tokens = burst;
    this.#at = now;
  }

  /** Whether the bucket has refilled completely (nothing to remember about its client). */
  full(now = performance.now()): boolean {
    return this.#tokens + ((now - this.#at) / 1000) * this.#perSecond >= this.#burst;
  }

  /** Takes a token: undefined when allowed, else the seconds until one is free. */
  take(now = performance.now()): number | undefined {
    this.#tokens = Math.min(
      this.#burst,
      this.#tokens + ((now - this.#at) / 1000) * this.#perSecond,
    );
    this.#at = now;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return undefined;
    }
    return Math.max(1, Math.ceil((1 - this.#tokens) / this.#perSecond));
  }
}

/**
 * One token bucket per key (the login's user name, #168): a bucket that has refilled completely
 * holds nothing worth remembering, so it is forgotten (at most once a second), and the map holds
 * only the keys used within about `burst / perSecond` seconds, whatever names are tried.
 */
export class KeyedLimiter {
  readonly #perSecond: number;
  readonly #burst: number;
  readonly #buckets = new Map<string, WriteLimiter>();
  #pruned = -Infinity;

  constructor(perSecond: number, burst: number) {
    this.#perSecond = perSecond;
    this.#burst = burst;
  }

  /** Keys with a bucket that has not refilled yet (or not been pruned). */
  get size(): number {
    return this.#buckets.size;
  }

  /** Takes a token for the key: undefined when allowed, else the seconds until one is free. */
  take(key: string, now = performance.now()): number | undefined {
    if (now - this.#pruned >= 1_000) {
      this.#pruned = now;
      for (const [other, bucket] of this.#buckets) {
        if (bucket.full(now)) this.#buckets.delete(other);
      }
    }
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = new WriteLimiter(this.#perSecond, this.#burst, now);
      this.#buckets.set(key, bucket);
    }
    return bucket.take(now);
  }
}

/** A JSON content type: `application/json`, with parameters (charset) or not. */
const isJson = (contentType: string | undefined): boolean =>
  (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() === 'application/json';

const CODING_STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const IDENTITY_STATUS = {
  unauthenticated: 401,
  'not-found': 404,
  conflict: 409,
  invalid: 422,
} as const;

/** The value of one cookie of a `Cookie` header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const split = part.indexOf('=');
    if (split > 0 && part.slice(0, split).trim() === name) return part.slice(split + 1).trim();
  }
  return undefined;
}

const sessionDto = (principal: Principal): SessionDto => ({
  user: {
    id: principal.userId,
    username: principal.username,
    roles: [...principal.roles],
    permissions: [...principal.permissions],
    mustChangePassword: principal.mustChangePassword,
  },
  kind: principal.session.kind,
  createdAt: principal.session.createdAt.toISOString(),
  idleExpiresAt: principal.session.idleExpiresAt.toISOString(),
  expiresAt: principal.session.expiresAt.toISOString(),
});

const userDto = (user: User): UserDto => ({
  id: user.id,
  username: user.username,
  roles: [...user.roles],
  enabled: user.enabled,
  mustChangePassword: user.mustChangePassword,
  locked: user.locked,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const usernameParams = z.strictObject({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
});
const emptyBody = z.strictObject({}).describe('An empty JSON object');
/** Alarm write refusals (#143) map the same way. */
const ALARM_WRITE_STATUS = CODING_STATUS;
const SHIFT_STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;

export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** The API and push, registered before the modules exist; `attach` connects them. */
export interface Realtime {
  attach(sources: ApiSources): Promise<void>;
  readonly push: PushHub;
}

interface Attached {
  readonly sources: ApiSources;
  readonly catalog: ReadonlyMap<string, EquipmentInfo>;
  readonly shifts: ReadonlySet<string>;
}

/** The host name of a `Host` header (`[::1]:4700` → `[::1]`), lower-cased. */
export function hostName(host: string): string {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return (name ?? '').toLowerCase();
}

/**
 * Whether an Origin header names the host the request was sent to: host and port, not the scheme
 * (TLS ends in front of the MES, if anywhere; acceptable on loopback, ADR-0023).
 */
export function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    const url = new URL(origin);
    // Only an exact origin string (scheme://host[:port], nothing after it) is one.
    return url.origin === origin && url.host === host;
  } catch {
    return false;
  }
}

/**
 * Pool or statement timeouts of the read pool: the database is busy, try again (503), never 500.
 * SQLSTATE 57014 is `query_canceled` (statement_timeout); pg reports a pool wait without a code.
 */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '57014' || /timeout exceeded when trying to connect/i.test(error.message);
}

const iso = (date: Date): string => date.toISOString();

/** `{raisedAtMs}~{occurrence id}` (the alarm list's `next`). */
function parseCursor(cursor: string): { raisedAt: Date; id: string } {
  const split = cursor.indexOf('~');
  return { raisedAt: new Date(Number(cursor.slice(0, split))), id: cursor.slice(split + 1) };
}

/**
 * Merges the stored hour and shift pieces of each interval back, clipped to [from, to).
 *
 * `cutoff` is the start of the first piece left out by the row limit: an interval reaching it may
 * have pieces beyond the limit, so it is dropped, and `next` (the earliest start of the dropped
 * ones) is where the following request continues.
 */
export function mergePieces(
  pieces: readonly StoredInterval[],
  from: Date,
  to: Date,
  cutoff?: Date,
): { intervals: IntervalDto[]; next: Date | null } {
  const merged = new Map<
    string,
    { piece: StoredInterval; start: number; end: number; provisional: boolean }
  >();
  for (const piece of pieces) {
    const key = `${String(piece.epoch)}|${String(piece.intervalStart.getTime())}|${String(piece.startSeq)}`;
    const entry = merged.get(key);
    if (entry) {
      entry.start = Math.min(entry.start, piece.start.getTime());
      entry.end = Math.max(entry.end, piece.end.getTime());
      entry.provisional ||= piece.provisional;
    } else {
      merged.set(key, {
        piece,
        start: piece.start.getTime(),
        end: piece.end.getTime(),
        provisional: piece.provisional,
      });
    }
  }
  const all = [...merged.values()].sort(
    (a, b) => a.start - b.start || a.piece.epoch - b.piece.epoch,
  );
  const limit = cutoff?.getTime() ?? Infinity;
  const complete = all.filter((entry) => entry.end < limit);
  const dropped = all.filter((entry) => entry.end >= limit);
  const next =
    cutoff === undefined
      ? null
      : new Date(Math.max(from.getTime(), Math.min(limit, ...dropped.map((e) => e.start))));
  return {
    next,
    intervals: complete.map(({ piece, start, end, provisional }) => ({
      epoch: piece.epoch,
      start: iso(new Date(Math.max(start, from.getTime()))),
      end: iso(new Date(Math.min(end, to.getTime()))),
      state: piece.state,
      cause: piece.cause,
      provisional,
      intervalStart: iso(piece.intervalStart),
      startSeq: piece.startSeq,
    })),
  };
}

/**
 * The `realtime` module (#97): the read-only REST API under `/api/v1` and WebSocket push at
 * `/api/v1/ws`. Routes answer 503 until `attach` gave them the modules.
 */
export async function registerRealtime(
  app: FastifyInstance,
  options: RealtimeOptions = {},
): Promise<Realtime> {
  const push = new PushHub({
    ...options.push,
    ...(options.registry ? { registry: options.registry } : {}),
  });
  let attached: Attached | undefined;
  const ready = (): Attached => {
    if (!attached) throw new HttpProblem(503, 'the MES is starting');
    return attached;
  };
  const known = (id: string): EquipmentInfo => {
    const info = ready().catalog.get(id);
    if (!info) throw new HttpProblem(404, `no equipment ${id}`);
    return info;
  };
  const dto = (info: EquipmentInfo): EquipmentDto => {
    const { equipment } = ready().sources;
    const current = equipment.currentState(info.id);
    return {
      id: info.id,
      name: info.name,
      operation: info.operation,
      interface: info.interface,
      position: info.position,
      site: info.site,
      area: info.area,
      workCenter: info.workCenter,
      current: current ? currentStateDto(current, equipment.watermark(current.epoch)) : null,
    };
  };

  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
  );
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const writes = options.writes ?? true;
  const limiter = new WriteLimiter(
    options.writeRate?.perSecond ?? LIMITS.writesPerSecond,
    options.writeRate?.burst ?? LIMITS.writeBurst,
  );
  // Writes before identity (ADR-0023): only a page of this origin (or an allowlisted one) may
  // write. A cross-site form or other simple request (no JSON content type, no Origin from a
  // non-browser that didn't set one) never reaches a handler; there are no CORS headers, so no
  // other page can send a JSON write either.
  const writeRefusal = (
    headers: IncomingHttpHeaders,
    access: Access,
  ):
    | { status: number; detail: string; type: ProblemType; headers?: Record<string, string> }
    | undefined => {
    // Logging in and out and changing one's password stay possible with MES_WRITES=off (#168
    // review, M3): otherwise MES_AUTH=on would lock everyone out of a read-only MES. The Origin
    // and JSON guards below still apply.
    if (!writes && access !== 'public' && access !== 'session') {
      return {
        status: 405,
        detail: 'writes are turned off (MES_WRITES=off)',
        type: PROBLEM_TYPES.writesOff,
        headers: { allow: 'GET, HEAD' },
      };
    }
    const forbidden = (detail: string) =>
      ({ status: 403, detail, type: PROBLEM_TYPES.writeOrigin }) as const;
    const origin = headers.origin;
    if (origin === undefined) return forbidden('a write needs an Origin header');
    if (!allowedOrigins.has(origin) && !sameOrigin(origin, headers.host)) {
      return forbidden('origin not allowed (HTTP_ALLOWED_ORIGINS)');
    }
    const site = headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') {
      return forbidden(`Sec-Fetch-Site ${site} not allowed for a write`);
    }
    if (!isJson(headers['content-type'])) {
      return {
        status: 415,
        detail: 'a write must be application/json',
        type: PROBLEM_TYPES.writeNotJson,
      };
    }
    return undefined;
  };
  // The rate limits come last, after authentication (#168): an anonymous request never spends a
  // token. The global bucket stays (ADR-0023); each user has its own besides.
  const userLimiters = new Map<number, WriteLimiter>();
  const rateRefusal = (
    principal: Principal | undefined,
  ):
    | { status: number; detail: string; type: ProblemType; headers: Record<string, string> }
    | undefined => {
    let wait: number | undefined;
    let detail = 'too many writes; try again';
    if (principal !== undefined) {
      let bucket = userLimiters.get(principal.userId);
      if (!bucket) {
        bucket = new WriteLimiter(
          options.userWriteRate?.perSecond ?? LIMITS.userWritesPerSecond,
          options.userWriteRate?.burst ?? LIMITS.userWriteBurst,
        );
        userLimiters.set(principal.userId, bucket);
      }
      wait = bucket.take();
      if (wait !== undefined) detail = `too many writes by ${principal.username}; try again`;
    }
    wait ??= limiter.take();
    if (wait === undefined) return undefined;
    return {
      status: 429,
      detail,
      type: PROBLEM_TYPES.writeRate,
      headers: { 'retry-after': String(wait) },
    };
  };

  // Logins have buckets of their own (#168 review, M2), so anonymous login attempts never spend
  // the write bucket that plant writes need: one for all logins together and one per user name.
  const loginLimiter = new WriteLimiter(
    options.loginRate?.perSecond ?? LIMITS.loginsPerSecond,
    options.loginRate?.burst ?? LIMITS.loginBurst,
  );
  const nameLimiters = new KeyedLimiter(
    options.userLoginRate?.perSecond ?? LIMITS.userLoginsPerSecond,
    options.userLoginRate?.burst ?? LIMITS.userLoginBurst,
  );
  const loginRefusal = (username: string): number | undefined =>
    nameLimiters.take(username.trim().toLowerCase()) ?? loginLimiter.take();

  // Identity (#168, ADR-0026).
  const identity = options.identity;
  const auth = options.auth ?? false;
  const cookieName = options.cookieSecure === true ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${options.cookieSecure === true ? '; Secure' : ''}`;
  /** Principals of authenticated requests (also WebSocket upgrades). */
  const principals = new WeakMap<FastifyRequest, Principal>();
  /** Requests whose upgrade had no live session: the socket is closed with 4401 at once. */
  const anonymousUpgrades = new WeakSet<FastifyRequest>();
  /** Upgrades whose session may not read (a temporary password, no `read`): closed with 4403. */
  const forbiddenUpgrades = new WeakSet<FastifyRequest>();
  const needIdentity = (): IdentityApi => {
    if (!identity?.started) throw new HttpProblem(503, 'the MES is starting');
    return identity;
  };
  const principalOf = (request: FastifyRequest): Principal => {
    const principal = principals.get(request);
    if (!principal) {
      throw new HttpProblem(401, 'a session is needed', PROBLEM_TYPES.unauthenticated);
    }
    return principal;
  };
  /**
   * Who a write is by: the session's user (#170). Every write needs a session, also with
   * `MES_AUTH=off`, so the authentication hook has always set the principal before a handler runs.
   */
  const writeBy = (request: FastifyRequest): WriteBy => {
    const principal = principalOf(request);
    return { userId: principal.userId, username: principal.username, roles: principal.roles };
  };
  const tokenOf = (request: FastifyRequest): Buffer | undefined =>
    parseToken(cookieValue(request.headers.cookie, cookieName));
  const accessOf = (request: FastifyRequest): Access =>
    (request.routeOptions.config as Partial<RouteConfig> | undefined)?.access ?? 'read';
  /**
   * Authentication (401) and permission (403), after the Host and Origin checks so a cross-site
   * request never learns whether a session exists (ADR-0026). With `MES_AUTH=off` (#170) only the
   * reads (`read`) and the WebSocket are served without one: every write still needs a session and
   * its permission, so every write has a known user.
   */
  const authRefusal = async (
    request: FastifyRequest,
  ): Promise<{ status: number; detail: string; type?: ProblemType } | undefined> => {
    const access = accessOf(request);
    if (access === 'public' || (!auth && access === 'read')) return undefined;
    if (!identity?.started) return { status: 503, detail: 'the MES is starting' };
    const token = tokenOf(request);
    const principal = token && (await identity.authenticate(token, { touch: true }));
    if (!principal) {
      return {
        status: 401,
        detail: 'a session is needed: log in (POST /api/v1/session)',
        type: PROBLEM_TYPES.unauthenticated,
      };
    }
    principals.set(request, principal);
    if (access === 'session') return undefined;
    if (principal.mustChangePassword) {
      return {
        status: 403,
        detail: 'change the password first (POST /api/v1/account/password)',
        type: PROBLEM_TYPES.passwordChangeRequired,
      };
    }
    if (!principal.permissions.includes(access)) {
      return {
        status: 403,
        detail: `permission ${access} needed`,
        type: PROBLEM_TYPES.forbidden,
      };
    }
    return undefined;
  };
  /** Open sockets per session id, closed with 4401 when the session ends or expires. */
  const sockets = new Map<string, Set<{ close(code: number, reason: string): void }>>();
  const closeSession = (id: string, reason: string): void => {
    for (const socket of sockets.get(id) ?? []) socket.close(WS_CLOSE_UNAUTHENTICATED, reason);
    sockets.delete(id);
  };
  const unsubscribe = identity?.onSessionsEnded((ended) => {
    for (const id of ended.ids) closeSession(id, `session ended (${ended.reason})`);
  });
  const sessionCheck = setInterval(() => {
    if (!identity) return;
    for (const id of [...sockets.keys()]) {
      identity.live(id).then(
        (live) => {
          if (!live) closeSession(id, 'session expired');
        },
        (error: unknown) => {
          app.log.warn({ err: error }, 'session check failed');
        },
      );
    }
  }, options.sessionCheckMs ?? 15_000);
  sessionCheck.unref();
  app.addHook('onClose', () => {
    clearInterval(sessionCheck);
    unsubscribe?.();
  });
  const problemReply = async (
    reply: FastifyReply,
    request: FastifyRequest,
    refused: {
      status: number;
      detail: string;
      type?: ProblemType;
      headers?: Record<string, string>;
    },
  ): Promise<void> => {
    await reply
      .code(refused.status)
      .headers(refused.headers ?? {})
      .type(PROBLEM_TYPE)
      .send(problem(refused.status, refused.detail, request.url, refused.type));
  };
  // A page on another site must not read plant data: by DNS rebinding (its own name resolving to
  // the MES, caught by the Host check) or by opening a WebSocket (not covered by CORS, caught by
  // the Origin check). A request without Origin is not from a browser page.
  const refusal = (
    headers: IncomingHttpHeaders,
  ): { detail: string; type?: ProblemType } | undefined => {
    const host = hostName(headers.host ?? '');
    if (!allowedHosts.has('*') && !allowedHosts.has(host)) {
      return {
        detail: 'host not allowed (HTTP_ALLOWED_HOSTS)',
        type: PROBLEM_TYPES.hostNotAllowed,
      };
    }
    const origin = headers.origin;
    if (origin === undefined || allowedOrigins.has(origin) || sameOrigin(origin, headers.host)) {
      return undefined;
    }
    return { detail: 'origin not allowed (HTTP_ALLOWED_ORIGINS)' };
  };

  app.addSchema({ $id: 'Problem', ...jsonSchema(problemSchema, 'output') });

  await app.register(websocket, {
    options: {
      maxPayload: 4096,
      verifyClient: (info, done) => {
        const refused = refusal(info.req.headers);
        if (refused === undefined) done(true);
        else done(false, 403, refused.detail);
      },
    },
    // A client that stopped reading would hold up shutdown for ws's 30 s close timeout.
    preClose: (done) => {
      push.close();
      for (const client of app.websocketServer.clients) client.terminate();
      done();
    },
  });

  await app.register(
    (api, _options, done) => {
      // A page on another site must not read plant data: by DNS rebinding (its own name resolving
      // to the MES, caught by the Host check) or by opening a WebSocket (not covered by CORS,
      // caught by the Origin check). A request without Origin is not from a browser page.
      api.addHook('onRequest', async (request, reply) => {
        // A real WebSocket upgrade of the push route only (#168 review, B1): `request.ws` is
        // set by @fastify/websocket for a connection that upgrades (Connection: upgrade); an
        // `Upgrade` header alone is an ordinary request and meets every guard below. Host and
        // Origin are checked here and answered by `verifyClient`; the session here, so the handler
        // can close a socket with 4401 or 4403 (a browser can't read an HTTP status of a refused
        // upgrade).
        if (request.ws && request.method === 'GET' && request.routeOptions.url === WS_PATH) {
          // A refused Host or Origin: no session lookup; `verifyClient` answers the 403 (a reply
          // from this hook would be dropped with the upgrading socket).
          if (refusal(request.headers) !== undefined) return;
          if (!auth) return;
          const token = tokenOf(request);
          const principal =
            identity?.started === true && token !== undefined
              ? await identity.authenticate(token, { touch: true })
              : undefined;
          if (!principal) anonymousUpgrades.add(request);
          else if (principal.mustChangePassword || !principal.permissions.includes('read')) {
            forbiddenUpgrades.add(request);
          } else principals.set(request, principal);
          return;
        }
        const read = request.method === 'GET' || request.method === 'HEAD';
        // A write's Origin is checked by `writeRefusal`, after MES_WRITES (ADR-0023's order).
        const refused = refusal(read ? request.headers : { host: request.headers.host });
        if (refused !== undefined) {
          await reply
            .code(403)
            .type(PROBLEM_TYPE)
            .send(problem(403, refused.detail, request.url, refused.type));
          return;
        }
        if (!read) {
          // Every other method is a write (ADR-0023); its answer names the request for the audit.
          reply.header('x-request-id', request.id);
          const write = writeRefusal(request.headers, accessOf(request));
          if (write !== undefined) {
            await problemReply(reply, request, write);
            return;
          }
        }
        const denied = await authRefusal(request);
        if (denied !== undefined) {
          await problemReply(reply, request, denied);
          return;
        }
        // The login has buckets of its own (in its handler, which knows the name); logout needs
        // none (it only ends the session it presents).
        if (read || accessOf(request) === 'public') return;
        const rate = rateRefusal(principals.get(request));
        if (rate !== undefined) await problemReply(reply, request, rate);
      });
      api.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
        const busy = isBusy(error);
        const status = busy
          ? 503
          : error instanceof HttpProblem
            ? error.status
            : error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
              ? error.statusCode
              : 500;
        if (status >= 500) request.log[busy || status === 503 ? 'warn' : 'error'](error);
        const detail = busy
          ? 'the database is busy; try again'
          : status >= 500 && status !== 503
            ? 'internal error'
            : error.message;
        return reply
          .code(status)
          .type(PROBLEM_TYPE)
          .send(
            problem(
              status,
              detail,
              request.url,
              !busy && error instanceof HttpProblem ? error.type : undefined,
            ),
          );
      });
      api.setNotFoundHandler((request, reply) =>
        reply
          .code(404)
          .type(PROBLEM_TYPE)
          .send(
            problem(
              404,
              `no route ${request.method} ${request.url.split('?', 1)[0] ?? ''}`,
              request.url,
            ),
          ),
      );

      getRoute(
        api,
        {
          url: '/equipment',
          summary: 'Every equipment with its place in the hierarchy and its current state',
          tags: ['equipment'],
          query: noQuery,
          response: equipmentListSchema,
          errors: [400, 503],
        },
        () => ({ equipment: [...ready().catalog.values()].map(dto) }),
      );

      getRoute(
        api,
        {
          url: '/equipment/:id',
          summary: 'One equipment with its current state',
          tags: ['equipment'],
          params: equipmentParams,
          query: noQuery,
          response: equipmentSchema,
          errors: [400, 404, 503],
        },
        ({ params }) => dto(known(params.id)),
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/intervals',
          summary: 'State intervals overlapping a time range',
          description:
            'The stored pieces (each inside one UTC hour and one shift) are merged back into ' +
            'whole intervals and clipped to the range. Per shift, use /shifts/{date}/{shift}/totals.',
          tags: ['equipment'],
          params: equipmentParams,
          query: intervalsQuery,
          response: intervalsSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          known(params.id);
          const pieces = await ready().sources.equipment.intervals(
            params.id,
            query.from,
            query.to,
            {
              limit: LIMITS.intervalPieces + 1,
            },
          );
          const truncated = pieces.length > LIMITS.intervalPieces;
          const { intervals, next } = mergePieces(
            truncated ? pieces.slice(0, LIMITS.intervalPieces) : pieces,
            query.from,
            query.to,
            truncated ? pieces[LIMITS.intervalPieces]?.start : undefined,
          );
          return {
            equipment: params.id,
            from: iso(query.from),
            to: iso(query.to),
            truncated,
            next: next && iso(next),
            intervals,
          };
        },
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/telemetry/metrics',
          summary: "The equipment's telemetry metrics with unit and latest sample",
          tags: ['telemetry'],
          params: equipmentParams,
          query: noQuery,
          response: metricsSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          known(params.id);
          const metrics = await ready().sources.ingest.telemetryMetrics(params.id);
          return {
            equipment: params.id,
            metrics: metrics.map((m) => ({
              metric: m.metric,
              unit: m.unit,
              latest: { t: iso(m.latest.sourceTime), value: m.latest.value },
            })),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/telemetry',
          summary: 'Telemetry series, decimated into time buckets (min, max, avg)',
          description:
            'The range is cut into at most maxPoints buckets of equal width, aligned on `from` ' +
            '(TimescaleDB time_bucket); each non-empty bucket gives min, max, average and count.',
          tags: ['telemetry'],
          params: equipmentParams,
          query: telemetryQuery,
          response: seriesSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          known(params.id);
          const { ingest } = ready().sources;
          const metrics = await ingest.telemetryMetrics(params.id);
          const units = new Map(metrics.map((m) => [m.metric, m.unit]));
          const wanted = query.metric ?? [...units.keys()];
          const unknown = wanted.find((metric) => !units.has(metric));
          if (unknown !== undefined) {
            throw new HttpProblem(404, `no telemetry ${unknown} of ${params.id}`);
          }
          const bucketMs = Math.max(
            1,
            Math.ceil((query.to.getTime() - query.from.getTime()) / query.maxPoints),
          );
          const series = await ingest.telemetrySeries(
            params.id,
            [...new Set(wanted)],
            query.from,
            query.to,
            bucketMs,
          );
          return {
            equipment: params.id,
            from: iso(query.from),
            to: iso(query.to),
            bucketMs,
            series: series.map((s) => ({
              metric: s.metric,
              unit: units.get(s.metric) ?? '',
              points: s.buckets.map((b) => ({
                t: iso(b.start),
                min: b.min,
                max: b.max,
                avg: b.avg,
                n: b.count,
              })),
            })),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/totals',
          summary: 'Time per state in one shift, per equipment and epoch',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftTotalsQuery,
          response: shiftTotalsSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          if (!ready().shifts.has(params.shift)) {
            throw new HttpProblem(404, `no shift ${params.shift} in the shift pattern`);
          }
          if (query.equipment !== undefined) known(query.equipment);
          const shiftKey = `${params.date}/${params.shift}`;
          const totals = await ready().sources.equipment.shiftTotals(
            shiftKey,
            query.equipment === undefined ? {} : { equipment: query.equipment },
          );
          return { shiftKey, totals: totals.map((t) => ({ ...t })) };
        },
      );

      // ---- OEE, shifts and downtime (#120) ----

      const members = async (scope: OeeScope, id: string): Promise<readonly string[]> => {
        const found = await ready().sources.oee.members(scope, id);
        if (!found) throw new HttpProblem(404, `no ${scope} ${id}`);
        return found;
      };

      getRoute(
        api,
        {
          url: '/oee',
          summary: 'OEE of an equipment or work center per hour or shift bucket',
          description:
            'Computed on read (ADR-0021): availability, performance, quality and OEE as exact ' +
            'fractions and four-decimal strings, with inputs, totals and losses. A work center sums ' +
            "its machines' inputs. Shift buckets are whole shifts; no-shift stretches are clipped " +
            'to the range. `final` once nothing that can still arrive changes the bucket.',
          tags: ['oee'],
          query: oeeQuery,
          response: oeeListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          await members(query.scope, query.id);
          const buckets = await ready().sources.oee.buckets(query);
          return {
            scope: query.scope,
            id: query.id,
            bucket: query.bucket,
            from: iso(query.from),
            to: iso(query.to),
            buckets: buckets.map(bucketDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/oee',
          summary: 'OEE of one shift for every machine and work center',
          tags: ['shifts', 'oee'],
          params: shiftParams,
          query: shiftOeeQuery,
          response: shiftOeeSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          if (!ready().shifts.has(params.shift)) {
            throw new HttpProblem(404, `no shift ${params.shift} in the shift pattern`);
          }
          const { oee } = ready().sources;
          const instance = shiftInstance(oee.shiftPattern, params.date, params.shift);
          if (!instance) {
            throw new HttpProblem(
              404,
              `no shift ${params.shift} on ${params.date} (not a workday)`,
            );
          }
          return shiftOeeDto(instance, await oee.shift(instance, query.epoch));
        },
      );

      getRoute(
        api,
        {
          url: '/shifts',
          summary: 'Scheduled shifts overlapping a time range, from the shift calendar',
          tags: ['shifts'],
          query: shiftsQuery,
          response: shiftListSchema,
          errors: [400, 503],
        },
        ({ query }) => ({
          from: iso(query.from),
          to: iso(query.to),
          shifts: shiftInstances(
            ready().sources.oee.shiftPattern,
            query.from.getTime(),
            query.to.getTime(),
          ).map(shiftInstanceDto),
        }),
      );

      getRoute(
        api,
        {
          url: '/shifts/current',
          summary: 'The shift the plant clock is in',
          tags: ['shifts'],
          query: noQuery,
          response: currentShiftSchema,
          errors: [400, 503],
        },
        () => {
          const { sources } = ready();
          const clock = sources.equipment.watermarks()[0];
          if (!clock) return { clock: null, shiftKey: null, shift: null };
          // The instant just before the watermark, as the current OEE buckets read it.
          const at = clock.watermark.getTime() - 1;
          const [instance] = shiftInstances(sources.oee.shiftPattern, at, at + 1);
          return {
            clock: { epoch: clock.epoch, watermark: iso(clock.watermark) },
            shiftKey: instance?.key ?? NO_SHIFT,
            shift: instance ? shiftInstanceDto(instance) : null,
          };
        },
      );

      getRoute(
        api,
        {
          url: '/reason-codes',
          summary: 'The downtime reason tree',
          tags: ['downtime'],
          query: reasonCodesQuery,
          response: reasonCodesSchema,
          errors: [400, 503],
        },
        async ({ query }) => {
          const reasons = await ready().sources.masterData.reasonCodes({
            inactive: query.inactive,
          });
          return {
            reasons: reasons.map((r) => ({
              id: r.id,
              parent: r.parent,
              name: r.name,
              active: r.active,
            })),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/downtime',
          summary: 'Downtime records overlapping a time range',
          description:
            'One record per availability-loss interval per scheduled shift bucket (#119), with its ' +
            'auto reason. With uncoded=true, only records still UNCODED.',
          tags: ['downtime'],
          query: downtimeQuery,
          response: downtimeListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          if (query.equipment !== undefined) known(query.equipment);
          const { equipment } = ready().sources;
          // Filtered in the database, so `truncated` counts only the records that match.
          const found = await equipment.downtimeRecords({
            from: query.from,
            to: query.to,
            uncodedFirst: true,
            uncoded: query.uncoded,
            limit: LIMITS.downtimeRecords + 1,
            ...(query.equipment === undefined ? {} : { equipment: query.equipment }),
          });
          const truncated = found.length > LIMITS.downtimeRecords;
          const records = truncated ? found.slice(0, LIMITS.downtimeRecords) : found;
          return {
            from: iso(query.from),
            to: iso(query.to),
            truncated,
            records: records.map((record) => recordDto(record, equipment.watermark(record.epoch))),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/downtime/pareto',
          summary: 'Availability loss by reason and micro-stops by cause',
          description:
            'Own and external availability loss by reason from the downtime records, micro-stops ' +
            '(performance loss) by cause from the Stopped intervals below the threshold, all ' +
            'clipped to the range, without a row limit: the sums equal the OEE losses. Epoch: the ' +
            'one given, else the newest with data (one for all machines of a work center).',
          tags: ['downtime', 'oee'],
          query: paretoQuery,
          response: paretoSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const { oee } = ready().sources;
          await members(query.scope, query.id);
          const [read, reasons] = await Promise.all([
            oee.paretoInputs(query.scope, query.id, query.from, query.to, query.epoch),
            oee.reasonCodes(),
          ]);
          const result = pareto({
            losses: read.losses,
            stops: read.stops,
            from: query.from,
            to: query.to,
            thresholdMs: oee.config.microStopThresholdMs,
            reasons,
          });
          return {
            scope: query.scope,
            id: query.id,
            from: iso(query.from),
            to: iso(query.to),
            members: read.members.map((m) => ({ ...m })),
            availability: { ...result.availability },
            reasons: result.reasons.map((r) => ({ ...r })),
            microStops: result.microStops.map((m) => ({ ...m })),
          };
        },
      );

      // ---- Downtime coding writes (#121, ADR-0023) ----

      const recordKey = (id: string) => {
        const key = parseRecordId(id);
        if (!key) throw new HttpProblem(404, `no downtime record ${id}`);
        known(key.equipment);
        return key;
      };
      const codingProblem = (error: unknown): unknown =>
        error instanceof CodingError
          ? new HttpProblem(CODING_STATUS[error.kind], error.message, error.type)
          : error;

      writeRoute(
        api,
        {
          method: 'PUT',
          url: '/downtime/:id/coding',
          access: 'downtime:code',
          summary: 'Codes one downtime record: replaces its codings (splits, comment, who)',
          description:
            'Each segment is a time range [from, to) inside the record with an active reason ' +
            '(not UNCODED); segments must not overlap; an empty list clears the codings. Time ' +
            'without a coding keeps the auto reason. `version` is the record’s `version` as read: ' +
            'it belongs to the coding set of the (equipment, epoch), and a mismatch is 409. ' +
            'The actor is the session’s user. Audited; reasons never change OEE, only the Pareto and the ' +
            'reason view. Writes need an Origin of this host (or ' +
            'allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).',
          tags: ['downtime'],
          params: downtimeParams,
          body: codingRequestSchema,
          response: codingResultSchema,
          errors: [400, 403, 404, 405, 409, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          const { sources } = ready();
          const key = recordKey(params.id);
          const codedBy = writeBy(request);
          const { version } = await sources.coding
            .code(key, {
              segments: body.segments.map((segment) => ({
                from: new Date(segment.from),
                to: new Date(segment.to),
                reason: segment.reason,
                comment: segment.comment,
              })),
              codedBy,
              version: body.version,
              requestId,
            })
            .catch((error: unknown) => {
              throw codingProblem(error);
            });
          const records = await sources.equipment.downtimeRecords({
            from: key.start,
            to: new Date(key.start.getTime() + 1),
            equipment: key.equipment,
            epoch: key.epoch,
          });
          const record = records.find((r) => r.start.getTime() === key.start.getTime());
          if (!record) throw new HttpProblem(404, `no downtime record ${params.id}`);
          return {
            record: recordDto(record, sources.equipment.watermark(record.epoch)),
            version,
          };
        },
      );

      getRoute(
        api,
        {
          url: '/downtime/:id/audit',
          summary: 'The coding history of one downtime record (append-only audit)',
          description:
            'Writes to the record and clips of codings that lay in its time (after a late fact ' +
            're-cut the intervals), newest first, at most 500.',
          tags: ['downtime'],
          params: downtimeParams,
          query: noQuery,
          response: downtimeAuditSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          const key = recordKey(params.id);
          const entries = await ready()
            .sources.coding.audit(key)
            .catch((error: unknown) => {
              throw codingProblem(error);
            });
          return {
            record: params.id,
            entries: entries.map((entry) => ({
              id: entry.id,
              recordId: entry.recordId,
              from: iso(entry.from),
              to: entry.to && iso(entry.to),
              action: entry.action,
              before: [...entry.before],
              after: [...entry.after],
              actor: entry.actor,
              authenticated: entry.authenticated,
              at: iso(entry.at),
              requestId: entry.requestId,
              version: entry.version,
            })),
          };
        },
      );

      // ---- Orders (#174): list, detail, incidents and the supervisor's writes ----
      orderRoutes(api, {
        orders: () => {
          const orders = ready().sources.orders;
          if (!orders) throw new HttpProblem(503, 'orders are not available');
          return orders;
        },
        writer: (request) => Promise.resolve(writeBy(request)),
      });

      // ---- Execution (#175): units, an order's execution, scrap records and coding ----
      executionRoutes(api, {
        execution: () => {
          const execution = ready().sources.execution;
          if (!execution) throw new HttpProblem(503, 'execution is not available');
          return execution;
        },
        writer: (request) => Promise.resolve(writeBy(request)),
      });

      // ---- Shifts: instances, report and handover notes (#144, ADR-0025) ----

      const shiftsOf = () => {
        const found = ready().sources.shifts;
        if (!found) throw new HttpProblem(503, 'shifts are not available');
        return found;
      };
      const stored = async (
        params: { date: string; shift: string },
        epoch: number | undefined,
      ): Promise<ShiftRecord> => {
        if (!ready().shifts.has(params.shift)) {
          throw new HttpProblem(404, `no shift ${params.shift} in the shift pattern`);
        }
        const found = await shiftsOf().instance(params.date, params.shift, epoch);
        if (!found) {
          const where = epoch === undefined ? '' : ` in epoch ${String(epoch)}`;
          throw new HttpProblem(
            404,
            `no shift instance ${params.date}/${params.shift}${where} (not a workday, or not reached by the plant clock)`,
          );
        }
        return found;
      };
      const shiftProblem = (error: unknown): unknown =>
        error instanceof ShiftError
          ? new HttpProblem(SHIFT_STATUS[error.kind], error.message, error.type)
          : error;
      const WRITE_ERRORS = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503] as const;

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift',
          summary: 'One shift instance: status, finality and the report’s composite revision',
          description:
            'A shift instance is stored per (plant epoch, shift key) once the plant clock enters ' +
            'the shift (ADR-0025). Default epoch: the newest that has it.',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftInstanceQuery,
          response: shiftRecordSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => shiftRecordDto(await stored(params, query.epoch)),
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/report',
          summary: 'The shift report: OEE, downtime, production, alarms and handover notes',
          description:
            'Computed on read (ADR-0025): the OEE section is the body of ' +
            '/shifts/{date}/{shift}/oee; the downtime Pareto by reason sums to the own and external ' +
            'availability loss, with the ten longest records and the uncoded time; production per ' +
            'machine from the OEE inputs and finished parts (the line’s last machine); per position ' +
            'and the plant the alarm KPIs of the shift bucket (equal to /alarms/kpi) and the top 5 ' +
            'bad actors; the handover notes with their history. `final` once every input is final; ' +
            '`revision.inputs` counts input revisions after that, `revision.content` note writes ' +
            'and recodes (recoding never changes OEE). `generatedAt` and `asOf` are for a printout.',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftInstanceQuery,
          response: shiftReportSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          const instance = await stored(params, query.epoch);
          const report = await shiftsOf().report(params.date, params.shift, instance.epoch);
          if (!report) throw new HttpProblem(404, `no shift instance ${instance.key}`);
          return shiftReportDto(report, new Date());
        },
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/notes',
          summary: 'The handover notes of a shift instance, each with its history',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftInstanceQuery,
          response: handoverNotesSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          const instance = await stored(params, query.epoch);
          return {
            shiftKey: instance.key,
            epoch: instance.epoch,
            notes: notesDto(await shiftsOf().notes(instance.epoch, instance.key, true)),
          };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/shifts/:date/:shift/notes',
          access: 'note:write',
          summary: 'Writes a handover note on a shift instance',
          description:
            'From the shift’s start until the end of the following shift (plant time); afterwards ' +
            '409 (handover closed). The author is the session’s user; audited. ' +
            'Raises the report’s `revision.content`. Writes need an Origin of this host (or ' +
            'allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftInstanceQuery,
          body: noteCreateSchema,
          response: noteResultSchema,
          errors: WRITE_ERRORS,
        },
        LIMITS.writeBodyBytes,
        async ({ params, query, body, requestId, request }) => {
          const author = writeBy(request);
          const instance = await stored(params, query.epoch);
          const note = await shiftsOf()
            .createNote(instance.epoch, instance.key, { ...body, author, requestId })
            .catch((error: unknown) => {
              throw shiftProblem(error);
            });
          const after = await stored(params, instance.epoch);
          return { note: handoverNoteDto(note), shift: shiftRecordDto(after) };
        },
      );

      const noteOf = async (params: { date: string; shift: string; noteId: number }) => {
        if (!ready().shifts.has(params.shift)) {
          throw new HttpProblem(404, `no shift ${params.shift} in the shift pattern`);
        }
        const note = await shiftsOf().note(params.noteId);
        if (note?.shiftKey !== `${params.date}/${params.shift}`) {
          throw new HttpProblem(
            404,
            `no note ${String(params.noteId)} in shift ${params.date}/${params.shift}`,
          );
        }
        return note;
      };

      writeRoute(
        api,
        {
          method: 'PUT',
          url: '/shifts/:date/:shift/notes/:noteId',
          access: 'note:write',
          summary: 'Writes a new version of a handover note (text, category, retracted)',
          description:
            '`version` is the note’s `version` as read; a mismatch is 409. No delete: a wrong note ' +
            'is retracted and stays in the history. Same handover window and guards as a create; ' +
            'audited; raises the report’s `revision.content`.',
          tags: ['shifts'],
          params: noteParams,
          body: noteEditSchema,
          response: noteResultSchema,
          errors: WRITE_ERRORS,
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          const author = writeBy(request);
          const found = await noteOf(params);
          const note = await shiftsOf()
            .editNote(found.epoch, found.shiftKey, found.id, { ...body, author, requestId })
            .catch((error: unknown) => {
              throw shiftProblem(error);
            });
          const after = await stored(params, found.epoch);
          return { note: handoverNoteDto(note), shift: shiftRecordDto(after) };
        },
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/notes/:noteId/audit',
          summary: 'The history of one handover note (append-only audit)',
          description: 'Every create and edit with before, after, actor, wall and plant time.',
          tags: ['shifts'],
          params: noteParams,
          query: noQuery,
          response: handoverAuditSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          const note = await noteOf(params);
          const entries = await shiftsOf().noteAudit(note.id);
          return { note: note.id, entries: entries.map(handoverAuditDto) };
        },
      );

      // ---- Alarms (#142, ADR-0024) ----

      const alarmsOf = () => {
        const found = ready().sources.alarms;
        if (!found) throw new HttpProblem(503, 'alarms are not available');
        return found;
      };
      const alarmScope = (scope: AlarmScope, id: string | undefined): string => {
        const name = scope === 'plant' ? 'plant' : (id ?? '');
        if (!alarmsOf().scope(scope, name)) throw new HttpProblem(404, `no ${scope} ${name}`);
        return name;
      };

      getRoute(
        api,
        {
          url: '/alarms',
          summary: 'Alarm occurrences: active, or the history of a range, newest first',
          description:
            'One occurrence per device raise (ADR-0024), id `{equipment}~{epoch}~{seq}`. ' +
            '`active`: not ended; `history`: ended (cleared by the device, lost by a resync ' +
            'snapshot, superseded by the next raise, or ended by a newer epoch), by raise time in ' +
            'a range of at most 7 days. Pages by `cursor` (`next`). Views (#143, ISA-18.2) ' +
            'partition the occurrences: `active` (default) not acknowledged and not closed (a ' +
            'cleared one stays until acknowledged), `acknowledged` still active, both with the ' +
            'point not shelved; `shelved` not closed with the point shelved; `history` closed ' +
            '(ended and acknowledged, or ended by a newer epoch), by raise time in a range of at ' +
            'most 7 days.',
          tags: ['alarms'],
          query: alarmListQuery,
          response: alarmListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const alarms = alarmsOf();
          if (query.equipment !== undefined) known(query.equipment);
          if (query.position !== undefined) alarmScope('position', query.position);
          const after = query.cursor === undefined ? undefined : parseCursor(query.cursor);
          const found = await alarms.list({
            view: query.view,
            position: query.position,
            equipment: query.equipment,
            priority: query.priority,
            from: query.from,
            to: query.to,
            limit: query.limit + 1,
            after,
          });
          const page = found.slice(0, query.limit);
          const last = page.at(-1);
          return {
            view: query.view,
            from: query.from ? iso(query.from) : null,
            to: query.to ? iso(query.to) : null,
            next:
              found.length > query.limit && last
                ? `${String(last.raisedAt.getTime())}~${last.id}`
                : null,
            alarms: page.map(occurrenceDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/scopes',
          summary: 'The scopes of alarm KPIs: the plant, the operator positions, the equipment',
          tags: ['alarms'],
          query: noQuery,
          response: alarmScopesSchema,
          errors: [400, 503],
        },
        () => ({
          scopes: alarmsOf()
            .scopes()
            .map((scope) => ({ ...scope, equipment: [...scope.equipment] })),
        }),
      );

      getRoute(
        api,
        {
          url: '/alarms/config',
          summary:
            'The alarm configuration a client shows: shelving limit, KPI thresholds, benchmarks',
          description:
            'From config/plant/alarms.yaml (#160): `maxShelveMs` (a longer shelf is 422) and the ' +
            'shortest shelf, the KPI thresholds alarm-core computes with (flood threshold and window, ' +
            'chattering, fleeting, standing) and the rate benchmarks (for colouring only). Fixed ' +
            'while the MES runs.',
          tags: ['alarms'],
          query: noQuery,
          response: alarmConfigSchema,
          errors: [400, 503],
        },
        () => {
          const settings = alarmsOf().settings();
          return {
            maxShelveMs: settings.maxShelveMs,
            minShelveMs: LIMITS.minShelveMs,
            kpi: { ...settings.kpi },
            benchmarks: { ...settings.benchmarks },
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/kpi',
          summary: 'Alarm KPIs of the plant, a position or an equipment per hour or shift bucket',
          description:
            'Computed on read with alarm-core (ADR-0024), in exact integers and fractions: raises ' +
            'by priority, average and peak per 10 minutes, flood windows and sliding flood ' +
            'episodes, standing, active at the end, chattering, fleeting, active time. Hours are ' +
            'listed when something happened in them, and the hour in progress; shift buckets are ' +
            'every shift instance and `no-shift/{start}` stretch (clipped to the range) begun by ' +
            'the plant clock. `final` once every equipment of the scope is final through the ' +
            "bucket's end plus fleetingMs; `revision` counts changes after that.",
          tags: ['alarms'],
          query: alarmKpiQuery,
          response: alarmKpiListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const id = alarmScope(query.scope, query.id);
          const buckets = await alarmsOf().kpis({ ...query, id });
          return {
            scope: query.scope,
            id,
            bucket: query.bucket,
            from: iso(query.from),
            to: iso(query.to),
            buckets: buckets.map(alarmKpiDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/operator-kpi',
          summary: 'Operator measures of a scope per hour, shift bucket or range (MES only)',
          description:
            'Not reconciled and apart from /alarms/kpi, which no operator action changes (#143): ' +
            'shelved and annunciated raises (raises while their point was shelved, and the others), ' +
            'time to acknowledge (count, sum and longest in integer ms of plant time, for the ' +
            'raises in the bucket acknowledged in the same epoch), occurrences unacknowledged at ' +
            "the bucket's end (or the plant clock) and shelved time per point. One epoch: the one " +
            'given, else the newest of the scope.',
          tags: ['alarms'],
          query: operatorKpiQuery,
          response: operatorKpiListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const id = alarmScope(query.scope, query.id);
          const { epoch, buckets } = await alarmsOf().operatorMeasures({ ...query, id });
          return {
            scope: query.scope,
            id,
            bucket: query.bucket,
            from: iso(query.from),
            to: iso(query.to),
            epoch,
            buckets: buckets.map(operatorBucketDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/floods',
          summary: 'Sliding flood episodes of a scope in a range',
          description:
            'An episode starts at the raise that makes the count in the last 10 minutes exceed ' +
            'the flood threshold and ends when the count is back at it (ADR-0024); its id is ' +
            '`{startAt ms}~{equipment}~{code}` of the starting raise, unique in its scope.',
          tags: ['alarms'],
          query: alarmRangeQuery,
          response: floodListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const id = alarmScope(query.scope, query.id);
          const { epoch, episodes } = await alarmsOf().floods({ ...query, id });
          return {
            scope: query.scope,
            id,
            from: iso(query.from),
            to: iso(query.to),
            epoch,
            episodes: episodes.map(floodEpisodeDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/bad-actors',
          summary: 'The alarm points of a scope with the most raises in a range',
          description:
            'Ranked by raises, then active time descending, then equipment and code; each with ' +
            "its share of the scope's raises (exact), active time and chattering raises.",
          tags: ['alarms'],
          query: badActorsQuery,
          response: badActorListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const id = alarmScope(query.scope, query.id);
          const { epoch, actors } = await alarmsOf().badActors({ ...query, id });
          return {
            scope: query.scope,
            id,
            from: iso(query.from),
            to: iso(query.to),
            epoch,
            actors: actors.map(badActorDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/:id',
          summary: 'One alarm occurrence with its definition',
          tags: ['alarms'],
          params: alarmParams,
          query: noQuery,
          response: alarmDetailSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          const alarms = alarmsOf();
          const occurrence = await alarms.occurrence(params.id);
          if (!occurrence) throw new HttpProblem(404, `no alarm ${params.id}`);
          const definition = alarms.definition(occurrence.equipment, occurrence.code);
          const [shelf, comments] = await Promise.all([
            alarms.shelf(occurrence.equipment, occurrence.code),
            alarms.comments(params.id),
          ]);
          return {
            occurrence: occurrenceDto(occurrence),
            definition: definition
              ? {
                  text: definition.text,
                  consequence: definition.consequence,
                  response: definition.response,
                }
              : null,
            shelf: shelfDto(shelf),
            comments: (comments ?? []).map(commentDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarms/:id/history',
          summary: 'The device raise and end of an occurrence, by time',
          description:
            "From ingest's stored facts (seq, sourceTime, receivedAt, protocol), or the retained " +
            'delivery or resync snapshot they came from, merged with the audit (#143): its ' +
            'acknowledgement and comments, and its point’s shelf transitions while it was ' +
            'active, each with actor, wall time and request id, by plant time.',
          tags: ['alarms'],
          params: alarmParams,
          query: noQuery,
          response: alarmHistorySchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          const entries = await alarmsOf().history(params.id);
          if (!entries) throw new HttpProblem(404, `no alarm ${params.id}`);
          return historyDto(params.id, entries);
        },
      );

      // ---- Alarm writes (#143, ADR-0023, ADR-0024 "Operator lifecycle") ----

      const alarmWriteProblem = (error: unknown): unknown =>
        error instanceof AlarmWriteError
          ? new HttpProblem(ALARM_WRITE_STATUS[error.kind], error.message, error.type)
          : error;
      const guarded =
        'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when ' +
        'sent, and application/json (ADR-0023). The actor is the session’s user. ' +
        'Audited in alarms.alarm_transition and ' +
        'identity.audit_log with wall time, plant time and the request id. Operator ' +
        'actions never change alarm KPIs or their revisions (every raise counts).';
      const occurrenceAfterWrite = async (id: string) => {
        const occurrence = await alarmsOf().occurrence(id);
        if (!occurrence) throw new HttpProblem(404, `no alarm ${id}`);
        return occurrenceDto(occurrence);
      };
      const knownPoint = (equipment: string): void => {
        known(equipment);
      };

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/alarms/ack',
          access: 'alarm:ack',
          summary: 'Acknowledges up to 100 occurrences in one transaction',
          description:
            'Monotonic, so no version: one INSERT … ON CONFLICT DO NOTHING; an id acknowledged ' +
            'already (also concurrently) is `changed: false` and gets no audit entry. An unknown ' +
            'id is 404 and nothing changes. Counts as one write for the rate limit. ' +
            guarded,
          tags: ['alarms'],
          params: noParams,
          body: bulkAcknowledgeRequestSchema,
          response: bulkAcknowledgeResultSchema,
          errors: [400, 403, 404, 405, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ body, requestId, request }) => {
          const actor = writeBy(request);
          const results = await alarmsOf()
            .acknowledge(body.ids, { actor, comment: body.comment, requestId })
            .catch((error: unknown) => {
              throw alarmWriteProblem(error);
            });
          return { results, acknowledged: results.filter((r) => r.changed).length };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/alarms/:id/ack',
          access: 'alarm:ack',
          summary: 'Acknowledges one occurrence',
          description:
            'Monotonic, so no version; acknowledged already: 200 with `changed: false` and no ' +
            'audit entry. A clear does not acknowledge: a cleared occurrence stays in the active ' +
            'list until acknowledged. ' +
            guarded,
          tags: ['alarms'],
          params: alarmParams,
          body: acknowledgeRequestSchema,
          response: acknowledgeResultSchema,
          errors: [400, 403, 404, 405, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          const [result] = await alarmsOf()
            .acknowledge([params.id], {
              actor: writeBy(request),
              comment: body.comment,
              requestId,
            })
            .catch((error: unknown) => {
              throw alarmWriteProblem(error);
            });
          return {
            occurrence: await occurrenceAfterWrite(params.id),
            changed: result?.changed ?? false,
          };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/alarms/:id/comments',
          access: 'alarm:comment',
          summary: 'Adds a comment to an occurrence',
          description: 'Append-only (1 to 500 characters), so no version. ' + guarded,
          tags: ['alarms'],
          params: alarmParams,
          body: commentRequestSchema,
          response: commentResultSchema,
          errors: [400, 403, 404, 405, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          const comment = await alarmsOf()
            .comment(params.id, {
              actor: writeBy(request),
              text: body.text,
              requestId,
            })
            .catch((error: unknown) => {
              throw alarmWriteProblem(error);
            });
          return {
            comment: commentDto(comment),
            occurrence: await occurrenceAfterWrite(params.id),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/alarm-points',
          summary: 'Alarm points with their definition, shelf and active occurrence',
          description:
            'Every defined point (alarms.yaml), and every other point with an active occurrence ' +
            'or a shelf, by equipment and code. `shelf.version` goes with shelve and unshelve.',
          tags: ['alarms'],
          query: alarmPointsQuery,
          response: alarmPointListSchema,
          errors: [400, 404, 503],
        },
        async ({ query }) => {
          const alarms = alarmsOf();
          if (query.equipment !== undefined) known(query.equipment);
          if (query.position !== undefined) alarmScope('position', query.position);
          const points = await alarms.points({
            equipment: query.equipment,
            position: query.position,
            shelved: query.shelved,
          });
          return { points: points.map(pointDto) };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/alarm-points/:equipment/:code/shelve',
          access: 'alarm:shelve',
          summary: 'Shelves an alarm point for a time of plant time',
          description:
            'ISA-18.2 shelves a point, not an occurrence: its occurrences leave the active list ' +
            'and keep their states; KPIs count every raise anyway. `durationMs` runs in plant ' +
            'time, 1 minute to maxShelveMs (alarms.yaml, 8 hours; longer is 422): `until` = the ' +
            'plant clock now + duration; once the plant clock passes it, the MES unshelves the ' +
            'point itself (audited `expire`, actor system), and a newer epoch ends the shelf ' +
            '(`epoch-ended`). Shelving a shelved point replaces its shelf. `version` is the ' +
            'shelf’s as read (0 for a point never shelved): a mismatch is 409. ' +
            guarded,
          tags: ['alarms'],
          params: alarmPointParams,
          body: shelveRequestSchema,
          response: shelfResultSchema,
          errors: [400, 403, 404, 405, 409, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          knownPoint(params.equipment);
          const point = await alarmsOf()
            .shelve(params.equipment, params.code, {
              actor: writeBy(request),
              reason: body.reason,
              durationMs: body.durationMs,
              version: body.version,
              requestId,
            })
            .catch((error: unknown) => {
              throw alarmWriteProblem(error);
            });
          return { point: pointDto(point) };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/alarm-points/:equipment/:code/unshelve',
          access: 'alarm:shelve',
          summary: 'Unshelves an alarm point',
          description:
            '`version` is the shelf’s as read: a mismatch is 409; a point not shelved is 422. ' +
            guarded,
          tags: ['alarms'],
          params: alarmPointParams,
          body: unshelveRequestSchema,
          response: shelfResultSchema,
          errors: [400, 403, 404, 405, 409, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) => {
          knownPoint(params.equipment);
          const point = await alarmsOf()
            .unshelve(params.equipment, params.code, {
              actor: writeBy(request),
              version: body.version,
              requestId,
            })
            .catch((error: unknown) => {
              throw alarmWriteProblem(error);
            });
          return { point: pointDto(point) };
        },
      );

      getRoute(
        api,
        {
          url: '/alarm-points/:equipment/:code/audit',
          summary: "An alarm point's audit (append-only), newest first",
          description:
            'Its shelf transitions (shelve, unshelve, expire, epoch-ended) and its occurrences’ ' +
            'acknowledgements and comments, at most 500, each with actor, `authenticated: ' +
            'false`, wall time, plant time and request id.',
          tags: ['alarms'],
          params: alarmPointParams,
          query: noQuery,
          response: alarmPointAuditSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          knownPoint(params.equipment);
          const alarms = alarmsOf();
          if (!(await alarms.point(params.equipment, params.code))) {
            throw new HttpProblem(404, `no alarm point ${params.equipment}/${params.code}`);
          }
          const entries = await alarms.pointAudit(params.equipment, params.code, LIMITS.alarmAudit);
          return {
            equipment: params.equipment,
            code: params.code,
            entries: entries.map(transitionDto),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/plant',
          summary: 'The site and the plant clock (watermark of the newest epoch)',
          tags: ['plant'],
          query: noQuery,
          response: plantSchema,
          errors: [400, 503],
        },
        async () => {
          const { sources } = ready();
          const site = await sources.masterData.site();
          const epochs = sources.equipment
            .watermarks()
            .slice(0, 20)
            .map((w) => ({ epoch: w.epoch, watermark: iso(w.watermark) }));
          return { site: site ?? null, clock: epochs[0] ?? null, epochs };
        },
      );

      // Identity (#168, ADR-0026): the session and user administration.
      const identityProblem = (error: unknown): unknown =>
        error instanceof IdentityError
          ? new HttpProblem(IDENTITY_STATUS[error.kind], error.message, error.type)
          : error;
      const setCookie = (reply: FastifyReply, token: string, maxAgeS: number): void => {
        reply.header(
          'set-cookie',
          `${cookieName}=${token}; Max-Age=${String(maxAgeS)}; ${cookieAttributes}`,
        );
      };

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/session',
          access: 'public',
          summary: 'Logs in: sets the session cookie',
          description:
            `Sets \`${cookieName}\` (HttpOnly, SameSite=Strict, Path=/) to a new random token; ` +
            'a session the request carried ends. Every failure (unknown or disabled user, wrong ' +
            'password, a locked account, an admin within its delay) is the same 401. Five ' +
            'failures in a row lock a normal account for 15 minutes; an admin is delayed instead ' +
            '(1 s doubling, at most 5 min). Passes the write guards (login CSRF).',
          tags: ['identity'],
          params: z.strictObject({}),
          body: loginRequestSchema,
          response: sessionSchema,
          errors: [400, 401, 413, 415, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ body, requestId, request, reply }) => {
          const wait = loginRefusal(body.username);
          if (wait !== undefined) {
            reply.header('retry-after', String(wait));
            throw new HttpProblem(429, 'too many logins; try again', PROBLEM_TYPES.loginRate);
          }
          const { token, principal } = await needIdentity()
            .login({
              username: body.username,
              password: body.password,
              kind: body.kind,
              requestId,
              replaces: tokenOf(request),
            })
            .catch((error: unknown) => {
              throw identityProblem(error);
            });
          const { createdAt, expiresAt } = principal.session;
          setCookie(reply, token, Math.ceil((expiresAt.getTime() - createdAt.getTime()) / 1000));
          return sessionDto(principal);
        },
      );

      getRoute(
        api,
        {
          url: '/session',
          access: 'session',
          summary: "The caller's session: user, roles, permissions, expiry",
          tags: ['identity'],
          query: noQuery,
          response: sessionSchema,
          errors: [400, 503],
        },
        ({ request }) => sessionDto(principalOf(request)),
      );

      writeRoute(
        api,
        {
          method: 'DELETE',
          url: '/session',
          access: 'public',
          summary: 'Logs out: ends the session, if live, and clears the cookie',
          description:
            'The body is an empty JSON object (writes are application/json). Clears the cookie ' +
            'also when the session already ended or expired, or the cookie is invalid ' +
            '(`ended: false`).',
          tags: ['identity'],
          params: z.strictObject({}),
          body: emptyBody,
          response: z.object({
            ended: z.boolean().describe('Whether a live session ended (false: none was live)'),
          }),
          errors: [400, 413, 415, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ requestId, request, reply }) => {
          const live = needIdentity();
          const token = tokenOf(request);
          const principal = token && (await live.authenticate(token, { touch: false }));
          if (principal) await live.logout(principal, requestId);
          setCookie(reply, '', 0);
          return { ended: principal !== undefined };
        },
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/account/password',
          access: 'session',
          summary: "Changes the caller's own password",
          description:
            'The current password must match (a mismatch counts as a failed login); the new one ' +
            'has 12–128 characters and differs from it. Ends every other session of the user.',
          tags: ['identity'],
          params: z.strictObject({}),
          body: passwordChangeRequestSchema,
          response: passwordChangeResultSchema,
          errors: [400, 405, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ body, requestId, request }) => {
          const { endedSessions } = await needIdentity()
            .changePassword(principalOf(request), body.currentPassword, body.newPassword, requestId)
            .catch((error: unknown) => {
              throw identityProblem(error);
            });
          return { changed: true as const, endedSessions };
        },
      );

      getRoute(
        api,
        {
          url: '/users',
          access: 'user:admin',
          summary: 'Every user with roles, enabled and locked',
          tags: ['identity'],
          query: noQuery,
          response: userListSchema,
          errors: [400, 503],
        },
        async () => ({ users: (await needIdentity().users()).map(userDto) }),
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/users',
          access: 'user:admin',
          summary: 'Creates a user with a temporary password',
          tags: ['identity'],
          params: z.strictObject({}),
          body: userCreateRequestSchema,
          response: userSchema,
          errors: [400, 405, 409, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ body, requestId, request }) =>
          userDto(
            await needIdentity()
              .createUser(body, principalOf(request), requestId)
              .catch((error: unknown) => {
                throw identityProblem(error);
              }),
          ),
      );

      writeRoute(
        api,
        {
          method: 'PUT',
          url: '/users/:username',
          access: 'user:admin',
          summary: "Changes a user's roles or whether it may log in",
          description:
            'Disabling ends every session of the user and closes its sockets (4401). The last ' +
            'enabled admin stays an enabled admin (409).',
          tags: ['identity'],
          params: usernameParams,
          body: userUpdateRequestSchema,
          response: userSchema,
          errors: [400, 404, 405, 409, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) =>
          userDto(
            await needIdentity()
              .updateUser(params.username, body, principalOf(request), requestId)
              .catch((error: unknown) => {
                throw identityProblem(error);
              }),
          ),
      );

      writeRoute(
        api,
        {
          method: 'POST',
          url: '/users/:username/password',
          access: 'user:admin',
          summary: 'Sets a temporary password; ends the sessions and clears a lock',
          tags: ['identity'],
          params: usernameParams,
          body: passwordResetRequestSchema,
          response: userSchema,
          errors: [400, 404, 405, 413, 415, 422, 429, 503],
        },
        LIMITS.writeBodyBytes,
        async ({ params, body, requestId, request }) =>
          userDto(
            await needIdentity()
              .resetPassword(params.username, body.password, principalOf(request), requestId)
              .catch((error: unknown) => {
                throw identityProblem(error);
              }),
          ),
      );

      api.get(
        '/ws',
        {
          websocket: true,
          schema: {
            summary:
              'WebSocket push of states, telemetry, OEE, downtime, alarms and shelves (protocol: docs/api/realtime.md)',
            tags: ['push'],
            hide: true,
          },
        },
        (socket, request) => {
          if (anonymousUpgrades.has(request)) {
            socket.close(WS_CLOSE_UNAUTHENTICATED, 'a session is needed');
            return;
          }
          if (forbiddenUpgrades.has(request)) {
            socket.close(
              WS_CLOSE_FORBIDDEN,
              'the session may not read (change the password first?)',
            );
            return;
          }
          push.connect(socket);
          const principal = principals.get(request);
          if (principal) {
            const id = principal.session.id;
            const open = sockets.get(id) ?? new Set();
            open.add(socket);
            sockets.set(id, open);
            socket.on('close', () => {
              open.delete(socket);
              if (open.size === 0 && sockets.get(id) === open) sockets.delete(id);
            });
          }
        },
      );
      done();
    },
    { prefix: API_PREFIX },
  );

  return {
    push,
    async attach(sources) {
      const equipment = await sources.masterData.equipment();
      const pattern = await sources.masterData.shiftPattern();
      const catalog = new Map(equipment.map((info) => [info.id, info]));
      attached = { sources, catalog, shifts: new Set(pattern.shifts.map((shift) => shift.id)) };
      const workCenters = await sources.oee.workCenters();
      push.attach({
        equipment: sources.equipment,
        ingest: sources.ingest,
        catalog: new Set(catalog.keys()),
        oee: sources.oee,
        oeeTopics: new Map<string, { scope: OeeScope; members: readonly string[] }>([
          ...[...catalog.keys()].map((id): [string, { scope: OeeScope; members: string[] }] => [
            id,
            { scope: 'equipment', members: [id] },
          ]),
          ...workCenters.map((wc): [string, { scope: OeeScope; members: readonly string[] }] => [
            wc.id,
            { scope: 'work-center', members: wc.equipment },
          ]),
        ]),
        ...(sources.downtime ? { downtime: sources.downtime } : {}),
        ...(sources.shifts ? { shifts: sources.shifts } : {}),
        ...(sources.orders ? { orders: sources.orders } : {}),
        ...(sources.alarms
          ? {
              alarms: sources.alarms,
              alarmKpiTopics: new Map(
                sources.alarms
                  .scopes()
                  .map(
                    (
                      scope,
                    ): [string, { scope: AlarmScope; id: string; members: readonly string[] }] => [
                      scope.scope === 'plant' ? 'plant' : `${scope.scope}:${scope.id}`,
                      { scope: scope.scope, id: scope.id, members: scope.equipment },
                    ],
                  ),
              ),
            }
          : {}),
      });
    },
  };
}
