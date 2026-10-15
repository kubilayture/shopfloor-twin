import websocket from '@fastify/websocket';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { Equipment, StoredInterval } from '../equipment/index.ts';
import type { Ingest } from '../ingest/index.ts';
import type { EquipmentInfo, MasterData } from '../master-data/index.ts';
import { PushHub, currentStateDto, type PushOptions } from './push.ts';
import { HttpProblem, PROBLEM_TYPE, getRoute, jsonSchema, problem } from './routes.ts';
import {
  LIMITS,
  equipmentListSchema,
  equipmentParams,
  equipmentSchema,
  intervalsQuery,
  intervalsSchema,
  metricsSchema,
  noQuery,
  plantSchema,
  problemSchema,
  seriesSchema,
  shiftParams,
  shiftTotalsQuery,
  shiftTotalsSchema,
  telemetryQuery,
  type EquipmentDto,
  type IntervalDto,
} from './schemas.ts';

export const API_PREFIX = '/api/v1';
export const WS_PATH = `${API_PREFIX}/ws`;

/** What the API reads from the other modules (their `index.ts` interfaces). */
export interface ApiSources {
  readonly masterData: Pick<MasterData, 'equipment' | 'site' | 'shiftPattern'>;
  readonly equipment: Pick<
    Equipment,
    | 'currentStates'
    | 'currentState'
    | 'intervals'
    | 'shiftTotals'
    | 'watermark'
    | 'watermarks'
    | 'onChange'
  >;
  readonly ingest: Pick<Ingest, 'telemetryMetrics' | 'telemetrySeries' | 'onStored'>;
}

export interface RealtimeOptions {
  readonly registry?: Registry;
  readonly push?: Omit<PushOptions, 'registry'>;
  /** Host names the API answers (`Host` header, against DNS rebinding); `*` for any. */
  readonly allowedHosts?: readonly string[];
  /** Origins a WebSocket may connect from besides the MES's own host (none by default). */
  readonly allowedOrigins?: readonly string[];
}

export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** The API and push, registered before the modules exist; `attach` connects them. */
export interface Realtime {
  attach(sources: ApiSources): Promise<void>;
  readonly push: PushHub;
}

interface Attached {
  readonly sources: ApiSources;
  readonly catalog: ReadonlyMap<string, EquipmentInfo>;
  readonly shifts: ReadonlySet<string>;
}

/** The host name of a `Host` header (`[::1]:4700` → `[::1]`), lower-cased. */
export function hostName(host: string): string {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return (name ?? '').toLowerCase();
}

/** Whether an Origin header names the host the request was sent to. */
function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Pool or statement timeouts of the read pool: the database is busy, try again (503), never 500.
 * SQLSTATE 57014 is `query_canceled` (statement_timeout); pg reports a pool wait without a code.
 */
function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '57014' || /timeout exceeded when trying to connect/i.test(error.message);
}

const iso = (date: Date): string => date.toISOString();

/**
 * Merges the stored hour and shift pieces of each interval back, clipped to [from, to).
 *
 * `cutoff` is the start of the first piece left out by the row limit: an interval reaching it may
 * have pieces beyond the limit, so it is dropped, and `next` (the earliest start of the dropped
 * ones) is where the following request continues.
 */
export function mergePieces(
  pieces: readonly StoredInterval[],
  from: Date,
  to: Date,
  cutoff?: Date,
): { intervals: IntervalDto[]; next: Date | null } {
  const merged = new Map<
    string,
    { piece: StoredInterval; start: number; end: number; provisional: boolean }
  >();
  for (const piece of pieces) {
    const key = `${String(piece.epoch)}|${String(piece.intervalStart.getTime())}|${String(piece.startSeq)}`;
    const entry = merged.get(key);
    if (entry) {
      entry.start = Math.min(entry.start, piece.start.getTime());
      entry.end = Math.max(entry.end, piece.end.getTime());
      entry.provisional ||= piece.provisional;
    } else {
      merged.set(key, {
        piece,
        start: piece.start.getTime(),
        end: piece.end.getTime(),
        provisional: piece.provisional,
      });
    }
  }
  const all = [...merged.values()].sort(
    (a, b) => a.start - b.start || a.piece.epoch - b.piece.epoch,
  );
  const limit = cutoff?.getTime() ?? Infinity;
  const complete = all.filter((entry) => entry.end < limit);
  const dropped = all.filter((entry) => entry.end >= limit);
  const next =
    cutoff === undefined
      ? null
      : new Date(Math.max(from.getTime(), Math.min(limit, ...dropped.map((e) => e.start))));
  return {
    next,
    intervals: complete.map(({ piece, start, end, provisional }) => ({
      epoch: piece.epoch,
      start: iso(new Date(Math.max(start, from.getTime()))),
      end: iso(new Date(Math.min(end, to.getTime()))),
      state: piece.state,
      cause: piece.cause,
      provisional,
      intervalStart: iso(piece.intervalStart),
      startSeq: piece.startSeq,
    })),
  };
}

