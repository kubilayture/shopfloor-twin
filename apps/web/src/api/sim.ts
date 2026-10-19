import { z } from 'zod';

// The simulation console's client (#237, Phase 9 plan "Simulation console", ADR-0037): the
// simulator's control API (docs/contracts/simulator-control-api.md, 1.11) through nginx's
// allowlisting `/sim/` proxy. nginx checks the session's `sim:control` with the MES and adds the
// control token itself: this page never holds it. Only the allowlisted routes exist here; the
// ground truth and the recorded run are not reachable from the browser (404).

export const SIM_BASE = '/sim/api/v1';
/** The plant event stream (WebSocket), same origin: `ws(s)://<host>/sim/api/v1/events`. */
export const SIM_EVENTS_PATH = `${SIM_BASE}/events`;

/** A refused console request: the control API's `{ error, message }`, or nginx's status alone. */
export class SimError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SimError';
    this.status = status;
  }
}

/** What each status nginx answers by itself means on this page. */
const NGINX_TEXT: Readonly<Record<number, string>> = {
  401: 'Your session ended: log in again',
  403: 'Not allowed: the console needs the admin role (sim:control), from this page',
  404: 'Not a console route',
  413: 'The request is too large',
  500: 'The MES could not check the permission; try again',
  502: 'The simulator cannot be reached',
  503: 'The simulator is starting',
  504: 'The simulator did not answer in time',
};

const errorBody = z.object({ error: z.string(), message: z.string() });

async function request<S extends z.ZodType>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  schema: S,
  body?: unknown,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${SIM_BASE}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      mode: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SimError('The console cannot be reached', 0);
  }
  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = undefined;
  }
  if (!response.ok) {
    const known = errorBody.safeParse(parsedBody);
    throw new SimError(
      known.success
        ? known.data.message
        : (NGINX_TEXT[response.status] ?? `HTTP ${String(response.status)}`),
      response.status,
    );
  }
  const parsed = schema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new SimError(`Unexpected answer from ${path}: ${parsed.error.message}`, response.status);
  }
  return parsed.data;
}

export const PACER_STATES = ['idle', 'running', 'paused', 'finished'] as const;
export type PacerState = (typeof PACER_STATES)[number];

export const simStatusSchema = z.object({
  state: z.enum(PACER_STATES),
  speed: z.number(),
  simTime: z.string(),
  lagMs: z.number(),
  events: z.number(),
});
export type SimStatus = z.infer<typeof simStatusSchema>;

/** The control API's speed range (control API "REST"). */
export const SPEED_RANGE = { min: 0.5, max: 60 } as const;

const injectionSchema = z.object({
  id: z.number(),
  machine: z.string(),
  code: z.string(),
  at: z.string(),
  status: z.string(),
  repairMs: z.number().optional(),
  heldAt: z.string().optional(),
  appliedAt: z.string().optional(),
});
export type SimInjection = z.infer<typeof injectionSchema>;

const driftSchema = z.object({
  id: z.number(),
  machine: z.string(),
  shift: z.number(),
  at: z.string(),
  until: z.string(),
  status: z.string(),
  appliedAt: z.string().optional(),
  endedAt: z.string().optional(),
  endedBy: z.string().optional(),
});
export type SimDrift = z.infer<typeof driftSchema>;

const lotSchema = z.object({
  lot: z.string(),
  material: z.string(),
  remaining: z.number(),
  blocked: z.boolean(),
});
export type SimLot = z.infer<typeof lotSchema>;

const absenceSchema = z.object({
  id: z.number(),
  kind: z.literal('operators-absent'),
  shift: z.string(),
  start: z.string(),
  operators: z.array(z.string()),
  status: z.string(),
  appliedAt: z.string().optional(),
});

const operatorSchema = z.object({
  id: z.string(),
  shift: z.string(),
  skills: z.array(z.string()),
  speedFactor: z.number(),
  status: z.enum(['present', 'absent', 'off-shift']),
  station: z.string().nullable(),
  forced: z.boolean(),
});
export type SimOperator = z.infer<typeof operatorSchema>;

export const operatorsViewSchema = z.object({
  currentShift: z.string().nullable(),
  operators: z.array(operatorSchema),
  absences: z.array(absenceSchema),
});
export type OperatorsView = z.infer<typeof operatorsViewSchema>;

