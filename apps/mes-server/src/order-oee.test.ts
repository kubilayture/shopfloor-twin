/**
 * Order OEE (#231) against a real database and the real modules: `orders-01` replayed in order up
 * to Monday 08:00Z (the end of its fifth order, shift A), with the command state seeded from the
 * run header's dispatches. The orders completed by then are final and equal `line-oee.json`; the
 * one still running is provisional with its window open at the CNC's final-through; the ones
 * behind it wait. Then the API (`GET /oee/orders/{id}`: 200, 404, 503) and the push topic
 * `oee:order:<id>` (snapshot, a paced delta once the order moves, null for an unknown order).
 */
import { EventEmitter } from 'node:events';
import {
  orderOeeSchema,
  serverMessageSchema,
  type ServerMessage,
} from '@shopfloor/contracts/mes-api';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMesHttp } from './http.ts';
import { PLANT_CONFIG } from './modules/equipment/test-support.ts';
import { MasterData } from './modules/master-data/index.ts';
import type { OrderOeeView } from './modules/oee/index.ts';
import {
  PushHub,
  orderOeeDto,
  type ApiSources,
  type PushSocket,
} from './modules/realtime/index.ts';
import {
  Judge,
  goldenFacts,
  goldenRun,
  oeeShape,
  orderOeeStack,
  removeAll,
  seedDispatches,
  truthOeeShape,
  yieldShape,
  type GoldenRun,
  type OrderOeeStack,
} from './order-oee.test-support.ts';
import { startDatabase } from './testing.ts';

const CUT = Date.parse('2026-10-12T08:00:00.000Z');
const time = (d: { payload: string }): number =>
  Date.parse((JSON.parse(d.payload) as { sourceTime: string }).sourceTime);

