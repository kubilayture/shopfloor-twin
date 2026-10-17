import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import { STATUS_CODES } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import { z } from 'zod';
import type { PacerState, PacerStatus } from '../live/pacer.ts';
import { MAX_SPEED, MIN_SPEED } from '../live/pacer.ts';
import { isoTime } from '../headless/serialize.ts';
import { AsOfAfterSimTimeError } from '../headless/trace-truth.ts';
import type { LiveGroundTruth } from '../live/run.ts';
import type {
  FailureInjection,
  InjectDriftRequest,
  InjectDriftResult,
  InjectFailureRequest,
  InjectFailureResult,
  LeakDrift,
} from '../plant/line.ts';
import { PRODUCTION_MODES } from '../plant/line.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';
import type { EventHub } from './event-hub.ts';

/**
 * The contract version (docs/contracts/simulator-control-api.md); 1.2 adds the OEE ground truth,
 * 1.3 failure injection and the alarm ground truth (#140), 1.4 the production mode and the order
 * ground truth (#172), 1.5 the leak-test drift injection (#196).
 */
export const CONTROL_API_VERSION = '1.6.0';
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

const ratioSchema = z
  .object({
    fraction: z.string().describe('Exact reduced fraction `num/den`'),
    decimal: z.string().describe('Rounded half-up to four decimals'),
  })
  .nullable();

const oeeResultSchema = z
  .object({
    availability: ratioSchema.describe('APT / PBT; null when PBT = 0'),
    performance: ratioSchema.describe('Ideal time / APT, not clamped; null when PBT or APT is 0'),
    quality: ratioSchema.describe('good / produced; null when PBT = 0 or nothing was produced'),
    oee: ratioSchema.describe('(ideal × good) / (PBT × produced); null when PBT = 0 or anomaly'),
    anomaly: z.boolean().describe('Cycles were counted although APT = 0'),
    provisional: z.boolean().describe('An open Stopped interval counts as a micro-stop for now'),
    totals: z.object({
      plannedBusyMs: count,
      actualProductionMs: count,
      excludedMs: count,
      longStopMs: count,
      microStopMs: count,
      idealMs: count,
      good: count,
      scrap: count,
      rework: count,
      produced: count,
    }),
    unplanned: z
      .object({ good: count, produced: count, idealMs: count })
      .describe('Cycles of the unscheduled no-shift bucket, kept out of P and Q'),
    losses: z
      .object({
        availability: z.object({
          own: z.object({ stopped: count, down: count, setup: count, idle: count, total: count }),
          external: z.object({ starved: count, blocked: count, total: count }),
        }),
        performance: z.object({ microStops: count, speed: count, total: count }),
        quality: z.object({ fraction: z.string(), decimal: z.string() }),
      })
      .nullable()
      .describe('In ms; null when PBT = 0'),
  })
  .describe('`bucketOee` / `workCenterOee` of `oee-core` (ADR-0021)');

const bucketInputsShape = {
  scheduled: z.boolean(),
  stateMs: stateMsSchema,
  noOrderIdleMs: count
    .optional()
    .describe('The part of Idle with cause NO-ORDER (#172); only when above 0'),
  stops: z
    .array(z.object({ ms: count, wholeMs: count, open: z.boolean().optional() }))
    .describe('Stopped pieces with the whole interval length; an open one runs to simTime'),
  cycles: z.array(
    z.object({ product: z.string(), result: z.enum(['good', 'scrap', 'rework']), count }),
  ),
};

export const oeeSchema = z
  .object({
    config: z.object({
      microStopThresholdMs: count,
      scheduledTime: z
        .enum(['shift-calendar', 'orders'])
        .describe('oee.yaml: orders excludes Idle NO-ORDER from planned busy time (#172)'),
    }),
    machines: z.record(
      z.string(),
      z.object({
        operation: z.string(),
        idealCycleMs: z.record(z.string(), count),
        shifts: z.record(
          z.string(),
          z.object({ inputs: z.object(bucketInputsShape), result: oeeResultSchema }),
        ),
        hours: z
          .record(z.string(), z.object({ shift: z.string(), ...bucketInputsShape }))
          .describe('Keyed by the UTC hour start, ISO 8601; inputs only'),
      }),
    ),
    workCenters: z.record(
      z.string(),
      z.object({
        equipment: z.array(z.string()),
        shifts: z.record(z.string(), oeeResultSchema),
      }),
    ),
  })
  .describe('OEE inputs per machine, shift bucket and UTC hour; results per shift bucket (#117)');

