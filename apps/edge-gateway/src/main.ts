import { resolve } from 'node:path';
import { FAILURE_ALARM_SEVERITY, OPCUA_MACHINES, modbusTables } from '@shopfloor/contracts';
import { OPCUACertificateManager } from 'node-opcua';
import { formatIssues, loadPlantConfig, plantAlarms } from '@shopfloor/plant-config';
import { parseEnv } from './env.ts';
import { buildGatewayHttp } from './http.ts';
import { TopicSequences, unixSeconds } from './identity.ts';
import { Outbox } from './buffer/outbox.ts';
import { CommandExecutor, type CommandMachine } from './commands/executor.ts';
import { CommandLink } from './commands/link.ts';
import { CommandStore } from './commands/store.ts';
import { equipmentPaths } from './hierarchy.ts';
import { UnsIncidentReporter } from './incidents.ts';
import { MqttLink } from './mqtt-link.ts';
import { ModbusPoller, connectModbus } from './modbus/poller.ts';
import { OpcuaCollector } from './opcua/collector.ts';

const VERSION = '0.1.0';
const SHUTDOWN_TIMEOUT_MS = 10_000;

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const env = parsed.env;

const loaded = await loadPlantConfig(resolve(env.PLANT_CONFIG_DIR)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
}

const alarmPoints = plantAlarms(loaded.config);
const startedAt = Date.now();
const sequences = new TopicSequences(unixSeconds(startedAt));
const link = new MqttLink({
  url: env.MQTT_URL,
  username: env.MQTT_USERNAME,
  password: env.MQTT_PASSWORD,
  gatewayId: env.GATEWAY_ID,
  version: VERSION,
  sequences,
  startedAt,
  onError: (error) => {
    // AggregateError (several addresses refused) has an empty message: log its parts.
    const parts = error instanceof AggregateError ? error.errors.map(String) : [error.message];
    log.error({ errors: parts }, 'MQTT connection error');
  },
});
// Every UNS message goes through the outbox (store-and-forward, ADR-0014); only the gateway's own
// status goes straight to the broker.
const outbox = new Outbox({
  path: resolve(env.BUFFER_PATH),
  transport: link,
  maxMessages: env.BUFFER_MAX_MESSAGES,
  onDrop: (count, reason, detail) => {
    if (reason === 'overflow') {
      incidents.report({ type: 'buffer-overflow', equipment: null, lost: count, message: detail });
    } else {
      log.error({ count, detail }, 'message refused by the broker and dropped');
    }
  },
  onError: (error) => {
    log.error({ err: error }, 'store-and-forward error');
  },
});
const incidents = new UnsIncidentReporter({
  gatewayId: env.GATEWAY_ID,
  publisher: outbox,
  sequences,
  onReport: (incident) => {
    log.warn({ incident }, 'data-quality incident');
  },
});
const certificateManager = new OPCUACertificateManager({
  rootFolder: resolve(env.OPCUA_PKI_DIR),
  automaticallyAcceptUnknownCertificate: true,
});
const paths = equipmentPaths(loaded.config);
const collectors = OPCUA_MACHINES.map((machine) => {
  const path = paths.get(machine.id);
  if (!path) throw new Error(`${machine.id} is not in the plant configuration`);
  return new OpcuaCollector({
    machine,
    path,
    host: env.OPCUA_HOST,
    portOffset: env.OPCUA_PORT_OFFSET,
    publisher: outbox,
    sequences,
    incidents,
    // The Alarms.<CODE>.Active variables the resync reads for the alarm snapshot (#141).
    alarmCodes: alarmPoints.filter((p) => p.equipment === machine.id).map((p) => p.code),
    telemetrySamplingMs: env.TELEMETRY_SAMPLING_MS,
    certificateManager,
    onError: (error) => {
      log.error({ err: error, machine: machine.id }, 'OPC UA collector error');
    },
  });
});
// The command path (#173, ADR-0029): deliveries are recorded in the gateway's SQLite file before
// their PUBACK, executed on the CNCs' OPC UA sessions, and answered through the outbox.
const commandStore = new CommandStore(resolve(env.BUFFER_PATH));
const commandMachines = new Map<string, CommandMachine>(
  collectors
    .filter((collector) => collector.kind === 'machine-tool')
    .map((collector) => [collector.machineId, collector] as const),
);
const executor = new CommandExecutor({
  store: commandStore,
  publisher: outbox,
  sequences,
  paths,
  machines: commandMachines,
  callDeadlineMs: env.GATEWAY_CALL_DEADLINE_MS,
  onResult: (value, equipment) => {
    const level = value.result === 'unknown' || value.result === 'rejected' ? 'warn' : 'info';
    log[level]({ equipment, result: value }, 'command result');
  },
  onInvalid: (entry, error) => {
    log.error({ topic: entry.topic, error }, 'invalid command dropped');
  },
  onSettleAcceptance: (value, equipment) => {
    log.warn(
      { equipment, result: value },
      'settle call accepted the job after expiresAt: clock skew between gateway and device',
    );
  },
  onError: (error) => {
    log.error({ err: error }, 'command error');
  },
});
const commandLink = new CommandLink({
  url: env.MQTT_URL,
  username: env.MQTT_USERNAME,
  password: env.MQTT_PASSWORD,
  clientId: `${env.GATEWAY_ID}-cmd`,
  areas: loaded.config.plant.areas.map((area) => area.id),
  sessionExpirySeconds: env.GATEWAY_CMD_SESSION_EXPIRY_S,
  store: commandStore,
  onCommand: (entry) => {
    executor.submit(entry);
  },
  onIgnored: (topic) => {
    log.warn({ topic }, 'delivery outside an equipment command topic ignored');
  },
  onError: (error) => {
    log.error({ err: error }, 'command session error');
  },
});
const washer = loaded.config.process.processValues.washer;
const washerPath = paths.get(washer.machine);
if (!washerPath) throw new Error(`${washer.machine} is not in the plant configuration`);
const washerFailures = loaded.config.failures.equipment[washer.machine];
const poller = new ModbusPoller({
  machineId: washer.machine,
  path: washerPath,
  tables: modbusTables({
    products: loaded.config.products.products.map((p) => p.id),
    failureCodes: washerFailures?.failureModes.map((m) => m.code) ?? [],
    minorStopCauses: washerFailures?.minorStops.causes ?? [],
  }),
  scaling: { bath: washer.bath.resolution, conveyor: washer.conveyor.resolution },
  // The washer's alarms are its failure codes, raised with the failure severity, as on OPC UA.
  alarmSeverity: FAILURE_ALARM_SEVERITY,
  // Answers take milliseconds; a timeout above 2 s only delays noticing a silent device.
  connect: () =>
    connectModbus(
      env.MODBUS_HOST,
      env.MODBUS_PORT,
      Math.min(2_000, Math.max(200, env.MODBUS_POLL_MS)),
    ),
  onError: (error) => {
    log.error({ err: error, machine: washer.machine }, 'Modbus poller error');
  },
  publisher: outbox,
  sequences,
  incidents,
  cursors: outbox,
  pollMs: env.MODBUS_POLL_MS,
});
const http = buildGatewayHttp({
  // Ready when both broker sessions are up and the command subscriptions are granted.
  ready: () => link.connected && commandLink.subscribed,
  published: () => outbox.delivered,
  buffer: () => ({ depth: outbox.depth, dropped: outbox.dropped }),
  commands: () => ({
    received: commandLink.received,
    calls: executor.calls,
    settleAcceptances: executor.settleAcceptances,
    callTimeouts: executor.callTimeouts,
    results: executor.results,
    ...executor.pending,
  }),
  machines: () => [
    ...collectors.map((c) => ({ id: c.machineId, connected: c.connected, facts: c.facts })),
    { id: poller.machineId, connected: poller.connected, facts: poller.facts },
  ],
  logger: { level: env.LOG_LEVEL },
});
const log = http.log;
link.client.on('connect', () => {
  log.info({ url: env.MQTT_URL }, 'broker connected');
});
link.client.on('offline', () => {
  log.warn('broker unreachable; reconnecting');
});

