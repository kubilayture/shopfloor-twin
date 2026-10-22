import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { NO_EDGE, normaliseAddress, type EdgeTrust } from './edge.ts';
import {
  WS_PATH,
  registerRealtime,
  type IdentityApi,
  type PushOptions,
  type Realtime,
} from './modules/realtime/index.ts';
import { PRODUCT_VERSION } from './version.ts';

export interface MesHttpOptions {
  /** Ready once the database answers and migrations are applied. */
  readonly ready: () => Promise<boolean>;
  readonly logger?:
    boolean | { level: string; stream?: { write(line: string): void } } | FastifyBaseLogger;
  readonly push?: Omit<PushOptions, 'registry'>;
  /** The OpenAPI `info.version`; default the product version (root `package.json`). */
  readonly version?: string;
  /** See `RealtimeOptions`: Host names answered, extra WebSocket origins allowed. */
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  /** `MES_WRITES`: false answers every write with 405 (ADR-0023). */
  readonly writes?: boolean;
  /** The global write rate limit (default 10/s, bursts of 20). */
  readonly writeRate?: { readonly perSecond: number; readonly burst: number };
  /** Identity (#168): sessions, login and users; see `RealtimeOptions`. */
  readonly identity?: IdentityApi;
  /** `MES_AUTH=on`: a session on every route but the login, and on the WebSocket (`RealtimeOptions`). */
  readonly auth?: boolean;
  /** `MES_COOKIE_SECURE=on`. */
  readonly cookieSecure?: boolean;
  /** Each user's write bucket (default 5/s, bursts of 10). */
  readonly userWriteRate?: { readonly perSecond: number; readonly burst: number };
  /** How often open sockets' sessions are checked (default 15 s). */
  readonly sessionCheckMs?: number;
  /** Login buckets: per address (default 5/s, bursts of 10), per (name, address) (1/s, 5), all (100/s, 200). */
  readonly loginRate?: { readonly perSecond: number; readonly burst: number };
  readonly userLoginRate?: { readonly perSecond: number; readonly burst: number };
  readonly loginCeiling?: { readonly perSecond: number; readonly burst: number };
  /**
   * The learned `edge` network (#237): only requests from it may carry trusted proxy headers
   * (`X-Original-Method`, and `X-Real-IP` from P9-15). Default: nothing trusted.
   */
  readonly edge?: EdgeTrust;
}

export interface MesHttp {
  readonly app: FastifyInstance;
  readonly registry: Registry;
  /** The API and push; `realtime.attach(...)` once the modules have started. */
  readonly realtime: Realtime;
}

