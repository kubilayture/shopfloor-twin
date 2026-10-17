import {
  MES_API_LIMITS as LIMITS,
  QUALITY_LIMITS,
  SIGNAL_STATUSES,
  characteristicId,
  characteristicListSchema,
  characteristicSchema,
  limitsCreateRequestSchema,
  limitsEndRequestSchema,
  limitsWriteResultSchema,
  measurementListSchema,
  signalAckRequestSchema,
  spcChartSchema,
  spcSignalListSchema,
  spcSignalSchema,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WriteBy } from '../identity/index.ts';
import { QualityError, type Quality } from '../quality/index.ts';
import {
  characteristicDto,
  limitVersionDto,
  measurementDto,
  signalDto,
  spcChartDto,
} from './quality-dto.ts';
import { HttpProblem, getRoute, writeRoute, type ErrorStatus } from './routes.ts';

/** What the quality routes use of the quality module (#200). */
export type QualityApi = Pick<
  Quality,
  | 'characteristics'
  | 'characteristic'
  | 'chart'
  | 'chartTag'
  | 'measurements'
  | 'signals'
  | 'createLimits'
  | 'endLimits'
  | 'acknowledge'
>;

const QUALITY_STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const WRITE_ERRORS: readonly ErrorStatus[] = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503];

const queryTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const characteristicParams = z.strictObject({ id: characteristicId });
const versionParams = z.strictObject({
  id: characteristicId,
  version: z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .describe('The limit version'),
});
const signalParams = z.strictObject({
  id: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .describe('The signal id'),
});
const rangeQuery = z.strictObject({
  from: queryTime.optional().describe('Only points (readings) at or after this plant time'),
  to: queryTime.optional().describe('Only points (readings) before this plant time'),
});
const chartQuery = rangeQuery.extend({
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe(
      `Every point; by default (no \`from\`, \`to\`) those of the last ${String(QUALITY_LIMITS.chartRecent)} first-pass readings`,
    ),
});
const statuses = z
  .string()
  .regex(/^[a-z]+(,[a-z]+)*$/)
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(SIGNAL_STATUSES)));
const signalQuery = z.strictObject({
  characteristic: characteristicId.optional(),
  status: statuses
    .optional()
    .describe(
      `Only these statuses, comma-separated (${SIGNAL_STATUSES.join(', ')}); default: all but withdrawn`,
    ),
  unacknowledged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
    .describe('Only the signals not acknowledged yet'),
});

const problemOf = (error: unknown): unknown =>
  error instanceof QualityError
    ? new HttpProblem(QUALITY_STATUS[error.kind], error.message, error.type)
    : error;

/**
 * The SPC API of the quality module (#200, plan "SPC"): characteristics, the charts with every
 * point, subgroup, limit version and signal, measurements, signals, and the writes: a new limit
 * version and the end of one (`spc:limits`), a signal's acknowledgement (`spc:ack`), each with the
 * version read and audited with the session's user. Registered in the `/api/v1` scope.
 */
