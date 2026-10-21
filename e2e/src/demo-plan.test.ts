import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CLOSE_AT, CODE_AT, DEMO, SCENES, plantClock, plantTime } from './demo-plan.ts';
import { ENVELOPE, variant } from './demo-probe.ts';
import { REPO } from './stack.ts';

/**
 * The demo's inputs agree with each other (#281): the timeline `demo-v1`, its headless-only twin
 * of probe D1, the ERP dataset, the Compose override and the plan the walkthrough and the probe
 * share. A change to one that the others don't follow fails here, before a demo run.
 */

interface Entry {
  readonly action: string;
  readonly at?: string;
  readonly [key: string]: unknown;
}
interface Timeline {
  readonly seed: number;
  readonly start: string;
  readonly production?: string;
  readonly config: string;
  readonly timeline: readonly Entry[];
}

const yaml = async <T>(file: string): Promise<T> =>
  parse(await readFile(join(REPO, file), 'utf8')) as T;
const demo = () => yaml<Timeline>(`config/scenarios/${DEMO.timeline}.yaml`);
const probe = () => yaml<Timeline>(`config/scenarios/${DEMO.probe}.yaml`);
const at = (entry: Entry | undefined) => Date.parse(entry?.at ?? '');

describe("the demo's timeline and its probe twin", () => {
  it('runs the plan’s seed, start and production mode, with no dispatch entry live', async () => {
    const live = await demo();
    expect([live.seed, Date.parse(live.start), live.production, live.config]).toEqual([
      DEMO.seed,
      Date.parse(DEMO.start),
      'orders',
      'config/plant',
    ]);
    expect(live.timeline.filter((e) => e.action === 'dispatch')).toEqual([]);
  });

  it("gives probe D1 exactly the live timeline's entries, plus the dispatches", async () => {
    const live = await demo();
    const twin = await probe();
    expect([twin.seed, twin.start, twin.production, twin.config]).toEqual([
      live.seed,
      live.start,
      live.production,
      live.config,
    ]);
    expect(twin.timeline.filter((e) => e.action !== 'dispatch')).toEqual(live.timeline);
    expect(
      twin.timeline
        .filter((e) => e.action === 'dispatch')
        .map((e) => [
          e.commandId,
          e.orderId,
          e.machine,
          e.product,
          e.quantity,
          Date.parse(String(e.notBefore)),
        ]),
    ).toEqual(
      DEMO.orders.map((o) => [
        `${o.id}~OP10~1`,
        o.id,
        o.machine,
        'VB-100',
        o.quantity,
        DEMO.plannedStart,
      ]),
    );
  });

  it('pauses before the planned start and places each action where the plan says', async () => {
    const entries = (await demo()).timeline;
    const pause = entries.find((e) => e.action === 'pause');
    expect(at(pause)).toBe(DEMO.pauseAt);
    expect(DEMO.pauseAt).toBeLessThan(DEMO.plannedStart);
    expect(entries.filter((e) => e.action === 'pause')).toHaveLength(1);
    const failure = entries.find((e) => e.action === 'failure');
    expect([failure?.machine, failure?.code, at(failure)]).toEqual([
      DEMO.failure.machine,
      DEMO.failure.code,
      DEMO.failure.at,
    ]);
    const tool = entries.find((e) => e.action === 'tool-breakage');
    expect([tool?.machine, at(tool)]).toEqual([DEMO.toolBreakage.machine, DEMO.toolBreakage.at]);
    const drift = entries.find((e) => e.action === 'leak-drift');
    expect([drift?.machine, at(drift)]).toEqual([DEMO.drift.machine, DEMO.drift.at]);
    // Every lot of the blocked material, blocked and then released.
    const stock = await yaml<{ lots: { id: string; material: string }[] }>(
      'config/plant/stock.yaml',
    );
    const lots = stock.lots.filter((l) => l.material === DEMO.blockedMaterial).map((l) => l.id);
    expect(lots.length).toBeGreaterThan(1);
    for (const action of ['lot-block', 'lot-release']) {
      expect(
        entries
          .filter((e) => e.action === action)
          .map((e) => e.lot)
          .sort(),
      ).toEqual(lots);
    }
  });

  it('opens the scenes in order, after the facts they need', () => {
    expect(SCENES.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const times = SCENES.flatMap((s) => (s.at === null ? [] : [plantTime(s.at)]));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(plantTime('07:20')).toBeGreaterThan(DEMO.failure.at);
    expect(plantTime(CODE_AT)).toBeGreaterThan(DEMO.failure.at + 30 * 60_000);
    expect(plantTime('12:00')).toBeGreaterThan(DEMO.drift.at);
    expect(plantTime(CLOSE_AT)).toBeGreaterThan(plantTime('12:00'));
    expect(plantClock(plantTime('06:14'))).toBe('06:14:00');
  });
});

describe("the demo's ERP dataset and Compose override", () => {
  it('serves the plan’s orders, every one planned to start at 06:15', async () => {
    const dataset = await yaml<{
      orders: { orderNumber: string; product: string; quantity: number; plannedStart: string }[];
    }>('config/erp/demo-v1.yaml');
    expect(dataset.orders.map((o) => [o.orderNumber, o.product, o.quantity])).toEqual(
      DEMO.orders.map((o) => [o.id, 'VB-100', o.quantity]),
    );
    for (const order of dataset.orders) {
      expect(Date.parse(order.plannedStart)).toBe(DEMO.plannedStart);
    }
  });

  it('sets the timeline, its run and the dataset, and publishes or mounts nothing', async () => {
    const override = await yaml<{
      services: Record<string, { environment?: Record<string, string>; [key: string]: unknown }>;
    }>('compose.demo.yml');
    expect(Object.keys(override.services).sort()).toEqual(['erp', 'mes', 'simulator']);
    for (const service of Object.values(override.services)) {
      expect(Object.keys(service)).toEqual(['environment']);
    }
    expect(override.services.simulator?.environment).toEqual({
      SIM_SEED: String(DEMO.seed),
      SIM_START: DEMO.start,
      SIM_PRODUCTION: 'orders',
      SIM_TIMELINE: DEMO.timeline,
      SIM_AUTOSTART: 'false',
    });
    expect(override.services.mes?.environment).toEqual({ MES_PRODUCTION_MODE: 'orders' });
    expect(override.services.erp?.environment).toEqual({
      ERP_DATASET: '/app/config/erp/demo-v1.yaml',
    });
  });
});

describe('probe D1’s variants', () => {
  it('moves NotBefore to the acceptance time only when that is later than the planned start', async () => {
    const twin = (await probe()) as unknown as Parameters<typeof variant>[0];
    const notBefore = (accepted: string) =>
      variant(twin, plantTime(accepted))
        .timeline.filter((e) => e.action === 'dispatch')
        .map((e) => Date.parse(e.notBefore ?? ''));
    for (const accepted of ENVELOPE) {
      expect(notBefore(accepted)).toEqual(DEMO.orders.map(() => DEMO.plannedStart));
    }
    expect(notBefore('06:30')).toEqual(DEMO.orders.map(() => plantTime('06:30')));
    expect(ENVELOPE.at(-1)).toBe('06:14');
    // Every other entry is unchanged.
    expect(
      variant(twin, plantTime('06:45')).timeline.filter((e) => e.action !== 'dispatch'),
    ).toEqual(twin.timeline.filter((e) => e.action !== 'dispatch'));
  });
});