const state = { stopping: false };
async function shutdown(signal: string): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Commands first: nothing unanswered is acknowledged without being recorded, and what is
  // recorded and unanswered is processed again at the next start.
  await commandLink.close().catch((error: unknown) => {
    log.error(error);
  });
  await executor.stop();
  const stopped = await Promise.allSettled([...collectors.map((c) => c.stop()), poller.stop()]);
  // Unsent messages stay in the outbox for the next start.
  await outbox.close();
  commandStore.close();
  const results = [...stopped, ...(await Promise.allSettled([http.close(), link.close()]))];
  for (const result of results) {
    if (result.status === 'rejected') log.error(result.reason);
  }
  process.exit(signal === 'SIGINT' ? 130 : 0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      log.error(error);
      process.exit(1);
    });
  });
}

await http.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
link.start();
executor.start();
commandLink.start();
poller.start();
// The collectors share one client certificate: create it one collector at a time, then start
// them all at once in the background. A machine that is down keeps retrying by itself and holds
// up neither the others nor the gateway's readiness.
async function startWithRetry(collector: OpcuaCollector): Promise<void> {
  for (;;) {
    try {
      await collector.start();
      return;
    } catch (error) {
      if (state.stopping) return;
      log.error(
        { err: error, machine: collector.machineId },
        'OPC UA collector failed to start; retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}
void (async () => {
  await certificateManager.initialize();
  for (const collector of collectors) await collector.prepare();
  await Promise.allSettled(collectors.map((collector) => startWithRetry(collector)));
})().catch((error: unknown) => {
  log.fatal({ err: error }, 'cannot prepare the OPC UA client certificate');
  process.exit(1);
});
log.info(
  { gatewayId: env.GATEWAY_ID, epoch: sequences.epoch, version: VERSION },
  'gateway started',
);
