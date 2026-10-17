import {
  characteristicListSchema,
  holdCommentRequestSchema,
  holdDecisionRequestSchema,
  holdDetailSchema,
  holdListSchema,
  holdOpenRequestSchema,
  holdReasonListSchema,
  holdSchema,
  holdSuggestionSchema,
  limitsCreateRequestSchema,
  limitsEndRequestSchema,
  limitsWriteResultSchema,
  signalAckRequestSchema,
  spcChartSchema,
  spcSignalSchema,
  type CharacteristicList,
  type HoldCommentRequest,
  type HoldDecisionRequest,
  type HoldDetailDto,
  type HoldDto,
  type HoldList,
  type HoldOpenRequest,
  type HoldReasonList,
  type HoldState,
  type HoldSubjectDto,
  type HoldSuggestionDto,
  type LimitsCreateRequest,
  type LimitsEndRequest,
  type LimitsWriteResult,
  type SignalAckRequest,
  type SpcChartDto,
  type SpcSignalDto,
} from '@shopfloor/contracts/mes-api';
import { getJson, getJsonTagged, sendJson } from './client.ts';

// The SPC and holds screens' reads and writes (#203): the quality API of #200 and #201, parsed
// with the shared schemas (ADR-0020). Every query key starts with `quality`, so the live cache
// can tell them apart (live/live-quality.ts reads them again by these prefixes).

const segment = encodeURIComponent;

/** The chart's window: the default recent readings, every one, or a plant-time range. */
export interface ChartWindow {
  readonly all: boolean;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export const chartWindowKey = (window: ChartWindow): string =>
  `${window.all ? 'all' : ''}|${window.from ?? ''}|${window.to ?? ''}`;

export const qualityKeys = {
  all: ['quality'] as const,
  characteristics: ['quality', 'characteristics'] as const,
  chartAll: (id: string) => ['quality', 'chart', id] as const,
  chart: (id: string, window: ChartWindow) =>
    ['quality', 'chart', id, chartWindowKey(window)] as const,
  holdsAll: ['quality', 'holds'] as const,
  holds: (filter: string) => ['quality', 'holds', filter] as const,
  hold: (id: string) => ['quality', 'hold', id] as const,
  reasons: ['quality', 'hold-reasons'] as const,
  suggestion: (signal: number) => ['quality', 'suggestion', signal] as const,
};

export function getCharacteristics(signal?: AbortSignal): Promise<CharacteristicList> {
  return getJson('/quality/characteristics', characteristicListSchema, signal);
}

/** Chart answers by path with their `ETag`: a 304 serves the one kept (a few windows at most). */
const charts = new Map<string, { readonly etag: string; readonly data: SpcChartDto }>();
const CHARTS_KEPT = 8;

export function chartPath(id: string, window: ChartWindow): string {
  const query = new URLSearchParams();
  if (window.all) query.set('all', 'true');
  if (window.from) query.set('from', window.from);
  if (window.to) query.set('to', window.to);
  const search = query.toString();
  return `/quality/characteristics/${segment(id)}/chart${search === '' ? '' : `?${search}`}`;
}

/**
 * The I-MR and X̄-R charts with `If-None-Match` (ADR-0032's chart ETag): a characteristic push
 * reads it again, and an unchanged derivation answers 304 without a body.
 */
export async function getSpcChart(
  id: string,
  window: ChartWindow,
  signal?: AbortSignal,
): Promise<SpcChartDto> {
  const path = chartPath(id, window);
  const kept = charts.get(path);
  const answer = await getJsonTagged(path, spcChartSchema, kept?.etag, signal);
  if (answer.notModified) {
    if (kept) return kept.data;
    // A 304 for a tag not sent cannot happen; read it again without one.
    return getJson(path, spcChartSchema, signal);
  }
  charts.delete(path);
  if (answer.etag !== null) {
    charts.set(path, { etag: answer.etag, data: answer.data });
    for (const key of charts.keys()) {
      if (charts.size <= CHARTS_KEPT) break;
      charts.delete(key);
    }
  }
  return answer.data;
}

/** Forgets the kept chart answers (tests; a logout empties every cache). */
export function forgetCharts(): void {
  charts.clear();
}

export function createLimits(id: string, body: LimitsCreateRequest): Promise<LimitsWriteResult> {
  return sendJson(
    'POST',
    `/quality/characteristics/${segment(id)}/limits`,
    limitsCreateRequestSchema.parse(body),
    limitsWriteResultSchema,
  );
}

export function endLimits(
  id: string,
  version: number,
  body: LimitsEndRequest,
): Promise<LimitsWriteResult> {
  return sendJson(
    'POST',
    `/quality/characteristics/${segment(id)}/limits/${String(version)}/end`,
    limitsEndRequestSchema.parse(body),
    limitsWriteResultSchema,
  );
}

export function acknowledgeSignal(id: number, body: SignalAckRequest): Promise<SpcSignalDto> {
  return sendJson(
    'POST',
    `/quality/signals/${String(id)}/ack`,
    signalAckRequestSchema.parse(body),
    spcSignalSchema,
  );
}

export interface HoldFilter {
  readonly states: readonly HoldState[];
  readonly subject?: HoldSubjectDto | undefined;
}

export const holdFilterKey = (filter: HoldFilter): string =>
  `${filter.states.join(',')}|${filter.subject ? `${filter.subject.kind}:${filter.subject.id}` : ''}`;

export function getHolds(filter: HoldFilter, signal?: AbortSignal): Promise<HoldList> {
  const query = new URLSearchParams();
  if (filter.states.length > 0) query.set('state', filter.states.join(','));
  if (filter.subject) {
    query.set('subjectKind', filter.subject.kind);
    query.set('subjectId', filter.subject.id);
  }
  const search = query.toString();
  return getJson(`/quality/holds${search === '' ? '' : `?${search}`}`, holdListSchema, signal);
}

export function getHold(id: string, signal?: AbortSignal): Promise<HoldDetailDto> {
  return getJson(`/quality/holds/${segment(id)}`, holdDetailSchema, signal);
}

export function getHoldReasons(signal?: AbortSignal): Promise<HoldReasonList> {
  return getJson('/quality/hold-reasons', holdReasonListSchema, signal);
}

export function getHoldSuggestion(id: number, signal?: AbortSignal): Promise<HoldSuggestionDto> {
  return getJson(`/quality/signals/${String(id)}/hold-suggestion`, holdSuggestionSchema, signal);
}

export function openHold(body: HoldOpenRequest): Promise<HoldDto> {
  return sendJson('POST', '/quality/holds', holdOpenRequestSchema.parse(body), holdSchema);
}

export function commentHold(id: string, body: HoldCommentRequest): Promise<HoldDto> {
  return sendJson(
    'POST',
    `/quality/holds/${segment(id)}/comments`,
    holdCommentRequestSchema.parse(body),
    holdSchema,
  );
}

export function decideHold(
  id: string,
  decision: 'release' | 'reject',
  body: HoldDecisionRequest,
): Promise<HoldDto> {
  return sendJson(
    'POST',
    `/quality/holds/${segment(id)}/${decision}`,
    holdDecisionRequestSchema.parse(body),
    holdSchema,
  );
}
