import { resolve } from 'node:path';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { sql } from 'kysely';
import { createDatabase } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { parseEnv } from './env.ts';
import { buildMesHttp } from './http.ts';
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

const { app } = buildMesHttp({
  ready: async () => {
    if (!state.migrated || state.stopping) return false;
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
  // Requests first, then the pool they use.
  for (const close of [() => app.close(), () => db.destroy()]) {
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
} catch (error) {
  if (state.stopping) await new Promise(() => undefined); // shutdown() owns the exit
  log.fatal({ err: error }, 'migrations failed');
  await app.close();
  await db.destroy();
  process.exit(1);
}
log.info('mes-server ready');
