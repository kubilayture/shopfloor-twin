import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Simulation } from '@shopfloor/sim-core';
import { LivePacer } from '../live/pacer.ts';
import { buildControlApp } from './app.ts';
import { EventHub } from './event-hub.ts';

export const OPENAPI_FILE = resolve(
  import.meta.dirname,
  '../../../../docs/api/simulator-control.openapi.json',
);

/** The OpenAPI description of the control API, as committed in docs/api. */
export async function generateOpenApi(): Promise<string> {
  const app = await buildControlApp({
    pacer: new LivePacer({ simulation: new Simulation<unknown>(0), handle: () => undefined }),
    hub: new EventHub(),
    ready: () => false,
    // Every optional route, so the description is complete.
    faults: { modbusSilent: () => undefined, opcuaOffline: () => Promise.resolve(true) },
    groundTruth: () => {
      throw new Error('not served');
    },
  });
  await app.ready();
  const document = app.swagger();
  await app.close();
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const generated = await generateOpenApi();
  if (process.argv.includes('--check')) {
    const committed = await readFile(OPENAPI_FILE, 'utf8').catch(() => '');
    if (committed !== generated) {
      console.error(
        `${OPENAPI_FILE} is out of date; run pnpm --filter @shopfloor/simulator openapi`,
      );
      process.exit(1);
    }
    console.log('OpenAPI description is up to date');
  } else {
    await writeFile(OPENAPI_FILE, generated);
    console.log(`wrote ${OPENAPI_FILE}`);
  }
}
