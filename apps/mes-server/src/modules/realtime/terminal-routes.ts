import {
  MES_API_LIMITS as LIMITS,
  PROBLEM_TYPES,
  crewResultSchema,
  operationResultSchema,
  operationWriteRequestSchema,
  pauseRequestSchema,
  terminalEmptyRequestSchema,
  terminalViewSchema,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../identity/index.ts';
import type { EquipmentInfo } from '../master-data/index.ts';
import { OrderError, type OperationRecord, type Orders } from '../orders/index.ts';
import { ShiftError, type Shifts } from '../shifts/index.ts';
import { orderParams } from './order-routes.ts';
import { HttpProblem, getRoute, writeRoute, type ErrorStatus } from './routes.ts';
import { crewDto } from './shift-dto.ts';
import { operationDto, terminalView, type TerminalViewSources } from './terminal-view.ts';

/** What the terminal routes use of the modules (#177). */
export interface TerminalApi extends TerminalViewSources {
  readonly orders: TerminalViewSources['orders'] &
    Pick<Orders, 'startWork' | 'pauseWork' | 'resumeWork' | 'signOff' | 'endActivities'>;
  readonly shifts: NonNullable<TerminalViewSources['shifts']> & Pick<Shifts, 'signOn' | 'signOff'>;
  /** Master data's machines by id. */
  readonly catalog: ReadonlyMap<string, EquipmentInfo>;
}

const STATUS = { 'not-found': 404, conflict: 409, invalid: 422 } as const;
const WRITE_ERRORS: readonly ErrorStatus[] = [400, 403, 404, 405, 409, 413, 415, 422, 429, 503];
const GUARDS =
  'Writes need an Origin of this host (or allowlisted), `Sec-Fetch-Site: same-origin` when sent, and application/json (ADR-0023).';

export const workCenterParams = z.strictObject({
  workCenter: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
    .describe('A work center of master data'),
});
const operationParams = workCenterParams.extend({
  id: orderParams.shape.id,
  operation: z
    .string()
    .regex(/^OP[0-9]{2}$/)
    .describe('A routing operation of the order at this work center'),
});

/** The work centers of master data, from its machines. */
export function workCentersOf(
  catalog: ReadonlyMap<string, EquipmentInfo>,
): Map<string, { id: string; name: string; equipment: string[] }> {
  const centers = new Map<string, { id: string; name: string; equipment: string[] }>();
  for (const machine of [...catalog.values()].sort((a, b) => a.position - b.position)) {
    const found = centers.get(machine.workCenter.id) ?? {
      id: machine.workCenter.id,
      name: machine.workCenter.name,
      equipment: [],
    };
    found.equipment.push(machine.id);
    centers.set(found.id, found);
  }
  return centers;
}

const mapped = (error: unknown): never => {
  if (error instanceof OrderError || error instanceof ShiftError) {
    throw new HttpProblem(STATUS[error.kind], error.message, error.type);
  }
  throw error;
};

/**
 * The operator terminal (#177, plan "Operator terminal"): the view of a work center, sign-on and
 * sign-off (the crew), and an operator's start, pause, resume and sign-off of an order operation.
 * Every write needs `terminal:operate`; sign-on needs a `terminal` session, and the operation
 * writes an operator signed on at the operation's work center with the very session that writes.
 * Scrap coding at the terminal is `PUT /scrap-records/{id}/coding` (#175).
 */
export function terminalRoutes(
  api: FastifyInstance,
  deps: {
    readonly terminal: () => TerminalApi;
    /** The session's principal; 401 without one. */
    readonly principal: (request: FastifyRequest) => Principal;
  },
): void {
  const center = (sources: TerminalApi, id: string) => {
    const found = workCentersOf(sources.catalog).get(id);
    if (!found) throw new HttpProblem(404, `no work center ${id}`);
    return found;
  };
  const view = (sources: TerminalApi, id: string): Promise<TerminalViewDto> =>
    terminalView(sources, center(sources, id), sources.catalog);

  getRoute(
    api,
    {
      url: '/terminal/:workCenter',
      summary: "A work center's terminal view",
      description:
        'Per machine its state and current job; the active orders with, per operation at this work center, in, good, scrap and rework, completion, sign-off and who works on it, and their WIP here; the queue of released and dispatched orders; the uncoded scrap records of its operations; who is signed on. The push topic `terminal:<workCenter>` carries the same.',
      tags: ['terminal'],
      params: workCenterParams,
      query: z.strictObject({}),
      response: terminalViewSchema,
      errors: [400, 404, 503],
    },
    async ({ params }) => view(deps.terminal(), params.workCenter),
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/terminal/:workCenter/sign-on',
      access: 'terminal:operate',
      summary: 'Signs the operator on at the work center (a crew row)',
      description: `Needs a \`terminal\` session (409 urn:shopfloor:terminal-session-required) and a shift the plant clock is in (409 urn:shopfloor:no-shift). The same session again answers the open row; a row of another session of the same user here ends (\`replaced\`). Audited. ${GUARDS}`,
      tags: ['terminal'],
      params: workCenterParams,
      body: terminalEmptyRequestSchema,
      response: crewResultSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, request, requestId }) => {
      const sources = deps.terminal();
      center(sources, params.workCenter);
      const principal = deps.principal(request);
      if (principal.session.kind !== 'terminal') {
        throw new HttpProblem(
          409,
          'sign on at a terminal: log in with a terminal session (kind terminal)',
          PROBLEM_TYPES.terminalSessionRequired,
        );
      }
      const crew = await sources.shifts
        .signOn(params.workCenter, principal, principal.session.id, requestId)
        .catch(mapped);
      return { crew: crewDto(crew) };
    },
  );

  writeRoute(
    api,
    {
      method: 'POST',
      url: '/terminal/:workCenter/sign-off',
      access: 'terminal:operate',
      summary: 'Signs the operator off at the work center',
      description: `Ends the operator's crew row here (409 urn:shopfloor:not-signed-on without one) and their open activity intervals on its operations. The web then ends the session. Audited. ${GUARDS}`,
      tags: ['terminal'],
      params: workCenterParams,
      body: terminalEmptyRequestSchema,
      response: crewResultSchema,
      errors: WRITE_ERRORS,
    },
    LIMITS.writeBodyBytes,
    async ({ params, request, requestId }) => {
      const sources = deps.terminal();
      center(sources, params.workCenter);
      const principal = deps.principal(request);
      const crew = await sources.shifts
        .signOff(params.workCenter, principal, requestId)
        .catch(mapped);
      await sources.orders.endActivities({
        userId: principal.userId,
        workCenter: params.workCenter,
      });
      return { crew: crewDto(crew) };
    },
  );

  /** The operator signed on here with this session, and the operation at this work center. */
  const checked = async (
    sources: TerminalApi,
    request: FastifyRequest,
    params: z.output<typeof operationParams>,
  ): Promise<Principal> => {
    center(sources, params.workCenter);
    const principal = deps.principal(request);
    const crew = await sources.shifts.crew({
      userId: principal.userId,
      workCenter: params.workCenter,
      open: true,
    });
    if (!crew.some((row) => row.sessionId === principal.session.id)) {
      throw new HttpProblem(
        409,
        `${principal.username} is not signed on at ${params.workCenter} with this session`,
        PROBLEM_TYPES.notSignedOn,
      );
    }
    const [operation] = await sources.orders.operations({
      orderIds: [params.id],
      operation: params.operation,
    });
    if (operation?.workCenter !== params.workCenter) {
      throw new HttpProblem(
        404,
        `order ${params.id} has no operation ${params.operation} at ${params.workCenter}`,
      );
    }
    return principal;
  };

  const actions = [
    {
      path: 'start',
      summary: "Starts the operator's work on an order operation",
      description:
        "Opens a work interval of the operator on it (409 urn:shopfloor:operation-state while one of theirs is open). Records the operator's time; the machine runs its queue regardless.",
      body: operationWriteRequestSchema,
      run: (o: TerminalApi['orders'], p: OpParams, b: Body, c: Context) =>
        o.startWork(p.id, p.operation, b, c),
    },
    {
      path: 'pause',
      summary: "Pauses the operator's work on an order operation, with a reason",
      description:
        'Closes their work interval and opens a pause with the reason (409 urn:shopfloor:operation-state when they are not working on it).',
      body: pauseRequestSchema,
      run: (o: TerminalApi['orders'], p: OpParams, b: Body, c: Context) =>
        o.pauseWork(p.id, p.operation, { ...b, reason: b.reason ?? 'other' }, c),
    },
    {
      path: 'resume',
      summary: "Resumes the operator's paused work on an order operation",
      description:
        'Closes their pause and opens a work interval (409 urn:shopfloor:operation-state when they have not paused it).',
      body: operationWriteRequestSchema,
      run: (o: TerminalApi['orders'], p: OpParams, b: Body, c: Context) =>
        o.resumeWork(p.id, p.operation, b, c),
    },
    {
      path: 'sign-off',
      summary: 'Signs an order operation off',
      description:
        'Allowed once the MES has it complete (its final confirmation is written) and not signed off yet (409 urn:shopfloor:operation-state otherwise); closes every open interval on it. A close of the order needs every operation signed off.',
      body: operationWriteRequestSchema,
      run: (o: TerminalApi['orders'], p: OpParams, b: Body, c: Context) =>
        o.signOff(p.id, p.operation, b, c),
    },
  ] as const;

  for (const action of actions) {
    writeRoute(
      api,
      {
        method: 'POST',
        url: `/terminal/:workCenter/orders/:id/operations/:operation/${action.path}`,
        access: 'terminal:operate',
        summary: action.summary,
        description: `${action.description} Needs the operator signed on at the work center with this session (409 urn:shopfloor:not-signed-on); names the operation's \`version\` (409 urn:shopfloor:operation-stale); the order dispatched, in progress or completed (409 urn:shopfloor:operation-state). Audited. ${GUARDS}`,
        tags: ['terminal'],
        params: operationParams,
        body: action.body,
        response: operationResultSchema,
        errors: WRITE_ERRORS,
      },
      LIMITS.writeBodyBytes,
      async ({ params, body, request, requestId }) => {
        const sources = deps.terminal();
        const principal = await checked(sources, request, params);
        const operation: OperationRecord = await action
          .run(sources.orders, params, body as Body, {
            by: { userId: principal.userId, username: principal.username, roles: principal.roles },
            requestId,
          })
          .catch(mapped);
        return { operation: operationDto(operation) };
      },
    );
  }
}

type OpParams = z.output<typeof operationParams>;
interface Body {
  readonly version: number;
  readonly reason?: z.output<typeof pauseRequestSchema>['reason'];
  readonly comment?: string | undefined;
}
type Context = Parameters<Orders['startWork']>[3];