/**
 * The `realtime` module (#97): the read-only REST API under `/api/v1` and WebSocket push at
 * `/api/v1/ws`. Routes answer 503 until `attach` gave them the modules.
 */
export async function registerRealtime(
  app: FastifyInstance,
  options: RealtimeOptions = {},
): Promise<Realtime> {
  const push = new PushHub({
    ...options.push,
    ...(options.registry ? { registry: options.registry } : {}),
  });
  let attached: Attached | undefined;
  const ready = (): Attached => {
    if (!attached) throw new HttpProblem(503, 'the MES is starting');
    return attached;
  };
  const known = (id: string): EquipmentInfo => {
    const info = ready().catalog.get(id);
    if (!info) throw new HttpProblem(404, `no equipment ${id}`);
    return info;
  };
  const dto = (info: EquipmentInfo): EquipmentDto => {
    const { equipment } = ready().sources;
    const current = equipment.currentState(info.id);
    return {
      id: info.id,
      name: info.name,
      operation: info.operation,
      interface: info.interface,
      position: info.position,
      site: info.site,
      area: info.area,
      workCenter: info.workCenter,
      current: current ? currentStateDto(current, equipment.watermark(current.epoch)) : null,
    };
  };

  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
  );
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  // A page on another site must not read plant data: by DNS rebinding (its own name resolving to
  // the MES, caught by the Host check) or by opening a WebSocket (not covered by CORS, caught by
  // the Origin check). A request without Origin is not from a browser page.
  const refusal = (headers: IncomingHttpHeaders): string | undefined => {
    const host = hostName(headers.host ?? '');
    if (!allowedHosts.has('*') && !allowedHosts.has(host)) {
      return 'host not allowed (HTTP_ALLOWED_HOSTS)';
    }
    const origin = headers.origin;
    if (origin === undefined || allowedOrigins.has(origin) || sameOrigin(origin, headers.host)) {
      return undefined;
    }
    return 'origin not allowed (HTTP_ALLOWED_ORIGINS)';
  };

  app.addSchema({ $id: 'Problem', ...jsonSchema(problemSchema, 'output') });

  await app.register(websocket, {
    options: {
      maxPayload: 4096,
      verifyClient: (info, done) => {
        const refused = refusal(info.req.headers);
        if (refused === undefined) done(true);
        else done(false, 403, refused);
      },
    },
    // A client that stopped reading would hold up shutdown for ws's 30 s close timeout.
    preClose: (done) => {
      push.close();
      for (const client of app.websocketServer.clients) client.terminate();
      done();
    },
  });

  await app.register(
    (api, _options, done) => {
      // A page on another site must not read plant data: by DNS rebinding (its own name resolving
      // to the MES, caught by the Host check) or by opening a WebSocket (not covered by CORS,
      // caught by the Origin check). A request without Origin is not from a browser page.
      api.addHook('onRequest', async (request, reply) => {
        // WebSocket upgrades are checked by `verifyClient`, which can answer before the upgrade.
        if (request.headers.upgrade !== undefined) return;
        const refused = refusal(request.headers);
        if (refused !== undefined) {
          await reply
            .code(403)
            .type(PROBLEM_TYPE)
            .send(problem(403, refused, request.url));
        }
      });
      api.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
        const busy = isBusy(error);
        const status = busy
          ? 503
          : error instanceof HttpProblem
            ? error.status
            : error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500
              ? error.statusCode
              : 500;
        if (status >= 500) request.log[busy || status === 503 ? 'warn' : 'error'](error);
        const detail = busy
          ? 'the database is busy; try again'
          : status >= 500 && status !== 503
            ? 'internal error'
            : error.message;
        return reply
          .code(status)
          .type(PROBLEM_TYPE)
          .send(problem(status, detail, request.url));
      });
      api.setNotFoundHandler((request, reply) =>
        reply
          .code(404)
          .type(PROBLEM_TYPE)
          .send(
            problem(
              404,
              `no route ${request.method} ${request.url.split('?', 1)[0] ?? ''}`,
              request.url,
            ),
          ),
      );

      getRoute(
        api,
        {
          url: '/equipment',
          summary: 'Every equipment with its place in the hierarchy and its current state',
          tags: ['equipment'],
          query: noQuery,
          response: equipmentListSchema,
          errors: [400, 503],
        },
        () => ({ equipment: [...ready().catalog.values()].map(dto) }),
      );

      getRoute(
        api,
        {
          url: '/equipment/:id',
          summary: 'One equipment with its current state',
          tags: ['equipment'],
          params: equipmentParams,
          query: noQuery,
          response: equipmentSchema,
          errors: [400, 404, 503],
        },
        ({ params }) => dto(known(params.id)),
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/intervals',
          summary: 'State intervals overlapping a time range',
          description:
            'The stored pieces (each inside one UTC hour and one shift) are merged back into ' +
            'whole intervals and clipped to the range. Per shift, use /shifts/{date}/{shift}/totals.',
          tags: ['equipment'],
          params: equipmentParams,
          query: intervalsQuery,
          response: intervalsSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          known(params.id);
          const pieces = await ready().sources.equipment.intervals(
            params.id,
            query.from,
            query.to,
            {
              limit: LIMITS.intervalPieces + 1,
            },
          );
          const truncated = pieces.length > LIMITS.intervalPieces;
          const { intervals, next } = mergePieces(
            truncated ? pieces.slice(0, LIMITS.intervalPieces) : pieces,
            query.from,
            query.to,
            truncated ? pieces[LIMITS.intervalPieces]?.start : undefined,
          );
          return {
            equipment: params.id,
            from: iso(query.from),
            to: iso(query.to),
            truncated,
            next: next && iso(next),
            intervals,
          };
        },
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/telemetry/metrics',
          summary: "The equipment's telemetry metrics with unit and latest sample",
          tags: ['telemetry'],
          params: equipmentParams,
          query: noQuery,
          response: metricsSchema,
          errors: [400, 404, 503],
        },
        async ({ params }) => {
          known(params.id);
          const metrics = await ready().sources.ingest.telemetryMetrics(params.id);
          return {
            equipment: params.id,
            metrics: metrics.map((m) => ({
              metric: m.metric,
              unit: m.unit,
              latest: { t: iso(m.latest.sourceTime), value: m.latest.value },
            })),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/equipment/:id/telemetry',
          summary: 'Telemetry series, decimated into time buckets (min, max, avg)',
          description:
            'The range is cut into at most maxPoints buckets of equal width, aligned on `from` ' +
            '(TimescaleDB time_bucket); each non-empty bucket gives min, max, average and count.',
          tags: ['telemetry'],
          params: equipmentParams,
          query: telemetryQuery,
          response: seriesSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          known(params.id);
          const { ingest } = ready().sources;
          const metrics = await ingest.telemetryMetrics(params.id);
          const units = new Map(metrics.map((m) => [m.metric, m.unit]));
          const wanted = query.metric ?? [...units.keys()];
          const unknown = wanted.find((metric) => !units.has(metric));
          if (unknown !== undefined) {
            throw new HttpProblem(404, `no telemetry ${unknown} of ${params.id}`);
          }
          const bucketMs = Math.max(
            1,
            Math.ceil((query.to.getTime() - query.from.getTime()) / query.maxPoints),
          );
          const series = await ingest.telemetrySeries(
            params.id,
            [...new Set(wanted)],
            query.from,
            query.to,
            bucketMs,
          );
          return {
            equipment: params.id,
            from: iso(query.from),
            to: iso(query.to),
            bucketMs,
            series: series.map((s) => ({
              metric: s.metric,
              unit: units.get(s.metric) ?? '',
              points: s.buckets.map((b) => ({
                t: iso(b.start),
                min: b.min,
                max: b.max,
                avg: b.avg,
                n: b.count,
              })),
            })),
          };
        },
      );

      getRoute(
        api,
        {
          url: '/shifts/:date/:shift/totals',
          summary: 'Time per state in one shift, per equipment and epoch',
          tags: ['shifts'],
          params: shiftParams,
          query: shiftTotalsQuery,
          response: shiftTotalsSchema,
          errors: [400, 404, 503],
        },
        async ({ params, query }) => {
          if (!ready().shifts.has(params.shift)) {
            throw new HttpProblem(404, `no shift ${params.shift} in the shift pattern`);
          }
          if (query.equipment !== undefined) known(query.equipment);
          const shiftKey = `${params.date}/${params.shift}`;
          const totals = await ready().sources.equipment.shiftTotals(
            shiftKey,
            query.equipment === undefined ? {} : { equipment: query.equipment },
          );
          return { shiftKey, totals: totals.map((t) => ({ ...t })) };
        },
      );

      getRoute(
        api,
        {
          url: '/plant',
          summary: 'The site and the plant clock (watermark of the newest epoch)',
          tags: ['plant'],
          query: noQuery,
          response: plantSchema,
          errors: [400, 503],
        },
        async () => {
          const { sources } = ready();
          const site = await sources.masterData.site();
          const epochs = sources.equipment
            .watermarks()
            .slice(0, 20)
            .map((w) => ({ epoch: w.epoch, watermark: iso(w.watermark) }));
          return { site: site ?? null, clock: epochs[0] ?? null, epochs };
        },
      );

      api.get(
        '/ws',
        {
          websocket: true,
          schema: {
            summary: 'WebSocket push of states and telemetry (protocol: docs/api/realtime.md)',
            tags: ['push'],
            hide: true,
          },
        },
        (socket) => {
          push.connect(socket);
        },
      );
      done();
    },
    { prefix: API_PREFIX },
  );

  return {
    push,
    async attach(sources) {
      const equipment = await sources.masterData.equipment();
      const pattern = await sources.masterData.shiftPattern();
      const catalog = new Map(equipment.map((info) => [info.id, info]));
      attached = { sources, catalog, shifts: new Set(pattern.shifts.map((shift) => shift.id)) };
      push.attach({
        equipment: sources.equipment,
        ingest: sources.ingest,
        catalog: new Set(catalog.keys()),
      });
    },
  };
}
