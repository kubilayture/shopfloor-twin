import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

export interface GatewayHttpOptions {
  /** Ready when the broker session is up. */
  readonly ready: () => boolean;
  readonly published: () => number;
  /** Store-and-forward: messages waiting, and messages dropped (overflow, refusals). */
  readonly buffer?: () => { readonly depth: number; readonly dropped: number };
  /** Per machine (OPC UA and Modbus): connected, and device facts published. */
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
  buffer = () => ({ depth: 0, dropped: 0 }),
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
    name: 'gateway_device_connected',
    help: '1 while the machine answers (OPC UA session up, or Modbus device answering)',
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
  new Gauge({
    name: 'gateway_buffer_messages',
    help: 'UNS messages stored and not yet acknowledged by the broker',
    registers: [registry],
    collect() {
      this.set(buffer().depth);
    },
  });
  new Gauge({
    name: 'gateway_buffer_dropped_messages',
    help: 'UNS messages dropped without delivery since start (overflow or refused by the broker)',
    registers: [registry],
    collect() {
      this.set(buffer().dropped);
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
