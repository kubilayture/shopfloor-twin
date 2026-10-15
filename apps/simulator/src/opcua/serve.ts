import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { MAX_SPEED, MIN_SPEED } from '../live/pacer.ts';
import { createLiveRun } from '../live/run.ts';
import { PlantServers } from './plant-servers.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');

function usage(problem: string): never {
  console.error(
    `${problem}\nUsage: serve [--seed N] [--speed ${String(MIN_SPEED)}..${String(MAX_SPEED)}] [--start ISO-8601 with offset] [--host H] [--port-offset N] [--config DIR]`,
  );
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      seed: { type: 'string', default: '1' },
      speed: { type: 'string', default: '60' },
      start: { type: 'string', default: '2026-10-12T06:00:00+03:00' },
      host: { type: 'string', default: 'localhost' },
      'port-offset': { type: 'string', default: '0' },
      config: { type: 'string', default: DEFAULT_CONFIG },
    },
  }));
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
if (!/^\d{1,10}$/.test(values.seed) || Number(values.seed) >= 2 ** 32)
  usage(`invalid --seed "${values.seed}"`);
const speed = Number(values.speed);
if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) usage(`invalid --speed "${values.speed}"`);
if (!/^\d{1,4}$/.test(values['port-offset']))
  usage(`invalid --port-offset "${values['port-offset']}"`);
let start: number;
try {
  start = Temporal.Instant.from(values.start).epochMilliseconds;
} catch {
  usage(`invalid --start "${values.start}"`);
}

const loaded = await loadPlantConfig(resolve(values.config)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
}

const servers = new PlantServers({
  config: loaded.config,
  start,
  host: values.host,
  portOffset: Number(values['port-offset']),
});
const run = createLiveRun({
  config: loaded.config,
  seed: Number(values.seed),
  start,
  speed,
  onEvent: (event) => {
    servers.record(event);
  },
});
servers.attach(run);
await servers.start();
for (const server of servers.servers) {
  console.log(`${server.machineId}  ${server.endpoint}`);
}
run.pacer.start();
console.log(
  `simulating at ${String(speed)}× from ${values.start} (seed ${values.seed}). Ctrl+C to stop.`,
);

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  run.pacer.stop();
  const code = signal === 'SIGINT' ? 130 : 0;
  setTimeout(() => {
    console.error('shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
  servers
    .stop()
    .then(() => {
      console.log(`stopped on ${signal}`);
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
};
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