let container: StartedTestContainer;
let plant: PlantConfig;
let run: GoldenRun;
let stack: OrderOeeStack;
let rest: { topic: string; payload: string }[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  let url: string;
  ({ url, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  run = await goldenRun('orders-01', dirs);
  const { anchors, before, after } = goldenFacts(run, plant);
  stack = await orderOeeStack(url, plant, run, 'order_oee');
  await stack.send([...anchors, ...before]);
  await seedDispatches(stack, run);
  const judge = new Judge(run);
  const head = after.filter((d) => time(d) < CUT);
  rest = after.filter((d) => time(d) >= CUT);
  for (let i = 0; i < head.length; i += 100) {
    await stack.send(head.slice(i, i + 100));
    await stack.tick();
    // Partial data all along: whatever is final is already the truth's.
    await judge.check(stack);
  }
}, 300_000);

afterAll(async () => {
  await stack.stop();
  await removeAll(dirs);
  await container.stop();
});

/** The MES's view of an order that exists. */
async function view(id: string): Promise<OrderOeeView> {
  const found = await stack.orderOee.order(id);
  if (!found) throw new Error(`no order ${id}`);
  return found;
}

const SHIFT_A = ['PO-2610-001', 'PO-2610-002', 'PO-2610-003', 'PO-2610-004', 'PO-2610-006'];

describe('order OEE on orders-01 up to Monday 08:00Z (#231)', () => {
  it('makes the orders complete by then final and equal to line-oee.json', async () => {
    for (const id of SHIFT_A) {
      const view = await stack.orderOee.order(id);
      const truth = run.orders[id];
      if (!view || !truth) throw new Error(id);
      expect([id, view.final, view.firstPassYield.final]).toEqual([id, true, true]);
      expect(oeeShape(view)).toEqual(truthOeeShape(truth));
      expect(yieldShape(view)).toEqual({
        firstPassYield: truth.firstPassYield,
        completedAt: truth.completedAt,
      });
      expect(view.jobs.every((job) => job.final)).toBe(true);
    }
    // PO-2610-001 by hand (ADR-0036, phase-09 log): head 03:00Z from its acceptance, window to
    // 04:13:44.974Z, Setup 1 500 000 ms, OEE 1440000/2212487.
    const first = orderOeeDto(await view('PO-2610-001'));
    expect(first.jobs[0]).toMatchObject({
      head: { kind: 'head', at: '2026-10-12T03:00:00.000Z', source: 'accepted', reason: null },
      window: { from: '2026-10-12T03:00:00.000Z', to: '2026-10-12T04:13:44.974Z', open: false },
      cycles: 12,
    });
    expect(first.oee.oee).toEqual({ fraction: '1440000/2212487', decimal: '0.6509' });
  });

  it('keeps the running order provisional, open at the CNC’s final-through, and the ones behind waiting', async () => {
    const running = await view('PO-2610-005');
    expect([running.final, running.result.open, running.result.order.provisional]).toEqual([
      false,
      true,
      true,
    ]);
    const [job] = running.jobs;
    const cut = running.cutoffs.find((c) => c.machine === 'cnc-01');
    expect(cut?.at?.getTime()).toBeLessThan(CUT);
    expect(job?.window?.to).toBe(cut?.at?.getTime());
    expect(job?.head).toEqual({
      kind: 'head',
      at: Date.parse('2026-10-12T05:01:59.242Z'),
      source: 'previous-completed',
    });
    // PO-2610-007 queues behind PO-2610-005 on CNC-01; PO-2610-009's notBefore (Tuesday) is
    // after CNC-02's final-through: neither has a window yet.
    const waiting = await view('PO-2610-007');
    expect([waiting.final, waiting.result.pending, waiting.jobs[0]?.head]).toEqual([
      false,
      true,
      { kind: 'waiting' },
    ]);
    const later = await view('PO-2610-009');
    expect([later.final, later.result.pending, later.jobs[0]?.head]).toEqual([
      false,
      true,
      { kind: 'head', at: Date.parse('2026-10-13T08:17:00.000Z'), source: 'notBefore' },
    ]);
    expect(later.jobs[0]?.window).toBeUndefined();
    // An order never dispatched has no job and is not final.
    const undispatched = await view('PO-2610-008');
    expect([undispatched.jobs.length, undispatched.final]).toEqual([0, false]);
    expect(await stack.orderOee.order('PO-NONE')).toBeUndefined();
  });

  it('serves GET /oee/orders/{id} (200, 404; 503 without the module)', async () => {
    const none = () => () => undefined;
    const sources = {
      masterData: new MasterData(stack.db),
      equipment: {
        currentStates: () => [],
        currentState: () => undefined,
        onChange: none,
        watermark: () => undefined,
        watermarks: () => [],
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      oee: { workCenters: () => Promise.resolve([]), onChange: none },
      coding: {},
    };
    for (const withModule of [true, false]) {
      const http = await buildMesHttp({ ready: () => Promise.resolve(true) });
      await http.realtime.attach({
        ...sources,
        ...(withModule ? { orderOee: stack.orderOee } : {}),
      } as unknown as ApiSources);
      const get = (url: string) =>
        http.app.inject({ method: 'GET', url, headers: { host: 'localhost:4700' } });
      const found = await get('/api/v1/oee/orders/PO-2610-001');
      if (withModule) {
        expect(found.statusCode, found.body).toBe(200);
        const body = orderOeeSchema.parse(found.json());
        expect(body).toEqual(orderOeeDto(await view('PO-2610-001')));
        expect(body.final).toBe(true);
        expect((await get('/api/v1/oee/orders/PO-NONE')).statusCode).toBe(404);
        expect((await get('/api/v1/oee/orders/bad%20id')).statusCode).toBe(400);
      } else {
        expect(found.statusCode).toBe(503);
      }
      await http.app.close();
    }
  });

  it('pushes oee:order:<id>: a snapshot, a paced delta once the order moves, null for an unknown order', async () => {
    const none = () => () => undefined;
    const sent: ServerMessage[] = [];
    const emitter = new EventEmitter();
    const socket = Object.assign(emitter, {
      bufferedAmount: 0,
      send: (data: string) => {
        sent.push(serverMessageSchema.parse(JSON.parse(data)));
      },
      ping: () => undefined,
      close: () => undefined,
      terminate: () => undefined,
    }) as unknown as PushSocket;
    const subscribe = (topic: string) => {
      emitter.emit('message', Buffer.from(JSON.stringify({ type: 'subscribe', topic })), false);
    };
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
    const base = {
      equipment: {
        currentStates: () => [],
        watermark: () => undefined,
        watermarks: () => [],
        onChange: none,
      },
      ingest: { onStored: none, telemetryMetrics: () => Promise.resolve([]) },
      catalog: new Set<string>(),
    };
    // Without the module the topic is refused.
    const bare = new PushHub({ heartbeatMs: 3_600_000, clockMs: 3_600_000 });
    bare.attach(base);
    bare.connect(socket);
    subscribe('oee:order:PO-2610-005');
    await until(() => sent.some((m) => m.type === 'error'));
    expect(sent.find((m) => m.type === 'error')).toMatchObject({ code: 'unknown-topic' });
    bare.close();
    sent.length = 0;

    const hub = new PushHub({ heartbeatMs: 3_600_000, clockMs: 3_600_000, oeeMs: 20 });
    hub.attach({ ...base, orderOee: stack.orderOee });
    hub.connect(socket);
    subscribe('oee:order:PO-2610-005');
    subscribe('oee:order:PO-NONE');
    await until(() => sent.filter((m) => m.type === 'snapshot').length === 2);
    type OrderMessage = Extract<ServerMessage, { order: unknown }>;
    const isOrder = (m: ServerMessage): m is OrderMessage => 'order' in m;
    const snapshot = sent
      .filter(isOrder)
      .find((m) => m.type === 'snapshot' && m.topic === 'oee:order:PO-2610-005');
    expect(snapshot?.order).toEqual(orderOeeDto(await view('PO-2610-005')));
    expect(
      sent.find((m) => m.type === 'snapshot' && m.topic === 'oee:order:PO-NONE'),
    ).toMatchObject({
      order: null,
    });
    // The order moves (more facts, the modules' ticks): a delta with the new body.
    await stack.send(rest.slice(0, 200));
    await stack.tick();
    await until(() => sent.some((m) => m.type === 'oee-order'));
    const delta = sent.filter(isOrder).find((m) => m.type === 'oee-order');
    expect(delta?.topic).toBe('oee:order:PO-2610-005');
    expect(delta?.order?.final).toBe(false);
    expect(delta?.order).not.toEqual(snapshot?.order);
    emitter.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'unsubscribe', topic: 'oee:order:PO-2610-005' })),
      false,
    );
    await until(() => sent.some((m) => m.type === 'unsubscribed'));
    hub.close();
  });
});
