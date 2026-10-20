/**
 * The orders pass of the reconciliation (#178, Phase 7 exit criteria 4 and 5): what reconcile.ts
 * checks around the live orders-01 shift A beyond the Phase 4–6 comparisons it shares with the
 * alarms-01 pass. Each step returns what it found and reports failures through `fail`; none of
 * them widens a tolerance: counts, quantities and messages are compared exactly.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { LineBucketDto, OrderOeeDto } from '@shopfloor/contracts/mes-api';
import { z } from 'zod';
import {
  MesClient,
  mesLogin,
  mesWrite,
  type ErpClient,
  type GatewayClient,
  type GroundTruth,
  type OrdersTruth,
  type SimulatorClient,
} from './clients.ts';
import { jsonDifferences } from './compare.ts';
import type { Stack } from './stack.ts';

/** One dispatch of a golden scenario's `dispatches` (ADR-0030, B3). */
export interface ScenarioDispatch {
  readonly commandId: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly notBefore: string;
}

export interface PassContext {
  readonly stack: Stack;
  /** The supervisor's MES client. */
  readonly mes: MesClient;
  readonly erp: ErpClient;
  readonly sim: SimulatorClient;
  readonly gateway: GatewayClient;
  readonly log: (message: string) => void;
  readonly fail: (message: string) => void;
}

/**
 * Every order of `GET /api/v1/orders`: it answers at most 500 and says so (`truncated`), and a
 * partial list would make every check over it partial, so a truncated answer fails (#257).
 */
export async function listOrders(ctx: Pick<PassContext, 'mes' | 'fail'>) {
  const list = await ctx.mes.orders();
  if (list.truncated) {
    ctx.fail(`GET /orders is truncated (${String(list.orders.length)} listed): the set is partial`);
  }
  return list.orders;
}

/** Polls `check` until it returns true; rejects with `what` after `timeoutMs`. */
export async function until(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`, { cause: last });
    }
    // Jittered (#178): a fixed period can phase-lock with a periodic source, such as the
    // gateway's Modbus poller every 250 ms, and see its one message in flight at every poll.
    await sleep(250 + Math.floor(Math.random() * 500));
  }
}

/** Counts per key without zeros, in key order: the shape both sides are compared in. */
function counts(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, n]) => n !== 0)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** ERP lines (`[{reason|material, quantity}]`) as counts. */
function lines(list: readonly { quantity: number; reason?: string; material?: string }[]) {
  return counts(Object.fromEntries(list.map((l) => [l.reason ?? l.material ?? '?', l.quantity])));
}

/**
 * Step 1: the ERP mock holds orders-01's orders, and the MES imports every one of them (none
 * rejected) and posts `accepted` for each, which the ERP shows before anything is released.
 */
export async function checkImport(ctx: PassContext) {
  const feed = await ctx.erp.feed();
  const latest = new Map<string, number>();
  for (const entry of feed.entries) {
    latest.set(
      entry.order.orderNumber,
      Math.max(latest.get(entry.order.orderNumber) ?? 0, entry.order.revision),
    );
  }
  const ids = [...latest.keys()].sort();
  let mesOrders: { id: string; status: string; revision: number }[] = [];
  await until(
    'the MES imported every order of the ERP feed',
    async () => {
      mesOrders = (await listOrders(ctx)).map((o) => ({
        id: o.id,
        status: o.status,
        revision: o.revision,
      }));
      return ids.every((id) =>
        mesOrders.some(
          (o) => o.id === id && o.revision === latest.get(id) && o.status === 'imported',
        ),
      );
    },
    60_000,
  );
  const accepted: Record<string, string | null> = {};
  await until(
    'the ERP shows every order accepted',
    async () => {
      for (const id of ids) accepted[id] = (await ctx.erp.order(id)).status;
      return ids.every((id) => accepted[id] === 'accepted');
    },
    60_000,
  );
  const rejected = mesOrders.filter((o) => o.status === 'rejected');
  if (rejected.length > 0) ctx.fail(`orders rejected at import: ${JSON.stringify(rejected)}`);
  return { feedEntries: feed.entries.length, feedId: feed.feedId, orders: ids, accepted };
}

/** The `accepted` job facts per command id the MES stored (device facts, any epoch). */
async function acceptedFacts(stack: Stack): Promise<Record<string, number>> {
  return stack.sqlJson<Record<string, number>>(
    `SELECT coalesce(json_object_agg(command_id, n), '{}') FROM (
       SELECT payload -> 'value' ->> 'commandId' AS command_id, count(*) AS n
       FROM ingest.equipment_event
       WHERE event_type = 'job' AND payload -> 'value' ->> 'transition' = 'accepted'
       GROUP BY 1) AS t`,
  );
}

/**
 * Step 2, after the supervisor's dispatch through the UI and before the injections: the commands
 * equal the scenario's `dispatches` (ids, machines, quantities, `notBefore`), each is confirmed by
 * exactly one `accepted` job fact, no order's accepted jobs exceed its quantity, and the CNC queues
 * (the live ground truth's jobs per machine in acceptance order) equal the golden run's.
 */
export async function checkDispatch(
  ctx: PassContext,
  dispatches: readonly ScenarioDispatch[],
  goldenJobs: OrdersTruth['jobs'],
) {
  const ids = [...new Set(dispatches.map((d) => d.orderId))];
  const commands = [];
  const quantities: Record<string, { ordered: number; accepted: number }> = {};
  for (const id of ids) {
    const detail = await ctx.mes.order(id);
    for (const c of detail.commands) commands.push(c);
    const tally = {
      ordered: detail.order.quantity,
      accepted: detail.commands.filter((c) => c.confirmed).reduce((s, c) => s + c.quantity, 0),
    };
    quantities[id] = tally;
    if (tally.accepted > tally.ordered) {
      ctx.fail(`${id}: accepted jobs ${JSON.stringify(tally)} exceed the order quantity`);
    }
  }
  const byDispatch = dispatches.map((d) => d.commandId);
  commands.sort((a, b) => byDispatch.indexOf(a.commandId) - byDispatch.indexOf(b.commandId));
  const actual = commands.map((c) => ({
    commandId: c.commandId,
    machine: c.equipment,
    orderId: c.orderId,
    product: c.product,
    quantity: c.quantity,
    notBefore: new Date(c.notBefore).toISOString(),
  }));
  const commandDiffs = jsonDifferences(dispatches, actual);
  if (commandDiffs.length > 0) {
    ctx.fail(
      `the MES's commands are not the scenario's dispatches:\n  ${commandDiffs.join('\n  ')}`,
    );
  }
  const facts = await acceptedFacts(ctx.stack);
  const notOnce = commands.filter(
    (c) => facts[c.commandId] !== 1 || !c.confirmed || c.state !== 'accepted',
  );
  if (notOnce.length > 0 || Object.keys(facts).length !== commands.length) {
    ctx.fail(
      `commands not confirmed by exactly one accepted job fact: ${JSON.stringify({ facts, notOnce: notOnce.map((c) => [c.commandId, c.state, c.confirmed]) })}`,
    );
  }
  // The CNC queues: the devices' jobs per machine, in acceptance order, as in the golden run.
  const truth = await ctx.sim.groundTruth();
  const queue = (jobs: OrdersTruth['jobs']) =>
    Object.fromEntries(
      [...new Set(jobs.map((j) => j.machine))].sort().map((machine) => [
        machine,
        jobs
          .filter((j) => j.machine === machine)
          .map(({ commandId, orderId, product, quantity, acceptedAt }) => ({
            commandId,
            orderId,
            product,
            quantity,
            acceptedAt,
          })),
      ]),
    );
  const queueDiffs = jsonDifferences(queue(goldenJobs), queue(truth.orders.jobs));
  if (queueDiffs.length > 0) {
    ctx.fail(
      `the CNC queues differ from the golden run's (golden = expected):\n  ${queueDiffs.join('\n  ')}`,
    );
  }
  return {
    commands: commands.length,
    acceptedFacts: facts,
    quantities,
    queues: queue(truth.orders.jobs),
    commandsEqualDispatches: commandDiffs.length === 0,
    queuesEqualGolden: queueDiffs.length === 0,
  };
}

