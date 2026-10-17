/**
 * Golden SPC reconciliation (#200, Phase 8 plan "Ground truth and reconciliation", exit criterion
 * 3): the headless simulator runs `quality-01`, `orders-01` and `week-01` as a process (apps never
 * import each other); its event log becomes the leak tester's UNS facts as the gateway would
 * publish them (the machine's own sequence, one device epoch) and goes through ingest's store path
 * into TimescaleDB, where the quality module derives measurements, limit version 1, every point and
 * subgroup, and the signal episodes. They must equal the SPC section of the scenario's committed
 * `trace.json`, delivered in order and shuffled with 10 % duplicates, judged on partial data all
 * along: a version 1 created early must already equal the truth's, and an episode marked final
 * must be one of the truth's. In `quality-01` the drift's first episode must be the truth's and
 * open within 20 first-pass readings of the injection's start, and the counterfactual readings
 * (same limits, baseline judged retroactively) must open no episode in the 60-reading window.
 *
 * Probe P3 (plan "Probes"): the cost of one tick per new reading on a week of readings, the
 * database rewrite of the episodes included, and of a late reading that moves every later
 * subgroup; recorded in the phase log and ADR-0032.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EquipmentPath, MachineState } from '@shopfloor/contracts';
import { loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import {
  CHARTS,
  comparePositions,
  spcChart,
  type Position,
  type Reading,
} from '@shopfloor/spc-core';
import { attachConsumption } from '@shopfloor/trace-core';
import type { Kysely } from 'kysely';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './db/database.ts';
import { startDatabase } from './testing.ts';
import {
  PLANT_CONFIG,
  UnsFeed,
  freshDatabase,
  random,
  shuffle,
  type Delivery,
} from './modules/equipment/test-support.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { spcChartDto } from './modules/realtime/index.ts';
import { Quality, characteristicsOf, keyParts } from './modules/quality/index.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const GOLDENS = join(REPO, 'apps/simulator/golden');
const EPOCH = 1_760_000_000;
const TESTER = 'lkt-01';
const CHARACTERISTIC = 'leak-rate';
const DEVICE_FACTS = new Set(['state', 'cycle-complete', 'alarm', 'job']);
/** The counterfactual window (plan, round 2 HIGH A): 40 first-pass readings before, 20 after. */
const WINDOW = { before: 40, after: 20 } as const;
const DETECTION_READINGS = 20;

interface SimEvent {
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
  readonly transition?: string;
  readonly severity?: number;
  readonly commandId?: string;
  readonly orderId?: string;
  readonly quantity?: number;
  readonly material?: string;
  readonly lotId?: string;
  readonly operatorId?: string | null;
}

interface TruthRef {
  readonly partId: number;
  readonly pass: number;
}

interface TruthEpisode extends TruthRef {
  readonly chart: string;
  readonly rule: number;
  readonly version: number;
  readonly at: string;
  readonly last: TruthRef;
  readonly points: number;
  readonly closedBy: TruthRef | null;
  readonly baseline: boolean;
}

interface TruthSpc {
  readonly characteristic: string;
  readonly readings: { readonly firstPass: number; readonly retests: number };
  readonly limits: readonly unknown[];
  readonly points: Record<string, { readonly count: number; readonly sha256: string }>;
  readonly subgroups: { readonly complete: number; readonly pending: number };
  readonly episodes: readonly TruthEpisode[];
}

interface TruthDrift {
  readonly start: (TruthRef & { readonly firstPassBefore: number }) | null;
  readonly firstEpisode: (TruthEpisode & { readonly latency: number }) | null;
  readonly window: {
    readonly before: number;
    readonly after: number;
    readonly readings: readonly (TruthRef & {
      readonly counterfactual: number;
      readonly value: number;
    })[];
  };
  readonly counterfactual: { readonly clean: boolean };
}

interface Run {
  readonly events: SimEvent[];
  readonly start: number;
  readonly spc: TruthSpc;
  readonly drifts: readonly TruthDrift[];
}

let container: StartedTestContainer;
let serverUrl: string;
let plant: PlantConfig;
const dirs: string[] = [];

beforeAll(async () => {
  ({ url: serverUrl, container } = await startDatabase());
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
}, 180_000);

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  await container.stop();
});

