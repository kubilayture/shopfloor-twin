import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface GatewayHttpOptions {
  /** Ready when the broker session is up. */
  readonly ready: () => boolean;
  readonly published: () => number;
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
}

export function buildGatewayHttp({
  ready,
  published,
  logger = false,
}: GatewayHttpOptions): FastifyInstance {
  const app = Fastify({ logger });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: 'gateway_mqtt_connected',
    help: '1 while the broker session is up',
    registers: [registry],
    collect() {
      this.set(ready() ? 1 : 0);
    },
  });
  new Gauge({
    name: 'gateway_published_messages',
    help: 'UNS messages acknowledged by the broker since start',
    registers: [registry],
    collect() {
      this.set(published());
    },
  });
  app.get('/health/live', { logLevel: 'warn' }, () => ({ status: 'ok' }));
  app.get('/health/ready', { logLevel: 'warn' }, (_request, reply) =>
    ready() ? { status: 'ok' } : reply.code(503).send({ status: 'unavailable' }),
  );
  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
  return app;
}