/** What the orders checks after the drain found, per order completed in shift A. */
export interface CompletedOrderReport {
  readonly completedAt: string | null;
  readonly goldenEqual: boolean;
  readonly mesEqual: boolean;
  readonly erpStatus: string | null;
  readonly erpConfirmations: number;
  readonly confirmationsEqual: boolean;
  readonly differences: string[];
}

/**
 * Step 3, after the drain (exit criterion 4): every command still has exactly one `accepted` job
 * fact and each order's accepted quantities stay within its quantity; no order or execution
 * incident; at least three orders complete in shift A, and for each the live ground truth equals
 * orders-01's, the MES's execution and status equal the truth, and the ERP holds the status
 * `completed` and one final confirmation per routing operation whose yield, scrap, rework passes
 * and material equal the MES's confirmation and the ground truth.
 */
export async function checkOrdersAfterDrain(
  ctx: PassContext,
  truth: GroundTruth,
  golden: OrdersTruth,
  shiftEnd: number,
  operations: readonly string[],
) {
  // The MES plans line OEE as the plant runs: in orders mode (#232, MES_PRODUCTION_MODE from the
  // simulator's SIM_PRODUCTION in Compose).
  const line = await ctx.mes.lineOee('shift', new Date(shiftEnd - 3_600_000), new Date(shiftEnd));
  if (line.productionMode !== 'orders') {
    ctx.fail(`GET /oee/line answers productionMode ${line.productionMode}, not orders`);
  }
  const facts = await acceptedFacts(ctx.stack);
  const once = truth.orders.jobs.every((j) => facts[j.commandId] === 1);
  if (!once || Object.keys(facts).length !== truth.orders.jobs.length) {
    ctx.fail(`after the drain, accepted job facts per command: ${JSON.stringify(facts)}`);
  }
  for (const id of Object.keys(truth.orders.orders)) {
    const accepted = truth.orders.jobs
      .filter((j) => j.orderId === id)
      .reduce((s, j) => s + j.quantity, 0);
    // Against the dataset's quantity (the ERP's latest revision), which the MES must hold too.
    const ordered = (await ctx.erp.order(id)).order.quantity;
    const detail = await ctx.mes.order(id);
    if (accepted > ordered || detail.order.quantity !== ordered) {
      ctx.fail(
        `${id}: jobs accepted ${String(accepted)}, ERP order ${String(ordered)}, MES order ${String(detail.order.quantity)}`,
      );
    }
  }
  const incidents = await ctx.stack.sqlJson<unknown[]>(
    `SELECT coalesce(json_agg(t), '[]') FROM (
       SELECT 'orders' AS module, type, order_id, command_id, message FROM orders.order_incident
       UNION ALL
       SELECT 'execution', type, order_id, NULL, message FROM execution.execution_incident) AS t`,
  );
  if (incidents.length > 0) ctx.fail(`order or execution incidents: ${JSON.stringify(incidents)}`);

  const completed = Object.entries(truth.orders.orders)
    .filter(([, o]) => o.completedAt !== null && Date.parse(o.completedAt) < shiftEnd)
    .map(([id]) => id)
    .sort();
  // The scenario's promise (at least three), and exactly the golden run's set (five in orders-01).
  if (completed.length < 3) {
    ctx.fail(
      `${String(completed.length)} orders completed in shift A, not at least 3: ${completed.join(', ')}`,
    );
  }
  const goldenCompleted = Object.entries(golden.orders)
    .filter(([, o]) => o.completedAt !== null && Date.parse(o.completedAt) < shiftEnd)
    .map(([id]) => id)
    .sort();
  if (JSON.stringify(completed) !== JSON.stringify(goldenCompleted)) {
    ctx.fail(
      `orders completed in shift A: live ${completed.join(', ')}, golden ${goldenCompleted.join(', ')}`,
    );
  }
  // The ERP has every completed order's confirmations and status (the outbox posts with backoff).
  await until(
    'the ERP holds every completed order as completed, with one confirmation per operation',
    async () => {
      for (const id of completed) {
        const view = await ctx.erp.order(id);
        if (view.status !== 'completed') return false;
        if ((await ctx.erp.confirmations(id)).confirmations.length !== operations.length) {
          return false;
        }
      }
      return true;
    },
    60_000,
  ).catch((error: unknown) => {
    ctx.fail(error instanceof Error ? error.message : String(error));
  });

  const report: Record<string, CompletedOrderReport> = {};
  for (const id of completed) {
    const order = truth.orders.orders[id];
    if (!order) continue;
    const differences: string[] = [];
    // The live ground truth of the order equals orders-01's (it completed inside shift A).
    const pick = (o: OrdersTruth['orders'][string] | undefined) =>
      o === undefined
        ? null
        : {
            jobs: o.jobs,
            quantity: o.quantity,
            started: o.started,
            scrap: o.scrap,
            reworkPasses: o.reworkPasses,
            packedGood: o.packedGood,
            completedAt: o.completedAt,
            operations: o.operations,
            material: o.material,
          };
    const goldenDiffs = jsonDifferences(pick(golden.orders[id]), pick(order));
    differences.push(...goldenDiffs.map((d) => `golden: ${d}`));
    // The MES: execution and status equal the truth.
    const [detail, execution] = await Promise.all([ctx.mes.order(id), ctx.mes.orderExecution(id)]);
    const material: Record<string, number> = {};
    for (const op of execution.operations) {
      for (const [item, n] of Object.entries(op.material))
        material[item] = (material[item] ?? 0) + n;
    }
    const mesDiffs = jsonDifferences(
      {
        status: 'completed',
        short: order.packedGood < detail.order.quantity,
        operations: Object.fromEntries(
          operations.map((op) => [
            op,
            order.operations[op] ?? { in: 0, good: 0, scrap: 0, rework: 0 },
          ]),
        ),
        scrap: order.scrap,
        reworkPasses: order.reworkPasses,
        packedGood: order.packedGood,
        material: counts(order.material),
        completedAt: order.completedAt,
        wip: 0,
      },
      {
        status: detail.order.status,
        short: detail.order.flags.short,
        operations: Object.fromEntries(
          operations.map((op) => {
            const o = execution.operations.find((x) => x.operation === op);
            return [
              op,
              {
                in: o?.in ?? 0,
                good: o?.good ?? 0,
                scrap: Object.values(o?.scrap ?? {}).reduce((s, n) => s + n, 0),
                rework: o?.rework ?? 0,
              },
            ];
          }),
        ),
        scrap: execution.scrap,
        reworkPasses: execution.reworkPasses,
        packedGood: execution.packedGood,
        material: counts(material),
        completedAt: execution.completedAt,
        wip: execution.units.wip,
      },
    );
    differences.push(...mesDiffs.map((d) => `MES: ${d}`));
    // Confirmations: the truth's per operation = the MES's final one = the ERP's one per operation.
    const [erpView, erpList] = await Promise.all([ctx.erp.order(id), ctx.erp.confirmations(id)]);
    const expected = operations.map((op) => {
      const materials = new Set(
        detail.bom.filter((b) => b.operation === op).map((b) => b.material),
      );
      return {
        operation: op,
        kind: 'final',
        n: 1,
        yield: order.operations[op]?.good ?? 0,
        scrap: counts(order.scrap[op] ?? {}),
        reworkPasses: order.operations[op]?.rework ?? 0,
        material: counts(
          Object.fromEntries(Object.entries(order.material).filter(([m]) => materials.has(m))),
        ),
      };
    });
    const mesConfirmations = operations.map((op) => {
      const list = detail.confirmations.filter((c) => c.operation === op);
      const c = list[0];
      return {
        operation: op,
        kind: list.length === 1 ? c?.kind : `${String(list.length)} confirmations`,
        n: c?.n,
        yield: c?.yield,
        scrap: counts(c?.scrap ?? {}),
        reworkPasses: c?.reworkPasses,
        material: counts(c?.material ?? {}),
      };
    });
    const sentAll = detail.confirmations.every((c) => c.messageStatus === 'sent');
    const erpConfirmations = operations.map((op) => {
      const list = erpList.confirmations.filter((c) => c.body.operation === op);
      const c = list[0]?.body;
      return {
        operation: op,
        kind: list.length === 1 ? c?.kind : `${String(list.length)} confirmations`,
        n: c?.confirmation,
        yield: c?.yield,
        scrap: lines(c?.scrap ?? []),
        reworkPasses: c?.reworkPasses,
        material: lines(c?.material ?? []),
      };
    });
    const erpTotals = operations.map((op) => {
      const t = erpView.operations.find((o) => o.operation === op);
      return {
        operation: op,
        // The view counts messages (1: the final one alone); it carries no confirmation number,
        // so `n` is left out on both sides.
        kind: t?.confirmations === 1 ? 'final' : `${String(t?.confirmations)} confirmations`,
        yield: t?.yield,
        scrap: lines(t?.scrap ?? []),
        reworkPasses: t?.reworkPasses,
        material: lines(t?.material ?? []),
      };
    });
    const confirmationDiffs = [
      ...jsonDifferences(expected, mesConfirmations).map((d) => `MES confirmation: ${d}`),
      ...jsonDifferences(expected, erpConfirmations).map((d) => `ERP confirmation: ${d}`),
      ...jsonDifferences(
        expected.map((e) => ({ ...e, n: undefined })),
        erpTotals,
      ).map((d) => `ERP totals: ${d}`),
      ...(sentAll ? [] : ['an MES confirmation is not sent']),
      ...(erpView.status === 'completed' ? [] : [`ERP status ${String(erpView.status)}`]),
      ...(erpView.short === order.packedGood < detail.order.quantity ? [] : ['ERP short flag']),
    ];
    differences.push(...confirmationDiffs);
    report[id] = {
      completedAt: order.completedAt,
      goldenEqual: goldenDiffs.length === 0,
      mesEqual: mesDiffs.length === 0,
      erpStatus: erpView.status,
      erpConfirmations: erpList.confirmations.length,
      confirmationsEqual: confirmationDiffs.length === 0,
      differences,
    };
    if (differences.length > 0) ctx.fail(`${id}:\n  ${differences.join('\n  ')}`);
  }
  // The others: in progress, dispatched with no unit yet, never released.
  const statuses: Record<string, string> = {};
  for (const o of await listOrders(ctx)) statuses[o.id] = o.status;
  return { acceptedFacts: facts, incidents: incidents.length, completed: report, statuses };
}