/** The scenario run headless as a process; its `trace.json` must be the committed one. */
async function headless(name: string): Promise<Run> {
  const out = await mkdtemp(join(tmpdir(), 'spc-golden-'));
  dirs.push(out);
  await promisify(execFile)(process.execPath, [HEADLESS, '--scenario', name, '--out', out], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const [lines, traceText] = await Promise.all([
    readFile(join(out, 'events.jsonl'), 'utf8'),
    readFile(join(out, 'trace.json'), 'utf8'),
  ]);
  expect(traceText).toBe(await readFile(join(GOLDENS, name, 'trace.json'), 'utf8'));
  const [header, ...rest] = lines.trimEnd().split('\n');
  const trace = JSON.parse(traceText) as { spc: TruthSpc; drifts: TruthDrift[] };
  return {
    events: rest.map((line) => JSON.parse(line) as SimEvent),
    start: Date.parse((JSON.parse(header ?? '{}') as { start: string }).start),
    spc: trace.spc,
    drifts: trace.drifts,
  };
}

/**
 * The leak tester's UNS messages: its snapshot at connect (Off), then each of its device facts
 * with its own sequence (state, cycle, alarm), cycles with their measurement and the lots and
 * operator of `attachConsumption` (the machine server's rule), all in one epoch.
 */
function testerMessages(run: Run): { anchor: Delivery; facts: Delivery[] } {
  const paths = new Map<string, EquipmentPath>();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) {
        paths.set(item.id, { area: area.id, workCenter: wc.id, equipment: item.id });
      }
    }
  }
  const feed = new UnsFeed(paths);
  const attached = attachConsumption(run.events);
  const facts: Delivery[] = [];
  let seq = 0;
  for (const [index, event] of run.events.entries()) {
    if (event.machineId !== TESTER || !DEVICE_FACTS.has(event.type)) continue;
    seq += 1;
    const at = Date.parse(event.at);
    if (event.type === 'state') {
      facts.push(feed.state(TESTER, EPOCH, seq, at, event.to ?? 'Idle', event.cause ?? null));
    } else if (event.type === 'cycle-complete') {
      const attachment = attached[index];
      facts.push(
        feed.cycle(TESTER, EPOCH, seq, at, {
          product: event.product ?? '',
          partId: event.partId ?? 0,
          serial: event.serial ?? '',
          result: event.result ?? 'good',
          reason: event.reason ?? null,
          measurement: event.measurement ?? null,
          ...(attachment ? { lots: attachment.lots, operator: attachment.operator } : {}),
        }),
      );
    } else if (event.type === 'alarm') {
      facts.push(
        feed.alarm(
          TESTER,
          EPOCH,
          seq,
          at,
          event.code ?? '',
          event.transition === 'cleared' ? 'cleared' : 'active',
          event.severity ?? 1,
        ),
      );
    } else {
      throw new Error(`a ${event.type} fact on the leak tester`);
    }
  }
  return { anchor: feed.snapshot(TESTER, EPOCH, run.start, 'Off'), facts };
}

interface Mes {
  readonly db: Kysely<Database>;
  readonly ingest: Ingest;
  readonly quality: Quality;
  send(deliveries: readonly Delivery[]): Promise<void>;
  stop(): Promise<void>;
}

/** A fresh database with master data, ingest (no broker) and the quality module (tick by hand). */
async function mes(name: string): Promise<Mes> {
  const db = await freshDatabase(serverUrl, name);
  await new MasterData(db).seed(plant);
  const ingest = new Ingest({
    db,
    url: 'mqtt://127.0.0.1:1',
    username: 'mes',
    password: 'unused',
    refresh: {},
    // Above the run's length: no gap of a shuffled replay is written off.
    gapGraceMs: 3_600_000,
  });
  const quality = new Quality({
    db,
    ingest,
    characteristics: characteristicsOf(plant),
    tickMs: 0,
  });
  await quality.start();
  return {
    db,
    ingest,
    quality,
    send: async (deliveries) => {
      for (const d of deliveries) await ingest.deliver(d.topic, d.payload);
    },
    stop: async () => {
      await quality.stop();
      await ingest.stop();
      await db.destroy();
    },
  };
}

/** Canonical JSON, keys sorted (the simulator's `stableStringify`; apps never import each other). */
function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const at = (iso: string): string => new Date(iso).toISOString();

