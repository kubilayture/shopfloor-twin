import {
  MES_API_LIMITS,
  acknowledgeRequestSchema,
  acknowledgeResultSchema,
  alarmDetailSchema,
  alarmHistorySchema,
  alarmKpiListSchema,
  alarmListSchema,
  alarmPointListSchema,
  alarmConfigSchema,
  alarmScopesSchema,
  badActorListSchema,
  bulkAcknowledgeRequestSchema,
  bulkAcknowledgeResultSchema,
  codingResultSchema,
  commentRequestSchema,
  commentResultSchema,
  floodListSchema,
  operatorKpiListSchema,
  shelfResultSchema,
  shelveRequestSchema,
  unshelveRequestSchema,
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
  shiftRecordSchema,
  shiftReportSchema,
  handoverNotesSchema,
  handoverAuditSchema,
  noteCreateSchema,
  noteEditSchema,
  noteResultSchema,
  type HandoverAudit,
  type HandoverNotes,
  type NoteCreate,
  type NoteEdit,
  type NoteResult,
  type ShiftRecordDto,
  type ShiftReportDto,
  type AcknowledgeRequest,
  type AcknowledgeResult,
  type AlarmDetail,
  type AlarmHistory,
  type AlarmKpiList,
  type AlarmList,
  type AlarmPointList,
  type AlarmConfig,
  type AlarmScopes,
  type BadActorList,
  type BulkAcknowledgeRequest,
  type BulkAcknowledgeResult,
  type CodingRequest,
  type CodingResult,
  type CommentRequest,
  type CommentResult,
  type FloodList,
  type OperatorKpiList,
  type ShelfResult,
  type ShelveRequest,
  type UnshelveRequest,
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

let serverOffset = 0;

/**
 * The MES's clock minus this browser's, from the last answer's `Date` header (1 s resolution; 0
 * until one arrived): the idle timeout reads the MES's session times on this clock (#170).
 */
export function serverClockOffsetMs(): number {
  return serverOffset;
}

function noteServerDate(response: Response): void {
  const date = Date.parse(response.headers.get('date') ?? '');
  if (Number.isFinite(date)) serverOffset = date - Date.now();
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
  noteServerDate(response);
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

// ---- Alarms (#142, #143, #145) ----

export type AlarmViewName = AlarmList['view'];

/**
 * One page of an alarm view (`GET /alarms?view=`) of at most `alarmPageMax` occurrences; `history`
 * needs a range (at most 7 days).
 */
export function getAlarms(
  query: { readonly view: AlarmViewName; readonly from?: number; readonly to?: number },
  signal?: AbortSignal,
): Promise<AlarmList> {
  const params = new URLSearchParams({
    view: query.view,
    limit: String(MES_API_LIMITS.alarmPageMax),
  });
  if (query.from !== undefined) params.set('from', iso(query.from));
  if (query.to !== undefined) params.set('to', iso(query.to));
  return getJson(`/alarms?${params.toString()}`, alarmListSchema, signal);
}

export function getAlarm(id: string, signal?: AbortSignal): Promise<AlarmDetail> {
  return getJson(`/alarms/${segment(id)}`, alarmDetailSchema, signal);
}

export function getAlarmHistory(id: string, signal?: AbortSignal): Promise<AlarmHistory> {
  return getJson(`/alarms/${segment(id)}/history`, alarmHistorySchema, signal);
}

export function getAlarmPoints(signal?: AbortSignal): Promise<AlarmPointList> {
  return getJson('/alarm-points', alarmPointListSchema, signal);
}

export function getAlarmScopes(signal?: AbortSignal): Promise<AlarmScopes> {
  return getJson('/alarms/scopes', alarmScopesSchema, signal);
}

/** The shelving limit, KPI thresholds and benchmarks of alarms.yaml (#160). */
export function getAlarmConfig(signal?: AbortSignal): Promise<AlarmConfig> {
  return getJson('/alarms/config', alarmConfigSchema, signal);
}

/** A KPI scope as the API names it: the plant, or a position or an equipment with its id. */
export interface AlarmScopeRef {
  readonly scope: 'plant' | 'position' | 'equipment';
  readonly id: string;
}

interface ScopeRange extends AlarmScopeRef {
  readonly from: number;
  readonly to: number;
}

function scopeQuery(query: ScopeRange): URLSearchParams {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.scope !== 'plant') params.set('id', query.id);
  params.set('from', iso(query.from));
  params.set('to', iso(query.to));
  return params;
}

export function getAlarmKpi(
  query: ScopeRange & { readonly bucket: 'hour' | 'shift' },
  signal?: AbortSignal,
): Promise<AlarmKpiList> {
  const params = scopeQuery(query);
  params.set('bucket', query.bucket);
  return getJson(`/alarms/kpi?${params.toString()}`, alarmKpiListSchema, signal);
}

export function getOperatorKpi(
  query: ScopeRange & { readonly bucket: 'hour' | 'shift' | 'range' },
  signal?: AbortSignal,
): Promise<OperatorKpiList> {
  const params = scopeQuery(query);
  params.set('bucket', query.bucket);
  return getJson(`/alarms/operator-kpi?${params.toString()}`, operatorKpiListSchema, signal);
}

export function getFloods(query: ScopeRange, signal?: AbortSignal): Promise<FloodList> {
  return getJson(`/alarms/floods?${scopeQuery(query).toString()}`, floodListSchema, signal);
}

export function getBadActors(query: ScopeRange, signal?: AbortSignal): Promise<BadActorList> {
  const params = scopeQuery(query);
  params.set('limit', String(MES_API_LIMITS.badActors));
  return getJson(`/alarms/bad-actors?${params.toString()}`, badActorListSchema, signal);
}

/** Acknowledges one occurrence (monotonic: no version; `changed: false` if it already was). */
export function acknowledgeAlarm(id: string, body: AcknowledgeRequest): Promise<AcknowledgeResult> {
  return sendJson(
    'POST',
    `/alarms/${segment(id)}/ack`,
    acknowledgeRequestSchema.parse(body),
    acknowledgeResultSchema,
  );
}

/** Acknowledges up to 100 occurrences in one transaction (an unknown id is 404: nothing changes). */
export function acknowledgeAlarms(body: BulkAcknowledgeRequest): Promise<BulkAcknowledgeResult> {
  return sendJson(
    'POST',
    '/alarms/ack',
    bulkAcknowledgeRequestSchema.parse(body),
    bulkAcknowledgeResultSchema,
  );
}

/** Adds a comment to an occurrence (append-only: no version). */
export function commentAlarm(id: string, body: CommentRequest): Promise<CommentResult> {
  return sendJson(
    'POST',
    `/alarms/${segment(id)}/comments`,
    commentRequestSchema.parse(body),
    commentResultSchema,
  );
}

/** Shelves a point for a time of plant time; 409 when `version` is no longer the shelf's. */
export function shelvePoint(
  equipment: string,
  code: string,
  body: ShelveRequest,
): Promise<ShelfResult> {
  return sendJson(
    'POST',
    `/alarm-points/${segment(equipment)}/${segment(code)}/shelve`,
    shelveRequestSchema.parse(body),
    shelfResultSchema,
  );
}

/** Unshelves a point; 409 when `version` is no longer the shelf's, 422 when it isn't shelved. */
export function unshelvePoint(
  equipment: string,
  code: string,
  body: UnshelveRequest,
): Promise<ShelfResult> {
  return sendJson(
    'POST',
    `/alarm-points/${segment(equipment)}/${segment(code)}/unshelve`,
    unshelveRequestSchema.parse(body),
    shelfResultSchema,
  );
}

// ---- Shifts: instances, report and handover notes (#144, #146) ----

/** A shift (`date`, `shift`) and, when asked for, a plant epoch (the newest by default). */
export interface ShiftRef {
  readonly date: string;
  readonly shift: string;
  readonly epoch?: number | undefined;
}

const shiftPath = (ref: ShiftRef): string => `/shifts/${segment(ref.date)}/${segment(ref.shift)}`;

const epochQuery = (ref: ShiftRef): string =>
  ref.epoch === undefined ? '' : `?epoch=${String(ref.epoch)}`;

/** The report's URL, for the JSON download (the report as served). */
export const shiftReportUrl = (ref: ShiftRef): string =>
  `${API_BASE}${shiftPath(ref)}/report${epochQuery(ref)}`;

/** One shift instance: status, finality and the composite revision; 404 before the clock. */
export function getShiftInstance(ref: ShiftRef, signal?: AbortSignal): Promise<ShiftRecordDto> {
  return getJson(`${shiftPath(ref)}${epochQuery(ref)}`, shiftRecordSchema, signal);
}

export function getShiftReport(ref: ShiftRef, signal?: AbortSignal): Promise<ShiftReportDto> {
  return getJson(`${shiftPath(ref)}/report${epochQuery(ref)}`, shiftReportSchema, signal);
}

export function getShiftNotes(ref: ShiftRef, signal?: AbortSignal): Promise<HandoverNotes> {
  return getJson(`${shiftPath(ref)}/notes${epochQuery(ref)}`, handoverNotesSchema, signal);
}

/** A note's history from the append-only audit, newest first. */
export function getNoteAudit(
  ref: ShiftRef,
  noteId: number,
  signal?: AbortSignal,
): Promise<HandoverAudit> {
  return getJson(`${shiftPath(ref)}/notes/${String(noteId)}/audit`, handoverAuditSchema, signal);
}

/** Writes a note; 409 outside the handover window, 422 beyond the notes per shift. */
export function createNote(ref: ShiftRef, body: NoteCreate): Promise<NoteResult> {
  return sendJson(
    'POST',
    `${shiftPath(ref)}/notes${epochQuery(ref)}`,
    noteCreateSchema.parse(body),
    noteResultSchema,
  );
}

/** A new version of a note; 409 when `version` is stale or the handover window is closed. */
export function editNote(ref: ShiftRef, noteId: number, body: NoteEdit): Promise<NoteResult> {
  return sendJson(
    'PUT',
    `${shiftPath(ref)}/notes/${String(noteId)}`,
    noteEditSchema.parse(body),
    noteResultSchema,
  );
}
