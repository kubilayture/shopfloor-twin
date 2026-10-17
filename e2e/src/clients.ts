/**
 * HTTP clients of the stack under test: the simulator's control API (its own schemas here, since
 * apps never share code), the gateway's metrics and the MES's REST API (the shared
 * `@shopfloor/contracts/mes-api` schemas). Every answer is parsed at the boundary.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  alarmDetailSchema,
  alarmHistorySchema,
  alarmKpiListSchema,
  alarmListSchema,
  alarmPointAuditSchema,
  alarmScopesSchema,
  currentShiftSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  equipmentListSchema,
  oeeResultSchema,
  operatorKpiListSchema,
  paretoSchema,
  plantSchema,
  reasonCodesSchema,
  shiftOeeSchema,
  shiftListSchema,
  shiftRecordSchema,
  shiftReportSchema,
  shiftTotalsSchema,
  orderDetailSchema,
  orderExecutionSchema,
  orderListSchema,
  scrapRecordListSchema,
  terminalViewSchema,
} from '@shopfloor/contracts/mes-api';
import {
  confirmationListSchema,
  erpOrderViewSchema,
  orderFeedSchema,
  statusMessageListSchema,
} from '@shopfloor/contracts/erp-api';
import { z } from 'zod';

const stateMs = z.record(z.string(), z.number().int());

/** The ground truth's OEE (sim-summary/2): `oee-core` inputs and result per shift bucket (#117). */
const oeeTruthSchema = z.object({
  machines: z.record(
    z.string(),
    z.object({
      shifts: z.record(
        z.string(),
        z.object({
          inputs: z.object({
            stateMs,
            cycles: z.array(
              z.object({ product: z.string(), result: z.string(), count: z.number().int() }),
            ),
          }),
          result: oeeResultSchema,
        }),
      ),
    }),
  ),
  workCenters: z.record(z.string(), z.object({ shifts: z.record(z.string(), oeeResultSchema) })),
});

const count = z.number().int().min(0);
const operationQuantities = z.object({ in: count, good: count, scrap: count, rework: count });

/**
 * The ground truth's orders (sim-summary/4, control API 1.4, #172): the jobs in acceptance order,
 * per order its quantities per operation, scrap, rework, packed good, WIP and material booked at
 * cycle completion. Empty in schedule mode.
 */
export const ordersTruthSchema = z.object({
  jobs: z.array(
    z.object({
      commandId: z.string(),
      orderId: z.string(),
      machine: z.string(),
      product: z.string(),
      quantity: count,
      acceptedAt: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
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
      lastTerminalAt: z.string().nullable(),
      completedAt: z.string().nullable(),
      operations: z.record(z.string(), operationQuantities),
      material: z.record(z.string(), count),
      materialInProcess: z.record(z.string(), count),
    }),
  ),
  units: z.object({ count, sha256: z.string() }),
});
export type OrdersTruth = z.infer<typeof ordersTruthSchema>;

/** `GET /api/v1/ground-truth` of the simulator (docs/contracts/simulator-control-api.md). */
export const groundTruthSchema = z.object({
  epoch: z.number().int(),
  start: z.string(),
  simTime: z.string(),
  pacedTime: z.string(),
  currentBucket: z.string(),
  buckets: z.record(z.string(), z.object({ complete: z.boolean() })),
  current: z.record(z.string(), z.object({ state: z.string(), since: z.string() })),
  machines: z.record(z.string(), z.object({ stateMs, byShift: z.record(z.string(), stateMs) })),
  oee: oeeTruthSchema,
  /** The alarm KPIs per scope (sim-summary/3, control API 1.3, #140), as JSON to compare. */
  alarms: z.object({
    /** Every occurrence in raise order (#140): the raises the live alarm list is judged by (#147). */
    occurrences: z.array(
      z.object({
        equipment: z.string(),
        code: z.string(),
        raisedAt: z.string(),
        clearedAt: z.string().nullable(),
        endReason: z.string().nullable(),
      }),
    ),
    scopes: z.record(
      z.string(),
      z.object({
        shifts: z.record(z.string(), z.record(z.string(), z.unknown())),
        /** Per UTC hour where something happened (#140). */
        hours: z.record(z.string(), z.record(z.string(), z.unknown())),
        /** Every flood episode of the scope so far (#140): the flood banner's truth (#147). */
        floods: z.array(
          z.object({ id: z.string(), startAt: z.string(), endAt: z.string().nullable() }),
        ),
      }),
    ),
  }),
  orders: ordersTruthSchema,
});
export type GroundTruth = z.infer<typeof groundTruthSchema>;