/** A limit version of the API as `trace.json` writes it (`versionJson`): positions by time. */
function versionShape(v: ReturnType<typeof spcChartDto>['limits'][number]) {
  const pos = (p: { at: string } | null) => (p === null ? null : { at: at(p.at) });
  return {
    version: v.version,
    createdAt: at(v.createdAt),
    from: pos(v.from),
    until: pos(v.until),
    endedAt: v.endedAt === null ? null : at(v.endedAt),
    limits: {
      subgroupSize: v.subgroupSize,
      window: { from: { at: at(v.window.from.at) }, to: { at: at(v.window.to.at) } },
      counts: v.counts,
      statistics: {
        mean: v.statistics.mean.steps,
        movingRange: v.statistics.movingRange.steps,
        grandMean: v.statistics.grandMean.steps,
        range: v.statistics.range.steps,
      },
      charts: Object.fromEntries(
        CHARTS.map((c) => [
          c,
          {
            lower: v.charts[c].lower.steps,
            centre: v.charts[c].centre.steps,
            upper: v.charts[c].upper.steps,
          },
        ]),
      ),
    },
  };
}

const ref = (r: { partId: number; pass: number }): TruthRef => ({
  partId: r.partId,
  pass: r.pass,
});

/** A stored signal as `trace.json` writes an episode (`episodeJson`). */
function episodeShape(s: ReturnType<typeof spcChartDto>['signals'][number]): TruthEpisode {
  return {
    chart: s.chart,
    rule: s.rule,
    version: s.version,
    ...ref(s.first),
    at: at(s.first.at),
    last: ref(s.last),
    points: s.points,
    closedBy: s.closedBy === null ? null : ref(s.closedBy),
    baseline: s.baseline,
  };
}

const identity = (e: TruthEpisode): string =>
  `${e.chart}~${String(e.rule)}~${String(e.version)}~${String(e.partId)}/${String(e.pass)}~${String(e.baseline)}`;

/**
 * Judged on partial data, after every tick: a limit version, once there, is exactly the truth's
 * version 1; every episode marked final is one of the truth's (chart, rule, version, triggering
 * point, baseline); nothing is withdrawn (no gap is written off); no baseline notice.
 */
async function expectPartial(
  m: Mes,
  run: Run,
): Promise<{
  v1: boolean;
  final: number;
  provisional: number;
  signals: ReturnType<typeof spcChartDto>['signals'];
}> {
  const view = await m.quality.chart(CHARACTERISTIC);
  if (!view) throw new Error('no characteristic');
  const dto = spcChartDto(view, { all: true });
  const truth = new Set(run.spc.episodes.map(identity));
  expect(dto.limits.map(versionShape)).toEqual(run.spc.limits.slice(0, dto.limits.length));
  const final = dto.signals.filter((s) => s.status === 'final');
  for (const signal of final)
    expect(truth, identity(episodeShape(signal))).toContain(identity(episodeShape(signal)));
  expect(dto.signals.filter((s) => s.status === 'withdrawn')).toEqual([]);
  expect(dto.characteristic.notice).toBeNull();
  return {
    v1: dto.limits.length > 0,
    final: final.length,
    provisional: dto.signals.filter((s) => s.status === 'provisional').length,
    signals: dto.signals,
  };
}

/** The first-pass readings of the chart with their positions, in chart order. */
const firstPassOf = (view: NonNullable<Awaited<ReturnType<Quality['chart']>>>) =>
  view.chart.firstPass.map((r) => ({ ...keyParts(r.key), reading: r }));

/**
 * Exit criterion 3 on the whole run: version 1, every point of the four charts (hashed as the
 * truth hashes them), the subgroups, every episode (all final), and in a scenario with a drift
 * the first episode after its start and the counterfactual window. Returns the comparison counts.
 */
