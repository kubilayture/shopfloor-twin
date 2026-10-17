import {
  HOLD_STATES,
  HOLD_SUBJECT_KINDS,
  MES_API_LIMITS as LIMITS,
  QUALITY_LIMITS,
  holdCommentRequestSchema,
  holdDecisionRequestSchema,
  holdDetailSchema,
  holdIncidentSchema,
  holdListSchema,
  holdOpenRequestSchema,
  holdReasonListSchema,
  holdSchema,
  holdSuggestionSchema,
  type HoldDetailDto,
  type HoldDto,
  type HoldIncidentDto,
  type HoldSuggestionDto,
  type HoldSubjectDto,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WriteBy } from '../identity/index.ts';
import {
  QualityError,
  type HoldDetail,
  type HoldIncidentRecord,
  type HoldRecord,
  type HoldSuggestion,
  type Holds,
} from '../quality/index.ts';
import { HttpProblem, getRoute, writeRoute, type ErrorStatus } from './routes.ts';

/** What the hold routes use of the quality module's holds (#201). */
export type HoldsApi = Pick<
  Holds,
  | 'list'
  | 'detail'
  | 'incidents'
  | 'reasons'
  | 'suggestion'
  | 'open'
  | 'comment'
  | 'decide'
  | 'holdsOn'
>;

const STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const WRITE_ERRORS: readonly ErrorStatus[] = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503];

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

const holdParams = z.strictObject({
  id: z
    .string()
    .regex(/^[0-9a-fA-F-]{36}$/)
    .describe('A hold id (UUID)'),
});
const signalParams = z.strictObject({
  id: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .describe('The signal id'),
});
const states = z
  .string()
  .regex(/^[a-z]+(,[a-z]+)*$/)
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(HOLD_STATES)));
const listQuery = z
  .strictObject({
    state: states
      .optional()
      .describe(`Only these states, comma-separated (${HOLD_STATES.join(', ')}); default: all`),
    subjectKind: z.enum(HOLD_SUBJECT_KINDS).optional().describe('With `subjectId`: one subject'),
    subjectId: z.string().min(1).max(128).optional(),
  })
  .refine((q) => (q.subjectKind === undefined) === (q.subjectId === undefined), {
    message: 'subjectKind and subjectId go together',
  });

const problemOf = (error: unknown): unknown =>
  error instanceof QualityError
    ? new HttpProblem(STATUS[error.kind], error.message, error.type)
    : error;

const subjectDto = (s: HoldRecord['subject']): HoldSubjectDto => ({ kind: s.kind, id: s.id });

export function holdDto(hold: HoldRecord): HoldDto {
  return {
    id: hold.id,
    subject: subjectDto(hold.subject),
    state: hold.state,
    reason: hold.reason,
    openedBy: hold.openedBy,
    openedAt: iso(hold.openedAt),
    openedPlantAt: isoOrNull(hold.openedPlantAt),
    decidedBy: hold.decidedBy,
    decidedAt: isoOrNull(hold.decidedAt),
    decidedPlantAt: isoOrNull(hold.decidedPlantAt),
    decisionReason: hold.decisionReason,
    transitions: hold.transitions,
    version: hold.version,
    scope: { ...hold.scope },
    heldMaterialConsumed: hold.heldMaterialConsumed,
  };
}

const incidentDto = (i: HoldIncidentRecord): HoldIncidentDto => ({
  id: i.id,
  type: i.type,
  lot: i.lot,
  equipment: i.equipment,
  epoch: i.epoch,
  seq: i.seq,
  partId: i.partId,
  operation: i.operation,
  pass: i.pass,
  consumedAt: iso(i.consumedAt),
  message: i.message,
  detectedAt: iso(i.detectedAt),
});

export function holdDetailDto(detail: HoldDetail): HoldDetailDto {
  return {
    hold: holdDto(detail.hold),
    transitions: detail.transitions.map((t) => ({
      n: t.n,
      kind: t.kind,
      reason: t.reason,
      comment: t.comment,
      by: t.by,
      at: iso(t.at),
      plantAt: isoOrNull(t.plantAt),
      scope: t.scope === null ? null : { ...t.scope },
      notification: t.notification === null ? null : { ...t.notification },
    })),
    units: detail.units.map((u) => ({
      epoch: u.epoch,
      partId: u.partId,
      serial: u.serial,
      orderId: u.orderId,
      carton: u.carton,
      joinedAt: iso(u.joinedAt),
    })),
    unitsTruncated: detail.unitsTruncated,
    orders: [...detail.orders],
    cartons: [...detail.cartons],
    incidents: detail.incidents.map(incidentDto),
  };
}

