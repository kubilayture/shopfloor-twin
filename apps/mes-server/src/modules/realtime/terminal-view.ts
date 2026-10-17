import {
  TERMINAL_LIMITS,
  type ActivityDto,
  type TerminalMachineDto,
  type TerminalOperationDto,
  type TerminalOrderDto,
  type TerminalQualityDto,
  type TerminalViewDto,
} from '@shopfloor/contracts/mes-api';
import type { CurrentState } from '../equipment/index.ts';
import type { Execution, OrderExecutionRecord } from '../execution/index.ts';
import type { Genealogy } from '../genealogy/index.ts';
import type { EquipmentInfo } from '../master-data/index.ts';
import type { ActivityRecord, OperationRecord, OrderRecord, Orders } from '../orders/index.ts';
import type { Holds, Quality, SignalRecord } from '../quality/index.ts';
import type { Shifts } from '../shifts/index.ts';
import { scrapRecordDto } from './execution-routes.ts';
import { holdDto } from './hold-routes.ts';
import { orderDto } from './order-dto.ts';
import { signalDto } from './quality-dto.ts';
import { crewDto } from './shift-dto.ts';

// The operator terminal's view of a work center (#177, plan "Operator terminal: Shows"): per
// machine its state and current job; the active orders with, per operation at this work center,
// in, good, scrap and rework, completion, sign-off and who works on it, and the order's WIP here;
// the queue of released and dispatched orders; the uncoded scrap records of its operations; who
// is signed on. The same content is `GET /terminal/{workCenter}` and the push topic
// `terminal:<workCenter>`.

/** What the view reads of the modules. */
export interface TerminalViewSources {
  readonly equipment: { currentStates(): CurrentState[] };
  readonly orders: Pick<Orders, 'list' | 'operations' | 'commands'>;
  readonly execution?: Pick<Execution, 'orderExecution' | 'scrapRecords'>;
  readonly shifts?: Pick<Shifts, 'crew' | 'currentInstance'>;
  /** SPC episodes of the work center's machines (#203); none without it. */
  readonly quality?: Pick<Quality, 'machines' | 'signals'>;
  /** Open holds touching its orders (#203); none without them. */
  readonly holds?: Pick<Holds, 'openOnOrders'>;
  /** The lots of each machine's last cycle (#203); none without it. */
  readonly genealogy?: Pick<Genealogy, 'lastLots'>;
}

/** Signals one characteristic's read takes, newest first, before the terminal filters them. */
const SIGNAL_READ = 200;

/**
 * What quality says about the work center (#203, plan "Operator terminal"): the open holds that
 * touch its orders, the episodes of its machines' characteristics that are open or not yet
 * acknowledged (neither withdrawn nor baseline ones: those existed before anyone could act), and
 * the lots of each machine's last cycle that reported lots. Read-only.
 */