async function expectSpc(m: Mes, run: Run): Promise<{ points: number; episodes: number }> {
  const view = await m.quality.chart(CHARACTERISTIC);
  if (!view) throw new Error('no characteristic');
  const dto = spcChartDto(view, { all: true });
  expect(dto.readings).toEqual(run.spc.readings);
  expect(dto.limits.map(versionShape)).toEqual(run.spc.limits);
  let points = 0;
  for (const chart of CHARTS) {
    const shaped = dto.points[chart].map((p) => ({
      partId: p.partId,
      pass: p.pass,
      at: at(p.at),
      segment: p.segment,
      value: p.value.steps,
      version: p.version,
      baseline: p.baseline,
      rules: p.rules,
    }));
    expect([chart, shaped.length, sha256(canonicalJson(shaped))]).toEqual([
      chart,
      run.spc.points[chart]?.count,
      run.spc.points[chart]?.sha256,
    ]);
    expect(dto.points[chart].every((p) => p.final)).toBe(true);
    points += shaped.length;
  }
  expect({ complete: dto.subgroups.complete, pending: dto.subgroups.pending }).toEqual(
    run.spc.subgroups,
  );
  const stored = [...dto.signals].sort(
    (a, b) =>
      a.first.epoch - b.first.epoch ||
      Date.parse(a.first.at) - Date.parse(b.first.at) ||
      a.first.seq - b.first.seq ||
      CHARTS.indexOf(a.chart) - CHARTS.indexOf(b.chart) ||
      a.rule - b.rule,
  );
  expect(stored.map((s) => s.status)).toEqual(stored.map(() => 'final'));
  expect(stored.map(episodeShape)).toEqual(run.spc.episodes);
  expect(dto.characteristic.notice).toBeNull();
  expect(dto.characteristic.currentLimits).toBe(1);

  // The drift (quality-01): the first episode after its start and the counterfactual window.
  for (const drift of run.drifts) {
    const ordered = firstPassOf(view);
    if (!drift.start || !drift.firstEpisode) throw new Error('a drift without start or episode');
    const start = drift.start;
    const startIndex = ordered.findIndex((r) => r.partId === start.partId && r.pass === start.pass);
    expect(startIndex).toBe(start.firstPassBefore);
    const startPosition = ordered[startIndex]?.reading;
    if (!startPosition) throw new Error('no start reading');
    const first = stored.find(
      (s) =>
        !s.baseline &&
        comparePositions(
          { epoch: s.first.epoch, at: Date.parse(s.first.at), seq: s.first.seq },
          startPosition,
        ) >= 0,
    );
    if (!first) throw new Error('no episode after the drift’s start');
    const trigger = ordered.findIndex(
      (r) => r.partId === first.first.partId && r.pass === first.first.pass,
    );
    const latency = trigger - startIndex + 1;
    const { latency: truthLatency, ...truthEpisode } = drift.firstEpisode;
    expect({ ...episodeShape(first), latency }).toEqual({ ...truthEpisode, latency: truthLatency });
    expect(latency).toBeLessThanOrEqual(DETECTION_READINGS);
    // Counterfactual: the same readings with the drift's steps taken out of the window's drifted
    // ones, the MES's own limit versions, baseline points judged retroactively.
    expect([drift.window.before, drift.window.after]).toEqual([WINDOW.before, WINDOW.after]);
    expect(drift.window.readings).toHaveLength(WINDOW.before + WINDOW.after);
    const counterfactual = new Map(
      drift.window.readings.map((r) => [`${String(r.partId)}/${String(r.pass)}`, r.counterfactual]),
    );
    const windowKeys = ordered.slice(startIndex - WINDOW.before, startIndex + WINDOW.after);
    expect(windowKeys.map((r) => `${String(r.partId)}/${String(r.pass)}`)).toEqual([
      ...counterfactual.keys(),
    ]);
    for (const r of windowKeys) {
      const truth = drift.window.readings.find((w) => w.partId === r.partId && w.pass === r.pass);
      expect([r.partId, r.reading.value]).toEqual([r.partId, truth?.value]);
    }
    const readings: Reading[] = [...view.chart.firstPass, ...view.chart.retests].map((r) => {
      const { partId, pass } = keyParts(r.key);
      return { ...r, value: counterfactual.get(`${String(partId)}/${String(pass)}`) ?? r.value };
    });
    const cf = spcChart({
      readings,
      versions: view.limits,
      rules: view.characteristic.rules,
      subgroupSize: view.characteristic.subgroupSize,
    });
    const from = windowKeys[0]?.reading;
    const to = windowKeys.at(-1)?.reading;
    if (!from || !to) throw new Error('empty window');
    const inside = (p: Position) => comparePositions(p, from) >= 0 && comparePositions(p, to) <= 0;
    const signals = CHARTS.flatMap((c) =>
      cf.points[c].filter((p) => p.rules.length > 0 && inside(p.position)),
    );
    expect(signals).toEqual([]);
    expect(cf.episodes.filter((e) => inside(e.position))).toEqual([]);
    expect(drift.counterfactual.clean).toBe(true);
    console.log(
      `drift: first episode ${first.chart} rule ${String(first.rule)} at part ${String(first.first.partId)}, ${String(latency)} first-pass readings after the start; counterfactual window of ${String(windowKeys.length)} readings (${String(WINDOW.before)} before, ${String(WINDOW.after)} after) opens no episode`,
    );
  }
  return { points, episodes: stored.length };
}