const position = (p: { epoch: number; at: number; seq: number }) => ({
  epoch: p.epoch,
  at: new Date(p.at).toISOString(),
  seq: p.seq,
});

export function holdSuggestionDto(s: HoldSuggestion): HoldSuggestionDto {
  return {
    signal: s.window.signal.id,
    characteristic: s.window.signal.characteristic,
    chart: s.window.signal.chart,
    rule: s.window.signal.rule,
    after: s.window.after === null ? null : position(s.window.after),
    through: position(s.window.through),
    readings: s.window.readings.length,
    units: s.units.map((u) => ({
      epoch: u.epoch,
      partId: u.partId,
      serial: u.serial,
      orderId: u.orderId,
      carton: u.carton,
    })),
    orders: [...s.orders],
    cartons: [...s.cartons],
    final: s.window.final,
  };
}

const GUARDS =
  'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).';

/**
 * The quality holds API (#201, plan "Quality holds", ADR-0035): holds with their scope, transitions
 * and incidents, the hold reasons, a signal's suggested scope, and the writes: open and comment
 * (`quality:hold`), release and reject (`quality:release`), each audited with the session's user.
 * Registered in the `/api/v1` scope, behind its guards.
 */
export function holdRoutes(
  api: FastifyInstance,
  deps: {
    /** The holds, or 503 while the MES starts. */
    readonly holds: () => HoldsApi;
    /** Who writes: the session's user; 401 without a session. */
    readonly writer: (request: FastifyRequest) => Promise<WriteBy>;
  },
): void {
  getRoute(
    api,
    {
      url: '/quality/holds',
      summary: 'Quality holds, newest first',
      description: `At most ${String(QUALITY_LIMITS.holds)}; \`truncated\` when more matched. Each with its scope as last derived from the genealogy (it grows with facts) and its held-material-consumed count.`,
      tags: ['quality'],
      query: listQuery,
      response: holdListSchema,
      errors: [400, 503],
    },
    async ({ query }) => {
      const found = await deps.holds().list({
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.subjectKind === undefined || query.subjectId === undefined
          ? {}
          : { subject: { kind: query.subjectKind, id: query.subjectId } }),
        limit: QUALITY_LIMITS.holds,
      });
      return { holds: found.holds.map(holdDto), truncated: found.truncated };
    },
  );

  getRoute(
    api,
    {
      url: '/quality/holds/:id',
      summary: 'A quality hold with its transitions, scope and incidents',
      description: `Transitions and comments in order, each transition with its ERP notification’s state; the scope’s units (at most ${String(QUALITY_LIMITS.holdUnits)}), orders and cartons as last derived; held-material-consumed incidents.`,
      tags: ['quality'],
      params: holdParams,
      query: z.strictObject({}),
      response: holdDetailSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.holds().detail(params.id);
      if (!found) throw new HttpProblem(404, `no hold ${params.id}`);
      return holdDetailDto(found);
    },
  );

  getRoute(
    api,
    {
      url: '/quality/hold-reasons',
      summary: 'The reasons a hold is opened, released or rejected with (quality.yaml)',
      tags: ['quality'],
      query: z.strictObject({}),
      response: holdReasonListSchema,
      errors: [400, 503],
    },
    () => ({
      reasons: deps
        .holds()
        .reasons()
        .map((r) => ({ id: r.id, name: r.name, for: [...r.for] })),
    }),
  );

  getRoute(
    api,
    {
      url: '/quality/hold-incidents',
      summary: 'held-material-consumed incidents, newest first',
      description:
        'A lot under a hold consumed after the hold opened (and before a release): the MES sees it, it can’t stop it (a hold never commands a machine). At most 500.',
      tags: ['quality'],
      query: z.strictObject({}),
      response: z.object({ incidents: z.array(holdIncidentSchema) }),
      errors: [400, 503],
    },
    async () => ({ incidents: (await deps.holds().incidents()).map(incidentDto) }),
  );

  getRoute(
    api,
    {
      url: '/quality/signals/:id/hold-suggestion',
      summary: 'The units tested since the last in-control point before a signal episode',
      description:
        'A suggested hold scope (plan "Signals and people"): every reading, retests included, after the episode’s chart’s last point that fired no rule before it, through its last triggering point, with their units, orders and cartons. `final` is the episode’s `extentFinal`. No hold is opened by itself. 404 for an unknown or withdrawn signal.',
      tags: ['quality'],
      params: signalParams,
      query: z.strictObject({}),
      response: holdSuggestionSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => {
      const found = await deps.holds().suggestion(params.id);
      if (!found) throw new HttpProblem(404, `no signal ${String(params.id)} to suggest from`);
      return holdSuggestionDto(found);
    },
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/quality/holds',
      access: 'quality:hold',
      summary: 'Opens a quality hold on a lot, serial, carton or order',
      description:
        'The scope is derived through the genealogy and grows with facts (a unit that consumes a held lot later, or whose fact arrives late, joins it). 404 for a subject the MES doesn’t know (a lot not imported from the ERP, a serial or carton genealogy hasn’t seen, an unknown order); 422 for a reason not listed in quality.yaml for an opening. Serializes with order closes on one advisory lock; notifies the ERP (`{holdId}~opened~1`) in the same transaction; audited `hold.open`. ' +
        GUARDS,
      tags: ['quality'],
      params: z.strictObject({}),
      body: holdOpenRequestSchema,
      response: holdSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ body, requestId, request }) => {
      const by = await deps.writer(request);
      const hold = await deps
        .holds()
        .open(
          {
            subject: body.subject,
            reason: body.reason,
            ...(body.comment === undefined ? {} : { comment: body.comment }),
          },
          { by, requestId },
        )
        .catch((error: unknown) => {
          throw problemOf(error);
        });
      return holdDto(hold);
    },
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/quality/holds/:id/comments',
      access: 'quality:hold',
      summary: 'Comments on a quality hold',
      description:
        'Appended to its transitions and audited (`hold.comment`); not notified to the ERP. Names the hold’s `version` (409 urn:shopfloor:hold-stale). ' +
        GUARDS,
      tags: ['quality'],
      params: holdParams,
      body: holdCommentRequestSchema,
      response: holdSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, body, requestId, request }) => {
      const by = await deps.writer(request);
      const hold = await deps
        .holds()
        .comment(params.id, body, { by, requestId })
        .catch((error: unknown) => {
          throw problemOf(error);
        });
      return holdDto(hold);
    },
  );

  for (const decision of ['release', 'reject'] as const) {
    writeRoute(
      api,
      {
        method: 'POST',
        url: `/quality/holds/:id/${decision}`,
        access: 'quality:release',
        summary:
          decision === 'release'
            ? 'Releases an open quality hold (use as is)'
            : 'Rejects an open quality hold',
        description:
          (decision === 'release'
            ? 'open → released: the goods are used as is; the hold no longer blocks a close or its cartons. '
            : 'open → rejected: quality wants the units scrapped or reworked outside the MES; quantities and confirmations don’t change (only machine facts change them), the cartons stay held, a close is no longer blocked by it. ') +
          `Names the hold’s \`version\` (409 urn:shopfloor:hold-stale); 409 urn:shopfloor:hold-decided for a hold released or rejected already; 422 for a reason not listed in quality.yaml for a ${decision}. Notifies the ERP in the same transaction; audited \`hold.${decision}\`. ` +
          GUARDS,
        tags: ['quality'],
        params: holdParams,
        body: holdDecisionRequestSchema,
        response: holdSchema,
        errors: WRITE_ERRORS,
      },
      LIMITS.writeBodyBytes,
      async ({ params, body, requestId, request }) => {
        const by = await deps.writer(request);
        const hold = await deps
          .holds()
          .decide(
            params.id,
            decision,
            {
              version: body.version,
              reason: body.reason,
              ...(body.comment === undefined ? {} : { comment: body.comment }),
            },
            { by, requestId },
          )
          .catch((error: unknown) => {
            throw problemOf(error);
          });
        return holdDto(hold);
      },
    );
  }
}
