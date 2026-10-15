import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatIssues, loadPlantConfig } from '@shopfloor/plant-config';
import { MAX_SPEED, MIN_SPEED } from './pacer.ts';
import { createLiveRun } from './run.ts';

const DEFAULT_CONFIG = resolve(import.meta.dirname, '../../../../config/plant');

function usage(problem: string): never {
  console.error(
    `${problem}\nUsage: live [--seed N] [--speed ${String(MIN_SPEED)}..${String(MAX_SPEED)}] [--start ISO-8601 with offset] [--config DIR]`,
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
      config: { type: 'string', default: DEFAULT_CONFIG },
    },
  }));
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
if (!/^\d{1,10}$/.test(values.seed) || Number(values.seed) >= 2 ** 32) {
  usage(`invalid --seed "${values.seed}"`);
}
const speed = Number(values.speed);
if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
  usage(`invalid --speed "${values.speed}"`);
}
let start: number;
try {
  start = Temporal.Instant.from(values.start).epochMilliseconds;
} catch {
  usage(`invalid --start "${values.start}"`);
}

const loaded = await loadPlantConfig(resolve(values.config));
if (!loaded.ok) {
  console.error(formatIssues(loaded.issues));
  process.exit(1);
}

const time = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
console.log(
  `live run: seed ${values.seed}, speed ${String(speed)}×, start ${time(start)}Z. Ctrl+C to stop.`,
);
const { pacer } = createLiveRun({
  config: loaded.config,
  seed: Number(values.seed),
  start,
  speed,
  onEvent: (event) => {
    if (event.type === 'state') {
      console.log(
        `${time(event.at)}Z  ${event.machineId.padEnd(6)} ${event.from} → ${event.to}${event.cause ? `  (${event.cause})` : ''}`,
      );
    }
  },
});
pacer.start();
const stop = (): void => {
  pacer.stop();
  console.log(`stopped at simulation time ${time(pacer.simNow())}Z`);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
