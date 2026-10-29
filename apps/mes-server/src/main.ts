import { resolve } from 'node:path';
import { formatIssues, idealCycleMs, loadPlantConfig } from '@shopfloor/plant-config';
import { sql } from 'kysely';
import { Counter, Gauge } from 'prom-client';
import { createDatabase, onConnectionError, poolStats } from './db/database.ts';
import { migrationStatus, type MigrationStatus } from './db/migrate.ts';
import { EdgeTrust, learnEdgeCidr } from './edge.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
import { Alarms } from './modules/alarms/index.ts';
import { DowntimeCoding, Equipment, downtimeRules } from './modules/equipment/index.ts';
import { Identity, type IdentityLog } from './modules/identity/index.ts';
import { Ingest } from './modules/ingest/index.ts';
import { MasterData } from './modules/master-data/index.ts';
import { DowntimeFeed, LineOee, Oee, OrderOee } from './modules/oee/index.ts';
import { Execution } from './modules/execution/index.ts';
import { Genealogy } from './modules/genealogy/index.ts';
import { ErpClient, MqttCommandPublisher, Orders } from './modules/orders/index.ts';
import { Holds, Quality, characteristicsOf } from './modules/quality/index.ts';
import { Shifts } from './modules/shifts/index.ts';
import { closeOrphansAtStart, wireTerminal } from './terminal-wiring.ts';

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
// The `edge` network (#237): its CIDR from the MES's own alias there; in Compose a must.
let edgeCidr = await learnEdgeCidr(env.MES_EDGE_ALIAS);
// In Compose a network attached a moment late gets a few seconds before the MES gives up.
for (
  let attempt = 1;
  edgeCidr === undefined && env.MES_EDGE_REQUIRED === 'on' && attempt <= 10;
  attempt++
) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  edgeCidr = await learnEdgeCidr(env.MES_EDGE_ALIAS);
}
if (edgeCidr === undefined && env.MES_EDGE_REQUIRED === 'on') {
  console.error(
    `MES_EDGE_ALIAS ${env.MES_EDGE_ALIAS} does not resolve to a local interface; the MES is not ` +
      'on the edge network (MES_EDGE_REQUIRED=on)',
  );
  process.exit(2);
}
const edge = new EdgeTrust(edgeCidr);
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
// Logins and password checks on a pool of their own (#264 review, F1): a flood of logins waits
// there, never for the connections the session lookup of every request uses.
const loginDb = createDatabase(env.DATABASE_URL, 2);
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
const identity = new Identity({ db: identityDb, loginDb, loginPoolSize: 2, log: identityLog });