export function qualityRoutes(
  api: FastifyInstance,
  deps: {
    /** The quality module, or 503 while the MES starts. */
    readonly quality: () => QualityApi;
    /** Who writes: the session's user; 401 without a session. */
    readonly writer: (request: FastifyRequest) => Promise<WriteBy>;
  },
): void {
  getRoute(
    api,
    {
      url: '/quality/characteristics',
      summary: 'SPC characteristics (quality.yaml) with their limits, baseline and signal counts',
      tags: ['quality'],
      query: z.strictObject({}),
      response: characteristicListSchema,
      errors: [400, 503],
    },
    async () => ({
      characteristics: (await deps.quality().characteristics()).map(characteristicDto),
    }),
  );

  getRoute(
    api,
    {
      url: '/quality/characteristics/:id',
      summary: 'One SPC characteristic',
      tags: ['quality'],
      params: characteristicParams,
      query: z.strictObject({}),
      response: characteristicSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.quality().characteristic(params.id);
      if (!found) throw new HttpProblem(404, `no characteristic ${params.id}`);
      return characteristicDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/quality/characteristics/:id/chart',
      summary: 'The I-MR and X̄-R charts of a characteristic, with limits and signals',
      description: `The module's current derivation from the first-pass readings and the limit versions (ADR-0032): each point with its limit version, the rules firing at it and whether the tester is final through it; subgroups of consecutive first-pass readings; retests apart. By default the points of the last ${String(QUALITY_LIMITS.chartRecent)} first-pass readings (\`pointsFrom\`); \`all=true\` every one, \`from\` and \`to\` a range (limits, counts and signals stay whole). The answer carries an \`ETag\` that changes with every derivation, limit write and acknowledgement; \`If-None-Match\` with it answers 304.`,
      tags: ['quality'],
      params: characteristicParams,
      query: chartQuery,
      response: spcChartSchema,
      errors: [400, 404, 503],
      etag: true,
    },
    async ({ params, query, request, reply }) => {
      const quality = deps.quality();
      // The tag names the derivation and the normalized query (`all`, `from`, `to`).
      const variant = [
        query.all ? 'all' : '',
        query.from?.toISOString() ?? '',
        query.to?.toISOString() ?? '',
      ].join('|');
      const tag = quality.chartTag(params.id, variant);
      if (tag !== null) {
        void reply.header('etag', tag);
        if (request.headers['if-none-match'] === tag) {
          return reply.code(304).send() as never;
        }
      }
      const view = await quality.chart(params.id);
      if (!view) throw new HttpProblem(404, `no characteristic ${params.id}`);
      return spcChartDto(view, {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        all: query.all,
      });
    },
  );

  getRoute(
    api,
    {
      url: '/quality/characteristics/:id/measurements',
      summary: 'Readings of a characteristic in chart order, every pass',
      description: `At most ${String(QUALITY_LIMITS.measurements)}; \`truncated\` when more matched.`,
      tags: ['quality'],
      params: characteristicParams,
      query: rangeQuery,
      response: measurementListSchema,
      errors: [400, 404, 503],
    },
    async ({ params, query }) => {
      const found = await deps.quality().measurements(params.id, {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        limit: QUALITY_LIMITS.measurements,
      });
      if (!found) throw new HttpProblem(404, `no characteristic ${params.id}`);
      return {
        measurements: found.measurements.map(measurementDto),
        truncated: found.truncated,
      };
    },
  );

  getRoute(
    api,
    {
      url: '/quality/signals',
      summary: 'SPC signal episodes, newest first',
      description: `At most ${String(QUALITY_LIMITS.signals)}; \`truncated\` when more matched. Provisional until the tester is final through the triggering point; withdrawn ones only when asked for.`,
      tags: ['quality'],
      query: signalQuery,
      response: spcSignalListSchema,
      errors: [400, 503],
    },
    async ({ query }) => {
      const found = await deps.quality().signals({
        ...(query.characteristic === undefined ? {} : { characteristic: query.characteristic }),
        ...(query.status === undefined ? {} : { status: query.status }),
        unacknowledged: query.unacknowledged,
        limit: QUALITY_LIMITS.signals,
      });
      return { signals: found.signals.map(signalDto), truncated: found.truncated };
    },
  );

  const GUARDS =
    'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).';

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/quality/characteristics/:id/limits',
      access: 'spc:limits',
      summary: 'Estimates a new control limit version from a window of readings',
      description:
        'From the final first-pass readings whose plant time lies in [from, to]: I-MR from every reading, X̄-R from the complete subgroups inside (422 when the window holds no moving range or no complete subgroup). The new version applies after every reading received so far, from (newest epoch, plant clock, last sequence + 1): earlier points keep their version. Version 1 is estimated automatically once the baseline is final (409 urn:shopfloor:limits-v1-missing before). Clears a baseline-changed notice. Names the characteristic’s `version` (409 urn:shopfloor:limits-stale); audited with the session’s user. ' +
        GUARDS,
      tags: ['quality'],
      params: characteristicParams,
      body: limitsCreateRequestSchema,
      response: limitsWriteResultSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, body, requestId, request }) => {
      const by = await deps.writer(request);
      const result = await deps
        .quality()
        .createLimits(
          params.id,
          {
            version: body.version,
            from: new Date(body.from),
            to: new Date(body.to),
            comment: body.comment,
          },
          { by, requestId },
        )
        .catch((error: unknown) => {
          throw problemOf(error);
        });
      return {
        characteristic: characteristicDto(result.characteristic),
        limits: limitVersionDto(result.limits, result.characteristic.resolution),
      };
    },
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/quality/characteristics/:id/limits/:version/end',
      access: 'spc:limits',
      summary: 'Ends a control limit version at the plant clock',
      description:
        'Points after every reading received so far are judged by the highest other version open there, or not at all. 409 urn:shopfloor:limits-ended for a version ended already; names the characteristic’s `version` (409 urn:shopfloor:limits-stale); audited. ' +
        GUARDS,
      tags: ['quality'],
      params: versionParams,
      body: limitsEndRequestSchema,
      response: limitsWriteResultSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, body, requestId, request }) => {
      const by = await deps.writer(request);
      const result = await deps
        .quality()
        .endLimits(params.id, params.version, body, { by, requestId })
        .catch((error: unknown) => {
          throw problemOf(error);
        });
      return {
        characteristic: characteristicDto(result.characteristic),
        limits: limitVersionDto(result.limits, result.characteristic.resolution),
      };
    },
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/quality/signals/:id/ack',
      access: 'spc:ack',
      summary: 'Acknowledges an SPC signal episode, once',
      description:
        'With a comment; names the signal’s `rowVersion` (409 urn:shopfloor:signal-stale); 409 urn:shopfloor:signal-withdrawn or urn:shopfloor:signal-acknowledged when it is withdrawn or acknowledged already; audited with the session’s user and the plant time. No hold follows by itself (plan "Signals and people"). ' +
        GUARDS,
      tags: ['quality'],
      params: signalParams,
      body: signalAckRequestSchema,
      response: spcSignalSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, body, requestId, request }) => {
      const by = await deps.writer(request);
      const signal = await deps
        .quality()
        .acknowledge(params.id, body, { by, requestId })
        .catch((error: unknown) => {
          throw problemOf(error);
        });
      return signalDto(signal);
    },
  );
}