/** A problem answer's status and type. */
async function answer(
  promise: Promise<{ status: number; text: string }>,
): Promise<{ status: number; type: string | null }> {
  const { status, text } = await promise;
  try {
    return { status, type: (JSON.parse(text) as { type?: string }).type ?? null };
  } catch {
    return { status, type: null };
  }
}

/**
 * Step 4: the new refusals on the live order path (the stack smoke checks those it can reach on a
 * schedule-mode stack): a close before every operation is signed off, an abandon while the
 * command's run goes on, a re-dispatch of a completed order, a dispatch before the release, a stale
 * version, terminal writes without a crew row or with a desk session, a sign-on without the
 * permission, a sign-off of an operation not complete. None changes an order (versions asserted).
 */
export async function checkRefusals(
  ctx: PassContext,
  users: {
    readonly supervisor: string;
    readonly operator: { username: string; password: string };
    readonly operator2: { username: string; password: string };
    readonly maintenance: { username: string; password: string };
  },
  ids: { readonly completed: string; readonly running: string; readonly unreleased: string },
) {
  const base = ctx.mes.base;
  const version = async (id: string) => (await ctx.mes.order(id)).order.version;
  const before = {
    completed: await version(ids.completed),
    running: await version(ids.running),
    unreleased: await version(ids.unreleased),
  };
  const runningCommand = (await ctx.mes.order(ids.running)).commands[0]?.commandId ?? '';
  const post = (path: string, body: unknown, cookie: string) =>
    answer(mesWrite(base, 'POST', path, body, cookie));
  const order = (id: string, action: string) =>
    `/api/v1/orders/${encodeURIComponent(id)}/${action}`;
  const operation = (wc: string, id: string, op: string, action: string) =>
    `/api/v1/terminal/${wc}/orders/${encodeURIComponent(id)}/operations/${op}/${action}`;

  const operatorDesk = await mesLogin(base, users.operator.username, users.operator.password);
  const maintenance = await mesLogin(base, users.maintenance.username, users.maintenance.password);
  const operator2 = await mesLogin(
    base,
    users.operator2.username,
    users.operator2.password,
    'terminal',
  );
  // One at a time (the per-user write bucket), in this order.
  const results: { name: string; status: number; type: string | null; ok: boolean }[] = [];
  const check = async (
    name: string,
    run: () => Promise<{ status: number; type: string | null }>,
    status: number,
    type: string,
  ) => {
    const got = await run();
    const ok = got.status === status && got.type === type;
    results.push({ name, ...got, ok });
    if (!ok)
      ctx.fail(
        `refusal "${name}": ${String(got.status)} ${String(got.type)}, not ${String(status)} ${type}`,
      );
  };
  await check(
    'close before every operation is signed off',
    () => post(order(ids.completed, 'close'), { version: before.completed }, users.supervisor),
    409,
    'urn:shopfloor:sign-off-missing',
  );
  await check(
    'abandon a command while its run goes on',
    () =>
      post(
        order(ids.running, 'abandon-command'),
        { version: before.running, commandId: runningCommand },
        users.supervisor,
      ),
    409,
    'urn:shopfloor:order-state',
  );
  await check(
    'redispatch a completed order',
    () => post(order(ids.completed, 'redispatch'), { version: before.completed }, users.supervisor),
    409,
    'urn:shopfloor:order-state',
  );
  await check(
    'dispatch an order not released',
    () => post(order(ids.unreleased, 'dispatch'), { version: before.unreleased }, users.supervisor),
    409,
    'urn:shopfloor:order-state',
  );
  await check(
    'release with a stale version',
    () =>
      post(order(ids.unreleased, 'release'), { version: before.unreleased + 1 }, users.supervisor),
    409,
    'urn:shopfloor:order-stale',
  );
  await check(
    'start work without a crew row',
    () =>
      post(
        operation('line-a1', ids.running, 'OP30', 'start'),
        { activity: null },
        operatorDesk.cookie,
      ),
    409,
    'urn:shopfloor:not-signed-on',
  );
  await check(
    'sign on with a desk session',
    () => post('/api/v1/terminal/line-a1/sign-on', {}, operatorDesk.cookie),
    409,
    'urn:shopfloor:terminal-session-required',
  );
  await check(
    'sign on as maintenance (no terminal:operate)',
    () => post('/api/v1/terminal/line-a1/sign-on', {}, maintenance.cookie),
    403,
    'urn:shopfloor:forbidden',
  );
  await check(
    'an order write as an operator',
    () =>
      post(order(ids.unreleased, 'release'), { version: before.unreleased }, operatorDesk.cookie),
    403,
    'urn:shopfloor:forbidden',
  );
  // Signed on with a terminal session: a sign-off of an operation the MES has not complete.
  const signOn = await post('/api/v1/terminal/line-a1/sign-on', {}, operator2.cookie);
  if (signOn.status !== 200)
    ctx.fail(`operator2 sign-on for the refusals: ${JSON.stringify(signOn)}`);
  const view = await new MesClient(base, operator2.cookie).terminal('line-a1');
  const open = view.orders
    .find((o) => o.order.id === ids.running)
    ?.operations.find((o) => o.operation === 'OP30');
  await check(
    'sign off an operation not complete',
    () =>
      post(
        operation('line-a1', ids.running, 'OP30', 'sign-off'),
        { version: open?.version ?? 1 },
        operator2.cookie,
      ),
    409,
    'urn:shopfloor:operation-state',
  );
  await post('/api/v1/terminal/line-a1/sign-off', {}, operator2.cookie);
  for (const cookie of [operator2.cookie, operatorDesk.cookie, maintenance.cookie]) {
    // A logout may end the connection with the session: its answer is not part of the check.
    await mesWrite(base, 'DELETE', '/api/v1/session', {}, cookie).catch(() => undefined);
  }
  const after = {
    completed: await version(ids.completed),
    running: await version(ids.running),
    unreleased: await version(ids.unreleased),
  };
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    ctx.fail(`a refused write changed an order: ${JSON.stringify({ before, after })}`);
  }
  return { refusals: results, versions: before };
}

