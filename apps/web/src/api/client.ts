import {
  MES_API_LIMITS,
  codingResultSchema,
  currentShiftSchema,
  downtimeAuditSchema,
  downtimeListSchema,
  equipmentListSchema,
  equipmentSchema,
  intervalsSchema,
  metricsSchema,
  oeeListSchema,
  paretoSchema,
  plantSchema,
  problemSchema,
  reasonCodesSchema,
  seriesSchema,
  shiftListSchema,
  shiftOeeSchema,
  type CodingRequest,
  type CodingResult,
  type CurrentShift,
  type DowntimeAudit,
  type DowntimeList,
  type EquipmentDto,
  type IntervalDto,
  type Metrics,
  type OeeList,
  type Pareto,
  type Plant,
  type Problem,
  type ReasonCodes,
  type Series,
  type ShiftList,
  type ShiftOee,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';

export const API_BASE = '/api/v1';

/** A failed API call: the MES's problem details when it sent them (RFC 9457, ADR-0019). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | undefined;
  /** Seconds from a 429's `Retry-After`, when the MES sent one. */
  readonly retryAfter: number | undefined;

  constructor(message: string, status: number, problem?: Problem, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
}

async function problemOf(response: Response): Promise<Problem | undefined> {
  if (!response.headers.get('content-type')?.includes('application/problem+json')) {
    return undefined;
  }
  try {
    const parsed = problemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (value === undefined || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}

/** Sends a request under `/api/v1` and parses the JSON answer with a shared response schema. */
async function requestJson<S extends z.ZodType>(
  path: string,
  schema: S,
  init: RequestInit,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('The MES cannot be reached', 0);
  }
  if (!response.ok) {
    const problem = await problemOf(response);
    throw new ApiError(
      problem ? `${problem.title}: ${problem.detail}` : `HTTP ${String(response.status)}`,
      response.status,
      problem,
      retryAfterOf(response),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('The MES sent an answer that is not JSON', response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(`Unexpected answer from ${path}: ${parsed.error.message}`, response.status);
  }
  return parsed.data;
}

/** GET a path under `/api/v1` and parse the answer with the shared response schema. */
export function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  return requestJson(path, schema, {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
}

/**
 * A write (ADR-0023): a JSON body to a relative URL, so it goes same-origin through the proxy and
 * the browser sends the page's `Origin`. Never a form or `text/plain` body (the MES answers 415).
 */
export function sendJson<S extends z.ZodType>(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>> {
  return requestJson(path, schema, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    mode: 'same-origin',
  });
}

const segment = encodeURIComponent;

export async function listEquipment(signal?: AbortSignal): Promise<EquipmentDto[]> {
  return (await getJson('/equipment', equipmentListSchema, signal)).equipment;
}

export function getEquipment(id: string, signal?: AbortSignal): Promise<EquipmentDto> {
  return getJson(`/equipment/${segment(id)}`, equipmentSchema, signal);
}

export function getPlant(signal?: AbortSignal): Promise<Plant> {
  return getJson('/plant', plantSchema, signal);
}

export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

const rangeQuery = ({ from, to }: TimeRange): URLSearchParams =>
  new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });

/** Most pages one intervals read follows; a 7-day range needs one or two at most. */
export const MAX_INTERVAL_PAGES = 20;

export interface IntervalRead {
  readonly intervals: IntervalDto[];
  /** True when the pages ran out before `to` (more than MAX_INTERVAL_PAGES). */
  readonly truncated: boolean;
}

/** State intervals over a range, following `next` while the MES truncates its answer. */
export async function getIntervals(
  id: string,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<IntervalRead> {
  const intervals: IntervalDto[] = [];
  let from = range.from;
  for (let page = 0; page < MAX_INTERVAL_PAGES; page += 1) {
    const answer = await getJson(
      `/equipment/${segment(id)}/intervals?${rangeQuery({ from, to: range.to }).toString()}`,
      intervalsSchema,
      signal,
    );
    intervals.push(...answer.intervals);
    if (!answer.truncated || answer.next === null) return { intervals, truncated: false };
    const next = new Date(answer.next);
    if (next.getTime() <= from.getTime()) break;
    from = next;
  }
  return { intervals, truncated: true };
}

export function getMetrics(id: string, signal?: AbortSignal): Promise<Metrics> {
  return getJson(`/equipment/${segment(id)}/telemetry/metrics`, metricsSchema, signal);
}

/** Decimated telemetry (min, max, average per bucket) of up to 8 metrics. */
export function getSeries(
  id: string,
  metrics: readonly string[],
  range: TimeRange,
  maxPoints: number,
  signal?: AbortSignal,
): Promise<Series> {
  const query = rangeQuery(range);
  for (const metric of metrics.slice(0, MES_API_LIMITS.metrics)) query.append('metric', metric);
  query.set('maxPoints', String(Math.min(maxPoints, MES_API_LIMITS.maxPoints)));
  return getJson(`/equipment/${segment(id)}/telemetry?${query.toString()}`, seriesSchema, signal);
}

// ---- OEE, shifts and downtime (#120, #121) ----

const iso = (time: number): string => new Date(time).toISOString();

export function getCurrentShift(signal?: AbortSignal): Promise<CurrentShift> {
  return getJson('/shifts/current', currentShiftSchema, signal);
}

export function getShifts(range: TimeRange, signal?: AbortSignal): Promise<ShiftList> {
  return getJson(`/shifts?${rangeQuery(range).toString()}`, shiftListSchema, signal);
}

/** `2026-10-12/A` → `GET /shifts/2026-10-12/A/oee`. */
export function getShiftOee(shiftKey: string, signal?: AbortSignal): Promise<ShiftOee> {
  const [date = '', shift = ''] = shiftKey.split('/');
  return getJson(`/shifts/${segment(date)}/${segment(shift)}/oee`, shiftOeeSchema, signal);
}

export type OeeScope = 'equipment' | 'work-center';

export interface OeeQuery {
  readonly scope: OeeScope;
  readonly id: string;
  readonly bucket: 'hour' | 'shift';
  readonly from: number;
  readonly to: number;
}

export function getOee(query: OeeQuery, signal?: AbortSignal): Promise<OeeList> {
  const params = new URLSearchParams({
    scope: query.scope,
    id: query.id,
    bucket: query.bucket,
    from: iso(query.from),
    to: iso(query.to),
  });
  return getJson(`/oee?${params.toString()}`, oeeListSchema, signal);
}

export function getPareto(
  query: {
    readonly scope: OeeScope;
    readonly id: string;
    readonly from: number;
    readonly to: number;
  },
  signal?: AbortSignal,
): Promise<Pareto> {
  const params = new URLSearchParams({
    scope: query.scope,
    id: query.id,
    from: iso(query.from),
    to: iso(query.to),
  });
  return getJson(`/downtime/pareto?${params.toString()}`, paretoSchema, signal);
}

export function getReasonCodes(signal?: AbortSignal): Promise<ReasonCodes> {
  return getJson('/reason-codes', reasonCodesSchema, signal);
}

export function getDowntime(
  query: { readonly from: number; readonly to: number; readonly uncoded?: boolean },
  signal?: AbortSignal,
): Promise<DowntimeList> {
  const params = new URLSearchParams({ from: iso(query.from), to: iso(query.to) });
  if (query.uncoded) params.set('uncoded', 'true');
  return getJson(`/downtime?${params.toString()}`, downtimeListSchema, signal);
}

export function getDowntimeAudit(id: string, signal?: AbortSignal): Promise<DowntimeAudit> {
  return getJson(`/downtime/${segment(id)}/audit`, downtimeAuditSchema, signal);
}

/** Replaces a record's codings (#121); 409 when `version` is no longer the coding set's. */
export function putCoding(id: string, body: CodingRequest): Promise<CodingResult> {
  return sendJson('PUT', `/downtime/${segment(id)}/coding`, body, codingResultSchema);
}
