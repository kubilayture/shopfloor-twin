import { resolve } from 'node:path';
import { formatIssues, idealCycleMs, loadPlantConfig } from '@shopfloor/plant-config';
import { sql } from 'kysely';
import { Gauge } from 'prom-client';
import { createDatabase, poolStats } from './db/database.ts';
import { migrationStatus, type MigrationStatus } from './db/migrate.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
import { Alarms } from './modules/alarms/index.ts';
import { DowntimeCoding, Equipment, downtimeRules } from './modules/equipment/index.ts';
import { Identity, type IdentityLog } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { DowntimeFeed, Oee } from './modules/oee/index.ts';
import { Shifts } from './modules/shifts/index.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** How often a MES waiting for the migrate step looks at the migration history again. */
const MIGRATION_POLL_MS = 2_000;

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
// Logins, sessions and users on their own small pool (#168): a burst of logins or the session
// lookup of every request never takes a connection ingest's acknowledgement path waits for.
const identityDb = createDatabase(env.DATABASE_URL, 2);
const state = { migrated: false, stopping: false };
// The identity module answers the API from the start (503 until `start()` after the migrations);
// its log is the app's, which exists only once the HTTP server is built.
const identityLog: IdentityLog = {
  info: (object, message) => {
    app.log.child({ module: 'identity' }).info(object, message);
  },
  warn: (object, message) => {
    app.log.child({ module: 'identity' }).warn(object, message);
  },
  error: (object, message) => {
    app.log.child({ module: 'identity' }).error(object, message);
  },
};
const identity = new Identity({ db: identityDb, log: identityLog });

let ingest: Ingest | undefined;
let equipment: Equipment | undefined;
let oee: Oee | undefined;
let downtime: DowntimeFeed | undefined;
let coding: DowntimeCoding | undefined;
let alarms: Alarms | undefined;
let shifts: Shifts | undefined;

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
  writes: env.MES_WRITES === 'on',
  identity,
  auth: env.MES_AUTH === 'on',
  cookieSecure: env.MES_COOKIE_SECURE === 'on',
});
const log = app.log;
// Connections of each pool, and queries waiting for one (#147: the API's 4 connections serve the
// REST reads and every paced push computation).
const pools = [
  ['main', db],
  ['api', readDb],
  ['aggregate', aggregateDb],
  ['identity', identityDb],
] as const;
for (const field of ['total', 'idle', 'waiting'] as const) {
  new Gauge({
    name: `mes_db_pool_${field}`,
    help: `Database pool connections (${field === 'waiting' ? 'queries waiting for one' : field}), by pool`,
    labelNames: ['pool'] as const,
    registers: [registry],
    collect() {
      for (const [name, pool] of pools) this.set({ pool: name }, poolStats(pool)?.[field] ?? 0);
    },
  });
}

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
    async () => shifts?.stop(),
    () => {
      oee?.stop();
      downtime?.stop();
      coding?.stop();
      return Promise.resolve();
    },
    async () => alarms?.stop(),
    async () => equipment?.stop(),
    () => {
      identity.stop();
      return Promise.resolve();
    },
    () => identityDb.destroy(),
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

/**
 * Waits until the database's migration history equals this version's migrations (#169, ADR-0016
 * amendment): the `migrate` step migrates as the owner, the MES never does. Not ready meanwhile.
 */