/** The most events one stepping may take (the report sets each stepping's count against it). */
export const MAX_STEPS = 5_000;

/**
 * Steps the paused simulator event by event (control API `step`) until `done` holds, checked every
 * 20 events, with 10 ms between events. At each check the MES must have caught up: every machine's
 * current state and its start equal the simulator's (the state facts went through the gateway and
 * the broker). The gateway's buffer depth is no signal here: the washer's Modbus poller publishes
 * every 250 ms even while the simulator is paused, so a poll phase-locked to it sees a message in
 * flight every time. Resolves with the number of events stepped.
 */
export async function stepUntil(
  ctx: PassContext,
  what: string,
  done: () => Promise<boolean>,
  maxSteps = MAX_STEPS,
): Promise<number> {
  let steps = 0;
  for (;;) {
    if (!(await ctx.sim.step())) throw new Error(`the run ended before ${what}`);
    steps++;
    if (steps % 20 === 0) {
      const truth = await ctx.sim.groundTruth();
      let behind: string[] = [];
      await until(
        'the MES caught up with the stepped simulator',
        async () => {
          const { equipment } = await ctx.mes.equipment();
          behind = Object.entries(truth.current)
            .filter(([id, expected]) => {
              const known = equipment.find((e) => e.id === id)?.current;
              return (
                known?.state !== expected.state ||
                Date.parse(known.since) !== Date.parse(expected.since)
              );
            })
            .map(([id]) => id);
          return behind.length === 0;
        },
        60_000,
      ).catch((error: unknown) => {
        throw new Error(`${String(error)} after ${String(steps)} steps: ${behind.join(', ')}`, {
          cause: error,
        });
      });
      if (await done()) return steps;
    }
    if (steps > maxSteps) throw new Error(`not ${what} within ${String(maxSteps)} steps`);
    await sleep(10);
  }
}

/**
 * Step 5: the simulator, paused after shift A, is stepped event by event (control API `step`)
 * until the ground truth has `order`'s first scrap (orders-01: CNC-01's OP10 scrap of PO-2610-007,
 * Tuesday 12:49 Istanbul, about 500 events on), a little at a time so the gateway keeps up; then
 * the MES must list its scrap record. No scrap happens in shift A of any golden scenario, and
 * stepping is the only way to reach one without pacing a whole day.
 */
export async function stepToScrap(ctx: PassContext, order: string) {
  const startedAt = Date.now();
  const steps = await stepUntil(ctx, `a scrap of ${order}`, async () => {
    const truth = await ctx.sim.groundTruth();
    return Object.keys(truth.orders.orders[order]?.scrap ?? {}).length > 0;
  });
  const status = await ctx.sim.status();
  let records = 0;
  await until(
    `the MES lists ${order}'s scrap record`,
    async () => {
      records = (await ctx.mes.scrapRecords(order)).records.length;
      return records > 0;
    },
    60_000,
  );
  return {
    steps,
    maxSteps: MAX_STEPS,
    simTime: status.simTime,
    wallMs: Date.now() - startedAt,
    records,
  };
}

/**
 * Step 6, after the terminal checks: the closed order is `closed` in the ERP; every action of the
 * operators and the supervisor is in `identity.audit_log` with the user, a role of theirs,
 * `authenticated` and the request id; the operator's sign-on during shift A wrote a crew row at
 * Line A1, ended by the sign-off.
 */
