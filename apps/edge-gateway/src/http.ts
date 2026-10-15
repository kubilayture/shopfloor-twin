import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface GatewayHttpOptions {
  /** Ready when the broker session is up. */
  readonly ready: () => boolean;
  readonly published: () => number;
  /** Per OPC UA machine: connected, and device facts published. */
  readonly machines?: () => readonly {
    readonly id: string;
    readonly connected: boolean;
    readonly facts: number;
  }[];
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
}

export function buildGatewayHttp({
  ready,
  published,
  machines = () => [],
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
  new Gauge({
    name: 'gateway_opcua_connected',
    help: '1 while the OPC UA session to the machine is up',
    labelNames: ['machine'],
    registers: [registry],
    collect() {
      for (const m of machines()) this.set({ machine: m.id }, m.connected ? 1 : 0);
    },
  });
  new Gauge({
    name: 'gateway_device_facts',
    help: 'State changes, cycles and alarm transitions published per machine since start',
    labelNames: ['machine'],
    registers: [registry],
    collect() {
      for (const m of machines()) this.set({ machine: m.id }, m.facts);
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
