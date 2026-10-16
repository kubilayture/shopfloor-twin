import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import {
  WS_PATH,
  registerRealtime,
  type PushOptions,
  type Realtime,
} from './modules/realtime/index.ts';

export interface MesHttpOptions {
  /** Ready once the database answers and migrations are applied. */
  readonly ready: () => Promise<boolean>;
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
  readonly push?: Omit<PushOptions, 'registry'>;
  readonly version?: string;
  /** See `RealtimeOptions`: Host names answered, extra WebSocket origins allowed. */
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  /** `MES_WRITES`: false answers every write with 405 (ADR-0023). */
  readonly writes?: boolean;
  /** The global write rate limit (default 10/s, bursts of 20). */
  readonly writeRate?: { readonly perSecond: number; readonly burst: number };
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
  version = '0.0.0',
  allowedHosts,
  allowedOrigins,
  writes,
  writeRate,
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
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'ShopFloor Twin MES API',
        version,
        description:
          'API of the MES (Phases 4 and 5): equipment with current state, state ' +
          'intervals, telemetry series, shift totals, the plant clock, OEE per hour and shift, ' +
          'shift instances, reason codes, downtime records and the loss Pareto; one write, ' +
          'downtime coding (#121), with its audit. No authentication yet (Phase 7): writes are ' +
          'guarded (ADR-0023: Origin of this host, Sec-Fetch-Site, application/json, 16 KiB, a ' +
          'global rate limit, MES_WRITES=off answers 405) and audited as unauthenticated; ' +
          'bound to loopback by default. Errors are RFC 9457 problem details. ' +
          `Push: WebSocket at ${WS_PATH} (see docs/api/realtime.md).`,
      },
      tags: [
        { name: 'equipment', description: 'Equipment, current states and state intervals' },
        { name: 'telemetry', description: 'Telemetry metrics and decimated series' },
        { name: 'shifts', description: 'Shift instances, time per state and OEE in a shift' },
        { name: 'oee', description: 'OEE per equipment and work center, per hour and shift' },
        { name: 'downtime', description: 'Reason codes, downtime records and the loss Pareto' },
        { name: 'plant', description: 'Site and plant clock' },
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
  });
  return { app, registry, realtime };
}
