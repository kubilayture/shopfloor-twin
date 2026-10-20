/**
 * The performance suite's headroom replay (#245, Phase 9 plan "Performance", run P3, target T6;
 * ADR-0040): `week-01`'s Monday golden feed published to a disposable Compose project's broker at
 * three times the 60× rate, while that project's MES ingests it.
 *
 * Skipped unless `PERF_REPLAY_BROKER_URL` is set: `e2e/src/perf.ts` (`pnpm test:perf`) runs it with
 * `pnpm --filter @shopfloor/mes-server exec vitest run --config vitest.e2e.config.ts
 * src/perf-replay.e2e.test.ts`, with the broker's port that e2e/compose.perf-replay.yml publishes
 * for that run only. It lives here, as the trace-performance loader does (#204), because the feed
 * is the golden harness's (`goldenUnsMessages`): `e2e/src/perf.ts` only measures and imports no
 * `mes-server` code (Phase 9 plan review round 1, finding 22).
 *
 * The feed: the headless run of `week-01` cut at `PERF_REPLAY_HOURS` (default 26: Monday's three
 * shifts and two more hours, so every machine has a fact after Monday's last shift ends) as the
 * gateway would publish it: one state snapshot per machine, then every state change, cycle, alarm
 * and job fact with the machine's own sequence, and one WSH-01 telemetry sample at the cut (the
 * watermark). Each message is published at its source time's place on a wall clock running at
 * `PERF_REPLAY_SPEED` (default 180, three times 60×), QoS 1, as the gateway's MQTT user, with
 * `receivedAt` set to the wall time of its publication: the MES's `mes_ingest_lag_seconds` then
 * measures from this publication to its commit, as it measures from the gateway's read live. The
 * report (`PERF_REPLAY_REPORT`) lists the messages, each machine's last sequence number, the wall
 * times of the first and last publication, the rate and how late the pacing ran.
 *
 * Telemetry (#245 review, finding 1): the golden feed has none, so on its own "three times 60×"
 * offered about the live message rate. The gateway samples each OPC UA telemetry variable every
 * second (`TELEMETRY_SAMPLING_MS`, published on change) and polls the Modbus washer every 250 ms
 * (`MODBUS_POLL_MS`, both values every poll), wall time at any speed. So beside the facts this
 * publishes every telemetry metric of `UNS_TELEMETRY` at `PERF_REPLAY_TELEMETRY_FACTOR` (default
 * 3) times that cadence, as the gateway would: topic-scoped sequences in the gateway's epoch, the
 * device epoch, a slowly varying value, and as its source time the source time of the last fact
 * published (so no sample moves the plant clock ahead of a fact still to come). A last washer
 * sample at the cut is the watermark the run is observed up to, as the golden feed's.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { loadPlantConfig } from '@shopfloor/plant-config';
import { UNS_TELEMETRY, type EquipmentPath } from '@shopfloor/contracts';
import mqtt from 'mqtt';
import { describe, expect, it } from 'vitest';
import { goldenUnsMessages, type SimEvent } from './modules/equipment/golden-feed.test-support.ts';
import { PLANT_CONFIG, UnsFeed } from './modules/equipment/test-support.ts';

const url = process.env.PERF_REPLAY_BROKER_URL;
const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const HOUR = 3_600_000;
/** The gateway's live cadence per telemetry source (wall ms; its env defaults). */
const LIVE_SAMPLING_MS = { opcua: 1_000, modbus: 250 } as const;