let ingest: Ingest | undefined;
let equipment: Equipment | undefined;
let oee: Oee | undefined;
let orderOee: OrderOee | undefined;
let lineOee: LineOee | undefined;
let downtime: DowntimeFeed | undefined;
let coding: DowntimeCoding | undefined;
let alarms: Alarms | undefined;
let shifts: Shifts | undefined;
let orders: Orders | undefined;
let execution: Execution | undefined;
let genealogy: Genealogy | undefined;
let quality: Quality | undefined;
let holds: Holds | undefined;
let publisher: MqttCommandPublisher | undefined;

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
  edge,
});
const log = app.log;
log.info(
  { alias: env.MES_EDGE_ALIAS, cidr: edge.cidr ?? null },
  edge.cidr === undefined
    ? 'no edge network: proxy headers are trusted from nowhere'
    : 'edge network learned: proxy headers trusted from it only',
);
// Connections of each pool, and queries waiting for one (#147: the API's 4 connections serve the
// REST reads and every paced push computation).
const pools = [
  ['main', db],
  ['api', readDb],
  ['aggregate', aggregateDb],
  ['identity', identityDb],
  ['login', loginDb],
] as const;
// A connection the server ended (a database restart, #243): a warning and a count per pool.
onConnectionError((error, place) => {
  log.warn({ err: error, place }, 'database connection ended; the pool reconnects');
});
new Counter({
  name: 'mes_db_connections_ended_total',
  help: 'Database connections the server ended since start (idle or held by a caller), each once, by pool',
  labelNames: ['pool'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [name, pool] of pools) this.inc({ pool: name }, poolStats(pool)?.ended ?? 0);
  },
});
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
    async () => genealogy?.stop(),
    async () => holds?.stop(),
    async () => quality?.stop(),
    async () => execution?.stop(),
    async () => orders?.stop(),
    async () => publisher?.close(),
    async () => shifts?.stop(),
    () => {
      oee?.stop();
      orderOee?.stop();
      lineOee?.stop();
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
    () => loginDb.destroy(),
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
  if (env.MES_COOKIE_SECURE === 'off') {
    log.warn(
      'MES_COOKIE_SECURE=off: the session cookie is sft_session without Secure, for a browser on ' +
        'plain HTTP straight to the MES only (ADR-0039); behind the HTTPS front leave it on',
    );
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
    // Crew rows end with their terminal session (#177): idle and absolute expiry.
    sessions: identity,
    // After each crew check, intervals that hold no crew row any more are closed, by crew row
    // where they carry one (#383) (the orders module exists from further down; until then there
    // is nothing to close).
    afterCrewCheck: (check) => (orders ? orders.endOrphanedActivities(check) : Promise.resolve()),
    log: log.child({ module: 'shifts' }),
  });
  shifts = shiftsModule;
  await shiftsModule.start();
  // Orders (#174): the ERP feed, the supervisor's writes and the command outbox. Commands go out
  // on a connection of their own (client id `{MQTT_CLIENT_ID}-cmd`, never ingest's session).
  publisher = new MqttCommandPublisher({
    url: env.MQTT_URL,
    username: env.MQTT_CMD_USERNAME,
    password: env.MQTT_PASSWORD,
    clientId: `${env.MQTT_CLIENT_ID}-cmd`,
    log: log.child({ module: 'orders', part: 'publisher' }),
  });
  const equipmentModule = equipment;
  const erp =
    env.ERP_URL !== undefined && env.ERP_API_TOKEN !== undefined
      ? new ErpClient({ url: env.ERP_URL, token: env.ERP_API_TOKEN })
      : undefined;
  const ordersModule = new Orders({
    db,
    readDb,
    ingest,
    masterData,
    publisher,
    ...(erp ? { erp } : {}),
    clock: () => equipmentModule.watermarks()[0]?.watermark,
    erpPollMs: env.ERP_POLL_MS,
    timings: {
      ttlMs: env.COMMAND_TTL_MS,
      resendMs: env.COMMAND_RESEND_MS,
      maxAttempts: env.COMMAND_ATTEMPTS,
      failMarginMs: env.COMMAND_FAIL_MARGIN_MS,
    },
    registry,
    log: log.child({ module: 'orders' }),
  });
  orders = ordersModule;
  await ordersModule.start();
  if (env.ERP_URL === undefined) {
    log.warn('ERP_URL is not set: no orders are imported and nothing is posted to the ERP');
  }
  // Execution (#175): units from the cycle facts, completion and confirmations through orders; a
  // lost job's blanks are counted from its units from here on.
  const executionModule = new Execution({
    db,
    readDb,
    ingest,
    masterData,
    orders: ordersModule,
    rework: {
      test: plant.config.process.leakTest.operation,
      back: plant.config.process.leakTest.reworkOperation,
    },
    clock: () => equipmentModule.watermarks()[0]?.watermark,
    registry,
    log: log.child({ module: 'execution' }),
  });
  execution = executionModule;
  // Genealogy (#199): lots from the ERP's lot list on the ERP poll, and every unit's lots, records
  // and carton, following the execution module's units: it follows them before execution starts,
  // so the units execution's catch-up rebuilds are announced to it too.
  const genealogyModule = new Genealogy({
    db,
    readDb,
    ingest,
    execution: executionModule,
    orders: ordersModule,
    masterData,
    crew: (workCenter, during) => shiftsModule.crew({ workCenter, during }),
    ...(erp ? { erp } : {}),
    packing: plant.config.packing,
    lotPollMs: env.ERP_POLL_MS,
    registry,
    log: log.child({ module: 'genealogy' }),
  });
  genealogy = genealogyModule;
  genealogyModule.follow();
  await executionModule.start();
  ordersModule.useBlankCounter(executionModule);
  await genealogyModule.start();
  // Order OEE (#231): derived on read from the command state, the units and the CNCs' pieces,
  // through the API's pool; final orders kept in memory.
  const orderOeeModule = new OrderOee({
    orders: ordersModule,
    execution: executionModule,
    equipment: equipmentModule,
    ingest,
    masterData: apiMasterData,
    shiftPattern: await masterData.shiftPattern(),
    config: plant.config.oee,
    idealCycleMs: idealCycleMs(plant.config),
    operations: plant.config.products.operations,
  });
  orderOee = orderOeeModule;
  orderOeeModule.start();
  // Line OEE (#232): per hour and shift bucket from the packing machine's cycles, the bottleneck's
  // pieces, the calendar and (orders mode) the orders' in-progress time; final buckets in memory.
  const lineOeeModule = new LineOee({
    orderOee: orderOeeModule,
    ingest,
    equipment: equipmentModule,
    execution: executionModule,
    shiftPattern: await masterData.shiftPattern(),
    productionMode: env.MES_PRODUCTION_MODE,
    log,
  });
  lineOee = lineOeeModule;
  await lineOeeModule.start();
  log.info({ productionMode: env.MES_PRODUCTION_MODE }, 'line OEE production mode');
  // SPC (#200): measurements from the leak tester's cycle facts, limit versions and signal
  // episodes on final data; the charts are derived on read through the API's pool.
  const qualityModule = new Quality({
    db,
    readDb,
    ingest,
    characteristics: characteristicsOf(plant.config),
    clock: () => equipmentModule.watermarks()[0]?.watermark,
    registry,
    log: log.child({ module: 'quality' }),
  });
  quality = qualityModule;
  await qualityModule.start();
  // Quality holds (#201, ADR-0035): scope through the genealogy, notifications through the orders
  // outbox, and the close guard injected into orders (so `orders` imports nothing of `quality`).
  const holdsModule = new Holds({
    db,
    readDb,
    genealogy: genealogyModule,
    ingest,
    execution: executionModule,
    orders: ordersModule,
    reasons: plant.config.quality.holdReasons,
    signals: qualityModule,
    clock: () => equipmentModule.watermarks()[0]?.watermark,
    epoch: () => equipmentModule.watermarks()[0]?.epoch,
    registry,
    log: log.child({ module: 'quality', part: 'holds' }),
  });
  holds = holdsModule;
  ordersModule.useCloseGuard(holdsModule.closeGuard());
  // Fail closed (#201 review, L2): a close without the guard is refused; say so at start.
  if (!ordersModule.closeGuarded) throw new Error('orders: no quality close guard wired');
  await holdsModule.start();
  // The operator terminal (#177): a session that ends (logout, a disabled user, a password
  // change, a new login) ends its crew rows; a crew row that ends closes its operator's activity
  // intervals at that work center; intervals left open while the MES was down are closed now.
  wireTerminal({
    identity,
    shifts: shiftsModule,
    orders: ordersModule,
    log: log.child({ module: 'terminal' }),
  });
  await closeOrphansAtStart(shiftsModule, ordersModule);
  // The API and push follow the modules from here; until then they answer 503.
  await realtime.attach({
    masterData: apiMasterData,
    equipment,
    ingest,
    oee,
    orderOee: orderOeeModule,
    lineOee: lineOeeModule,
    downtime,
    coding: {
      code: (key, request) => codingModule.code(key, request),
      audit: (key) => codingModule.audit(key, readDb),
    },
    alarms,
    shifts: shiftsModule,
    orders: ordersModule,
    execution: executionModule,
    genealogy: genealogyModule,
    quality: qualityModule,
    holds: holdsModule,
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
  await loginDb.destroy();
  process.exit(1);
}
log.info('mes-server started; ready once subscribed to the UNS');
