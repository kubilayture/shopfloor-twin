import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface MesHttpOptions {
  /** Ready once the database answers and migrations are applied. */
  readonly ready: () => Promise<boolean>;
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
}

export interface MesHttp {
  readonly app: FastifyInstance;
  readonly registry: Registry;
}

export function buildMesHttp({ ready, logger = false }: MesHttpOptions): MesHttp {
  const app = Fastify({ logger });
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
  app.get('/health/live', { logLevel: 'warn' }, () => ({ status: 'ok' }));
  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) =>
    (await ready()) ? { status: 'ok' } : reply.code(503).send({ status: 'unavailable' }),
  );
  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
  return { app, registry };
}
