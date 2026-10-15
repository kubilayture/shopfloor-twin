/**
 * The `realtime` module (#97): the read-only REST API under `/api/v1` (OpenAPI in
 * `docs/api/mes.openapi.json`) and WebSocket push at `/api/v1/ws` (`docs/api/realtime.md`). It
 * owns no tables: it reads master data, equipment and ingest through their interfaces.
 */
export { API_PREFIX, WS_PATH, mergePieces, registerRealtime } from './realtime.ts';
export type { ApiSources, Realtime, RealtimeOptions } from './realtime.ts';
export { PushHub } from './push.ts';
export type { PushOptions, PushSocket, PushSources } from './push.ts';
export { LIMITS, clientMessageSchema, serverMessageSchema } from './schemas.ts';
export type { ClientMessage, ServerMessage } from './schemas.ts';