const isoSchema = z.string().describe('ISO 8601 UTC');
const priorityCounts = z.object({ high: count, medium: count, low: count });
const alarmRatioSchema = z.object({
  fraction: z.string().describe('Exact reduced fraction `num/den`'),
  decimal: z.string().describe('Rounded half-up to four decimals'),
});

const alarmKpisSchema = z
  .object({
    from: isoSchema,
    to: isoSchema,
    raises: count,
    byPriority: priorityCounts,
    averageRate: alarmRatioSchema.describe('Raises per windowMs over the whole bucket'),
    windows: count,
    peak10: count,
    floodWindows: count,
    floods: z.array(
      z.object({
        id: z.string().describe('`{startAt ms}~{equipment}~{code}` of the starting raise'),
        startAt: isoSchema,
        floodMs: count,
        peak: count,
        open: z.boolean(),
        ended: z.object({ endAt: isoSchema, peak: count, raises: count }).nullable(),
      }),
    ),
    floodMs: count,
    activeAtEnd: count,
    standing: z.array(z.object({ equipment: z.string(), code: z.string(), raisedAt: isoSchema })),
    chatteringRaises: count,
    chatteringPoints: z.array(z.string()),
    fleeting: count,
    fleetingUndecided: count,
    activeMs: count,
    provisional: z.boolean(),
  })
  .describe('`kpisOfBucket` / `composeBuckets` of `alarm-core` (ADR-0024)');

const badActorSchema = z.object({
  equipment: z.string(),
  code: z.string(),
  raises: count,
  share: alarmRatioSchema,
  activeMs: count,
  chatteringRaises: count,
});

export const alarmsSchema = z
  .object({
    config: z.object({
      floodThreshold: count,
      windowMs: count,
      chatterCount: count,
      chatterWindowMs: count,
      fleetingMs: count,
      standingMs: count,
    }),
    positions: z.record(z.string(), z.object({ workCenters: z.array(z.string()) })),
    occurrences: z.array(
      z.object({
        equipment: z.string(),
        code: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
        severity: count,
        raisedAt: isoSchema,
        clearedAt: isoSchema.nullable(),
        endReason: z.string().nullable(),
      }),
    ),
    scopes: z.record(
      z.string(),
      z.object({
        hours: z
          .record(z.string(), alarmKpisSchema)
          .describe('Keyed by the UTC hour start; only hours where something happened'),
        shifts: z
          .record(z.string(), alarmKpisSchema)
          .describe('Every shift instance and `no-shift/{start}` stretch so far'),
        floods: z.array(
          z.object({
            id: z.string(),
            startAt: isoSchema,
            equipment: z.string(),
            code: z.string(),
            endAt: isoSchema.nullable(),
            peak: count,
            raises: count,
          }),
        ),
        badActors: z.object({
          run: z.array(badActorSchema),
          shifts: z.record(z.string(), z.array(badActorSchema)),
        }),
      }),
    ),
  })
  .describe('Alarm occurrences and KPIs per position and plant, per hour and shift bucket (#140)');

const operationQuantitiesSchema = z.object({ in: count, good: count, scrap: count, rework: count });

