import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { parseEnv } from './env.ts';
import { buildGatewayHttp } from './http.ts';
import { TopicSequences, unixSeconds } from './identity.ts';
import { MqttLink } from './mqtt-link.ts';

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
const http = buildGatewayHttp({
  ready: () => link.connected,
  published: () => link.published,
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
  const results = await Promise.allSettled([http.close(), link.close()]);
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
log.info(
  { gatewayId: env.GATEWAY_ID, epoch: sequences.epoch, version: VERSION },
  'gateway started',
);
