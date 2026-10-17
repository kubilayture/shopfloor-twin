/**
 * The dispatch rule (#174, plan "Orders", ADR-0030 "Dispatches"): deterministic, from master data
 * and the MES's own queue only. The whole order goes to the CNC whose queue, with the order
 * appended, finishes first by an ideal-time estimate; ties go to the lower id. The estimate walks
 * the queue in order: a job starts at the later of its `notBefore` and the previous job's end, plus
 * a changeover when its product differs from the one before it (the first job of a run too,
 * `none→…`), and takes quantity × the product's ideal OP10 cycle. Breaks and shift ends are
 * ignored, which is enough for a deterministic choice. The simulator pins the same rule with a
 * test that recomputes `orders-01`'s `dispatches` (apps/simulator/src/headless/orders-01.test.ts).
 */

export interface QueuedJob {
  readonly product: string;
  readonly quantity: number;
  /** Plant time, ms. */
  readonly notBefore: number;
}

/** One CNC's queue as the MES knows it: jobs not finished, in queue order. */
export interface CncQueue {
  readonly equipment: string;
  /** The product loaded before the first job of `jobs` (undefined: nothing, `none→…`). */
  readonly loaded: string | undefined;
  readonly jobs: readonly QueuedJob[];
}

export interface ProductTimes {
  /** Ideal OP10 cycle per blank, ms. */
  idealMs(product: string): number;
  /** A changeover to this product, ms. */
  changeoverMs(product: string): number;
}

/** When the queue finishes by the estimate, starting no earlier than `from` (ms). */
export function estimateFinish(
  queue: Pick<CncQueue, 'loaded' | 'jobs'>,
  times: ProductTimes,
  from = Number.NEGATIVE_INFINITY,
): number {
  let end = from;
  let loaded = queue.loaded;
  for (const job of queue.jobs) {
    const start =
      Math.max(job.notBefore, end) + (job.product === loaded ? 0 : times.changeoverMs(job.product));
    end = start + job.quantity * times.idealMs(job.product);
    loaded = job.product;
  }
  return end;
}

/** The CNC the job goes to: the earliest finish with it appended, ties to the lower id. */
export function chooseCnc(
  queues: readonly CncQueue[],
  job: QueuedJob,
  times: ProductTimes,
  from?: number,
): string | undefined {
  let best: { equipment: string; finish: number } | undefined;
  for (const queue of [...queues].sort((a, b) => (a.equipment < b.equipment ? -1 : 1))) {
    const finish = estimateFinish(
      { loaded: queue.loaded, jobs: [...queue.jobs, job] },
      times,
      from,
    );
    if (best === undefined || finish < best.finish) best = { equipment: queue.equipment, finish };
  }
  return best?.equipment;
}
