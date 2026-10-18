/**
 * Order OEE as JSON (#231): `GET /oee/orders/{id}` and the `oee:order:<id>` push topic. The OEE
 * results have the shape of the simulator's ground truth (`resultDto`), so a final order compares
 * with `line-oee.json`'s orders section with one equality.
 */
import type { OrderOeeDto } from '@shopfloor/contracts/mes-api';
import type { OrderOeeView } from '../oee/index.ts';
import { ratio, resultDto } from './oee-dto.ts';

const iso = (at: number | Date): string => new Date(at).toISOString();

function safe(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${String(value)} is not a safe integer`);
  return n;
}

export function orderOeeDto(view: OrderOeeView): OrderOeeDto {
  const { result, firstPassYield: fpy } = view;
  return {
    orderId: view.orderId,
    product: view.product,
    status: view.status,
    oee: resultDto(result.order),
    open: result.open,
    pending: result.pending,
    headTimeUnknown: result.headTimeUnknown,
    endLost: result.endLost,
    lost: result.lost,
    final: view.final,
    jobs: view.jobs.map((job) => ({
      commandId: job.commandId,
      machine: job.machine,
      deviceEpoch: job.deviceEpoch,
      quantity: job.quantity,
      notBefore: iso(job.notBefore),
      head: {
        kind: job.head.kind,
        at: job.head.kind === 'head' ? iso(job.head.at) : null,
        source: job.head.kind === 'head' ? job.head.source : null,
        reason: job.head.kind === 'unknown' ? job.head.reason : null,
      },
      window:
        job.window === undefined
          ? null
          : {
              from: iso(job.window.from),
              to: iso(job.window.to),
              open: job.window.open,
              headTimeUnknown: job.window.headTimeUnknown,
              endLost: job.window.endLost,
              lost: job.window.lost,
            },
      cycles: job.cycles,
      oee: job.result === null ? null : resultDto(job.result),
      final: job.final,
    })),
    firstPassYield: {
      firstPassGood: safe(fpy.firstPassGood),
      started: safe(fpy.started),
      yield: fpy.yield === null ? null : ratio(fpy.yield),
      final: fpy.final,
    },
    completedAt: view.completedAt === null ? null : iso(view.completedAt),
    cutoffs: view.cutoffs.map((cut) => ({
      machine: cut.machine,
      epoch: cut.epoch,
      at: cut.at === null ? null : iso(cut.at),
    })),
  };
}
