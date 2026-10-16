import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { sql } from 'kysely';
import { createDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
import { Equipment, downtimeRules } from './modules/equipment/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

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
// The API reads through its own small pool with a statement timeout (ADR-0019).
const readDb = createDatabase(env.DATABASE_URL, env.API_DB_POOL_SIZE, {
  statementTimeoutMs: env.API_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMs: env.API_STATEMENT_TIMEOUT_MS,
});
// The hourly aggregates refresh on their own connections, outside a transaction and without the
// API's statement timeout, never on ingest's acknowledgement path (ADR-0022).
const aggregateDb = createDatabase(env.DATABASE_URL, 2);
const state = { migrated: false, stopping: false };

let ingest: Ingest | undefined;
let equipment: Equipment | undefined;

const { app, registry, realtime } = await buildMesHttp({
  // Ready once migrated, the database answers and the UNS subscription is granted.
  ready: async () => {
    if (!state.migrated || state.stopping || ingest?.subscribed !== true) return false;
    return sql`SELECT 1`.execute(db).then(
      () => true,
      () => false,
    );
  },
  logger: { level: env.LOG_LEVEL },
  allowedHosts: list(env.HTTP_ALLOWED_HOSTS),
  allowedOrigins: list(env.HTTP_ALLOWED_ORIGINS),
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
  for (const close of [
    () => app.close(),
    async () => ingest?.stop(),
    async () => equipment?.stop(),
    () => db.destroy(),
    () => readDb.destroy(),
    () => aggregateDb.destroy(),
  ]) {
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
  const masterData = new MasterData(db);
  await masterData.seed(plant.config);
  state.migrated = true;
  log.info({ applied: result.applied, alreadyApplied: result.skipped }, 'database migrated');
  ingest = new Ingest({
    db,
    readDb,
    url: env.MQTT_URL,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    clientId: env.MQTT_CLIENT_ID,
    sessionExpirySeconds: env.MQTT_SESSION_EXPIRY_S,
    gapGraceMs: env.INGEST_GAP_GRACE_MS,
    refresh: { db: aggregateDb },
    registry,
    log: log.child({ module: 'ingest' }),
  });
  // Intervals catch up from the tables first, then follow ingest's notices.
  equipment = new Equipment({
    db,
    readDb,
    source: ingest,
    shiftPattern: await masterData.shiftPattern(),
    refresh: { db: aggregateDb },
    downtime: downtimeRules(plant.config),
    log: log.child({ module: 'equipment' }),
  });
  await equipment.start();
  // The API and push follow the modules from here; until then they answer 503.
  await realtime.attach({ masterData: new MasterData(readDb), equipment, ingest });
  await ingest.start();
} catch (error) {
  if (state.stopping) await new Promise(() => undefined); // shutdown() owns the exit
  log.fatal({ err: error }, 'start-up failed');
  await app.close();
  await db.destroy();
  await readDb.destroy();
  await aggregateDb.destroy();
  process.exit(1);
}
log.info('mes-server started; ready once subscribed to the UNS');