export const ordersSchema = z
  .object({
    jobs: z.array(
      z.object({
        commandId: z.string(),
        orderId: z.string(),
        machine: z.string(),
        product: z.string(),
        quantity: count,
        acceptedAt: isoSchema,
        startedAt: isoSchema.nullable(),
        completedAt: isoSchema.nullable(),
      }),
    ),
    orders: z.record(
      z.string(),
      z.object({
        product: z.string(),
        jobs: z.array(z.string()),
        quantity: count,
        started: count,
        scrap: z.record(z.string(), z.record(z.string(), count)),
        reworkPasses: count,
        packedGood: count,
        wip: z.record(z.string(), count),
        lastTerminalAt: isoSchema.nullable(),
        completedAt: isoSchema.nullable(),
        operations: z.record(z.string(), operationQuantitiesSchema),
        material: z.record(z.string(), count),
        materialInProcess: z.record(z.string(), count),
      }),
    ),
    units: z.object({ count, sha256: z.string() }),
  })
  .describe(
    "Jobs, per-order quantities, WIP and material, and the hash of every unit's operation " +
      'records (#172); empty in schedule mode',
  );

const fractionSchema = z
  .string()
  .regex(/^-?\d+\/\d+$/)
  .describe('An exact fraction of reading steps, `num/den` (BigInt digits)');
const limitsSchema = z.object({
  lower: fractionSchema,
  centre: fractionSchema,
  upper: fractionSchema,
});
const atSchema = z.object({ at: isoSchema });
const readingRefSchema = z.object({ partId: count, pass: count });
const episodeSchema = z.object({
  chart: z.enum(['I', 'MR', 'Xbar', 'R']),
  rule: count,
  version: count,
  partId: count,
  pass: count,
  at: isoSchema,
  last: readingRefSchema,
  points: count,
  closedBy: readingRefSchema.nullable(),
  baseline: z.boolean(),
});
const pointSchema = z.object({
  partId: count,
  pass: count,
  at: isoSchema,
  segment: count,
  value: fractionSchema,
  version: count.nullable(),
  baseline: z.boolean(),
  rules: z.array(count),
});
const windowReadingSchema = z.object({
  partId: count,
  pass: count,
  at: isoSchema,
  value: z.number().int(),
  counterfactual: z.number().int(),
  drifted: z.boolean(),
});

export const traceSchema = z
  .object({
    traceConfigSha256: z.string(),
    config: z.object({
      packOperation: z.string(),
      capacity: z.record(z.string(), count),
      spc: z.object({
        characteristic: z.string(),
        operation: z.string(),
        subgroupSize: count,
        baselineSubgroups: count,
        rules: z.record(z.string(), z.array(count)),
      }),
    }),
    units: z.object({ count, unitsTraceSha256: z.string() }),
    orders: z.array(
      z.object({ orderId: z.string(), product: z.string(), completedAt: isoSchema.nullable() }),
    ),
    lots: z.array(
      z.object({
        lot: z.string(),
        material: z.string(),
        consumed: count,
        units: z.array(count).describe('Part ids'),
        orders: z.array(z.string()),
        cartons: z.array(z.string()),
      }),
    ),
    cartons: z.array(
      z.object({
        id: z.string(),
        orderId: z.string(),
        product: z.string(),
        capacity: count,
        status: z.enum(['open', 'closed']),
        closedAt: isoSchema.nullable(),
        members: z.object({ count, sha256: z.string() }),
      }),
    ),
    spc: z.object({
      characteristic: z.string(),
      readings: z.object({ firstPass: count, retests: count }),
      limits: z.array(
        z.object({
          version: count,
          createdAt: isoSchema,
          from: atSchema.nullable(),
          until: atSchema.nullable(),
          endedAt: isoSchema.nullable(),
          limits: z.object({
            subgroupSize: count,
            window: z.object({ from: atSchema, to: atSchema }),
            counts: z.object({ readings: count, movingRanges: count, subgroups: count }),
            statistics: z.object({
              mean: fractionSchema,
              movingRange: fractionSchema,
              grandMean: fractionSchema,
              range: fractionSchema,
            }),
            charts: z.object({
              I: limitsSchema,
              MR: limitsSchema,
              Xbar: limitsSchema,
              R: limitsSchema,
            }),
          }),
        }),
      ),
      points: z.record(z.string(), z.object({ count, sha256: z.string() })),
      subgroups: z.object({ complete: count, pending: count }),
      episodes: z.array(episodeSchema),
    }),
    drifts: z.array(
      z.object({
        injection: count,
        machine: z.string(),
        shift: z.number(),
        steps: z.number().int(),
        appliedAt: isoSchema,
        endedAt: isoSchema.nullable(),
        endedBy: z.enum(['until', 'calibration']).nullable(),
        start: z
          .object({
            partId: count,
            pass: count,
            at: isoSchema,
            value: z.number().int(),
            firstPassBefore: count,
          })
          .nullable(),
        firstEpisode: episodeSchema.extend({ latency: count.nullable() }).nullable(),
        window: z.object({ before: count, after: count, readings: z.array(windowReadingSchema) }),
        counterfactual: z.object({
          signals: z.array(pointSchema.extend({ chart: z.enum(['I', 'MR', 'Xbar', 'R']) })),
          episodes: z.array(episodeSchema),
          clean: z.boolean(),
        }),
      }),
    ),
  })
  .describe(
    'The traceability and SPC truth so far (#208): trace.json (sim-trace/1) without its schema ' +
      'and run header; provisional while cartons are open, orders incomplete or episodes open',
  );

