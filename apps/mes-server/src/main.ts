import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { sql } from 'kysely';
import { createDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const env = parsed.env;
const plant = await loadPlantConfig(resolve(env.PLANT_CONFIG_DIR));
if (!plant.ok) {
  console.error(formatIssues(plant.issues));
  process.exit(1);
}
const db = createDatabase(env.DATABASE_URL);
const state = { migrated: false, stopping: false };

let ingest: Ingest | undefined;

const { app, registry } = buildMesHttp({
  // Ready once migrated, the database answers and the UNS subscription is granted.
  ready: async () => {
    if (!state.migrated || state.stopping || ingest?.subscribed !== true) return false;
    return sql`SELECT 1`.execute(db).then(
      () => true,
      () => false,
    );
  },
  logger: { level: env.LOG_LEVEL },
});
const log = app.log;

async function shutdown(signal: string): Promise<void> {
  if (state.stopping) return;
  state.stopping = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Requests and the UNS session first (nothing unstored is acknowledged), then the pool they use.
  for (const close of [() => app.close(), async () => ingest?.stop(), () => db.destroy()]) {
    await close().catch((error: unknown) => {
      log.error(error);
    });
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

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
try {
  const result = await migrate(db, env.MIGRATIONS_DIR);
  await new MasterData(db).seed(plant.config);
  state.migrated = true;
  log.info({ applied: result.applied, alreadyApplied: result.skipped }, 'database migrated');
  ingest = new Ingest({
    db,
    url: env.MQTT_URL,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    clientId: env.MQTT_CLIENT_ID,
    sessionExpirySeconds: env.MQTT_SESSION_EXPIRY_S,
    gapGraceMs: env.INGEST_GAP_GRACE_MS,
    registry,
    log: log.child({ module: 'ingest' }),
  });
  await ingest.start();
} catch (error) {
  if (state.stopping) await new Promise(() => undefined); // shutdown() owns the exit
  log.fatal({ err: error }, 'start-up failed');
  await app.close();
  await db.destroy();
  process.exit(1);
}
log.info('mes-server started; ready once subscribed to the UNS');