describe.skipIf(url === undefined)('performance headroom replay (#245, run P3)', () => {
  it('publishes week-01 Monday’s golden feed to the broker at three times 60×', async () => {
    const speed = Number(process.env.PERF_REPLAY_SPEED ?? 180);
    const hours = Number(process.env.PERF_REPLAY_HOURS ?? 26);
    const epoch = Number(process.env.PERF_REPLAY_EPOCH ?? 1_760_200_000);
    const factor = Number(process.env.PERF_REPLAY_TELEMETRY_FACTOR ?? 3);
    const loaded = await loadPlantConfig(PLANT_CONFIG);
    if (!loaded.ok) throw new Error('plant config');
    const out = await mkdtemp(join(tmpdir(), 'perf-replay-'));
    try {
      await promisify(execFile)(
        process.execPath,
        [HEADLESS, '--scenario', 'week-01', '--out', out],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const [header, ...rest] = (await readFile(join(out, 'events.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n');
      const span = JSON.parse(header ?? '{}') as { start: string };
      const start = Date.parse(span.start);
      const end = start + hours * HOUR;
      const events = rest
        .map((line) => JSON.parse(line) as SimEvent)
        .filter((event) => Date.parse(event.at) < end);
      const { facts, anchors } = goldenUnsMessages({ start, end, events }, loaded.config, epoch);
      const deliveries = [...anchors, ...facts].map((d) => {
        const message = JSON.parse(d.payload) as { sourceTime?: string; seq?: number };
        return {
          topic: d.topic,
          message: message,
          sourceTime: message.sourceTime === undefined ? start : Date.parse(message.sourceTime),
        };
      });
      const lastSeq: Record<string, number> = {};
      for (const fact of facts) {
        const message = JSON.parse(fact.payload) as { source: { id: string }; seq: number };
        lastSeq[message.source.id] = Math.max(lastSeq[message.source.id] ?? 0, message.seq);
      }

      const client = await mqtt.connectAsync(url ?? '', {
        clientId: process.env.PERF_REPLAY_CLIENT_ID ?? 'gw-01',
        username: process.env.PERF_REPLAY_USERNAME ?? 'gw-01',
        password: process.env.PERF_REPLAY_PASSWORD ?? '',
        protocolVersion: 5,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 10_000,
      });
      // The synthetic telemetry streams, each with its own wall period.
      const paths = new Map<string, EquipmentPath>();
      for (const area of loaded.config.plant.areas) {
        for (const workCenter of area.workCenters) {
          for (const item of workCenter.equipment) {
            paths.set(item.id, { area: area.id, workCenter: workCenter.id, equipment: item.id });
          }
        }
      }
      const feed = new UnsFeed(paths);
      const streams = Object.entries(UNS_TELEMETRY).flatMap(([name, metric]) =>
        metric.equipment.map((equipment) => ({
          equipment,
          name,
          unit: metric.unit,
          periodMs: LIVE_SAMPLING_MS[equipment.startsWith('wsh') ? 'modbus' : 'opcua'] / factor,
          // Spread over the period, so the streams don't publish in one burst.
          next: 0,
        })),
      );
      streams.forEach((stream, i) => {
        stream.next = (stream.periodMs * i) / streams.length;
      });
      const telemetry = (equipment: string, name: string, unit: string, at: number, i: number) => {
        const d = feed.telemetry(equipment, at, epoch, name, unit, 0);
        const message = JSON.parse(d.payload) as Record<string, unknown>;
        // A slowly varying reading, two decimals, as a sensor's.
        message.value = Math.round((50 + 10 * Math.sin(i / 50 + name.length)) * 100) / 100;
        return { topic: d.topic, message };
      };

      let lateMaxMs = 0;
      const t0 = Date.now() + 1_000;
      let firstAt: number | undefined;
      let lastAt = 0;
      let published = 0;
      let samples = 0;
      let plantAt = start;
      const publish = async (topic: string, message: Record<string, unknown>, due: number) => {
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        lateMaxMs = Math.max(lateMaxMs, Date.now() - due);
        const at = Date.now();
        firstAt ??= at;
        lastAt = at;
        // The gateway's read time is its publication here: the lag runs from it to the commit.
        const payload = JSON.stringify({ ...message, receivedAt: new Date(at).toISOString() });
        await client.publishAsync(topic, payload, { qos: 1 });
        published++;
      };
      try {
        for (const delivery of deliveries) {
          const due = t0 + (delivery.sourceTime - start) / speed;
          // Every telemetry sample due before this fact, in due order.
          for (;;) {
            const stream = streams.reduce((a, b) => (b.next < a.next ? b : a));
            const sampleDue = t0 + stream.next;
            if (sampleDue >= due) break;
            const { topic, message } = telemetry(
              stream.equipment,
              stream.name,
              stream.unit,
              plantAt,
              samples,
            );
            await publish(topic, message, sampleDue);
            samples++;
            stream.next += stream.periodMs;
          }
          await publish(delivery.topic, delivery.message, due);
          plantAt = Math.max(plantAt, delivery.sourceTime);
        }
        // The watermark: a washer sample at the cut, as the golden feed's last message.
        const last = telemetry('wsh-01', 'bath-temperature', '°C', end, samples);
        await publish(last.topic, last.message, Date.now());
        samples++;
      } finally {
        await client.endAsync();
      }
      const report = {
        scenario: 'week-01',
        hours,
        speed,
        epoch,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        messages: published,
        facts: facts.length,
        telemetry: samples,
        telemetryFactor: factor,
        messagesPerSecond:
          Math.round((published / Math.max(1, (lastAt - (firstAt ?? t0)) / 1000)) * 10) / 10,
        lastSeq,
        firstAt: new Date(firstAt ?? t0).toISOString(),
        lastAt: new Date(lastAt).toISOString(),
        wallMs: lastAt - (firstAt ?? t0),
        lateMaxMs: Math.round(lateMaxMs),
      };
      console.log(`perf replay: ${JSON.stringify(report)}`);
      const reportPath = process.env.PERF_REPLAY_REPORT;
      if (reportPath) await writeFile(reportPath, JSON.stringify(report));
      expect(published).toBe(deliveries.length + samples);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 3_600_000);
});
