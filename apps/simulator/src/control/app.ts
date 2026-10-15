import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { z } from 'zod';
import type { PacerState, PacerStatus } from '../live/pacer.ts';
import { MAX_SPEED, MIN_SPEED } from '../live/pacer.ts';
import { isoTime } from '../headless/serialize.ts';
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
  readonly logger?: boolean | { level: string } | FastifyBaseLogger;
  readonly version?: string;
}

export async function buildControlApp({
  pacer,
  hub,
  ready,
  logger = false,
  version = '0.0.0',
}: ControlAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
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
      ],
    },
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });

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
  const responses = (ok: z.ZodType) => ({ 200: json(ok), 409: json(errorSchema) });

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
        response: { 200: json(statusSchema), 400: json(errorSchema) },
      },
    },
    (request) => {
      pacer.setSpeed((request.body as { speed: number }).speed);
      return status();
    },
  );

  app.get(EVENTS_PATH, { websocket: true, schema: { hide: true } }, (socket) => {
    metrics.clients.inc();
    const unsubscribe = hub.subscribe((line) => {
      if (socket.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) {
        socket.close(1013, 'client too slow');
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
    { schema: { tags: ['operations'], summary: 'Prometheus metrics (text format)' } },
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
