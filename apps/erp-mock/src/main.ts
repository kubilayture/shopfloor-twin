import { resolve } from 'node:path';
import { loadDataset } from './dataset.ts';
import { parseEnv, isWeakToken } from './env.ts';
import { Erp } from './erp.ts';
import { createLogger } from './log.ts';
import { createErpServer } from './server.ts';
import { ErpStore } from './store.ts';

const SHUTDOWN_TIMEOUT_MS = 5_000;

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const env = parsed.env;
const log = createLogger(env.LOG_LEVEL);

const dataset = await loadDataset(resolve(env.ERP_DATASET), resolve(env.PLANT_CONFIG_DIR)).catch(
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
const store = new ErpStore(resolve(env.ERP_STORE_PATH));
let erp: Erp;
try {
  erp = new Erp(dataset, store);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  store.close();
  process.exit(1);
}
if (isWeakToken(env.ERP_API_TOKEN)) {
  log.warn({}, 'ERP_API_TOKEN is short or the .env.example placeholder; set a random value');
}
if (env.ERP_ADMIN === 'on') {
  log.warn({}, 'ERP_ADMIN=on: POST /api/v1/orders adds orders (dev only)');
}

const server = createErpServer({
  erp,
  store,
  token: env.ERP_API_TOKEN,
  admin: env.ERP_ADMIN === 'on',
  log,
});
server.listen(env.HTTP_PORT, env.HTTP_HOST, () => {
  log.info(
    {
      address: `${env.HTTP_HOST}:${String(env.HTTP_PORT)}`,
      dataset: env.ERP_DATASET,
      feedEntries: erp.feedLength,
      lots: erp.lots.length,
    },
    'ERP mock listening',
  );
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping');
  const timer = setTimeout(() => {
    server.closeAllConnections();
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