export async function checkAuditAndClose(
  ctx: PassContext,
  closed: string,
  users: { readonly supervisor: string; readonly operator: string; readonly operator2: string },
  shiftKey: string,
) {
  let erpStatus: string | null = null;
  await until(
    `the ERP shows ${closed} closed`,
    async () => {
      erpStatus = (await ctx.erp.order(closed)).status;
      return erpStatus === 'closed';
    },
    60_000,
  ).catch((error: unknown) => {
    ctx.fail(error instanceof Error ? error.message : String(error));
  });
  const names = [users.supervisor, users.operator, users.operator2];
  const rows = await ctx.stack.sqlJson<
    {
      action: string;
      username: string;
      roles: string[];
      authenticated: boolean;
      requestId: string | null;
      entity: string;
    }[]
  >(
    `SELECT coalesce(json_agg(json_build_object('action', action, 'username', username,
       'roles', roles, 'authenticated', authenticated, 'requestId', request_id,
       'entity', entity_type || ':' || entity_id) ORDER BY id), '[]')
     FROM identity.audit_log WHERE username IN (${names.map((n) => `'${n}'`).join(', ')})`,
  );
  const tally = (user: string) => {
    const counted: Record<string, number> = {};
    for (const row of rows.filter((r) => r.username === user)) {
      counted[row.action] = (counted[row.action] ?? 0) + 1;
    }
    return counted;
  };
  const expected: Record<string, Record<string, number>> = {
    // At least: live sign-on, start, pause, resume, sign-off; three operation sign-offs at Line A1;
    // the scrap draft at Cell M1 and the return to it (sign-on and sign-off each, no coding).
    [users.operator]: {
      'session.login': 4,
      'crew.sign-on': 4,
      'operation.start': 1,
      'operation.pause': 1,
      'operation.resume': 1,
      'operation.sign-off': 3,
      'crew.sign-off': 4,
    },
    // The refusals' sign-on, the look at the draft, the coding and the Cell M1 sign-offs.
    [users.operator2]: {
      'crew.sign-on': 3,
      'scrap.code': 1,
      'operation.sign-off': 2,
      'crew.sign-off': 3,
    },
    [users.supervisor]: { 'order.release': 8, 'order.dispatch': 8, 'order.close': 1 },
  };
  const found: Record<string, Record<string, number>> = {};
  for (const [user, want] of Object.entries(expected)) {
    const got = tally(user);
    found[user] = got;
    for (const [action, n] of Object.entries(want)) {
      if ((got[action] ?? 0) < n) {
        ctx.fail(
          `audit: ${user} has ${String(got[action] ?? 0)} ${action}, at least ${String(n)} expected`,
        );
      }
    }
  }
  // The operator's scrap draft was never saved: no scrap.code by them.
  if ((found[users.operator]?.['scrap.code'] ?? 0) !== 0)
    ctx.fail('audit: the first operator coded scrap');
  const role = (user: string) => (user === users.supervisor ? 'supervisor' : 'operator');
  const bad = rows.filter(
    (r) =>
      !r.authenticated ||
      !r.roles.includes(role(r.username)) ||
      (r.requestId === null && !r.action.startsWith('session.')),
  );
  if (bad.length > 0)
    ctx.fail(`audit rows without user, role, authentication or request id: ${JSON.stringify(bad)}`);
  const crew = await ctx.stack.sqlJson<
    { username: string; workCenter: string; shiftKey: string; endReason: string | null }[]
  >(
    `SELECT coalesce(json_agg(json_build_object('username', username, 'workCenter', work_center,
       'shiftKey', shift_key, 'endReason', end_reason) ORDER BY id), '[]') FROM shifts.crew_assignment`,
  );
  const live = crew.find(
    (c) => c.username === users.operator && c.workCenter === 'line-a1' && c.shiftKey === shiftKey,
  );
  if (live?.endReason !== 'sign-off') {
    ctx.fail(
      `no crew row of ${users.operator} at line-a1 in ${shiftKey} ended by sign-off: ${JSON.stringify(crew)}`,
    );
  }
  const open = crew.filter((c) => c.endReason === null);
  if (open.length > 0) ctx.fail(`crew rows still open: ${JSON.stringify(open)}`);
  return { erpStatus, audit: found, auditRows: rows.length, crew };
}

/**
 * The ERP's state as the MES's messages made it: every order's view and every message; with
 * `lots` (the quality pass, #204), the quality notifications and those lots' views too.
 */
async function erpState(erp: ErpClient, ids: readonly string[], lots: readonly string[] = []) {
  const views: Record<string, unknown> = {};
  for (const id of ids) views[id] = await erp.order(id);
  const lotViews: Record<string, unknown> = {};
  for (const id of lots) lotViews[id] = await erp.lot(id);
  return {
    views,
    confirmations: (await erp.confirmations()).confirmations,
    statusMessages: (await erp.statusMessages()).messages,
    qualityNotifications: (await erp.qualityNotifications()).notifications,
    lotViews,
  };
}

/**
 * Step 7 (exit criterion 4, last clause): the MES's whole outbox is posted again after an MES
 * restart, as after a crash between the ERP's answer and the MES's commit: every outbound message
 * set back to `pending`, the MES restarted, and once it has posted them all again (the ERP answers
 * each replay 200 with its stored receipt) the ERP's views, confirmations and status messages are
 * byte-identical to before.
 */
export async function repostOutbox(
  ctx: PassContext,
  ids: readonly string[],
  lots: readonly string[] = [],
  /** Message kinds that must be among the messages posted again (#204 review LOW 4). */
  requiredKinds: readonly string[] = [],
) {
  const unsent = () =>
    ctx.stack.sqlJson<number>(
      `SELECT count(*) FROM orders.erp_message_log WHERE direction = 'out' AND status <> 'sent'`,
    );
  // Nothing on its way first, so the snapshot is the ERP's state after every message.
  await until(
    'the outbox drained before the snapshot',
    async () => (await unsent()) === 0,
    120_000,
  );
  const before = await erpState(ctx.erp, ids, lots);
  const postsBefore = await ctx.erp.postCounts();
  // As after a crash between the ERP's answer and the MES's commit: the MES stopped, every sent
  // message pending again, the MES started.
  await ctx.stack.compose(['stop', 'mes']);
  const resetByKind = await ctx.stack.sqlJson<Record<string, number>>(
    `WITH t AS (UPDATE orders.erp_message_log SET status = 'pending', next_attempt_at = NULL
       WHERE direction = 'out' AND status = 'sent' RETURNING kind)
     SELECT coalesce(json_object_agg(kind, n), '{}') FROM (SELECT kind, count(*) AS n FROM t GROUP BY kind) AS k`,
  );
  const reset = Object.values(resetByKind).reduce((a, n) => a + n, 0);
  if (reset === 0) ctx.fail('no sent message in the outbox to post again');
  for (const kind of requiredKinds) {
    if ((resetByKind[kind] ?? 0) === 0) ctx.fail(`no ${kind} message among those posted again`);
  }
  ctx.log(`set ${String(reset)} sent messages back to pending; starting the MES again`);
  await ctx.stack.compose(['start', 'mes']);
  // The restarted container gets a new ephemeral host port (e2e/compose.reconcile.yml).
  const restarted = new MesClient(await ctx.stack.url('mes', 4700));
  await until('MES ready after the restart', () => restarted.ready(), 120_000);
  let pending = -1;
  await until(
    'the MES posted its outbox again',
    async () => {
      pending = await ctx.stack.sqlJson<number>(
        `SELECT count(*) FROM orders.erp_message_log WHERE direction = 'out' AND status <> 'sent'`,
      );
      return pending === 0;
    },
    120_000,
  ).catch((error: unknown) => {
    ctx.fail(error instanceof Error ? error.message : String(error));
  });
  const reposted = await ctx.stack.sqlJson<number>(
    `SELECT count(*) FROM orders.erp_message_log WHERE direction = 'out' AND attempts >= 2`,
  );
  const after = await erpState(ctx.erp, ids, lots);
  const postsAfter = await ctx.erp.postCounts();
  // The ERP's own count of what the posts did: every message posted again was a replay, none new.
  const posts = {
    replayed: postsAfter.replayed - postsBefore.replayed,
    created: postsAfter.created - postsBefore.created,
    other: postsAfter.other - postsBefore.other,
  };
  if (posts.replayed !== reset || posts.created !== 0 || posts.other !== 0) {
    ctx.fail(`ERP posts while the outbox was posted again: ${JSON.stringify({ reset, posts })}`);
  }
  // Per kind too: each kind's messages set back to pending were replayed, none created.
  const kinds = [...new Set([...Object.keys(resetByKind), ...Object.keys(postsAfter.byKind)])];
  const postsByKind = Object.fromEntries(
    kinds.map((kind) => {
      const a = postsAfter.byKind[kind] ?? { created: 0, replayed: 0, other: 0 };
      const b = postsBefore.byKind[kind] ?? { created: 0, replayed: 0, other: 0 };
      return [
        kind,
        {
          reset: resetByKind[kind] ?? 0,
          replayed: a.replayed - b.replayed,
          created: a.created - b.created,
          other: a.other - b.other,
        },
      ];
    }),
  );
  for (const [kind, d] of Object.entries(postsByKind)) {
    if (d.replayed !== d.reset || d.created !== 0 || d.other !== 0) {
      ctx.fail(`ERP ${kind} posts while the outbox was posted again: ${JSON.stringify(d)}`);
    }
  }
  const diffs = jsonDifferences(before, after);
  if (diffs.length > 0) {
    ctx.fail(
      `the ERP changed when the outbox was posted again:\n  ${diffs.slice(0, 20).join('\n  ')}`,
    );
  }
  if (reposted < reset) ctx.fail(`${String(reposted)} of ${String(reset)} messages posted again`);
  return {
    messages: reset,
    reposted,
    pending,
    confirmations: after.confirmations.length,
    statusMessages: after.statusMessages.length,
    qualityNotifications: after.qualityNotifications.length,
    erpUnchanged: diffs.length === 0,
    erpPosts: posts,
    erpPostsByKind: postsByKind,
  };
}

