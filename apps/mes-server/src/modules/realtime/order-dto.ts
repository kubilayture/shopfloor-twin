import type {
  CommandDetailDto,
  CommandDto,
  CommandResultDto,
  ConfirmationDto,
  ErpMessageDto,
  OrderDetail,
  OrderDto,
  OrderHistoryEntryDto,
  OrderIncidentDto,
} from '@shopfloor/contracts/mes-api';
import type { StoredAuditEntry } from '../identity/index.ts';
import type { StoredCommandResult } from '../ingest/index.ts';
import type {
  CommandRecord,
  ConfirmationRecord,
  ErpMessageRecord,
  OrderDetailRecord,
  OrderIncident,
  OrderRecord,
} from '../orders/index.ts';

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function orderDto(order: OrderRecord): OrderDto {
  return {
    id: order.id,
    revision: order.revision,
    product: order.product,
    quantity: order.quantity,
    priority: order.priority,
    plannedStart: iso(order.plannedStart),
    dueDate: iso(order.dueDate),
    erpStatus: order.erpStatus,
    status: order.status,
    flags: {
      short: order.short,
      dispatchFailed: order.dispatchFailed,
      dispatchLost: order.dispatchLost,
    },
    rejection: order.rejection,
    dispatched: order.dispatched,
    remaining: Math.max(0, order.quantity - order.dispatched - order.inFlight),
    version: order.version,
    importedAt: iso(order.importedAt),
    updatedAt: iso(order.updatedAt),
    releasedAt: isoOrNull(order.releasedAt),
    dispatchedAt: isoOrNull(order.dispatchedAt),
    startedAt: isoOrNull(order.startedAt),
    completedAt: isoOrNull(order.completedAt),
    closedAt: isoOrNull(order.closedAt),
    cancelledAt: isoOrNull(order.cancelledAt),
  };
}

export function commandDto(command: CommandRecord): CommandDto {
  const last = command.attempts.at(-1);
  return {
    commandId: command.commandId,
    orderId: command.orderId,
    n: command.n,
    equipment: command.equipment,
    product: command.product,
    quantity: command.quantity,
    notBefore: iso(command.notBefore),
    deviceEpoch: command.deviceEpoch,
    createdAt: iso(command.createdAt),
    updatedAt: iso(command.updatedAt),
    state: command.state,
    settled: command.settled,
    failed: command.failed,
    confirmed: command.confirmed,
    acceptedBy: command.acceptedBy,
    acceptedSeq: command.acceptedSeq,
    acceptedAt: isoOrNull(command.acceptedAt),
    rejection: command.rejection,
    seqAfterExpiry: command.seqAfterExpiry,
    attempts: command.attempts.length,
    lastExpiresAt: last ? iso(last.expiresAt) : null,
    job: command.job,
    startedAt: isoOrNull(command.startedAt),
    completedAt: isoOrNull(command.completedAt),
  };
}

export function commandResultDto(stored: StoredCommandResult): CommandResultDto {
  const v = stored.value;
  return {
    result: v.result,
    equipment: stored.equipment,
    deviceEpoch: v.deviceEpoch,
    expiresAt: v.expiresAt,
    respondedAt: iso(stored.respondedAt),
    receivedAt: iso(stored.receivedAt),
    statusCode: v.statusCode,
    code: v.result === 'rejected' ? v.code : null,
    position: v.result === 'accepted' || v.result === 'duplicate' ? v.position : null,
    acceptedSeq: v.result === 'accepted' || v.result === 'duplicate' ? v.acceptedSeq : null,
    acceptedAt: v.result === 'accepted' || v.result === 'duplicate' ? v.acceptedAt : null,
    seqAfterExpiry: v.result === 'expired' || v.result === 'unknown' ? v.seqAfterExpiry : null,
    reason: v.result === 'unknown' ? v.reason : null,
  };
}

export function erpMessageDto(message: ErpMessageRecord): ErpMessageDto {
  return {
    id: message.id,
    direction: message.direction,
    kind: message.kind,
    revision: message.revision,
    idempotencyKey: message.idempotencyKey,
    status: message.status,
    detail: message.detail,
    attempts: message.attempts,
    lastError: message.lastError,
    createdAt: iso(message.createdAt),
    updatedAt: iso(message.updatedAt),
    payload: message.payload,
  };
}

export function orderIncidentDto(incident: OrderIncident): OrderIncidentDto {
  return {
    id: incident.id,
    type: incident.type,
    orderId: incident.orderId,
    commandId: incident.commandId,
    equipment: incident.equipment,
    message: incident.message,
    detectedAt: iso(incident.detectedAt),
    closedAt: isoOrNull(incident.closedAt),
    resolution: incident.resolution,
  };
}

function historyDto(entry: StoredAuditEntry): OrderHistoryEntryDto {
  return {
    id: entry.id,
    at: iso(entry.at),
    plantAt: isoOrNull(entry.plantAt),
    actor: entry.username,
    roles: [...entry.roles],
    authenticated: entry.authenticated,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    requestId: entry.requestId,
  };
}

export function confirmationDto(c: ConfirmationRecord): ConfirmationDto {
  return {
    operation: c.operation,
    n: c.n,
    kind: c.kind,
    revision: c.revision,
    yield: c.yield,
    scrap: { ...c.scrap },
    reworkPasses: c.reworkPasses,
    material: { ...c.material },
    totals: {
      yield: c.totals.yield,
      scrap: { ...c.totals.scrap },
      reworkPasses: c.totals.reworkPasses,
      material: { ...c.totals.material },
    },
    confirmedAt: iso(c.confirmedAt),
    idempotencyKey: c.idempotencyKey,
    createdAt: iso(c.createdAt),
    messageStatus: c.messageStatus,
  };
}

export function orderDetailDto(detail: OrderDetailRecord): OrderDetail {
  return {
    order: orderDto(detail.order),
    routing: detail.order.routing.map((step) => ({
      operation: step.operation,
      workCenter: step.workCenter,
    })),
    bom: detail.order.bom.map((item) => ({ ...item })),
    commands: detail.commands.map((command): CommandDetailDto => ({
      ...commandDto(command),
      attemptList: command.attempts.map((a) => ({
        attempt: a.attempt,
        issuedAt: iso(a.issuedAt),
        publishedAt: isoOrNull(a.publishedAt),
        expiresAt: iso(a.expiresAt),
      })),
      results: command.results.map(commandResultDto),
    })),
    confirmations: detail.confirmations.map(confirmationDto),
    erpMessages: detail.erpMessages.map(erpMessageDto),
    incidents: detail.incidents.map(orderIncidentDto),
    history: detail.history.map(historyDto),
  };
}