/** A console action (control API 1.7): lot block or release, tool breakage, forced absence. */
const actionSchema = z.union([
  z.object({
    id: z.number(),
    kind: z.enum(['lot-block', 'lot-release']),
    lot: z.string(),
    material: z.string(),
    at: z.string(),
    status: z.string(),
    appliedAt: z.string().optional(),
  }),
  z.object({
    id: z.number(),
    kind: z.literal('tool-breakage'),
    machine: z.string(),
    at: z.string(),
    status: z.string(),
    appliedAt: z.string().optional(),
    cycles: z.number().optional(),
  }),
  absenceSchema,
]);
export type SimAction = z.infer<typeof actionSchema>;

const scenarioEntrySchema = z.object({
  entry: z.string(),
  action: z.string(),
  at: z.string().optional(),
  status: z.string(),
  id: z.number().optional(),
});

const scenarioSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable().optional(),
  entries: z.array(scenarioEntrySchema),
});
export type SimScenario = z.infer<typeof scenarioSchema>;

const scenarioListSchema = z.object({
  scenarios: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
});
export type ScenarioList = z.infer<typeof scenarioListSchema>;

// Reads.

export const getStatus = (signal?: AbortSignal) =>
  request('GET', '/status', simStatusSchema, undefined, signal);
export const getInjections = (signal?: AbortSignal) =>
  request(
    'GET',
    '/faults/injections',
    z.object({ injections: z.array(injectionSchema) }),
    undefined,
    signal,
  );
export const getDrifts = (signal?: AbortSignal) =>
  request('GET', '/faults/drifts', z.object({ drifts: z.array(driftSchema) }), undefined, signal);
export const getLots = (signal?: AbortSignal) =>
  request('GET', '/lots', z.object({ lots: z.array(lotSchema) }), undefined, signal);
export const getOperators = (signal?: AbortSignal) =>
  request('GET', '/operators', operatorsViewSchema, undefined, signal);
export const getActions = (signal?: AbortSignal) =>
  request('GET', '/actions', z.object({ actions: z.array(actionSchema) }), undefined, signal);
export const getScenarios = (signal?: AbortSignal) =>
  request('GET', '/scenarios', scenarioListSchema, undefined, signal);
export const getScenario = (signal?: AbortSignal) =>
  request('GET', '/scenario', z.object({ scenario: scenarioSchema.nullable() }), undefined, signal);

// Writes: each is a console action, so each counts as use of the session (#237).

export const pause = () => request('POST', '/pause', simStatusSchema);
export const resume = () => request('POST', '/resume', simStatusSchema);
export const step = () =>
  request('POST', '/step', z.object({ stepped: z.boolean(), status: simStatusSchema }));
export const setSpeed = (speed: number) => request('PUT', '/speed', simStatusSchema, { speed });

export const injectFailure = (
  machine: string,
  body: { code: string; at?: string; repairMs?: number },
) =>
  request(
    'POST',
    `/faults/failure/${encodeURIComponent(machine)}`,
    z.object({ injection: injectionSchema }),
    body,
  );
export const injectDrift = (machine: string, body: { shift: number; until: string; at?: string }) =>
  request(
    'POST',
    `/faults/drift/${encodeURIComponent(machine)}`,
    z.object({ drift: driftSchema }),
    body,
  );
export const setOpcuaOffline = (machine: string, offline: boolean) =>
  request(
    'POST',
    `/faults/opcua/${encodeURIComponent(machine)}`,
    z.object({ offline: z.boolean() }),
    { offline },
  );
export const setModbusSilent = (silent: boolean) =>
  request('POST', '/faults/modbus', z.object({ silent: z.boolean() }), { silent });
export const breakTool = (machine: string) =>
  request(
    'POST',
    `/faults/tool/${encodeURIComponent(machine)}`,
    z.object({ action: actionSchema }),
    {},
  );
export const setLotBlocked = (lot: string, blocked: boolean) =>
  request(
    'POST',
    `/lots/${encodeURIComponent(lot)}/${blocked ? 'block' : 'release'}`,
    z.object({ action: actionSchema }),
    {},
  );
export const markAbsent = (shift: string, operators: readonly string[]) =>
  request('POST', '/operators/absent', z.object({ action: actionSchema }), {
    shift,
    operators,
  });
export const loadScenario = (name: string) =>
  request('POST', '/scenario', z.object({ scenario: scenarioSchema }), { name });