// ---- Order and line OEE (#233, Phase 9 exit criterion 2) ----

/** orders-01 completes exactly these many orders in shift A (the golden run's set, plan rev. 9). */
export const SHIFT_A_COMPLETED = 5;

/** How long the MES may take to call an order's or shift A's OEE final after the drain. */
const OEE_FINAL_WAIT_MS = 120_000;

const ratioJson = z.object({ fraction: z.string(), decimal: z.string() });
type RatioJson = z.infer<typeof ratioJson>;

/** `oee-core`'s result as JSON: the ratios read here, every other key kept for the equality. */
const oeeResultJson = z.looseObject({
  availability: ratioJson.nullable(),
  performance: ratioJson.nullable(),
  quality: ratioJson.nullable(),
  oee: ratioJson.nullable(),
});

const lineValueJson = z.object({
  from: z.string(),
  to: z.string(),
  plannedBusyMs: z.number().int(),
  good: z.record(z.string(), z.number().int()),
  idealMs: z.string(),
  oee: ratioJson.nullable(),
  aboveOne: z.boolean(),
  provisional: z.boolean(),
});

const truthOrderOee = z.object({
  product: z.string(),
  jobs: z.array(z.string()),
  jobOee: z.record(z.string(), z.looseObject({ oee: oeeResultJson.nullable() })),
  oee: oeeResultJson,
  open: z.boolean(),
  pending: z.boolean(),
  headTimeUnknown: z.boolean(),
  endLost: z.boolean(),
  lost: z.boolean(),
  firstPassYield: z.object({
    firstPassGood: z.number().int(),
    started: z.number().int(),
    yield: ratioJson.nullable(),
  }),
  completedAt: z.string().nullable(),
  line: lineValueJson.nullable(),
});

/**
 * The order and line OEE truth (`line-oee.json`, `sim-line-oee/1`; the live ground truth's
 * `lineOee`, cut by `?asOf`, control API 1.8): the parts this pass compares.
 */
export const lineOeeTruthSchema = z.object({
  config: z.looseObject({ productionMode: z.string() }),
  bottlenecks: z.record(
    z.string(),
    z.object({
      operation: z.string(),
      equipment: z.array(z.string()),
      idealCycleMs: z.number().int(),
      effectiveCycleMs: z.string(),
    }),
  ),
  line: z.object({
    hours: z.record(z.string(), lineValueJson),
    shifts: z.record(z.string(), lineValueJson),
  }),
  orders: z.record(z.string(), truthOrderOee),
});
export type LineOeeTruth = z.infer<typeof lineOeeTruthSchema>;
type TruthOrderOee = z.infer<typeof truthOrderOee>;

/** The truth's head sources; the MES's others (`acceptedAt`, `previous-last-cycle`) are null there. */
const HEAD_SOURCES_IN_TRUTH = new Set(['accepted', 'previous-completed', 'notBefore']);

/**
 * The MES's order OEE (`GET /oee/orders/{id}`) in the truth's shape, as the golden reconciliation
 * of P9-04 compares them (apps/mes-server/src/order-oee.test-support.ts, `oeeShape`).
 */
function mesOrderShape(dto: OrderOeeDto) {
  return {
    product: dto.product,
    jobs: dto.jobs.map((job) => job.commandId),
    jobOee: Object.fromEntries(
      dto.jobs.map((job) => [
        job.commandId,
        {
          machine: job.machine,
          headTime: job.head.at,
          headSource:
            job.head.source !== null && HEAD_SOURCES_IN_TRUTH.has(job.head.source)
              ? job.head.source
              : null,
          window:
            job.window === null
              ? null
              : { from: job.window.from, to: job.window.to, open: job.window.open },
          cycles: job.cycles,
          oee: job.oee,
        },
      ]),
    ),
    oee: dto.oee,
    open: dto.open,
    pending: dto.pending,
    headTimeUnknown: dto.headTimeUnknown,
    endLost: dto.endLost,
    lost: dto.lost,
    firstPassYield: {
      firstPassGood: dto.firstPassYield.firstPassGood,
      started: dto.firstPassYield.started,
      yield: dto.firstPassYield.yield,
    },
    completedAt: dto.completedAt,
  };
}

/** The truth's order without its line part (compared on its own). */
function truthOrderShape(truth: TruthOrderOee): Omit<TruthOrderOee, 'line'> {
  return { ...truth, line: undefined } as Omit<TruthOrderOee, 'line'>;
}

/** A line value without the truth's `provisional` and the MES's finality fields. */
function lineShape(value: {
  readonly from: string;
  readonly to: string;
  readonly plannedBusyMs: number;
  readonly good: Readonly<Record<string, number>>;
  readonly idealMs: string;
  readonly oee: RatioJson | null;
  readonly aboveOne: boolean;
}) {
  const { from, to, plannedBusyMs, good, idealMs, oee, aboveOne } = value;
  return { from, to, plannedBusyMs, good, idealMs, oee, aboveOne };
}

/** What the OEE checks expect on screen: the truth's values of each order and of shift A. */
export interface OeeExpected {
  readonly orders: Readonly<
    Record<
      string,
      {
        readonly oee: z.infer<typeof oeeResultJson>;
        readonly firstPassYield: TruthOrderOee['firstPassYield'];
        readonly line: RatioJson | null;
        readonly lineAboveOne: boolean | null;
        /** Each job in acceptance order: its OEE's four decimals (`n/a` when null). */
        readonly jobs: readonly { readonly id: string; readonly oee: string }[];
      }
    >
  >;
  readonly shiftKey: string;
  readonly line: RatioJson | null;
  readonly lineAboveOne: boolean | null;
  readonly bottlenecks: LineOeeTruth['bottlenecks'];
}

