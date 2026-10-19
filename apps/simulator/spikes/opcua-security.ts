/**
 * Probe Q1 (#239, Phase 9 plan): OPC UA SignAndEncrypt at 60×.
 *
 * One security mode per run, so each mode's process CPU stands alone:
 *
 *   node apps/simulator/spikes/opcua-security.ts none
 *   node apps/simulator/spikes/opcua-security.ts sign-and-encrypt [--paced-minutes 30] [--checks]
 *
 * 1. Lossless delivery (ADR-0009's spike and #56 repeated): five servers, two clients each, the rest
 *    of Monday's shift A on a manual clock (1 s of wall time every 5 ms, so the servers publish far
 *    faster than a real 60× run); every client must receive a gap-free `Sequence` equal to what the
 *    model emitted. Process CPU (servers and clients in this one process) per delivered event.
 * 2. Paced 60× (`--paced-minutes`, default 20 simulated minutes): the real clock, delivery latency
 *    from the server's raise to the client's notification, and CPU per wall second.
 * 3. `--checks` (sign-and-encrypt only): an unpinned client certificate, an anonymous session, and a
 *    client certificate issued by a CA that the server trusts, without and with a CRL.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPCUA_EVENT_FIELDS, OPCUA_MACHINES, SHOPFLOOR_NAMESPACE_URI } from '@shopfloor/contracts';
import {
  OPCUA_USERS,
  TOOLS_APPLICATION_URI,
  createCertificateAuthority,
  createEmptyCrl,
  createKeyAndCertificate,
  ensureOpcuaPki,
  issueCertificate,
  pkiFiles,
} from '@shopfloor/pki';
import { HOUR, MINUTE } from '@shopfloor/sim-core';
import { AttributeIds, TimestampsToReturn, constructEventFilter, resolveNodeId } from 'node-opcua';
import { createLiveRun, type LiveRun } from '../src/live/run.ts';
import { ManualClock } from '../src/live/testing.ts';
import { systemClock } from '../src/live/pacer.ts';
import type { PlantEvent } from '../src/plant/line.ts';
import { loadDefaultConfig } from '../src/plant/testing.ts';
import { PlantServers } from '../src/opcua/plant-servers.ts';
import type { ServerSecurity } from '../src/opcua/security.ts';
import { connect, wait, type TestClient } from '../src/opcua/testing.ts';
import { freeOffset } from '@shopfloor/test-kit/ports';

const mode = process.argv[2] === 'none' ? 'none' : 'sign-and-encrypt';
const pacedArg = process.argv.indexOf('--paced-minutes');
const pacedMinutes = pacedArg > 0 ? Number(process.argv[pacedArg + 1]) : 20;
const checks = process.argv.includes('--checks');
const T0 = Date.UTC(2026, 9, 12, 3); // Monday 06:00 Istanbul
const SPEED = 60;

const root = await mkdtemp(join(tmpdir(), 'shopfloor-twin-q1-'));
const pki = {
  simulator: join(root, 'simulator'),
  gateway: join(root, 'gateway'),
  tools: join(root, 'tools'),
};
const keyStart = performance.now();
const made = await ensureOpcuaPki(pki);
const keyMs = performance.now() - keyStart;
const passwords = {
  gateway: randomBytes(16).toString('hex'),
  reader: randomBytes(16).toString('hex'),
};
const security: ServerSecurity =
  mode === 'none' ? { mode: 'none' } : { mode: 'sign-and-encrypt', passwords };
const asGateway: TestClient =
  mode === 'none'
    ? { mode: 'none' }
    : {
        mode: 'sign-and-encrypt',
        pkiFolder: pki.gateway,
        applicationUri:
          made.identities.find((i) => i.name === 'edge-gateway')?.applicationUri ?? '',
        user: { userName: OPCUA_USERS.gateway, password: passwords.gateway },
      };
const asTools: TestClient =
  mode === 'none'
    ? { mode: 'none' }
    : {
        mode: 'sign-and-encrypt',
        pkiFolder: pki.tools,
        applicationUri: TOOLS_APPLICATION_URI,
        user: { userName: OPCUA_USERS.reader, password: passwords.reader },
      };

// The CA probe needs its material in place before the servers read their trust lists.
const caProbe = checks && mode === 'sign-and-encrypt' ? await prepareCaProbe() : undefined;

const config = await loadDefaultConfig();
const offset = await freeOffset(OPCUA_MACHINES.map((m) => m.port));
const port = (id: string) => (OPCUA_MACHINES.find((m) => m.id === id)?.port ?? 0) + offset;

interface Received {
  machine: string;
  sequences: number[];
  latencies: number[];
}

const raisedAt = new Map<string, number>();
const plantEvents: PlantEvent[] = [];

async function startPlant(clock: ManualClock | typeof systemClock) {
  const servers = new PlantServers({
    config,
    start: T0,
    portOffset: offset,
    pkiFolder: pki.simulator,
    security,
  });
  const run: LiveRun = createLiveRun({
    config,
    seed: 20261012,
    start: T0,
    speed: SPEED,
    clock,
    onEvent: (event) => {
      plantEvents.push(event);
      servers.record(event);
      if (
        'machineId' in event &&
        (event.type === 'state' ||
          event.type === 'cycle-complete' ||
          event.type === 'alarm' ||
          event.type === 'job')
      ) {
        const server = servers.servers.find((s) => s.machineId === event.machineId);
        if (server)
          raisedAt.set(`${event.machineId}:${String(server.sequence)}`, performance.now());
      }
    },
  });
  servers.attach(run);
  await servers.start();
  run.pacer.start();
  run.pacer.pause();
  return { servers, run };
}

async function subscribeAll(): Promise<{ clients: Received[]; close: () => Promise<void> }> {
  // Under `none` the clients use node-opcua's default certificate store, which ten clients would
  // race to create: one client first.
  if (mode === 'none') await (await connect(port('cnc-01'), asTools)).close();
  const opened = await Promise.all(
    OPCUA_MACHINES.flatMap((machine) =>
      [asGateway, asTools].map(async (as) => {
        const connection = await connect(port(machine.id), as);
        const namespaces = await connection.session.readNamespaceArray();
        const ns = namespaces.indexOf(SHOPFLOOR_NAMESPACE_URI);
        const subscription = await connection.session.createSubscription2({
          requestedPublishingInterval: 100,
          requestedMaxKeepAliveCount: 20,
          requestedLifetimeCount: 600,
          maxNotificationsPerPublish: 0,
          publishingEnabled: true,
          priority: 1,
        });
        const received: Received = { machine: machine.id, sequences: [], latencies: [] };
        const item = await subscription.monitor(
          { nodeId: resolveNodeId('i=2253'), attributeId: AttributeIds.EventNotifier },
          {
            samplingInterval: 0,
            queueSize: 5_000,
            discardOldest: false,
            filter: constructEventFilter(
              OPCUA_EVENT_FIELDS.common.map((f) => `${String(ns)}:${f}`),
            ),
          },
          TimestampsToReturn.Both,
        );
        item.on('changed', (values: unknown) => {
          const now = performance.now();
          const [sequence, machineId] = (values as { value: unknown }[]).map((v) => v.value);
          if (machineId !== machine.id) return;
          received.sequences.push(Number(sequence));
          const raised = raisedAt.get(`${machine.id}:${String(sequence)}`);
          if (raised !== undefined) received.latencies.push(now - raised);
        });
        return { received, connection, subscription };
      }),
    ),
  );
  return {
    clients: opened.map((o) => o.received),
    close: async () => {
      await Promise.all(
        opened.map(async (o) => {
          await o.subscription.terminate();
          await o.connection.close();
        }),
      );
    },
  };
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN
  );
};

function checkGapFree(
  clients: Received[],
  first: Map<string, number>,
  last: Map<string, number>,
): string[] {
  const problems: string[] = [];
  for (const c of clients) {
    const from = first.get(c.machine) ?? 0;
    const to = last.get(c.machine) ?? 0;
    const inWindow = c.sequences.filter((s) => s >= from && s <= to);
    const expected = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    if (JSON.stringify(inWindow) !== JSON.stringify(expected)) {
      problems.push(
        `${c.machine}: ${String(inWindow.length)} of ${String(expected.length)} in order`,
      );
    }
  }
  return problems;
}

const report: Record<string, unknown> = {
  mode,
  node: process.version,
  cpus: (await import('node:os')).availableParallelism(),
  pki: { identities: made.identities.length, ms: Math.round(keyMs) },
};

// 1. Compressed scripted shift on a manual clock.
{
  const clock = new ManualClock();
  const { servers, run } = await startPlant(clock);
  const { clients, close } = await subscribeAll();
  await wait(500);
  const first = new Map(servers.servers.map((s) => [s.machineId, s.sequence + 1]));
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  run.pacer.resume();
  const wallMs = Math.ceil((T0 + 8 * HOUR - run.simulation.now) / SPEED);
  for (let t = 0; t < wallMs; t += 1_000) {
    clock.advance(Math.min(1_000, wallMs - t));
    await wait(5);
  }
  run.pacer.pause();
  const last = new Map(servers.servers.map((s) => [s.machineId, s.sequence]));
  for (let deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (clients.every((c) => (c.sequences.at(-1) ?? 0) >= (last.get(c.machine) ?? 0))) break;
    await wait(50);
  }
  const cpu = process.cpuUsage(cpu0);
  const elapsed = performance.now() - wall0;
  const events = [...last].reduce((sum, [id, to]) => sum + to - (first.get(id) ?? 0) + 1, 0);
  const delivered = clients.reduce((sum, c) => sum + c.sequences.length, 0);
  const problems = checkGapFree(clients, first, last);
  report.compressed = {
    simulated: 'Monday 06:00-14:00 (rest of shift A)',
    eventsRaised: events,
    notificationsDelivered: delivered,
    gapFree: problems.length === 0,
    problems,
    wallMs: Math.round(elapsed),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    cpuUsPerNotification: Math.round((cpu.user + cpu.system) / delivered),
  };
  await close();
  run.pacer.stop();
  await servers.stop();
}

// 2. Paced 60× on the real clock.
if (pacedMinutes > 0) {
  raisedAt.clear();
  const { servers, run } = await startPlant(systemClock);
  const { clients, close } = await subscribeAll();
  await wait(500);
  const first = new Map(servers.servers.map((s) => [s.machineId, s.sequence + 1]));
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  run.pacer.resume();
  await wait((pacedMinutes * MINUTE) / SPEED);
  run.pacer.pause();
  const elapsed = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const last = new Map(servers.servers.map((s) => [s.machineId, s.sequence]));
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (clients.every((c) => (c.sequences.at(-1) ?? 0) >= (last.get(c.machine) ?? 0))) break;
    await wait(50);
  }
  const latencies = clients.flatMap((c) => c.latencies);
  const delivered = clients.reduce(
    (sum, c) => sum + c.sequences.filter((s) => s >= (first.get(c.machine) ?? 0)).length,
    0,
  );
  report.paced = {
    simulatedMinutes: pacedMinutes,
    wallMs: Math.round(elapsed),
    notificationsDelivered: delivered,
    gapFree: checkGapFree(clients, first, last).length === 0,
    cpuShareOfOneCore: Number(((cpu.user + cpu.system) / 1000 / elapsed).toFixed(3)),
    latencyMs: {
      count: latencies.length,
      p50: Number(percentile(latencies, 50).toFixed(1)),
      p95: Number(percentile(latencies, 95).toFixed(1)),
      p99: Number(percentile(latencies, 99).toFixed(1)),
      max: Number(Math.max(...latencies).toFixed(1)),
    },
  };
  await close();
  run.pacer.stop();
  await servers.stop();
}

// 3. Refusals and the CA probe.
if (checks && mode === 'sign-and-encrypt') {
  const clock = new ManualClock();
  const { servers, run } = await startPlant(clock);
  const outcome = async (as: TestClient, machine: string): Promise<string> => {
    try {
      const { close } = await connect(port(machine), as);
      await close();
      return 'session opened';
    } catch (error) {
      return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    }
  };
  const unpinned = join(root, 'unpinned');
  await mkdir(join(unpinned, 'own', 'certs'), { recursive: true });
  await mkdir(join(unpinned, 'own', 'private'), { recursive: true });
  await mkdir(join(unpinned, 'trusted', 'certs'), { recursive: true });
  const fresh = await createKeyAndCertificate({
    commonName: 'unpinned',
    role: 'client',
    applicationUri: TOOLS_APPLICATION_URI,
    dnsNames: ['localhost'],
    validityDays: 365,
    now: new Date(),
  });
  await writeFile(pkiFiles(unpinned).certificateFile, fresh.certificatePem);
  await writeFile(pkiFiles(unpinned).privateKeyFile, fresh.privateKeyPem);
  // The unpinned client trusts the servers, so only the server's check can refuse it.
  for (const machine of OPCUA_MACHINES) {
    await writeFile(
      join(unpinned, 'trusted', 'certs', `${machine.id}.pem`),
      await import('node:fs/promises').then((fs) =>
        fs.readFile(pkiFiles(join(pki.simulator, machine.id)).certificateFile, 'utf8'),
      ),
    );
  }
  const results: Record<string, string> = {
    'pinned tools certificate, opcua-reader': await outcome(asTools, 'cnc-01'),
    'unpinned client certificate, opcua-reader': await outcome(
      {
        mode: 'sign-and-encrypt',
        pkiFolder: unpinned,
        applicationUri: TOOLS_APPLICATION_URI,
        user: (asTools as { user: { userName: string; password: string } }).user,
      },
      'cnc-01',
    ),
    'pinned tools certificate, anonymous': await outcome(
      { mode: 'sign-and-encrypt', pkiFolder: pki.tools, applicationUri: TOOLS_APPLICATION_URI },
      'cnc-01',
    ),
  };
  if (caProbe) {
    results['CA-issued client, CA trusted, no CRL (lkt-01)'] = await outcome(
      caProbe.client,
      'lkt-01',
    );
    results['CA-issued client, CA trusted, empty CRL (pck-01)'] = await outcome(
      caProbe.client,
      'pck-01',
    );
  }
  report.checks = results;
  run.pacer.stop();
  await servers.stop();
}

console.log(JSON.stringify(report, null, 2));
await rm(root, { recursive: true, force: true });
process.exit(0);

/**
 * A CA, a client certificate it issues, and two servers that trust the CA: LKT-01 without a CRL,
 * PCK-01 with an empty one (in `trusted/crl`). Written before the servers start.
 */
