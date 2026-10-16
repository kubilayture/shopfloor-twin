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
  /** The command path (#173): deliveries, calls, results by kind, waiting and settling. */
  readonly commands?: () => {
    readonly received: number;
    readonly calls: number;
    /** Settle calls answered as a new acceptance (clock skew). */
    readonly settleAcceptances?: number;
    readonly results: ReadonlyMap<string, number>;
    readonly queued: number;
    readonly settling: number;
  };
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
}

export function buildGatewayHttp({
  ready,
  published,
  machines = () => [],
  buffer = () => ({ depth: 0, dropped: 0 }),
  commands,
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
  if (commands) {
    new Gauge({
      name: 'gateway_command_deliveries',
      help: 'Command deliveries recorded since start (redeliveries and resends included)',
      registers: [registry],
      collect() {
        this.set(commands().received);
      },
    });
    new Gauge({
      name: 'gateway_command_calls',
      help: 'LoadOrder calls made since start (retries and settle calls included)',
      registers: [registry],
      collect() {
        this.set(commands().calls);
      },
    });
    new Gauge({
      name: 'gateway_command_settle_acceptances',
      help: 'Settle calls after expiresAt that the device answered as a new acceptance (clock skew)',
      registers: [registry],
      collect() {
        this.set(commands().settleAcceptances ?? 0);
      },
    });
    new Gauge({
      name: 'gateway_command_results',
      help: 'Command results published since start, by result',
      labelNames: ['result'],
      registers: [registry],
      collect() {
        const results = commands().results;
        for (const result of ['accepted', 'duplicate', 'rejected', 'expired', 'unknown']) {
          this.set({ result }, results.get(result) ?? 0);
        }
      },
    });
    new Gauge({
      name: 'gateway_command_pending',
      help: 'Command deliveries waiting or in progress (queued) and outcomes being settled',
      labelNames: ['stage'],
      registers: [registry],
      collect() {
        const c = commands();
        this.set({ stage: 'queued' }, c.queued);
        this.set({ stage: 'settling' }, c.settling);
      },
    });
  }
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