export const injectionSchema = z.object({
  id: count,
  machine: z.string(),
  code: z.string(),
  at: isoSchema.describe('When it was due'),
  repairMs: count.optional(),
  status: z
    .enum(['scheduled', 'held', 'applied'])
    .describe('held: waiting for the machine to enter Running; applied: the machine went Down'),
  heldAt: isoSchema.optional(),
  appliedAt: isoSchema.optional(),
});

export const injectBodySchema = z
  .object({
    code: z.string().describe('A failure-mode code of the machine (failures.yaml)'),
    at: z
      .string()
      .optional()
      .describe('Simulation time, ISO 8601 with an offset or Z; the current time when left out'),
    repairMs: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Exact repair time; drawn from the mode's repair stream when left out"),
  })
  .strict();

export const driftSchema = z.object({
  id: count.describe('Numbered with the failure injections, in acceptance order'),
  machine: z.string(),
  shift: z.number().describe("Added to every reading while active, in the tester's unit (Pa/min)"),
  at: isoSchema.describe('When it starts'),
  until: isoSchema.describe('When it ends, unless a calibration ends it first'),
  status: z
    .enum(['scheduled', 'active', 'ended'])
    .describe('active: readings carry the shift; ended: by `until` or by a calibration'),
  appliedAt: isoSchema.optional(),
  endedAt: isoSchema.optional(),
  endedBy: z.enum(['until', 'calibration']).optional(),
});

export const driftBodySchema = z
  .object({
    shift: z
      .number()
      .describe(
        "Pa/min added to the reading's mean: a non-zero whole multiple of the tester's resolution (0.001)",
      ),
    at: z
      .string()
      .optional()
      .describe('Simulation time, ISO 8601 with an offset or Z; the current time when left out'),
    until: z
      .string()
      .describe(
        'Simulation time after `at`, ISO 8601 with an offset or Z; the drift ends then or at the ' +
          "tester's next calibration, whichever comes first",
      ),
  })
  .strict();