/** A failure injection (control API 1.3, #140): `POST /faults/failure/{machine}`. */
export const injectionSchema = z.object({
  id: z.number().int(),
  machine: z.string(),
  code: z.string(),
  at: z.string(),
  repairMs: z.number().int().optional(),
  status: z.enum(['scheduled', 'held', 'applied']),
  heldAt: z.string().optional(),
  appliedAt: z.string().optional(),
});
export type Injection = z.infer<typeof injectionSchema>;

/** One injection of a golden scenario's `scenario.json` (`injections`). */
export interface ScenarioInjection {
  readonly at: string;
  readonly machine: string;
  readonly code: string;
  readonly repairMs?: number;
}

export const statusSchema = z.object({
  state: z.enum(['idle', 'running', 'paused', 'finished']),
  speed: z.number(),
  simTime: z.string(),
  lagMs: z.number(),
  events: z.number(),
});
export type Status = z.infer<typeof statusSchema>;

async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url}: ${String(response.status)} ${text}`);
  }
  return schema.parse(JSON.parse(text));
}

export class SimulatorClient {
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  status(): Promise<Status> {
    return request(`${this.base}/api/v1/status`, statusSchema);
  }

  groundTruth(): Promise<GroundTruth> {
    return request(`${this.base}/api/v1/ground-truth`, groundTruthSchema);
  }

  resume(): Promise<Status> {
    return request(`${this.base}/api/v1/resume`, statusSchema, { method: 'POST' });
  }

  pause(): Promise<Status> {
    return request(`${this.base}/api/v1/pause`, statusSchema, { method: 'POST' });
  }

  /** Schedules a failure injection at simulation time `at` (control API 1.3, #140). */
  inject({ machine, code, at, repairMs }: ScenarioInjection): Promise<Injection> {
    return request(
      `${this.base}/api/v1/faults/failure/${encodeURIComponent(machine)}`,
      z.object({ injection: injectionSchema }),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, at, ...(repairMs === undefined ? {} : { repairMs }) }),
      },
    ).then(({ injection }) => injection);
  }

  /** Processes exactly one simulation event while paused (control API 1.1); false at the end. */
  async step(): Promise<boolean> {
    const { stepped } = await request(
      `${this.base}/api/v1/step`,
      z.object({ stepped: z.boolean() }),
      { method: 'POST' },
    );
    return stepped;
  }

  async injections(): Promise<Injection[]> {
    const { injections } = await request(
      `${this.base}/api/v1/faults/injections`,
      z.object({ injections: z.array(injectionSchema) }),
    );
    return injections;
  }
}

export class MesClient {
  readonly base: string;
  /** The session cookie (`sft_session=…`) every API request sends (#170: MES_AUTH=on). */
  readonly cookie: string | undefined;

  constructor(base: string, cookie?: string) {
    this.base = base;
    this.cookie = cookie;
  }

  /** The same MES with this session. */
  withCookie(cookie: string): MesClient {
    return new MesClient(this.base, cookie);
  }

  #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return request(`${this.base}${path}`, schema, {
      headers: this.cookie === undefined ? {} : { cookie: this.cookie },
    });
  }

  async ready(): Promise<boolean> {
    const response = await fetch(`${this.base}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    return response?.ok ?? false;
  }

  equipment() {
    return this.#get(`/api/v1/equipment`, equipmentListSchema);
  }

  plant() {
    return this.#get(`/api/v1/plant`, plantSchema);
  }

  /** `shiftKey` as the ground truth keys it: `2026-10-12/A`. */
  shiftTotals(shiftKey: string) {
    return this.#get(`/api/v1/shifts/${shiftKey}/totals`, shiftTotalsSchema);
  }

  /** OEE of one shift for every machine and work center (#120). */
  shiftOee(shiftKey: string) {
    return this.#get(`/api/v1/shifts/${shiftKey}/oee`, shiftOeeSchema);
  }

  /** Alarm KPIs of the plant or a position per shift bucket over [from, to) (#142). */
  alarmShifts(scope: 'plant' | 'position', id: string, from: number, to: number) {
    const query = new URLSearchParams({
      scope,
      ...(scope === 'plant' ? {} : { id }),
      bucket: 'shift',
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    return this.#get(`/api/v1/alarms/kpi?${query.toString()}`, alarmKpiListSchema);
  }

  /** Alarm KPIs of a scope per hour or shift bucket over [from, to), as raw text (#147). */
  alarmKpiText(
    scope: 'plant' | 'position',
    id: string,
    bucket: 'hour' | 'shift',
    from: number | string,
    to: number | string,
  ): Promise<string> {
    const query = new URLSearchParams({
      scope,
      ...(scope === 'plant' ? {} : { id }),
      bucket,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    return this.text(`/api/v1/alarms/kpi?${query.toString()}`);
  }

  /** MES-only operator measures of a scope (#143): acknowledgements, time to acknowledge. */
  operatorKpi(
    scope: 'plant' | 'position',
    id: string,
    bucket: 'hour' | 'shift' | 'range',
    from: number | string,
    to: number | string,
  ) {
    const query = new URLSearchParams({
      scope,
      ...(scope === 'plant' ? {} : { id }),
      bucket,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    return this.#get(`/api/v1/alarms/operator-kpi?${query.toString()}`, operatorKpiListSchema);
  }

  /** One view of the alarm list (#142): newest raise first, up to `limit`. */
  alarms(view: 'active' | 'acknowledged' | 'shelved' | 'history', from?: string, to?: string) {
    const query = new URLSearchParams({
      view,
      limit: '500',
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    return this.#get(`/api/v1/alarms?${query.toString()}`, alarmListSchema);
  }

  /** The plant and the operator positions with their equipment (#142). */
  alarmScopes() {
    return this.#get(`/api/v1/alarms/scopes`, alarmScopesSchema);
  }

  alarm(id: string) {
    return this.#get(`/api/v1/alarms/${encodeURIComponent(id)}`, alarmDetailSchema);
  }

  alarmHistory(id: string) {
    return this.#get(`/api/v1/alarms/${encodeURIComponent(id)}/history`, alarmHistorySchema);
  }

  pointAudit(equipment: string, code: string) {
    return this.#get(
      `/api/v1/alarm-points/${encodeURIComponent(equipment)}/${encodeURIComponent(code)}/audit`,
      alarmPointAuditSchema,
    );
  }

  /** The stored shift instance (#144) and the calendar's shifts over a range. */
  shiftRecord(shiftKey: string) {
    return this.#get(`/api/v1/shifts/${shiftKey}`, shiftRecordSchema);
  }

  shifts(from: number, to: number) {
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    return this.#get(`/api/v1/shifts?${query.toString()}`, shiftListSchema);
  }

  /** The shift report (#144): parsed, and as raw text for byte-for-byte comparisons. */
  shiftReport(shiftKey: string) {
    return this.#get(`/api/v1/shifts/${shiftKey}/report`, shiftReportSchema);
  }

  shiftReportText(shiftKey: string): Promise<string> {
    return this.text(`/api/v1/shifts/${shiftKey}/report`);
  }

  /** A GET answer as raw text (`path` from `/api/v1`), for byte-for-byte comparisons. */
  async text(path: string): Promise<string> {
    const url = `${this.base}${path}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: this.cookie === undefined ? {} : { cookie: this.cookie },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${text}`);
    return text;
  }

  /** The same answer as raw text, for a byte-for-byte comparison (#123). */
  async shiftOeeText(shiftKey: string): Promise<string> {
    const url = `${this.base}/api/v1/shifts/${shiftKey}/oee`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: this.cookie === undefined ? {} : { cookie: this.cookie },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${text}`);
    return text;
  }

  currentShift() {
    return this.#get(`/api/v1/shifts/current`, currentShiftSchema);
  }

  reasonCodes() {
    return this.#get(`/api/v1/reason-codes`, reasonCodesSchema);
  }

  downtime(from: string, to: string) {
    const query = new URLSearchParams({ from, to });
    return this.#get(`/api/v1/downtime?${query.toString()}`, downtimeListSchema);
  }

  pareto(scope: 'equipment' | 'work-center', id: string, from: string, to: string) {
    const query = new URLSearchParams({ scope, id, from, to });
    return this.#get(`/api/v1/downtime/pareto?${query.toString()}`, paretoSchema);
  }

  audit(id: string) {
    return this.#get(`/api/v1/downtime/${encodeURIComponent(id)}/audit`, downtimeAuditSchema);
  }

  // Orders, execution and the terminal (#174–#177).

  orders() {
    return this.#get(`/api/v1/orders`, orderListSchema);
  }

  order(id: string) {
    return this.#get(`/api/v1/orders/${encodeURIComponent(id)}`, orderDetailSchema);
  }

  orderExecution(id: string) {
    return this.#get(`/api/v1/orders/${encodeURIComponent(id)}/execution`, orderExecutionSchema);
  }

  scrapRecords(orderId: string) {
    const query = new URLSearchParams({ orderId });
    return this.#get(`/api/v1/scrap-records?${query.toString()}`, scrapRecordListSchema);
  }

  terminal(workCenter: string) {
    return this.#get(`/api/v1/terminal/${encodeURIComponent(workCenter)}`, terminalViewSchema);
  }
}

/** The ERP mock's REST API (ADR-0028) with the run's bearer token (never logged). */
export class ErpClient {
  readonly base: string;
  readonly #token: string;

  constructor(base: string, token: string) {
    this.base = base;
    this.#token = token;
  }

  #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return request(`${this.base}${path}`, schema, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
  }

  /** The order change feed from its start (every order version the ERP holds). */
  feed() {
    return this.#get(`/api/v1/orders?after=0&limit=500`, orderFeedSchema);
  }

  order(orderNumber: string) {
    return this.#get(`/api/v1/orders/${encodeURIComponent(orderNumber)}`, erpOrderViewSchema);
  }

  /** The confirmations received, of one order or of all. */
  confirmations(orderNumber?: string) {
    const query =
      orderNumber === undefined ? '' : `?orderNumber=${encodeURIComponent(orderNumber)}`;
    return this.#get(`/api/v1/confirmations${query}`, confirmationListSchema);
  }

  /** The status messages received, of one order or of all. */
  statusMessages(orderNumber?: string) {
    const query =
      orderNumber === undefined ? '' : `?orderNumber=${encodeURIComponent(orderNumber)}`;
    return this.#get(`/api/v1/order-status${query}`, statusMessageListSchema);
  }
}

/**
 * One HTTP request with exactly these headers (fetch adds or drops some, such as `Origin`):
 * resolves with the status and body. Each on a connection of its own (`agent: false`) and with the
 * body's Content-Length: Node frames no body of a DELETE by itself, so on a kept-alive connection
 * the server would read it as the start of the next request (#178).
 */
export function rawRequest(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
): Promise<{ status: number; text: string; setCookie: readonly string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(url),
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
        timeout: 5_000,
        agent: false,
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            text,
            setCookie: response.headers['set-cookie'] ?? [],
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${url}: timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

// Identity (#170): logins and user administration through the MES API, as a browser page of the
// MES's own origin would send them (ADR-0023 guards: Origin, JSON).

/** A JSON write to the MES with its own origin and, if given, the session cookie. */
export async function mesWrite(
  base: string,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; text: string; setCookie: readonly string[] }> {
  return rawRequest(
    method,
    `${base}${path}`,
    {
      origin: new URL(base).origin,
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    JSON.stringify(body),
  );
}

/** Logs in; resolves with the session cookie and whether the password must change first. */
export async function mesLogin(
  base: string,
  username: string,
  password: string,
  kind?: 'desk' | 'terminal',
): Promise<{ cookie: string; mustChangePassword: boolean }> {
  const answer = await mesWrite(base, 'POST', '/api/v1/session', {
    username,
    password,
    ...(kind === undefined ? {} : { kind }),
  });
  if (answer.status !== 200) {
    throw new Error(`login as ${username}: ${String(answer.status)} ${answer.text}`);
  }
  const cookie = answer.setCookie.map((c) => c.split(';')[0] ?? '').find((c) => c.includes('='));
  if (cookie === undefined) throw new Error(`login as ${username} set no cookie`);
  const session = z
    .object({ user: z.object({ mustChangePassword: z.boolean() }) })
    .parse(JSON.parse(answer.text));
  return { cookie, mustChangePassword: session.user.mustChangePassword };
}

/** A random password for a generated test user (never written anywhere). */
export const generatedPassword = (): string => randomBytes(18).toString('base64url');

/**
 * Users for a test run (#170), made through the API with the bootstrap admin: it logs in with its
 * temporary password, changes it, creates each user with a temporary password, and each user logs
 * in and changes its own. Resolves with every user's final password and a logged-in cookie.
 */
export async function provisionUsers(
  base: string,
  bootstrapPassword: string,
  users: readonly { readonly username: string; readonly roles: readonly string[] }[],
): Promise<Map<string, { password: string; cookie: string }>> {
  const done = new Map<string, { password: string; cookie: string }>();
  const own = async (username: string, temporary: string) => {
    const first = await mesLogin(base, username, temporary);
    if (!first.mustChangePassword) throw new Error(`${username}: password not temporary`);
    const password = generatedPassword();
    const changed = await mesWrite(
      base,
      'POST',
      '/api/v1/account/password',
      { currentPassword: temporary, newPassword: password },
      first.cookie,
    );
    if (changed.status !== 200) {
      throw new Error(`${username}: password change ${String(changed.status)} ${changed.text}`);
    }
    const login = await mesLogin(base, username, password);
    done.set(username, { password, cookie: login.cookie });
    return login.cookie;
  };
  const admin = await own('admin', bootstrapPassword);
  for (const user of users) {
    const temporary = generatedPassword();
    const created = await mesWrite(
      base,
      'POST',
      '/api/v1/users',
      { username: user.username, roles: user.roles, password: temporary },
      admin,
    );
    if (created.status !== 200) {
      throw new Error(`create ${user.username}: ${String(created.status)} ${created.text}`);
    }
    await own(user.username, temporary);
  }
  return done;
}

/** One gauge per label value from a Prometheus text exposition, e.g. per `machine`. */
export function gauge(text: string, name: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const match = /^([a-z_]+)(?:\{[a-z_]+="([^"]*)"\})? (\S+)$/.exec(line);
    if (match?.[1] !== name) continue;
    values.set(match[2] ?? '', Number(match[3]));
  }
  return values;
}

export class GatewayClient {
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async ready(): Promise<boolean> {
    const response = await fetch(`${this.base}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    return response?.ok ?? false;
  }

  async metrics(): Promise<string> {
    const response = await fetch(`${this.base}/metrics`, { signal: AbortSignal.timeout(5_000) });
    return response.text();
  }
}