async function migrated(): Promise<void> {
  for (let attempt = 0; !state.stopping; attempt++) {
    let status: MigrationStatus | undefined;
    let failure: unknown;
    try {
      status = await migrationStatus(db, env.MIGRATIONS_DIR);
    } catch (error) {
      failure = error;
    }
    if (status?.current === true) return;
    // Every 30 s, so a missing `migrate` step is visible without flooding the log.
    if (attempt % 15 === 0) {
      log.warn(
        status
          ? { pending: status.pending, unknown: status.unknown, changed: status.changed }
          : { err: failure },
        'waiting for the database to be migrated (the migrate step: ' +
          'pnpm --filter @shopfloor/mes-server migrate, or the Compose service `migrate`)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_POLL_MS));
  }
}

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
try {
  await migrated();
  // Stopped while waiting: shutdown() owns the exit (#185 review, L7).
  if (state.stopping) await new Promise(() => undefined);
  const masterData = new MasterData(db);
  await masterData.seed(plant.config);
  state.migrated = true;
  log.info('database migrated; connected as the application role');
  // Users and sessions (#168): the bootstrap admin, if asked for and none exists.
  await identity.start({ bootstrapAdminPassword: env.MES_BOOTSTRAP_ADMIN_PASSWORD });
  if (env.MES_AUTH === 'off') {
    log.warn(
      'MES_AUTH=off (diagnosis only): reads and the WebSocket are served without a session ' +
        '(ADR-0026); writes still need one. Set MES_AUTH=on (the default) again when done',
    );
  } else {
    log.info('MES_AUTH=on: every route but the login needs a session');
  }
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
  // Alarm occurrences (#142) follow ingest after equipment, which closes a newer epoch first; the
  // KPIs are computed on read through the API's pool.
  alarms = new Alarms({
    db,
    readDb,
    ingest,
    equipment,
    masterData,
    shiftPattern: await masterData.shiftPattern(),
    config: plant.config.alarms.kpi,
    maxShelveMs: plant.config.alarms.maxShelveMs,
    benchmarks: plant.config.alarms.benchmarks,
    log: log.child({ module: 'alarms' }),
  });
  await alarms.start();
  // OEE is computed on read (#120): it reads the other modules through the API's pool.
  const apiMasterData = new MasterData(readDb);
  oee = new Oee({
    equipment,
    ingest,
    masterData: apiMasterData,
    shiftPattern: await masterData.shiftPattern(),
    config: plant.config.oee,
    idealCycleMs: idealCycleMs(plant.config),
  });
  await oee.start();
  const oeeLog = log.child({ module: 'oee' });
  // Operator coding (#121): writes on the main pool; clips codings after a re-cut.
  const codingModule = new DowntimeCoding({
    db,
    equipment,
    codable: async (reason) =>
      (await apiMasterData.reasonCodes()).some((r) => r.id === reason && r.active),
    log: log.child({ module: 'equipment', part: 'coding' }),
  });
  coding = codingModule;
  await codingModule.start();
  downtime = new DowntimeFeed({
    equipment,
    codings: codingModule,
    onError: (error) => {
      oeeLog.warn({ err: error }, 'downtime feed: reading records failed; retrying');
    },
  });
  // Shift instances, the shift report and handover notes (#144): after the modules they read.
  const shiftsModule = new Shifts({
    db,
    readDb,
    equipment,
    oee,
    alarms,
    coding: codingModule,
    shiftPattern: await masterData.shiftPattern(),
    log: log.child({ module: 'shifts' }),
  });
  shifts = shiftsModule;
  await shiftsModule.start();
  // The API and push follow the modules from here; until then they answer 503.
  await realtime.attach({
    masterData: apiMasterData,
    equipment,
    ingest,
    oee,
    downtime,
    coding: {
      code: (key, request) => codingModule.code(key, request),
      audit: (key) => codingModule.audit(key, readDb),
    },
    alarms,
    shifts: shiftsModule,
  });
  log.info({ writes: env.MES_WRITES }, 'operator writes (downtime coding, alarms, handover notes)');
  await ingest.start();
} catch (error) {
  if (state.stopping) await new Promise(() => undefined); // shutdown() owns the exit
  log.fatal({ err: error }, 'start-up failed');
  await app.close();
  identity.stop();
  await db.destroy();
  await readDb.destroy();
  await aggregateDb.destroy();
  await identityDb.destroy();
  process.exit(1);
}
log.info('mes-server started; ready once subscribed to the UNS');