export const groundTruthSchema = z.object({
  epoch: count.describe('Run epoch (Unix seconds), as the devices publish it (ADR-0015)'),
  productionMode: z.enum(PRODUCTION_MODES).describe('The production mode of the run (#172)'),
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
  oee: oeeSchema,
  alarms: alarmsSchema,
  orders: ordersSchema,
  trace: traceSchema,
  traceAsOf: isoSchema
    .optional()
    .describe('1.6: present when `trace` was cut at an earlier plant time (`?asOf`)'),
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
    /** Failure injection (#140): schedules an injection, and lists them with their outcome. */
    readonly failure?: {
      readonly inject: (request: InjectFailureRequest) => InjectFailureResult;
      readonly list: () => readonly FailureInjection[];
    };
    /** Leak-test drift injection (#196): schedules a drift, and lists them with their outcome. */
    readonly drift?: {
      readonly inject: (request: InjectDriftRequest) => InjectDriftResult;
      readonly list: () => readonly LeakDrift[];
    };
  };
  /** The live run's ground truth (#100); the route exists only when given. */
  /**
   * `traceAsOf` (1.6): cut the `trace` section at that plant time; throws an
   * `AsOfAfterSimTimeError` when it is after the simulation time (400; any other error is a 500).
   */
  readonly groundTruth?: (traceAsOf?: number) => GroundTruthReport;
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
  version = CONTROL_API_VERSION,
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
        {
          name: 'faults',
          description: 'Infrastructure faults for resilience tests, and failure injection',
        },
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
            'Time per state and OEE, per machine and shift bucket, so far (the headless summary, live)',
          description:
            'The ground truth a headless run would write if it ended now, kept live while the run ' +
            'is paced. Reconciliation tests compare the MES with it (#100). Reading it never ' +
            'moves the run.',
          querystring: json(
            z.object({
              asOf: z
                .string()
                .optional()
                .describe(
                  '1.6 (#208): cut `trace` at this plant time (ISO 8601 with an offset or Z, not ' +
                    "after `simTime`) with trace-core's `traceAsOf`, counterfactual readings " +
                    'included; every other section stays as of `simTime`',
                ),
            }),
          ),
          response: { 200: json(groundTruthSchema), 400: json(errorSchema) },
        },
      },
      (request, reply) => {
        const { asOf } = request.query as { asOf?: string };
        if (asOf === undefined) return groundTruth();
        let at: number;
        try {
          at = Temporal.Instant.from(asOf).epochMilliseconds;
        } catch {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `asOf must be ISO 8601 with an offset or Z, got "${asOf}"`,
          });
        }
        try {
          return groundTruth(at);
        } catch (error) {
          if (!(error instanceof AsOfAfterSimTimeError)) throw error;
          return reply.code(400).send({ error: 'Bad Request', message: error.message });
        }
      },
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

  const failure = faults.failure;
  if (failure) {
    const injectionJson = (injection: FailureInjection) => ({
      id: injection.id,
      machine: injection.machine,
      code: injection.code,
      at: isoTime(injection.at),
      status: injection.status,
      ...(injection.repairMs === undefined ? {} : { repairMs: injection.repairMs }),
      ...(injection.heldAt === undefined ? {} : { heldAt: isoTime(injection.heldAt) }),
      ...(injection.appliedAt === undefined ? {} : { appliedAt: isoTime(injection.appliedAt) }),
    });
    app.post(
      `${API_PREFIX}/faults/failure/:machine`,
      {
        schema: {
          tags: ['faults'],
          summary: 'Inject a failure mode on a machine, now or at a simulation time',
          description:
            'The machine breaks down with the code as its cause and raises its alarm, as in a ' +
            'natural failure. It takes effect only while the machine is Running; otherwise it is ' +
            'held and applied where the machine would next enter Running (#140). With `at` it is ' +
            'scheduled as a simulation event, so a live run reproduces a headless run with the ' +
            'same injections. 404: unknown machine or code; 409: `at` in the past or on a ' +
            'calendar boundary, or the run has finished.',
          params: json(z.object({ machine: z.string() })),
          body: json(injectBodySchema),
          response: {
            200: json(z.object({ injection: injectionSchema })),
            400: json(errorSchema),
            404: json(errorSchema),
            409: json(errorSchema),
          },
        },
      },
      (request, reply) => {
        const { machine } = request.params as { machine: string };
        const body = request.body as { code: string; at?: string; repairMs?: number };
        if (pacer.state === 'finished') {
          return conflict(reply, 'the run has finished');
        }
        let at: number | undefined;
        if (body.at !== undefined) {
          try {
            at = Temporal.Instant.from(body.at).epochMilliseconds;
          } catch {
            return reply.code(400).send({
              error: 'Bad Request',
              message: `at must be ISO 8601 with an offset or Z, got "${body.at}"`,
            });
          }
        }
        const result = failure.inject({
          machine,
          code: body.code,
          ...(at === undefined ? {} : { at }),
          ...(body.repairMs === undefined ? {} : { repairMs: body.repairMs }),
        });
        if (result.ok) {
          return { injection: injectionJson(result.injection) };
        }
        switch (result.code) {
          case 'unknown-machine':
          case 'unknown-code':
            return reply.code(404).send({ error: 'Not Found', message: result.reason });
          case 'in-the-past':
          case 'calendar-boundary':
            return conflict(reply, result.reason);
          case 'invalid-time':
          case 'invalid-repair':
            return reply.code(400).send({ error: 'Bad Request', message: result.reason });
        }
      },
    );
    app.get(
      `${API_PREFIX}/faults/injections`,
      {
        schema: {
          tags: ['faults'],
          summary: 'Every failure injection of the run, in order, with its outcome',
          response: { 200: json(z.object({ injections: z.array(injectionSchema) })) },
        },
      },
      () => ({ injections: failure.list().map(injectionJson) }),
    );
  }

  const drift = faults.drift;
  if (drift) {
    const driftJson = (view: LeakDrift) => ({
      id: view.id,
      machine: view.machine,
      shift: view.shift,
      at: isoTime(view.at),
      until: isoTime(view.until),
      status: view.status,
      ...(view.appliedAt === undefined ? {} : { appliedAt: isoTime(view.appliedAt) }),
      ...(view.endedAt === undefined ? {} : { endedAt: isoTime(view.endedAt) }),
      ...(view.endedBy === undefined ? {} : { endedBy: view.endedBy }),
    });
    app.post(
      `${API_PREFIX}/faults/drift/:machine`,
      {
        schema: {
          tags: ['faults'],
          summary: 'Inject a leak-test sensor drift, from now or a simulation time until a time',
          description:
            "Adds `shift` to the leak tester's readings from `at` until `until` or the tester's " +
            'next calibration, whichever comes first (#196, ADR-0033). No random draw changes, ' +
            'so the readings without the drift are exactly the logged ones minus `shift`. The ' +
            'event log gets a `leak-drift` line when it applies and when it ends. 404: unknown ' +
            'machine; 400: not the leak tester, a shift that is not a non-zero whole multiple of ' +
            "the tester's resolution, an `until` not after `at`, or an invalid time; 409: `at` in " +
            'the past or `at`/`until` on a calendar boundary, or the run has finished.',
          params: json(z.object({ machine: z.string() })),
          body: json(driftBodySchema),
          response: {
            200: json(z.object({ drift: driftSchema })),
            400: json(errorSchema),
            404: json(errorSchema),
            409: json(errorSchema),
          },
        },
      },
      (request, reply) => {
        const { machine } = request.params as { machine: string };
        const body = request.body as { shift: number; at?: string; until: string };
        if (pacer.state === 'finished') {
          return conflict(reply, 'the run has finished');
        }
        const instant = (value: string): number | undefined => {
          try {
            return Temporal.Instant.from(value).epochMilliseconds;
          } catch {
            return undefined;
          }
        };
        const badTime = (name: string, value: string) =>
          reply.code(400).send({
            error: 'Bad Request',
            message: `${name} must be ISO 8601 with an offset or Z, got "${value}"`,
          });
        const at = body.at === undefined ? undefined : instant(body.at);
        if (body.at !== undefined && at === undefined) return badTime('at', body.at);
        const until = instant(body.until);
        if (until === undefined) return badTime('until', body.until);
        const result = drift.inject({
          machine,
          shift: body.shift,
          until,
          ...(at === undefined ? {} : { at }),
        });
        if (result.ok) {
          return { drift: driftJson(result.drift) };
        }
        switch (result.code) {
          case 'unknown-machine':
            return reply.code(404).send({ error: 'Not Found', message: result.reason });
          case 'in-the-past':
          case 'calendar-boundary':
            return conflict(reply, result.reason);
          case 'not-a-leak-tester':
          case 'invalid-shift':
          case 'invalid-time':
          case 'invalid-until':
            return reply.code(400).send({ error: 'Bad Request', message: result.reason });
        }
      },
    );
    app.get(
      `${API_PREFIX}/faults/drifts`,
      {
        schema: {
          tags: ['faults'],
          summary: 'Every leak-test drift injection of the run, in order, with its outcome',
          response: { 200: json(z.object({ drifts: z.array(driftSchema) })) },
        },
      },
      () => ({ drifts: drift.list().map(driftJson) }),
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
