/**
 * HTTP clients of the stack under test: the simulator's control API (its own schemas here, since
 * apps never share code), the gateway's metrics and the MES's REST API (the shared
 * `@shopfloor/contracts/mes-api` schemas). Every answer is parsed at the boundary.
 */
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
} from '@shopfloor/contracts/mes-api';
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

  constructor(base: string) {
    this.base = base;
  }

  async ready(): Promise<boolean> {
    const response = await fetch(`${this.base}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
    return response?.ok ?? false;
  }

  equipment() {
    return request(`${this.base}/api/v1/equipment`, equipmentListSchema);
  }

  plant() {
    return request(`${this.base}/api/v1/plant`, plantSchema);
  }

  /** `shiftKey` as the ground truth keys it: `2026-10-12/A`. */
  shiftTotals(shiftKey: string) {
    return request(`${this.base}/api/v1/shifts/${shiftKey}/totals`, shiftTotalsSchema);
  }

  /** OEE of one shift for every machine and work center (#120). */
  shiftOee(shiftKey: string) {
    return request(`${this.base}/api/v1/shifts/${shiftKey}/oee`, shiftOeeSchema);
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
    return request(`${this.base}/api/v1/alarms/kpi?${query.toString()}`, alarmKpiListSchema);
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
    return request(
      `${this.base}/api/v1/alarms/operator-kpi?${query.toString()}`,
      operatorKpiListSchema,
    );
  }

  /** One view of the alarm list (#142): newest raise first, up to `limit`. */
  alarms(view: 'active' | 'acknowledged' | 'shelved' | 'history', from?: string, to?: string) {
    const query = new URLSearchParams({
      view,
      limit: '500',
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    return request(`${this.base}/api/v1/alarms?${query.toString()}`, alarmListSchema);
  }

  /** The plant and the operator positions with their equipment (#142). */
  alarmScopes() {
    return request(`${this.base}/api/v1/alarms/scopes`, alarmScopesSchema);
  }

  alarm(id: string) {
    return request(`${this.base}/api/v1/alarms/${encodeURIComponent(id)}`, alarmDetailSchema);
  }

  alarmHistory(id: string) {
    return request(
      `${this.base}/api/v1/alarms/${encodeURIComponent(id)}/history`,
      alarmHistorySchema,
    );
  }

  pointAudit(equipment: string, code: string) {
    return request(
      `${this.base}/api/v1/alarm-points/${encodeURIComponent(equipment)}/${encodeURIComponent(code)}/audit`,
      alarmPointAuditSchema,
    );
  }

  /** The stored shift instance (#144) and the calendar's shifts over a range. */
  shiftRecord(shiftKey: string) {
    return request(`${this.base}/api/v1/shifts/${shiftKey}`, shiftRecordSchema);
  }

  shifts(from: number, to: number) {
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    return request(`${this.base}/api/v1/shifts?${query.toString()}`, shiftListSchema);
  }

  /** The shift report (#144): parsed, and as raw text for byte-for-byte comparisons. */
  shiftReport(shiftKey: string) {
    return request(`${this.base}/api/v1/shifts/${shiftKey}/report`, shiftReportSchema);
  }

  shiftReportText(shiftKey: string): Promise<string> {
    return this.text(`/api/v1/shifts/${shiftKey}/report`);
  }

  /** A GET answer as raw text (`path` from `/api/v1`), for byte-for-byte comparisons. */
  async text(path: string): Promise<string> {
    const url = `${this.base}${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${text}`);
    return text;
  }

  /** The same answer as raw text, for a byte-for-byte comparison (#123). */
  async shiftOeeText(shiftKey: string): Promise<string> {
    const url = `${this.base}/api/v1/shifts/${shiftKey}/oee`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${url}: ${String(response.status)} ${text}`);
    return text;
  }

  currentShift() {
    return request(`${this.base}/api/v1/shifts/current`, currentShiftSchema);
  }

  reasonCodes() {
    return request(`${this.base}/api/v1/reason-codes`, reasonCodesSchema);
  }

  downtime(from: string, to: string) {
    const query = new URLSearchParams({ from, to });
    return request(`${this.base}/api/v1/downtime?${query.toString()}`, downtimeListSchema);
  }

  pareto(scope: 'equipment' | 'work-center', id: string, from: string, to: string) {
    const query = new URLSearchParams({ scope, id, from, to });
    return request(`${this.base}/api/v1/downtime/pareto?${query.toString()}`, paretoSchema);
  }

  audit(id: string) {
    return request(
      `${this.base}/api/v1/downtime/${encodeURIComponent(id)}/audit`,
      downtimeAuditSchema,
    );
  }
}

/**
 * One HTTP request with exactly these headers (fetch adds or drops some, such as `Origin`):
 * resolves with the status and body.
 */
export function rawRequest(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(url), { method, headers, timeout: 5_000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url}: timed out`)));
    req.on('error', reject);
    req.end(body);
  });
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