/** Stored rows without wall-clock columns, in key order: in order and shuffled must agree. */
async function storedRows(db: Kysely<Database>) {
  return {
    measurements: await db
      .selectFrom('quality.measurement')
      .selectAll()
      .orderBy('equipment')
      .orderBy('epoch')
      .orderBy('seq')
      .execute(),
    limits: await db
      .selectFrom('quality.control_limit')
      .select(['characteristic', 'n', 'kind', 'version', 'plant_at', 'limits', 'actor'])
      .orderBy('characteristic')
      .orderBy('n')
      .execute(),
    signals: await db
      .selectFrom('quality.spc_signal')
      .select(['characteristic', 'limit_version', 'chart', 'rule', 'epoch', 'part_id', 'pass'])
      .select(['first_at', 'last_part_id', 'last_pass', 'points', 'closed_part_id', 'closed_pass'])
      .select(['baseline', 'status', 'withdrawn_reason', 'ack_by'])
      .orderBy('first_at')
      .orderBy('chart')
      .orderBy('rule')
      .execute(),
  };
}

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

const ms = (value: number): string => value.toFixed(1);

/** In order and shuffled for one golden scenario, with the pinned comparison counts. */
function spcSuite(name: string, pinned: { points: number; episodes: number }): void {
  describe(`golden SPC reconciliation: ${name} (#200)`, () => {
    let run: Run | undefined;
    let reference: Mes | undefined;

    it('in order, ticked every 50 facts: limits, points, subgroups and episodes equal trace.json', async () => {
      run = await headless(name);
      const { anchor, facts } = testerMessages(run);
      reference = await mes(`spc_${name.replace('-', '_')}_order`);
      await reference.send([anchor]);
      let createdAt = -1;
      for (let i = 0; i < facts.length; i += 50) {
        await reference.send(facts.slice(i, i + 50));
        await reference.quality.tick();
        const partial = await expectPartial(reference, run);
        if (partial.v1 && createdAt < 0) createdAt = i;
      }
      expect(createdAt).toBeGreaterThan(0);
      const counts = await expectSpc(reference, run);
      expect(counts).toEqual(pinned);
      console.log(
        `${name}: in order, version 1, ${String(counts.points)} points and ${String(counts.episodes)} episodes equal trace.json`,
      );
    }, 300_000);

    it('bounded disorder, blocks held back: provisional episodes on partial data, no final one withdrawn or changed', async () => {
      // Plan "Finality and late facts" (#200 review H2): facts in windows of 30–60, each window
      // shuffled and delivered in chunks of 10–20 with a tick after each (gaps of a few facts at
      // every tick); now and then a block of 20–40 held back and released 2–5 windows later, and
      // single facts held back for 1–3 windows, so gaps keep later readings provisional while
      // episodes form on them. Every tick: version 1 (once there) is the truth's, every final
      // episode is one of the truth's, nothing is withdrawn, and an episode once final stays final
      // with its identity.
      run ??= await headless(name);
      const truth = run;
      const { anchor, facts } = testerMessages(truth);
      const next = random(2_000);
      const m = await mes(`spc_${name.replace('-', '_')}_bounded`);
      await m.send([anchor]);
      const held: { block: Delivery[]; release: number }[] = [];
      const finals = new Map<number, string>();
      let ticks = 0;
      let windows = 0;
      let provisionalTicks = 0;
      let provisionalMax = 0;
      let heldBlocks = 0;
      const tickAndCheck = async () => {
        await m.quality.tick();
        ticks++;
        const partial = await expectPartial(m, truth);
        if (partial.provisional > 0) provisionalTicks++;
        provisionalMax = Math.max(provisionalMax, partial.provisional);
        const byId = new Map(partial.signals.map((sig) => [sig.id, sig]));
        for (const [id, was] of finals) {
          const now = byId.get(id);
          expect([id, now?.status, now ? identity(episodeShape(now)) : null]).toEqual([
            id,
            'final',
            was,
          ]);
        }
        for (const sig of partial.signals) {
          if (sig.status === 'final' && !finals.has(sig.id)) {
            finals.set(sig.id, identity(episodeShape(sig)));
          }
        }
      };
      for (let i = 0; i < facts.length || held.length > 0; windows++) {
        const size = 30 + Math.floor(next() * 31);
        let window = facts.slice(i, i + size);
        i += size;
        if (window.length > 40 && next() < 0.2) {
          const length = 20 + Math.floor(next() * 21);
          held.push({
            block: window.slice(0, length),
            release: windows + 2 + Math.floor(next() * 4),
          });
          window = window.slice(length);
          heldBlocks++;
        }
        if (window.length > 4 && next() < 0.5) {
          const count = 1 + Math.floor(next() * 4);
          for (let k = 0; k < count; k++) {
            const at = Math.floor(next() * window.length);
            held.push({
              block: window.splice(at, 1),
              release: windows + 1 + Math.floor(next() * 3),
            });
          }
        }
        for (let h = held.length - 1; h >= 0; h--) {
          const entry = held[h];
          if (entry && (entry.release <= windows || i >= facts.length)) {
            window = [...window, ...entry.block];
            held.splice(h, 1);
          }
        }
        const mixed = shuffle(window, next);
        for (let c = 0; c < mixed.length;) {
          const chunk = 10 + Math.floor(next() * 11);
          await m.send(mixed.slice(c, c + chunk));
          c += chunk;
          await tickAndCheck();
        }
      }
      expect(heldBlocks).toBeGreaterThan(0);
      expect(provisionalTicks).toBeGreaterThan(0);
      expect(await expectSpc(m, truth)).toEqual(pinned);
      if (reference !== undefined) {
        expect(await storedRows(m.db)).toEqual(await storedRows(reference.db));
      }
      console.log(
        `${name}: bounded disorder, ${String(ticks)} ticks, ${String(heldBlocks)} blocks held back: provisional episodes on ${String(provisionalTicks)} ticks (at most ${String(provisionalMax)} at once), no final episode withdrawn or changed; equal trace.json and the in-order run`,
      );
      await m.stop();
    }, 300_000);

    it('shuffled with 10 % duplicates, ticked every 97 deliveries: equal trace.json and the in-order run', async () => {
      if (!run || !reference) throw new Error('runs after the in-order test');
      const { anchor, facts } = testerMessages(run);
      const next = random(200);
      const mixed = shuffle([anchor, ...facts, ...facts.filter(() => next() < 0.1)], next);
      const m = await mes(`spc_${name.replace('-', '_')}_shuffled`);
      let finalSeen = 0;
      for (let i = 0; i < mixed.length; i += 97) {
        await m.send(mixed.slice(i, i + 97));
        await m.quality.tick();
        finalSeen = Math.max(finalSeen, (await expectPartial(m, run)).final);
      }
      await m.send(mixed.slice(0, 300));
      await m.quality.tick();
      expect(await expectSpc(m, run)).toEqual(pinned);
      expect(await storedRows(m.db)).toEqual(await storedRows(reference.db));
      console.log(
        `${name}: shuffled, equal trace.json and the in-order run (at most ${String(finalSeen)} final episodes on partial data before the end)`,
      );
      await m.stop();
      await reference.stop();
    }, 300_000);
  });
}