/**
 * Phase 9 exit criterion 2 through the API (#233), after the drain: the live ground truth cut at
 * the end of shift A (`?asOf`, the line OEE truth as a run that ended there gives it) completes
 * exactly `SHIFT_A_COMPLETED` orders, the golden run's set, each equal to `line-oee.json`'s, and
 * the MES's orders completed before the cut are the same; the MES calls each one's order OEE, first-pass yield and own line OEE final (waited for) and equal
 * to the truth's, with no incident under them; shift A's line OEE and each of its hours are final
 * and equal, and the bottleneck per product is the truth's.
 */
export async function checkOrderOee(
  ctx: PassContext,
  cut: { readonly from: number; readonly to: number; readonly shiftKey: string },
  golden: LineOeeTruth,
) {
  const asOf = new Date(cut.to).toISOString();
  const json = await ctx.sim.groundTruthJson(asOf);
  if (json.lineOeeAsOf !== asOf) {
    ctx.fail(`the ground truth's lineOee is cut at ${String(json.lineOeeAsOf)}, not ${asOf}`);
  }
  const truth = lineOeeTruthSchema.parse(json.lineOee);
  if (truth.config.productionMode !== 'orders') {
    ctx.fail(`the live line OEE truth runs in ${truth.config.productionMode} mode, not orders`);
  }
  const completedIn = (orders: LineOeeTruth['orders']) =>
    Object.entries(orders)
      .filter(([, o]) => o.completedAt !== null && Date.parse(o.completedAt) < cut.to)
      .map(([id]) => id)
      .sort();
  const completed = completedIn(truth.orders);
  const goldenCompleted = completedIn(golden.orders);
  if (completed.length !== SHIFT_A_COMPLETED || goldenCompleted.length !== SHIFT_A_COMPLETED) {
    ctx.fail(
      `orders completed in shift A: live ${String(completed.length)} (${completed.join(', ')}), golden ${String(goldenCompleted.length)}, not exactly ${String(SHIFT_A_COMPLETED)}`,
    );
  }
  if (JSON.stringify(completed) !== JSON.stringify(goldenCompleted)) {
    ctx.fail(
      `orders completed in shift A: live ${completed.join(', ')}, golden ${goldenCompleted.join(', ')}`,
    );
  }
  // The MES's own set: its orders completed before the cut are the same (#233 review), from a
  // whole list (#257).
  const mesCompleted = (await listOrders(ctx))
    .filter((o) => o.completedAt !== null && Date.parse(o.completedAt) < cut.to)
    .map((o) => o.id)
    .sort();
  if (JSON.stringify(mesCompleted) !== JSON.stringify(completed)) {
    ctx.fail(
      `orders the MES completed in shift A: ${mesCompleted.join(', ')}, the truth's ${completed.join(', ')}`,
    );
  }

  const orders: Record<
    string,
    {
      oee: string | null;
      firstPassYield: string | null;
      line: string | null;
      final: boolean;
      goldenEqual: boolean;
      mesEqual: boolean;
      differences: string[];
    }
  > = {};
  const expected: Record<string, OeeExpected['orders'][string]> = {};
  for (const id of completed) {
    const t = truth.orders[id];
    if (!t) continue;
    const differences: string[] = [];
    // The live truth of an order completed before the cut is the golden run's.
    const goldenDiffs = jsonDifferences(golden.orders[id] ?? null, t);
    differences.push(...goldenDiffs.map((d) => `golden: ${d}`));
    let dto: OrderOeeDto | undefined;
    await until(
      `${id}'s order OEE, first-pass yield and line OEE final`,
      async () => {
        dto = await ctx.mes.orderOee(id);
        return dto.final && dto.firstPassYield.final && dto.line?.final === true;
      },
      OEE_FINAL_WAIT_MS,
    ).catch((error: unknown) => {
      differences.push(error instanceof Error ? error.message : String(error));
    });
    const mesDiffs = dto
      ? [
          ...jsonDifferences(truthOrderShape(t), mesOrderShape(dto)).map((d) => `order: ${d}`),
          ...jsonDifferences(t.line && lineShape(t.line), dto.line && lineShape(dto.line)).map(
            (d) => `line: ${d}`,
          ),
          ...(t.line?.provisional === false ? [] : ['the truth’s line is provisional at the cut']),
          ...(dto.incidents.length === 0 && !dto.mayRevise && dto.revision === 0
            ? []
            : [
                `incidents ${String(dto.incidents.length)}, mayRevise ${String(dto.mayRevise)}, revision ${String(dto.revision)}`,
              ]),
          ...(dto.status === 'completed' ? [] : [`status ${dto.status}`]),
        ]
      : ['no answer'];
    differences.push(...mesDiffs.map((d) => `MES: ${d}`));
    orders[id] = {
      oee: dto?.oee.oee?.decimal ?? null,
      firstPassYield: dto?.firstPassYield.yield?.decimal ?? null,
      line: dto?.line?.oee?.decimal ?? null,
      final: dto?.final === true,
      goldenEqual: goldenDiffs.length === 0,
      mesEqual: mesDiffs.length === 0,
      differences,
    };
    expected[id] = {
      oee: t.oee,
      firstPassYield: t.firstPassYield,
      line: t.line?.oee ?? null,
      lineAboveOne: t.line?.aboveOne ?? null,
      jobs: t.jobs.map((job) => ({ id: job, oee: t.jobOee[job]?.oee?.oee?.decimal ?? 'n/a' })),
    };
    if (differences.length > 0) ctx.fail(`${id} order OEE:\n  ${differences.join('\n  ')}`);
  }

  // Shift A's line OEE and its hours, final and equal; the bottleneck per product.
  const truthShift = truth.line.shifts[cut.shiftKey];
  if (!truthShift || truthShift.provisional) {
    ctx.fail(`the truth has no final line OEE of ${cut.shiftKey}: ${JSON.stringify(truthShift)}`);
  }
  const truthHours = Object.entries(truth.line.hours)
    .filter(([key]) => Date.parse(key) >= cut.from && Date.parse(key) < cut.to)
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b));
  let shift: LineBucketDto | undefined;
  let hours: LineBucketDto[] = [];
  let bottlenecks: unknown;
  let productionMode = '';
  await until(
    `${cut.shiftKey}'s line OEE and its hours final`,
    async () => {
      const [shifts, hourly] = await Promise.all([
        ctx.mes.lineOee('shift', new Date(cut.from), new Date(cut.to)),
        ctx.mes.lineOee('hour', new Date(cut.from), new Date(cut.to)),
      ]);
      shift = shifts.buckets.find((b) => b.key === cut.shiftKey);
      hours = hourly.buckets;
      productionMode = shifts.productionMode;
      bottlenecks = Object.fromEntries(
        shifts.bottlenecks.map(({ product, ...rest }) => [product, rest]),
      );
      return shift?.final === true && hours.length > 0 && hours.every((h) => h.final);
    },
    OEE_FINAL_WAIT_MS,
  ).catch((error: unknown) => {
    ctx.fail(error instanceof Error ? error.message : String(error));
  });
  const lineDiffs = [
    ...jsonDifferences(truthShift && lineShape(truthShift), shift && lineShape(shift)).map(
      (d) => `shift: ${d}`,
    ),
    ...(shift?.incidents.length === 0 && !shift.mayRevise && shift.revision === 0
      ? []
      : [`shift incidents, mayRevise or revision: ${JSON.stringify(shift)}`]),
    ...jsonDifferences(
      truthHours.map(([, value]) => lineShape(value)),
      hours.map(lineShape),
    ).map((d) => `hours: ${d}`),
    ...jsonDifferences(truth.bottlenecks, bottlenecks).map((d) => `bottlenecks: ${d}`),
    ...(productionMode === 'orders' ? [] : [`productionMode ${productionMode}`]),
  ];
  if (truthHours.length !== 8) {
    ctx.fail(`the truth has ${String(truthHours.length)} hours in ${cut.shiftKey}, not 8`);
  }
  if (lineDiffs.length > 0) {
    ctx.fail(
      `${cut.shiftKey} line OEE (truth = expected, MES = actual):\n  ${lineDiffs.join('\n  ')}`,
    );
  }
  return {
    report: {
      asOf,
      completed,
      expectedCompleted: SHIFT_A_COMPLETED,
      goldenCompleted,
      mesCompleted,
      orders,
      line: {
        shiftKey: cut.shiftKey,
        oee: shift?.oee?.decimal ?? null,
        truth: truthShift?.oee?.decimal ?? null,
        aboveOne: shift?.aboveOne ?? null,
        final: shift?.final === true,
        hours: hours.length,
        hoursFinal: hours.filter((h) => h.final).length,
        equal: lineDiffs.length === 0,
      },
      bottlenecks: truth.bottlenecks,
    },
    expected: {
      orders: expected,
      shiftKey: cut.shiftKey,
      line: truthShift?.oee ?? null,
      lineAboveOne: truthShift?.aboveOne ?? null,
      bottlenecks: truth.bottlenecks,
    } satisfies OeeExpected,
  };
}

