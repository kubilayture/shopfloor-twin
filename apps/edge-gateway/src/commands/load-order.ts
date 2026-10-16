import {
  LOAD_ORDER_INPUTS,
  type CommandRejection,
  type CommandResultValue,
  type LoadOrderCommand,
} from '@shopfloor/contracts';
import { DataType, type CallMethodResult, type VariantOptions } from 'node-opcua';

/**
 * What one `LoadOrder` call told the gateway (#173, ADR-0029):
 *
 * - `final`: a definitive answer of the device (`accepted`, `duplicate`, `rejected`, `expired`);
 * - `transient`: refused before anything was checked (`BadWaitingForInitialData`: the run is not
 *   attached yet or has finished), so the same command may be called again;
 * - `unknown`: the gateway doesn't know whether the device acted (deadline, transport, session,
 *   any other status).
 */
export type CallOutcome =
  | { readonly kind: 'final'; readonly value: CommandResultValue }
  | { readonly kind: 'transient'; readonly statusCode: string }
  | { readonly kind: 'unknown'; readonly reason: string; readonly statusCode: string | null };

/** `LoadOrder`'s input arguments for a command, in `LOAD_ORDER_INPUTS` order. */
export function loadOrderArguments(command: LoadOrderCommand): VariantOptions[] {
  const v = command.value;
  return [
    { dataType: DataType.String, value: v.commandId },
    { dataType: DataType.String, value: v.orderId },
    { dataType: DataType.String, value: v.product },
    { dataType: DataType.UInt32, value: v.quantity },
    { dataType: DataType.DateTime, value: new Date(v.notBefore) },
    { dataType: DataType.UInt32, value: v.deviceEpoch },
    { dataType: DataType.DateTime, value: new Date(command.expiresAt) },
  ];
}

/** The fields every answer to this delivery carries. */
export function answeredFields(command: LoadOrderCommand, statusCode: string | null) {
  return {
    commandId: command.value.commandId,
    orderId: command.value.orderId,
    deviceEpoch: command.value.deviceEpoch,
    expiresAt: command.expiresAt,
    statusCode,
  };
}

/** What identifies a job: a stored answer is reused only for the same job on the same machine. */
export function jobKey(equipment: string, command: LoadOrderCommand): string {
  const v = command.value;
  return JSON.stringify([equipment, v.orderId, v.product, v.quantity, Date.parse(v.notBefore)]);
}

const BY_ARGUMENT: Partial<Record<(typeof LOAD_ORDER_INPUTS)[number], CommandRejection>> = {
  CommandId: 'command-conflict',
  Product: 'invalid-product',
  Quantity: 'invalid-quantity',
};

/**
 * Reads a `LoadOrder` answer (docs/contracts/opcua-address-space.md): the status code and the one
 * argument a refusal flags tell every case apart.
 */
export function interpretLoadOrder(
  command: LoadOrderCommand,
  result: CallMethodResult,
): CallOutcome {
  const status = result.statusCode.name;
  const flags = (result.inputArgumentResults ?? []).map((r) => r.name);
  const flagged = LOAD_ORDER_INPUTS.find(
    (_name, i) => flags[i] !== undefined && flags[i] !== 'Good',
  );
  const answered = answeredFields(command, status);
  const rejected = (code: CommandRejection): CallOutcome => ({
    kind: 'final',
    value: { result: 'rejected', ...answered, code },
  });
  switch (status) {
    case 'Good': {
      const [position, duplicate, acceptedSeq, acceptedAt] = (result.outputArguments ?? []).map(
        (o) => o.value as unknown,
      );
      if (
        typeof position !== 'number' ||
        typeof duplicate !== 'boolean' ||
        typeof acceptedSeq !== 'number' ||
        !(acceptedAt instanceof Date) ||
        position < 1 ||
        acceptedSeq < 1
      ) {
        return { kind: 'unknown', reason: 'Good without valid outputs', statusCode: status };
      }
      return {
        kind: 'final',
        value: {
          result: duplicate ? 'duplicate' : 'accepted',
          ...answered,
          position,
          acceptedSeq,
          acceptedAt: acceptedAt.toISOString(),
        },
      };
    }
    case 'BadWaitingForInitialData':
      return { kind: 'transient', statusCode: status };
    case 'BadInvalidState':
      if (flagged === 'ExpiresAt') {
        return { kind: 'final', value: { result: 'expired', ...answered, seqAfterExpiry: null } };
      }
      return rejected(flagged === 'DeviceEpoch' ? 'epoch-mismatch' : 'wrong-mode');
    case 'BadInvalidArgument':
      return rejected((flagged && BY_ARGUMENT[flagged]) ?? 'invalid-argument');
    case 'BadResourceUnavailable':
      return rejected('queue-full');
    default:
      return { kind: 'unknown', reason: `the call answered ${status}`, statusCode: status };
  }
}

/**
 * The settle call's mapping (plan, "Settling an unknown outcome"): `Duplicate` means the job was
 * accepted, the device's `expired` that it never was, `epoch-mismatch` that the run ended; anything
 * else stays `unknown`. An acceptance is the device's word too and is kept as such.
 */
export function interpretSettleCall(
  command: LoadOrderCommand,
  result: CallMethodResult,
  seqAfterExpiry: number,
): CallOutcome {
  const outcome = interpretLoadOrder(command, result);
  if (outcome.kind !== 'final') {
    return outcome.kind === 'transient'
      ? {
          kind: 'unknown',
          reason: `the settle call answered ${outcome.statusCode}`,
          statusCode: outcome.statusCode,
        }
      : outcome;
  }
  const value = outcome.value;
  switch (value.result) {
    case 'accepted':
    case 'duplicate':
      return outcome;
    case 'expired':
      return { kind: 'final', value: { ...value, seqAfterExpiry } };
    case 'rejected':
      return value.code === 'epoch-mismatch'
        ? outcome
        : {
            kind: 'unknown',
            reason: `the settle call was refused (${value.code})`,
            statusCode: value.statusCode,
          };
    case 'unknown':
      return { kind: 'unknown', reason: value.reason, statusCode: value.statusCode };
  }
}
