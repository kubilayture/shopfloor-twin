/**
 * The `realtime` module (#97): the REST API under `/api/v1` (read-only but for downtime coding,
 * #121, behind the write guards of ADR-0023) (OpenAPI in
 * `docs/api/mes.openapi.json`) and WebSocket push at `/api/v1/ws` (`docs/api/realtime.md`). It
 * owns no tables: it reads master data, equipment, ingest and oee through their interfaces.
 */
export {
  API_PREFIX,
  WS_PATH,
  KeyedLimiter,
  WriteLimiter,
  cookieValue,
  mergePieces,
  registerRealtime,
  sameOrigin,
} from './realtime.ts';
export type { ApiSources, IdentityApi, Realtime, RealtimeOptions } from './realtime.ts';
export type { Access } from './routes.ts';
export { bucketDto, recordDto, resultDto, shiftInstanceDto } from './oee-dto.ts';
export {
  alarmKpiDto,
  badActorDto,
  floodEpisodeDto,
  historyDto,
  occurrenceDto,
} from './alarm-dto.ts';
export {
  handoverAuditDto,
  handoverNoteDto,
  shiftOeeDto,
  shiftRecordDto,
  shiftReportDto,
} from './shift-dto.ts';
export { cartonTraceDto, lotTraceDto, serialTraceDto, traceUnitDto } from './genealogy-routes.ts';
export type { GenealogyApi } from './genealogy-routes.ts';
export { PushHub } from './push.ts';
export type { PushOptions, PushSocket, PushSources } from './push.ts';
export { LIMITS, clientMessageSchema, serverMessageSchema } from './schemas.ts';
export type { ClientMessage, ServerMessage } from './schemas.ts';