async function terminalQuality(
  sources: TerminalViewSources,
  machines: readonly string[],
  orderIds: readonly string[],
): Promise<TerminalQualityDto> {
  let truncated = false;
  const holds = sources.holds
    ? await sources.holds.openOnOrders(orderIds, TERMINAL_LIMITS.holds).then((found) => {
        truncated ||= found.truncated;
        return found.holds.map((h) => ({ hold: holdDto(h.hold), orders: h.orders }));
      })
    : [];
  const here = new Set(machines);
  const signals: SignalRecord[] = [];
  if (sources.quality) {
    for (const { characteristic, equipment } of sources.quality.machines()) {
      if (!here.has(equipment)) continue;
      const found = await sources.quality.signals({
        characteristic,
        status: ['provisional', 'final'],
        limit: SIGNAL_READ,
      });
      signals.push(
        ...found.signals.filter(
          (s) => !s.baseline && (s.closedBy === null || s.acknowledged === null),
        ),
      );
    }
  }
  signals.sort((a, b) => b.first.at - a.first.at || b.id - a.id);
  if (signals.length > TERMINAL_LIMITS.signals) truncated = true;
  const lots = sources.genealogy ? await sources.genealogy.lastLots(machines) : [];
  return {
    holds,
    signals: signals.slice(0, TERMINAL_LIMITS.signals).map(signalDto),
    lots: lots
      .filter((l) => l.lots.length > 0)
      .map((l) => ({
        equipment: l.equipment,
        operation: l.operation,
        epoch: l.epoch,
        partId: l.partId,
        serial: l.serial,
        pass: l.pass,
        at: iso(l.at),
        lots: l.lots.map((x) => ({ lot: x.lot, material: x.material })),
      })),
    truncated,
  };
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

export function activityDto(activity: ActivityRecord): ActivityDto {
  return {
    id: activity.id,
    orderId: activity.orderId,
    operation: activity.operation,
    workCenter: activity.workCenter,
    userId: activity.userId,
    username: activity.username,
    kind: activity.kind,
    reason: activity.reason,
    comment: activity.comment,
    from: iso(activity.from),
    fromPlant: iso(activity.fromPlant),
    to: isoOrNull(activity.to),
    toPlant: isoOrNull(activity.toPlant),
    endReason: activity.endReason,
  };
}

export function operationDto(operation: OperationRecord): TerminalOperationDto {
  return {
    orderId: operation.orderId,
    operation: operation.operation,
    workCenter: operation.workCenter,
    version: operation.version,
    complete: operation.completedAt !== null,
    completedAt: isoOrNull(operation.completedAt),
    signedOff: operation.signedOff && {
      username: operation.signedOff.username,
      at: iso(operation.signedOff.at),
      plantAt: iso(operation.signedOff.plantAt),
    },
    activities: operation.activities.map(activityDto),
  };
}

/**
 * Where a unit in WIP waits or works, by its position (`after:OPxx`, `rework:OPxx`,
 * `at:{equipment}`): the operation it goes to next, so its work center.
 */
export function nextOperation(
  position: string,
  routing: readonly string[],
  machines: ReadonlyMap<string, EquipmentInfo>,
): string | undefined {
  const [kind, value] = position.split(':', 2);
  if (value === undefined) return undefined;
  if (kind === 'rework') return value;
  if (kind === 'at') return machines.get(value)?.operation;
  if (kind === 'after') {
    const index = routing.indexOf(value);
    return index >= 0 ? routing[index + 1] : undefined;
  }
  return undefined;
}

/** The order's units in WIP at this work center's stations, and per machine the orders there. */
function wipHere(
  execution: OrderExecutionRecord | undefined,
  order: OrderRecord,
  workCenter: string,
  machines: ReadonlyMap<string, EquipmentInfo>,
): { count: number; atMachines: Set<string> } {
  const atMachines = new Set<string>();
  if (!execution) return { count: 0, atMachines };
  const routing = order.routing.map((r) => r.operation);
  const centerOf = new Map(order.routing.map((r) => [r.operation, r.workCenter]));
  let count = 0;
  for (const [position, units] of Object.entries(execution.wip)) {
    if (units <= 0) continue;
    const next = nextOperation(position, routing, machines);
    if (next === undefined || centerOf.get(next) !== workCenter) continue;
    count += units;
    for (const machine of machines.values()) {
      if (machine.workCenter.id === workCenter && machine.operation === next) {
        atMachines.add(machine.id);
      }
    }
  }
  for (const [machine, blanks] of Object.entries(execution.inMachine)) {
    if (blanks > 0 && machines.get(machine)?.workCenter.id === workCenter) {
      count += blanks;
      atMachines.add(machine);
    }
  }
  return { count, atMachines };
}

/**
 * `orderExecution` read at most once per order within `ttlMs` (#177 review, MEDIUM-2): every
 * terminal topic and read in one pace window shares it. A failed read is not kept, and `clear()`
 * (on every change of the execution module, which also marks the topics dirty) drops everything,
 * so a topic computed again after a change never reads what was kept before it.
 */
export function memoizeOrderExecution(
  execution: NonNullable<TerminalViewSources['execution']>,
  ttlMs: number,
  now: () => number = Date.now,
): NonNullable<TerminalViewSources['execution']> & { clear(): void } {
  const kept = new Map<string, { at: number; value: Promise<OrderExecutionRecord | undefined> }>();
  return {
    clear: () => {
      kept.clear();
    },
    scrapRecords: (query) => execution.scrapRecords(query),
    orderExecution: (id) => {
      const at = now();
      const found = kept.get(id);
      if (found && at - found.at < ttlMs) return found.value;
      for (const [key, entry] of kept) if (at - entry.at >= ttlMs) kept.delete(key);
      const value = execution.orderExecution(id);
      if (ttlMs > 0) {
        kept.set(id, { at, value });
        value.catch(() => {
          if (kept.get(id)?.value === value) kept.delete(id);
        });
      }
      return value;
    },
  };
}

/** The terminal view of a work center from the modules' current data. */
export async function terminalView(
  sources: TerminalViewSources,
  workCenter: { readonly id: string; readonly name: string },
  catalog: ReadonlyMap<string, EquipmentInfo>,
): Promise<TerminalViewDto> {
  const machines = [...catalog.values()]
    .filter((m) => m.workCenter.id === workCenter.id)
    .sort((a, b) => a.position - b.position);
  const states = new Map(sources.equipment.currentStates().map((s) => [s.equipment, s]));
  const { orders } = await sources.orders.list({
    status: ['released', 'dispatched', 'in-progress', 'completed'],
  });
  const here = orders
    .filter((o) => o.routing.some((r) => r.workCenter === workCenter.id))
    .sort((a, b) => a.plannedStart.getTime() - b.plannedStart.getTime() || (a.id < b.id ? -1 : 1));
  const candidates = here.filter((o) => o.status !== 'released');
  const executions = new Map<string, OrderExecutionRecord>();
  if (sources.execution) {
    for (const order of candidates.slice(0, TERMINAL_LIMITS.orders * 2)) {
      const found = await sources.execution.orderExecution(order.id);
      if (found) executions.set(order.id, found);
    }
  }
  const active = candidates.filter(
    (o) =>
      o.status === 'in-progress' ||
      o.status === 'completed' ||
      (executions.get(o.id)?.units.total ?? 0) > 0,
  );
  const activeIds = new Set(active.map((o) => o.id));
  const queued = here.filter((o) => !activeIds.has(o.id));
  const shown = active.slice(0, TERMINAL_LIMITS.orders);
  const operations = await sources.orders.operations({
    orderIds: shown.map((o) => o.id),
    workCenter: workCenter.id,
  });
  const ordersAt = new Map<string, string[]>(machines.map((m) => [m.id, []]));
  const commands = await sources.orders.commands({ orderIds: here.map((o) => o.id) });
  const started = commands.filter((c) => c.job === 'started');
  const terminalOrders: TerminalOrderDto[] = shown.map((order) => {
    const execution = executions.get(order.id);
    const wip = wipHere(execution, order, workCenter.id, catalog);
    for (const machine of wip.atMachines) ordersAt.get(machine)?.push(order.id);
    return {
      order: orderDto(order),
      operations: operations
        .filter((op) => op.orderId === order.id)
        .map((op) => {
          const counts = execution?.operations.find((o) => o.operation === op.operation);
          return {
            ...operationDto(op),
            counts: {
              operation: op.operation,
              in: counts?.in ?? 0,
              good: counts?.good ?? 0,
              scrap: Object.values(counts?.scrap ?? {}).reduce((sum, n) => sum + n, 0),
              rework: counts?.rework ?? 0,
            },
          };
        }),
      wip: wip.count,
    };
  });
  const lastCommand = new Map<string, string>();
  for (const command of commands) lastCommand.set(command.orderId, command.equipment);
  const machineDtos: TerminalMachineDto[] = machines.map((m) => {
    const state = states.get(m.id);
    const job = started.filter((c) => c.equipment === m.id).at(-1);
    return {
      id: m.id,
      name: m.name,
      operation: m.operation,
      state: state ? { state: state.state, cause: state.cause, since: iso(state.since) } : null,
      job: job ? { commandId: job.commandId, orderId: job.orderId, product: job.product } : null,
      orders: ordersAt.get(m.id) ?? [],
    };
  });
  // By the machine that scrapped it, not its operation id: operations may share ids across work
  // centers in another plant.
  const machinesHere = new Set(machines.map((m) => m.id));
  let scrapTruncated = false;
  const scrap = sources.execution
    ? await sources.execution.scrapRecords({ uncoded: true, limit: 500 }).then((found) => {
        const mine = found.records.filter((r) => machinesHere.has(r.equipment));
        scrapTruncated = found.truncated || mine.length > TERMINAL_LIMITS.scrapRecords;
        return mine.slice(0, TERMINAL_LIMITS.scrapRecords);
      })
    : [];
  const instance = sources.shifts?.currentInstance();
  const crew = sources.shifts
    ? await sources.shifts.crew({ workCenter: workCenter.id, open: true })
    : [];
  const quality = await terminalQuality(
    sources,
    machines.map((m) => m.id),
    here.map((o) => o.id),
  );
  return {
    workCenter: { id: workCenter.id, name: workCenter.name },
    shift: instance
      ? {
          epoch: instance.epoch,
          key: instance.key,
          start: iso(instance.start),
          end: iso(instance.end),
        }
      : null,
    machines: machineDtos,
    crew: crew.map(crewDto),
    orders: terminalOrders,
    queue: queued.slice(0, TERMINAL_LIMITS.orders).map((order) => ({
      order: orderDto(order),
      equipment: lastCommand.get(order.id) ?? null,
    })),
    scrapRecords: scrap.map(scrapRecordDto),
    truncated:
      active.length > TERMINAL_LIMITS.orders ||
      queued.length > TERMINAL_LIMITS.orders ||
      scrapTruncated,
    quality,
  };
}