const screenRatio = z.object({ decimal: z.string(), fraction: z.string() });

/** What `browser/orders/oee` read from the page (`oee-screen.json`). */
const oeeScreenSchema = z.object({
  orders: z.record(
    z.string(),
    z.object({
      final: z.string().nullable(),
      incidents: z.string().nullable(),
      revision: z.string().nullable(),
      oee: screenRatio,
      availability: screenRatio,
      performance: screenRatio,
      quality: screenRatio,
      firstPassYield: z.object({
        final: z.string().nullable(),
        yield: screenRatio,
        firstPassGood: z.number(),
        started: z.number(),
      }),
      line: z.object({
        final: z.string().nullable(),
        aboveOne: z.string().nullable(),
        oee: screenRatio,
      }),
      jobs: z.array(
        z.object({ id: z.string(), oee: z.string().nullable(), final: z.string().nullable() }),
      ),
    }),
  ),
  line: z.object({
    key: z.string().nullable(),
    final: z.string().nullable(),
    aboveOne: z.string().nullable(),
    oee: screenRatio,
    bottlenecks: z.array(
      z.object({
        product: z.string(),
        operation: z.string().nullable(),
        equipment: z.string().nullable(),
      }),
    ),
    workCenterBottleneck: z.array(
      z.object({ id: z.string().nullable(), equipment: z.string().nullable() }),
    ),
  }),
});

/** A ratio as the page shows it: the four decimals and the fraction, `n/a` for both when null. */
const onScreen = (ratio: RatioJson | null) =>
  ratio === null
    ? { decimal: 'n/a', fraction: 'n/a' }
    : { decimal: ratio.decimal, fraction: ratio.fraction };

/**
 * Phase 9 exit criterion 2 on screen (#233): the values `browser/orders/oee` read from each order
 * detail and from the OEE dashboard equal the live truth's, every one marked final, for exactly
 * the expected orders (count asserted) and shift A's line: the order OEE, A, P, Q, first-pass
 * yield, each job's OEE and finality, the line values and their `aboveOne`, and the bottleneck.
 */
export function checkOeeScreen(ctx: PassContext, read: unknown, expected: OeeExpected) {
  const parsed = oeeScreenSchema.safeParse(read);
  if (!parsed.success) {
    ctx.fail(`oee-screen.json: ${parsed.error.message}`);
    return { orders: 0, equal: false };
  }
  const screen = parsed.data;
  const ids = Object.keys(expected.orders).sort();
  const shown = Object.keys(screen.orders).sort();
  const differences: string[] = [];
  if (shown.length !== SHIFT_A_COMPLETED || JSON.stringify(shown) !== JSON.stringify(ids)) {
    differences.push(`orders read: ${shown.join(', ')}; expected ${ids.join(', ')}`);
  }
  for (const id of ids) {
    const want = expected.orders[id];
    const got = screen.orders[id];
    if (!want || !got) continue;
    differences.push(
      ...jsonDifferences(
        {
          final: 'true',
          incidents: '0',
          revision: '0',
          oee: onScreen(want.oee.oee),
          availability: onScreen(want.oee.availability),
          performance: onScreen(want.oee.performance),
          quality: onScreen(want.oee.quality),
          firstPassYield: {
            final: 'true',
            yield: onScreen(want.firstPassYield.yield),
            firstPassGood: want.firstPassYield.firstPassGood,
            started: want.firstPassYield.started,
          },
          line: {
            final: 'true',
            aboveOne: want.lineAboveOne === null ? null : String(want.lineAboveOne),
            oee: onScreen(want.line),
          },
          jobs: want.jobs.map((job) => ({ ...job, final: 'true' })),
        },
        got,
      ).map((d) => `${id}: ${d}`),
    );
  }
  const bottlenecks = Object.entries(expected.bottlenecks).map(([product, b]) => ({
    product,
    operation: b.operation,
    equipment: b.equipment.join(','),
  }));
  differences.push(
    ...jsonDifferences(
      {
        key: expected.shiftKey,
        final: 'true',
        aboveOne: expected.lineAboveOne === null ? null : String(expected.lineAboveOne),
        oee: onScreen(expected.line),
        bottlenecks,
      },
      {
        key: screen.line.key,
        final: screen.line.final,
        aboveOne: screen.line.aboveOne,
        oee: screen.line.oee,
        bottlenecks: screen.line.bottlenecks,
      },
    ).map((d) => `line: ${d}`),
  );
  // The work center card names the same machines (the MES's answer, no constant of the web).
  const machines = [...new Set(Object.values(expected.bottlenecks).flatMap((b) => b.equipment))];
  const named = screen.line.workCenterBottleneck.flatMap((w) => (w.equipment ?? '').split(','));
  if (JSON.stringify([...new Set(named)].sort()) !== JSON.stringify(machines.sort())) {
    differences.push(`work center bottleneck ${named.join(', ')}, not ${machines.join(', ')}`);
  }
  if (differences.length > 0) {
    ctx.fail(
      `the order detail or the OEE dashboard shows other values than the truth (truth = expected):\n  ${differences.join('\n  ')}`,
    );
  }
  return {
    orders: shown.length,
    line: screen.line.oee.decimal,
    equal: differences.length === 0,
    differences,
  };
}