spcSuite('quality-01', { points: 830 + 829 + 166 + 166, episodes: 24 });
spcSuite('orders-01', { points: 400 + 399 + 80 + 80, episodes: 5 });
spcSuite('week-01', { points: 2189 + 2188 + 437 + 437, episodes: 36 });

describe('probe P3: SPC rebuild cost on a week of readings (#200)', () => {
  it('derives a week of readings and writes the episodes per new reading within the budget', async () => {
    const run = await headless('week-01');
    const { anchor, facts } = testerMessages(run);
    const cycles = facts
      .map((d, index) => ({ d, index }))
      .filter(({ d }) => d.topic.endsWith('/events/cycle-complete'));
    // A first-pass reading after the baseline (the 150th cycle) arrives last: until then every
    // later reading is provisional; when it comes, every later moving range and subgroup moves.
    const late = cycles[150]?.index ?? -1;
    const m = await mes('spc_p3');
    await m.send([anchor]);
    const body = facts.filter((_, i) => i !== late);
    const tail = 400;
    const head = body.slice(0, body.length - tail);
    for (let i = 0; i < head.length; i += 500) {
      await m.send(head.slice(i, i + 500));
      await m.quality.tick();
    }
    const perReading: number[] = [];
    for (const delivery of body.slice(body.length - tail)) {
      await m.send([delivery]);
      const started = performance.now();
      await m.quality.tick();
      const took = performance.now() - started;
      if (delivery.topic.endsWith('/events/cycle-complete')) perReading.push(took);
    }
    const before = (await m.quality.signals({ characteristic: CHARACTERISTIC, limit: 10_000 }))
      .signals;
    const lateFact = facts[late];
    if (!lateFact) throw new Error('no late fact');
    await m.send([lateFact]);
    const started = performance.now();
    await m.quality.tick();
    const lateMs = performance.now() - started;
    const after = (await m.quality.signals({ characteristic: CHARACTERISTIC, limit: 10_000 }))
      .signals;
    // The very charts and episodes as delivered in order.
    expect(await expectSpc(m, run)).toEqual({ points: 2189 + 2188 + 437 + 437, episodes: 36 });
    // The read path (#200 review M5): the chart route's body from the derivation in memory, the
    // whole week and the default recent window, and ten reads at once.
    const read = async (all: boolean): Promise<{ ms: number; bytes: number }> => {
      const t0 = performance.now();
      const view = await m.quality.chart(CHARACTERISTIC);
      if (!view) throw new Error('no chart');
      const body = JSON.stringify(spcChartDto(view, { all }));
      return { ms: performance.now() - t0, bytes: body.length };
    };
    const reads = { all: [] as number[], recent: [] as number[], bytesAll: 0, bytesRecent: 0 };
    for (let i = 0; i < 20; i++) {
      const whole = await read(true);
      const recent = await read(false);
      reads.all.push(whole.ms);
      reads.recent.push(recent.ms);
      reads.bytesAll = whole.bytes;
      reads.bytesRecent = recent.bytes;
    }
    reads.all.sort((a, b) => a - b);
    reads.recent.sort((a, b) => a - b);
    const parallel0 = performance.now();
    await Promise.all(Array.from({ length: 10 }, () => read(false)));
    const parallel = performance.now() - parallel0;
    console.log(
      `P3 read path: chart body (whole week, ${String(reads.bytesAll)} bytes) p50 ${ms(quantile(reads.all, 0.5))} ms, max ${ms(reads.all.at(-1) ?? 0)} ms; ` +
        `default recent window (${String(reads.bytesRecent)} bytes) p50 ${ms(quantile(reads.recent, 0.5))} ms, max ${ms(reads.recent.at(-1) ?? 0)} ms; 10 concurrent ${ms(parallel)} ms`,
    );
    perReading.sort((a, b) => a - b);
    const p50 = quantile(perReading, 0.5);
    const p95 = quantile(perReading, 0.95);
    const max = perReading.at(-1) ?? 0;
    console.log(
      `P3: ${String(perReading.length)} new readings on a week (2,189 first-pass readings): tick p50 ${ms(p50)} ms, p95 ${ms(p95)} ms, max ${ms(max)} ms; ` +
        `a late reading before ${String(cycles.length - 150)} later ones: ${ms(lateMs)} ms (episodes ${String(before.length)} provisional and final before, ${String(after.length)} final after)`,
    );
    // The probe's 20 ms budget holds on an idle machine (ADR-0032: p95 about 14 ms); the gate may
    // share the machine, which slowed every suite here up to threefold, so the test guards against
    // a regression of that order rather than the budget itself, and the log line records it.
    expect(p95).toBeLessThan(60);
    await m.stop();
  }, 600_000);
});
