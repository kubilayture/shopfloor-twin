import {
  MES_API_LIMITS,
  equipmentListSchema,
  equipmentSchema,
  intervalsSchema,
  metricsSchema,
  plantSchema,
  problemSchema,
  seriesSchema,
  type EquipmentDto,
  type IntervalDto,
  type Metrics,
  type Plant,
  type Problem,
  type Series,
} from '@shopfloor/contracts/mes-api';
import type { z } from 'zod';

export const API_BASE = '/api/v1';

/** A failed API call: the MES's problem details when it sent them (RFC 9457, ADR-0019). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | undefined;

  constructor(message: string, status: number, problem?: Problem) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
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

/** GET a path under `/api/v1` and parse the answer with the shared response schema. */
export async function getJson<S extends z.ZodType>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
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
