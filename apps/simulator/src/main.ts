import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { buildControlApp } from './control/app.ts';
import { parseEnv } from './control/env.ts';
import { EventHub } from './control/event-hub.ts';
import { createLiveRun } from './live/run.ts';
import { WasherModbusServer } from './modbus/washer-server.ts';
import { PlantServers } from './opcua/plant-servers.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const env = parsed.env;

const loaded = await loadPlantConfig(resolve(env.SIM_CONFIG_DIR)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
}

const hub = new EventHub();
const servers = new PlantServers({
  config: loaded.config,
  start: env.SIM_START,
  host: env.OPCUA_HOST,
  portOffset: env.OPCUA_PORT_OFFSET,
  ...(env.OPCUA_PKI_DIR ? { pkiFolder: resolve(env.OPCUA_PKI_DIR) } : {}),
});
const washer = new WasherModbusServer({
  config: loaded.config,
  epoch: servers.epoch,
  host: env.MODBUS_HOST,
  port: env.MODBUS_PORT,
  onError: (error) => {
    log.error(error, 'Modbus server error');
  },
});
const run = createLiveRun({
  config: loaded.config,
  seed: env.SIM_SEED,
  start: env.SIM_START,
  speed: env.SIM_SPEED,
  onEvent: (event) => {
    servers.record(event);
    washer.record(event);
    hub.record(event);
  },
});
servers.attach(run);
washer.attach(run);

const app = await buildControlApp({
  pacer: run.pacer,
  hub,
  ready: () => servers.servers.every((server) => server.started) && washer.started,
  faults: {
    modbusSilent: (silent) => {
      washer.silent = silent;
    },
  },
  logger: { level: env.LOG_LEVEL },
});
const log = app.log;

const shutdownState = { stopping: false };
async function shutdown(signal: string): Promise<void> {
  if (shutdownState.stopping) return;
  shutdownState.stopping = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  run.pacer.stop();
  const results = await Promise.allSettled([app.close(), servers.stop(), washer.stop()]);
  for (const result of results) {
    if (result.status === 'rejected') log.error(result.reason);
  }
  log.info('stopped');
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

try {
  await app.listen({ host: env.CONTROL_HOST, port: env.CONTROL_PORT });
  await Promise.all([servers.start(), washer.start()]);
} catch (error) {
  if (shutdownState.stopping) {
    // A signal arrived during start-up; shutdown() owns the exit.
    await new Promise(() => undefined);
  }
  log.fatal(error);
  await app.close();
  process.exit(1);
}
for (const server of servers.servers) {
  log.info({ machineId: server.machineId, endpoint: server.endpoint }, 'OPC UA server listening');
}
log.info({ machineId: washer.machineId, port: washer.port }, 'Modbus TCP server listening');
if (env.SIM_AUTOSTART === 'true' && run.pacer.state === 'idle') {
  run.pacer.start();
}
log.info(
  {
    seed: env.SIM_SEED,
    epoch: servers.epoch,
    speed: env.SIM_SPEED,
    start: new Date(env.SIM_START).toISOString(),
    running: env.SIM_AUTOSTART === 'true',
  },
  'simulator ready',
);
