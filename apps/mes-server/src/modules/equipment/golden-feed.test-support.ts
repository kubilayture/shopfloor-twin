/**
 * Test support: a golden run as the MES receives it (moved out of `reconcile.test-support.ts` for
 * #204, so the trace-performance loader feeds a database without that file's container): the
 * simulator's events, the UNS messages the gateway would publish for them, and an ERP that serves
 * a scenario's dataset and stores every post.
 */
import type { EquipmentPath, MachineState } from '@shopfloor/contracts';
import type { FeedEntry, Lot, LotList } from '@shopfloor/contracts/erp-api';
import type { PlantConfig } from '@shopfloor/plant-config';
import { attachConsumption } from '@shopfloor/trace-core';
import type {
  CommandPublisher,
  ErpApi,
  ErpMessageKind,
  FeedPage,
  PostOutcome,
} from '../orders/index.ts';
import { UnsFeed, type Delivery } from './test-support.ts';

/** Device facts: every one takes the machine's next sequence number (job facts in orders mode). */
const DEVICE_FACTS = ['state', 'cycle-complete', 'alarm', 'job'];

export interface SimEvent {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly to?: MachineState;
  readonly cause?: string;
  readonly product?: string;
  readonly partId?: number;
  readonly serial?: string;
  readonly result?: 'good' | 'scrap' | 'rework';
  readonly reason?: string;
  readonly measurement?: {
    characteristic: string;
    value: number;
    unit: string;
    upperLimit: number;
  };
  readonly code?: string;
  readonly transition?: 'active' | 'cleared' | 'accepted' | 'started' | 'completed';
  readonly severity?: number;
  /** Orders mode (#172): job facts and material taken. */
  readonly commandId?: string;
  readonly orderId?: string;
  readonly quantity?: number;
  readonly material?: string;
  /** Traceability (#196, #197): the lot of a `material-consumed`, the operator of an `operator`. */
  readonly lotId?: string;
  readonly operatorId?: string | null;
}

/**
 * The UNS messages the gateway publishes for a run (docs/contracts/uns.md "Sources"): one snapshot
 * per machine at connect (every machine starts Off), then each state change, cycle and alarm with
 * the machine's own sequence (shared by its three fact topics, as OPC UA `Sequence` and the
 * washer's ring are), all in the simulator's single epoch. WSH-01's telemetry carries the
 * simulation clock; one sample at the end is the watermark the run is observed up to.
 */
export function goldenUnsMessages(
  run: { readonly start: number; readonly end: number; readonly events: readonly SimEvent[] },
  plant: PlantConfig,
  epoch: number,
): { facts: Delivery[]; anchors: Delivery[]; end: Delivery } {
  const paths = new Map<string, EquipmentPath>();
  for (const area of plant.plant.areas) {
    for (const workCenter of area.workCenters) {
      for (const item of workCenter.equipment) {
        paths.set(item.id, { area: area.id, workCenter: workCenter.id, equipment: item.id });
      }
    }
  }
  const feed = new UnsFeed(paths);
  const anchors = [...paths.keys()].map((id) => feed.snapshot(id, epoch, run.start, 'Off'));
  const seqs = new Map<string, number>();
  const facts: Delivery[] = [];
  // Lots and operator per cycle (UNS contract 1.4, #197): the machine server's very rule, the
  // fold `attachConsumption` of trace-core over the event log (ADR-0033).
  const attached = attachConsumption(run.events);
  for (const [index, event] of run.events.entries()) {
    const machine = event.machineId;
    if (!machine || !DEVICE_FACTS.includes(event.type)) continue;
    const seq = (seqs.get(machine) ?? 0) + 1;
    seqs.set(machine, seq);
    const at = Date.parse(event.at);
    if (event.type === 'state') {
      facts.push(feed.state(machine, epoch, seq, at, event.to ?? 'Idle', event.cause ?? null));
    } else if (event.type === 'job') {
      facts.push(
        feed.job(machine, epoch, seq, at, {
          transition: (event.transition ?? 'accepted') as 'accepted' | 'started' | 'completed',
          commandId: event.commandId ?? '',
          orderId: event.orderId ?? '',
          product: event.product ?? '',
          quantity: event.quantity ?? 0,
        }),
      );
    } else if (event.type === 'cycle-complete') {
      // WSH-01, a legacy washer on Modbus, reads no serial (its register map), and its ring
      // carries no lots or operator: the gateway sends none of them.
      const modbus = machine.startsWith('wsh');
      const attachment = attached[index];
      facts.push(
        feed.cycle(machine, epoch, seq, at, {
          product: event.product ?? '',
          partId: event.partId ?? 0,
          serial: modbus ? '' : (event.serial ?? ''),
          result: event.result ?? 'good',
          reason: event.reason ?? null,
          measurement: event.measurement ?? null,
          ...(modbus || !attachment
            ? {}
            : { lots: attachment.lots, operator: attachment.operator }),
        }),
      );
    } else {
      facts.push(
        feed.alarm(
          machine,
          epoch,
          seq,
          at,
          event.code ?? '',
          event.transition === 'cleared' ? 'cleared' : 'active',
          event.severity ?? 1,
        ),
      );
    }
  }
  return { facts, anchors, end: feed.telemetry('wsh-01', run.end, epoch) };
}

/** The ERP serving a scenario's dataset (`@shopfloor/contracts/erp-api`), storing every post. */
export class GoldenErp implements ErpApi {
  readonly feedId = 'b'.repeat(32);
  readonly posts: { kind: ErpMessageKind; key: string; body: unknown }[] = [];
  readonly #entries: readonly FeedEntry[];
  readonly #lots: readonly Lot[];

  constructor(entries: readonly FeedEntry[], lots: readonly Lot[]) {
    this.#entries = entries;
    this.#lots = lots;
  }

  /** The lot list (`GET /api/v1/lots`, #198): the dataset's lots, else `stock.yaml`'s (#199). */
  lots(): Promise<LotList> {
    return Promise.resolve({ feedId: this.feedId, lots: this.#lots.map((l) => ({ ...l })) });
  }

  feed(after: number, limit: number): Promise<FeedPage> {
    const entries = this.#entries.slice(after, after + limit);
    return Promise.resolve({
      kind: 'page',
      page: {
        feedId: this.feedId,
        entries: [...entries],
        cursor: entries.at(-1)?.feedSeq ?? after,
        more: after + entries.length < this.#entries.length,
      },
    });
  }

  post(kind: ErpMessageKind, key: string, body: unknown): Promise<PostOutcome> {
    const replay = this.posts.find((p) => p.key === key);
    if (replay && JSON.stringify(replay.body) !== JSON.stringify(body)) {
      return Promise.resolve({ kind: 'conflict', status: 409, detail: `${key}: another body` });
    }
    if (!replay) this.posts.push({ kind, key, body });
    const common = {
      idempotencyKey: key,
      receivedSeq: this.posts.findIndex((p) => p.key === key) + 1,
      receivedAt: new Date(0).toISOString(),
    };
    return Promise.resolve({
      kind: 'stored',
      status: replay ? 200 : 201,
      receipt:
        kind === 'quality-notification'
          ? { ...common, kind, holdId: key.split('~')[0] ?? '' }
          : { ...common, kind, orderNumber: key.split('~')[0] ?? '' },
    });
  }
}

/** The broker as the command outbox sees it: records every publish. */
export class CommandSink implements CommandPublisher {
  readonly connected = true;
  readonly published: string[] = [];

  publish(topic: string): Promise<void> {
    this.published.push(topic);
    return Promise.resolve();
  }
}
