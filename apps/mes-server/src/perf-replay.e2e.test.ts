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
 * times of the first and last publication and how late the pacing ran.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { loadPlantConfig } from '@shopfloor/plant-config';
import mqtt from 'mqtt';
import { describe, expect, it } from 'vitest';
import { goldenUnsMessages, type SimEvent } from './modules/equipment/golden-feed.test-support.ts';
import { PLANT_CONFIG } from './modules/equipment/test-support.ts';

const url = process.env.PERF_REPLAY_BROKER_URL;
const REPO = resolve(import.meta.dirname, '../../..');
const HEADLESS = join(REPO, 'apps/simulator/src/headless/cli.ts');
const HOUR = 3_600_000;

describe.skipIf(url === undefined)('performance headroom replay (#245, run P3)', () => {
  it('publishes week-01 Monday’s golden feed to the broker at three times 60×', async () => {
    const speed = Number(process.env.PERF_REPLAY_SPEED ?? 180);
    const hours = Number(process.env.PERF_REPLAY_HOURS ?? 26);
    const epoch = Number(process.env.PERF_REPLAY_EPOCH ?? 1_760_200_000);
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
      const {
        facts,
        anchors,
        end: watermark,
      } = goldenUnsMessages({ start, end, events }, loaded.config, epoch);
      const deliveries = [...anchors, ...facts, watermark].map((d) => {
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
      let lateMaxMs = 0;
      const t0 = Date.now() + 1_000;
      let firstAt: number | undefined;
      let lastAt = 0;
      try {
        for (const delivery of deliveries) {
          const due = t0 + (delivery.sourceTime - start) / speed;
          const wait = due - Date.now();
          if (wait > 0) await sleep(wait);
          lateMaxMs = Math.max(lateMaxMs, Date.now() - due);
          const at = Date.now();
          firstAt ??= at;
          lastAt = at;
          // The gateway's read time is its publication here: the lag runs from it to the commit.
          const payload = JSON.stringify({
            ...delivery.message,
            receivedAt: new Date(at).toISOString(),
          });
          await client.publishAsync(delivery.topic, payload, { qos: 1 });
        }
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
        messages: deliveries.length,
        facts: facts.length,
        lastSeq,
        firstAt: new Date(firstAt ?? t0).toISOString(),
        lastAt: new Date(lastAt).toISOString(),
        wallMs: lastAt - (firstAt ?? t0),
        lateMaxMs: Math.round(lateMaxMs),
      };
      console.log(`perf replay: ${JSON.stringify(report)}`);
      const reportPath = process.env.PERF_REPLAY_REPORT;
      if (reportPath) await writeFile(reportPath, JSON.stringify(report));
      expect(deliveries.length).toBeGreaterThan(0);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 3_600_000);
});
