import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { STATUS_CODES } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { z } from 'zod';
import type { PacerState, PacerStatus } from '../live/pacer.ts';
import { MAX_SPEED, MIN_SPEED } from '../live/pacer.ts';
import { isoTime } from '../headless/serialize.ts';
import type { LiveGroundTruth } from '../live/run.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';
import type { EventHub } from './event-hub.ts';

export const API_PREFIX = '/api/v1';
export const EVENTS_PATH = `${API_PREFIX}/events`;
/** A WebSocket client that falls this far behind is disconnected rather than buffered without bound. */
export const MAX_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024;

const PACER_STATES = [
  'idle',
  'running',
  'paused',
  'finished',
] as const satisfies readonly PacerState[];

export const statusSchema = z.object({
  state: z.enum(PACER_STATES),
  speed: z.number().describe('Simulation seconds per wall-clock second'),
  simTime: z.string().describe('Current simulation time, ISO 8601 UTC'),
  lagMs: z.number().describe('How far event processing trails the paced clock, in wall ms'),
  events: z.number().int().describe('Plant events emitted since start'),
});

export const stepSchema = z.object({
  stepped: z.boolean().describe('False when there is no event left to process'),
  status: statusSchema,
});

export const speedSchema = z.object({ speed: z.number().min(MIN_SPEED).max(MAX_SPEED) });

export const silentSchema = z.object({ silent: z.boolean() });

export const offlineSchema = z.object({ offline: z.boolean() });

const count = z.number().int();
const stateMsSchema = z
  .object(
    Object.fromEntries(MACHINE_STATES.map((state) => [state, count])) as Record<
      MachineState,
      typeof count
    >,
  )
  .describe('Simulation milliseconds per machine state');

export const groundTruthSchema = z.object({
  epoch: count.describe('Run epoch (Unix seconds), as the devices publish it (ADR-0015)'),
  start: z.string().describe('Simulation start, ISO 8601 UTC'),
  simTime: z
    .string()
    .describe('How far events have been processed, ISO 8601 UTC; the totals count up to here'),
  pacedTime: z
    .string()
    .describe(
      'The paced simulation clock when this was read, ISO 8601 UTC; simTime trails it by up to ' +
        'about 1 s × speed while running',
    ),
  currentBucket: z
    .string()
    .describe('The shift bucket the run is in: `2026-10-12/A` or `no-shift`'),
  buckets: z
    .record(z.string(), z.object({ complete: z.boolean() }))
    .describe(
      'Every bucket seen; complete once the run has left it (`no-shift` collects every gap ' +
        'between shifts and can be entered again)',
    ),
  current: z
    .record(z.string(), z.object({ state: z.enum(MACHINE_STATES), since: z.string() }))
    .describe("Each machine's current state and when it began"),
  machines: z
    .record(
      z.string(),
      z.object({
        stateMs: stateMsSchema,
        byShift: z.record(z.string(), stateMsSchema),
        cycles: z.object({ good: count, scrap: count, rework: count }),
      }),
    )
    .describe('Per machine, as in the headless summary.json'),
  production: z.object({
    started: count,
    finished: z.record(z.string(), count),
    scrapped: z.record(z.string(), z.record(z.string(), count)),
  }),
  lots: z.record(z.string(), z.number()).describe('Remaining quantity per material lot'),
});

/** The live ground truth with the run's epoch: what `GET /api/v1/ground-truth` returns. */
export type GroundTruthReport = LiveGroundTruth & { readonly epoch: number };

export const errorSchema = z.object({ error: z.string(), message: z.string() });

const healthSchema = z.object({ status: z.enum(['ok', 'unavailable']) });

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });

/** The pacer operations the API uses; `LivePacer` satisfies it for any event type. */
export interface PacerControl {
  readonly state: PacerState;
  readonly speed: number;
  simNow(): number;
  status(): PacerStatus;
  start(): void;
  pause(): void;
  resume(): void;
  step(): boolean;
  setSpeed(speed: number): void;
}

export interface ControlAppOptions {
  readonly pacer: PacerControl;
  readonly hub: EventHub;
  /** True once every OPC UA server is listening. */
  readonly ready: () => boolean;
  /** Infrastructure faults for resilience tests (plan section 4); routes exist only for those given. */
  readonly faults?: {
    readonly modbusSilent?: (silent: boolean) => void;
    /** Resolves false for an unknown machine. */
    readonly opcuaOffline?: (machineId: string, offline: boolean) => Promise<boolean>;
  };
  /** The live run's ground truth (#100); the route exists only when given. */
  readonly groundTruth?: () => GroundTruthReport;
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
  readonly version?: string;
}

