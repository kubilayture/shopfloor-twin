/**
 * HTTP clients of the stack under test: the simulator's control API (its own schemas here, since
 * apps never share code), the gateway's metrics and the MES's REST API (the shared
 * `@shopfloor/contracts/mes-api` schemas). Every answer is parsed at the boundary.
 */
import { request as httpRequest } from 'node:http';
import {
  alarmKpiListSchema,
  currentShiftSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  equipmentListSchema,
  oeeResultSchema,
  paretoSchema,
  plantSchema,
  reasonCodesSchema,
  shiftOeeSchema,
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
    scopes: z.record(
      z.string(),
      z.object({ shifts: z.record(z.string(), z.record(z.string(), z.unknown())) }),
    ),
  }),
});
export type GroundTruth = z.infer<typeof groundTruthSchema>;

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