export async function buildMesHttp({
  ready,
  logger = false,
  push,
  version = PRODUCT_VERSION,
  allowedHosts,
  allowedOrigins,
  writes,
  writeRate,
  identity,
  auth,
  cookieSecure,
  userWriteRate,
  sessionCheckMs,
  loginRate,
  userLoginRate,
  loginCeiling,
  edge = NO_EDGE,
}: MesHttpOptions): Promise<MesHttp> {
  // A request id per request (UUID): logged, returned as X-Request-Id on writes and audited.
  const app = Fastify({ logger, genReqId: () => randomUUID() });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: 'mes_up',
    help: '1 while the MES serves requests',
    registers: [registry],
    collect() {
      this.set(1);
    },
  });
  // Proxied requests (#237): those carrying `X-Real-IP` (nginx sets it on every request it
  // proxies), by whether their source lies in the `edge` network. The smoke asserts that requests
  // through nginx arrive trusted and none untrusted (`mes-edge`, never `mes`).
  const proxied = new Counter({
    name: 'mes_http_proxy_requests_total',
    help: 'Requests carrying X-Real-IP, by whether they came from nginx over the edge network',
    labelNames: ['trusted'] as const,
    registers: [registry],
  });
  proxied.inc({ trusted: 'true' }, 0);
  proxied.inc({ trusted: 'false' }, 0);
  const trusted = new WeakMap<object, boolean>();
  const trustsProxy = (request: FastifyRequest): boolean => {
    let known = trusted.get(request.raw);
    if (known === undefined) {
      known = edge.trusts(request.raw.socket.remoteAddress);
      trusted.set(request.raw, known);
    }
    return known;
  };
  // The client's address a login is keyed by (#242, ADR-0039): nginx overwrites `X-Real-IP` with
  // `$remote_addr`, and only over the `edge` network is it believed; from anywhere else (a
  // container on the default network sending its own header to `mes:4700`) the socket's address
  // counts, so a spoofed header can neither pick another client's pair nor dodge its own.
  const clientAddress = (request: FastifyRequest): string => {
    const header = request.headers['x-real-ip'];
    if (trustsProxy(request) && typeof header === 'string' && isIP(header.trim()) !== 0) {
      return normaliseAddress(header.trim());
    }
    return normaliseAddress(request.raw.socket.remoteAddress ?? 'unknown');
  };
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.headers['x-real-ip'] !== undefined) {
      proxied.inc({ trusted: String(trustsProxy(request)) });
    }
    done();
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ShopFloor Twin MES API',
        version,
        description:
          'API of the MES: equipment with current state, state intervals and telemetry ' +
          'series; the plant clock, shift instances, totals, reports and handover notes; OEE ' +
          'per equipment, work center, hour and shift, line OEE with the bottleneck and OEE per ' +
          'order; reason codes, downtime records and the loss Pareto; alarm occurrences, alarm ' +
          'KPIs, floods and bad actors, acknowledgement, shelving and comments; production ' +
          'orders from the ERP with release, dispatch and close, order execution, the operator ' +
          'terminal, scrap records and their coding; genealogy and traceability by serial, lot and carton; SPC ' +
          'characteristics, control limits, charts and signals; quality holds. ' +
          'Clients reach it through the HTTPS front of the stack, nginx (port 8443 by default, ' +
          'ADR-0039), which proxies /api/; the MES itself is not published (except on loopback ' +
          'with pnpm stack:up:dev). Identity (ADR-0026): ' +
          'login (POST /api/v1/session) sets the session cookie __Host-sft_session (Secure, ' +
          'HttpOnly, SameSite=Strict; sft_session only with MES_COOKIE_SECURE=off); with ' +
          'MES_AUTH=on, the default, every /api/v1 route but login and logout needs it (401) and ' +
          'the permission it names (403), while /health and /metrics are open; MES_AUTH=off (diagnosis only) ' +
          'serves reads and the WebSocket without one, never a write. Logins are throttled ' +
          '(429 with Retry-After, ADR-0039). Writes are guarded (ADR-0023: Origin of this host, ' +
          'Sec-Fetch-Site, application/json, 16 KiB, a global and a per-user rate limit, ' +
          'MES_WRITES=off answers 405). Errors are RFC 9457 problem details. ' +
          `Push: WebSocket at ${WS_PATH} (see docs/api/realtime.md).`,
      },
      tags: [
        { name: 'equipment', description: 'Equipment, current states and state intervals' },
        { name: 'telemetry', description: 'Telemetry metrics and decimated series' },
        { name: 'shifts', description: 'Shift instances, time per state and OEE in a shift' },
        { name: 'oee', description: 'OEE per equipment and work center, per hour and shift' },
        { name: 'downtime', description: 'Reason codes, downtime records and the loss Pareto' },
        {
          name: 'alarms',
          description: 'Alarm occurrences with their history, alarm KPIs, floods and bad actors',
        },
        {
          name: 'orders',
          description: 'Production orders from the ERP, their commands and incidents; order OEE',
        },
        {
          name: 'execution',
          description: 'Order execution: units, incidents, scrap records and their coding',
        },
        { name: 'terminal', description: 'The operator terminal of a work center' },
        { name: 'genealogy', description: 'Traceability by serial, lot and carton; incidents' },
        {
          name: 'quality',
          description: 'SPC characteristics, control limits, charts and signals; quality holds',
        },
        { name: 'plant', description: 'Site and plant clock' },
        { name: 'identity', description: 'Login, sessions, password changes and users' },
        { name: 'operations', description: 'Health and metrics' },
      ],
    },
    // Shared schemas become components named by their $id.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === 'string' ? json.$id : `def-${String(i)}`,
    },
  });
  app.get(
    '/health/live',
    { logLevel: 'warn', schema: { tags: ['operations'], summary: 'Liveness' } },
    () => ({ status: 'ok' }),
  );
  app.get(
    '/health/ready',
    {
      logLevel: 'warn',
      schema: {
        tags: ['operations'],
        summary: 'Readiness: migrated, database answers, subscribed to the UNS',
      },
    },
    async (_request, reply) =>
      (await ready()) ? { status: 'ok' } : reply.code(503).send({ status: 'unavailable' }),
  );
  app.get(
    '/metrics',
    { logLevel: 'warn', schema: { tags: ['operations'], summary: 'Prometheus metrics (text)' } },
    async (_request, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    },
  );
  const realtime = await registerRealtime(app, {
    registry,
    ...(push === undefined ? {} : { push }),
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    ...(writes === undefined ? {} : { writes }),
    ...(writeRate === undefined ? {} : { writeRate }),
    ...(identity === undefined ? {} : { identity }),
    ...(auth === undefined ? {} : { auth }),
    ...(cookieSecure === undefined ? {} : { cookieSecure }),
    ...(userWriteRate === undefined ? {} : { userWriteRate }),
    ...(sessionCheckMs === undefined ? {} : { sessionCheckMs }),
    ...(loginRate === undefined ? {} : { loginRate }),
    ...(userLoginRate === undefined ? {} : { userLoginRate }),
    ...(loginCeiling === undefined ? {} : { loginCeiling }),
    trustsProxy,
    clientAddress,
  });
  return { app, registry, realtime };
}