async function prepareCaProbe(): Promise<{ client: TestClient }> {
  const now = new Date();
  const ca = await createCertificateAuthority({
    commonName: 'q1 probe CA',
    validityDays: 365,
    now,
  });
  const issued = await issueCertificate(ca, {
    commonName: 'q1 CA-issued client',
    role: 'client',
    applicationUri: TOOLS_APPLICATION_URI,
    dnsNames: ['localhost'],
    validityDays: 365,
    now,
  });
  const folder = join(root, 'ca-client');
  for (const sub of ['own/certs', 'own/private', 'trusted/certs']) {
    await mkdir(join(folder, sub), { recursive: true });
  }
  // The client sends its chain (its certificate, then the CA's).
  await writeFile(pkiFiles(folder).certificateFile, issued.certificatePem + ca.certificatePem);
  await writeFile(pkiFiles(folder).privateKeyFile, issued.privateKeyPem);
  const fs = await import('node:fs/promises');
  for (const machine of ['lkt-01', 'pck-01']) {
    const serverFolder = join(pki.simulator, machine);
    await fs.writeFile(join(serverFolder, 'trusted', 'certs', 'q1-ca.pem'), ca.certificatePem);
    await fs.writeFile(
      join(folder, 'trusted', 'certs', `${machine}.pem`),
      await fs.readFile(pkiFiles(serverFolder).certificateFile, 'utf8'),
    );
  }
  await fs.writeFile(
    join(pki.simulator, 'pck-01', 'trusted', 'crl', 'q1-ca.crl.pem'),
    await createEmptyCrl(ca, now),
  );
  return {
    client: {
      mode: 'sign-and-encrypt',
      pkiFolder: folder,
      applicationUri: TOOLS_APPLICATION_URI,
      user: { userName: OPCUA_USERS.reader, password: passwords.reader },
    },
  };
}
