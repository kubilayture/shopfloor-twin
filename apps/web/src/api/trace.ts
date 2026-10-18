import {
  cartonTraceSchema,
  lotTraceSchema,
  serialTraceSchema,
  traceSearchSchema,
  type CartonTraceDto,
  type LotTraceDto,
  type SerialTraceDto,
  type TraceSearchDto,
} from '@shopfloor/contracts/mes-api';
import { getJson } from './client.ts';

// The trace screens' reads (#202): the genealogy API of #199 with the holds of #201, parsed with
// the shared schemas (ADR-0020). Read-only: holds are opened and decided on `/quality/holds`
// (#203).

const segment = encodeURIComponent;

/** `GET /trace/search?q=`: serials, lots, cartons and orders whose id starts with `q`. */
export function searchTrace(q: string, signal?: AbortSignal): Promise<TraceSearchDto> {
  const query = new URLSearchParams({ q }).toString();
  return getJson(`/trace/search?${query}`, traceSearchSchema, signal);
}

/** `GET /trace/serials/{serial}`: every unit with the serial, newest epoch first (backward). */
export function getSerialTrace(serial: string, signal?: AbortSignal): Promise<SerialTraceDto> {
  return getJson(`/trace/serials/${segment(serial)}`, serialTraceSchema, signal);
}

/** `GET /trace/lots/{lot}`: the units, orders and cartons that used the lot (forward). */
export function getLotTrace(lot: string, signal?: AbortSignal): Promise<LotTraceDto> {
  return getJson(`/trace/lots/${segment(lot)}`, lotTraceSchema, signal);
}

/** `GET /trace/cartons/{id}`: a carton, its members and their lots. */
export function getCartonTrace(carton: string, signal?: AbortSignal): Promise<CartonTraceDto> {
  return getJson(`/trace/cartons/${segment(carton)}`, cartonTraceSchema, signal);
}