export async function buildControlApp({
  pacer,
  hub,
  ready,
  faults = {},
  groundTruth,
  logger = false,
  version = '0.0.0',
}: ControlAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Strict bodies: "5" or true is not a speed, and unknown fields are refused, as the OpenAPI says.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const code = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    if (code >= 500) {
      request.log.error(error);
    }
    return reply.code(code).send({
      error: STATUS_CODES[code] ?? 'Error',
      message: code >= 500 ? 'internal error' : error.message,
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: 'Not Found', message: `no route ${request.method} ${request.url}` }),
  );
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'ShopFloor Twin simulator control API',
        version,
        description:
          'Controls the pacing of the live simulation and streams its plant events. ' +
          `Plant events: WebSocket at ${EVENTS_PATH} (see docs/contracts/simulator-control-api.md).`,
      },
      tags: [
        { name: 'simulation', description: 'Pacing of the live run' },
        { name: 'operations', description: 'Health and metrics' },
        { name: 'faults', description: 'Infrastructure faults for resilience tests' },
      ],
    },
  });
  await app.register(websocket, {
    options: { maxPayload: 1024 },
    // A client that stopped reading would hold up shutdown for ws's 30 s close timeout.
    preClose: (done) => {
      for (const client of app.websocketServer.clients) {
        client.terminate();
      }
      done();
    },
  });

  const metrics = createMetrics(pacer, hub);

  const status = () => {
    const current = pacer.status();
    return {
      state: current.state,
      speed: current.speed,
      simTime: isoTime(current.simNow),
      lagMs: current.lagMs,
      events: hub.seq,
    };
  };
  const conflict = (reply: FastifyReply, message: string) =>
    reply.code(409).send({ error: 'Conflict', message });
  const responses = (ok: z.ZodType) => ({
    200: json(ok),
    409: json(errorSchema),
    503: json(errorSchema),
  });
  const CONTROL_ROUTES = new Set(
    ['pause', 'resume', 'step', 'speed'].map((r) => `${API_PREFIX}/${r}`),
  );
  // Until every OPC UA server listens, the run must not move: events would reach no server.
  app.addHook('onRequest', async (request, reply) => {
    if (CONTROL_ROUTES.has(request.routeOptions.url ?? '') && !ready()) {
      await reply
        .code(503)
        .send({ error: 'Service Unavailable', message: 'the simulator is starting' });
    }
  });

  app.get(
    `${API_PREFIX}/status`,
    {
      schema: {
        tags: ['simulation'],
        summary: 'Current pacing state and simulation time',
        response: { 200: json(statusSchema) },
      },
    },
    () => status(),
  );

  app.post(
    `${API_PREFIX}/pause`,
    {
      schema: {
        tags: ['simulation'],
        summary: 'Freeze simulation time (no effect unless running)',
        response: responses(statusSchema),
      },
    },
    (_request, reply) => {
      if (pacer.state === 'finished') {
        return conflict(reply, 'the run has finished');
      }
      pacer.pause();
      return status();
    },
  );

  app.post(
    `${API_PREFIX}/resume`,
    {
      schema: {
        tags: ['simulation'],
        summary: 'Continue pacing from the current simulation time',
        response: responses(statusSchema),
      },
    },
    (_request, reply) => {
      if (pacer.state === 'finished') {
        return conflict(reply, 'the run has finished');
      }
      if (pacer.state === 'idle') {
        pacer.start();
      } else {
        pacer.resume();
      }
      return status();
    },
  );

  app.post(
    `${API_PREFIX}/step`,
    {
      schema: {
        tags: ['simulation'],
        summary: 'Process exactly one simulation event (only while paused or not yet started)',
        response: responses(stepSchema),
      },
    },
    (_request, reply) => {
      if (pacer.state !== 'paused' && pacer.state !== 'idle') {
        return conflict(reply, `step is only possible while paused, the run is ${pacer.state}`);
      }
      const stepped = pacer.step();
      return { stepped, status: status() };
    },
  );

  app.put(
    `${API_PREFIX}/speed`,
    {
      schema: {
        tags: ['simulation'],
        summary: `Change the speed (${String(MIN_SPEED)}–${String(MAX_SPEED)}×)`,
        body: json(speedSchema),
        response: { 200: json(statusSchema), 400: json(errorSchema), 503: json(errorSchema) },
      },
    },
    (request) => {
      pacer.setSpeed((request.body as { speed: number }).speed);
      return status();
    },
  );

  if (groundTruth) {
    app.get(
      `${API_PREFIX}/ground-truth`,
      {
        schema: {
          tags: ['simulation'],
          summary:
            'Time per state, per machine and shift bucket, so far (the headless summary, live)',
          description:
            'The ground truth a headless run would write if it ended now, kept live while the run ' +
            'is paced. Reconciliation tests compare the MES with it (#100). Reading it never ' +
            'moves the run.',
          response: { 200: json(groundTruthSchema) },
        },
      },
      () => groundTruth(),
    );
  }

  const modbusSilent = faults.modbusSilent;
  if (modbusSilent) {
    app.post(
      `${API_PREFIX}/faults/modbus`,
      {
        schema: {
          tags: ['faults'],
          summary: 'Make the WSH-01 Modbus device stop answering, or answer again',
          body: json(silentSchema),
          response: { 200: json(silentSchema), 400: json(errorSchema) },
        },
      },
      (request) => {
        const { silent } = request.body as { silent: boolean };
        modbusSilent(silent);
        return { silent };
      },
    );
  }

  const opcuaOffline = faults.opcuaOffline;
  if (opcuaOffline) {
    app.post(
      `${API_PREFIX}/faults/opcua/:machine`,
      {
        schema: {
          tags: ['faults'],
          summary:
            "Take one machine's OPC UA server offline (drop and refuse connections), or back",
          params: json(z.object({ machine: z.string() })),
          body: json(offlineSchema),
          response: { 200: json(offlineSchema), 400: json(errorSchema), 404: json(errorSchema) },
        },
      },
      async (request, reply) => {
        const { machine } = request.params as { machine: string };
        const { offline } = request.body as { offline: boolean };
        if (!(await opcuaOffline(machine, offline))) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: `no OPC UA machine ${machine}` });
        }
        return { offline };
      },
    );
  }

  app.get(EVENTS_PATH, { websocket: true, schema: { hide: true } }, (socket) => {
    metrics.clients.inc();
    const unsubscribe = hub.subscribe((line) => {
      if (socket.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
        // A close frame would queue behind the backlog the client isn't reading.
        socket.terminate();
        return;
      }
      socket.send(line);
    });
    socket.on('message', () => {
      socket.close(1003, 'this stream is read-only');
    });
    socket.on('close', () => {
      unsubscribe();
      metrics.clients.dec();
    });
  });

  app.get(
    '/health/live',
    {
      // Probed every few seconds; only problems are worth a log line.
      logLevel: 'warn',
      schema: {
        tags: ['operations'],
        summary: 'The process is up',
        response: { 200: json(healthSchema) },
      },
    },
    () => ({ status: 'ok' }),
  );

  app.get(
    '/health/ready',
    {
      // Probed every few seconds; only problems are worth a log line.
      logLevel: 'warn',
      schema: {
        tags: ['operations'],
        summary: 'Every OPC UA server is listening and the run has not finished',
        response: { 200: json(healthSchema), 503: json(healthSchema) },
      },
    },
    (_request, reply) =>
      ready() && pacer.state !== 'finished'
        ? { status: 'ok' }
        : reply.code(503).send({ status: 'unavailable' }),
  );

  app.get(
    '/metrics',
    {
      logLevel: 'warn',
      schema: { tags: ['operations'], summary: 'Prometheus metrics (text format)' },
    },
    async (_request, reply) => {
      reply.header('content-type', metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  return app;
}

function createMetrics(pacer: PacerControl, hub: EventHub) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  new Counter({
    name: 'sim_events_total',
    help: 'Plant events emitted, by event type',
    labelNames: ['type'],
    registers: [registry],
    collect() {
      this.reset();
      for (const [type, count] of hub.counts) {
        this.inc({ type }, count);
      }
    },
  });
  const clients = new Gauge({
    name: 'sim_websocket_clients',
    help: 'Connected WebSocket event-stream clients',
    registers: [registry],
  });
  new Gauge({
    name: 'sim_speed_ratio',
    help: 'Simulation seconds per wall-clock second',
    registers: [registry],
    collect() {
      this.set(pacer.speed);
    },
  });
  new Gauge({
    name: 'sim_time_seconds',
    help: 'Current simulation time, Unix seconds',
    registers: [registry],
    collect() {
      this.set(pacer.simNow() / 1000);
    },
  });
  new Gauge({
    name: 'sim_lag_seconds',
    help: 'How far event processing trails the paced clock, in wall seconds',
    registers: [registry],
    collect() {
      this.set(pacer.status().lagMs / 1000);
    },
  });
  new Gauge({
    name: 'sim_pacer_state',
    help: 'Pacer state (1 for the current state)',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      for (const state of PACER_STATES) {
        this.set({ state }, pacer.state === state ? 1 : 0);
      }
    },
  });
  new Gauge({
    name: 'sim_events_seq',
    help: 'Run-wide sequence number of the last plant event',
    registers: [registry],
    collect() {
      this.set(hub.seq);
    },
  });
  return { registry, clients };
}
