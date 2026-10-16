import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { UNS_COMMAND_SCHEMAS } from './commands.ts';
import { UNS_SCHEMAS } from './payloads.ts';

export const JSON_SCHEMA_DIR = resolve(import.meta.dirname, '../../../../docs/contracts/uns');

export const jsonSchemaFile = (name: string): string =>
  resolve(JSON_SCHEMA_DIR, `${name.replace('/', '.v')}.schema.json`);

/** JSON Schema (draft 2020-12) of every UNS payload and command (1.3), as committed in docs/contracts/uns. */
export function generateJsonSchemas(): Map<string, string> {
  return new Map(
    Object.entries({ ...UNS_SCHEMAS, ...UNS_COMMAND_SCHEMAS }).map(([name, schema]) => [
      jsonSchemaFile(name),
      `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2)}\n`,
    ]),
  );
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [file, content] of generateJsonSchemas()) {
    if (check) {
      const committed = await readFile(file, 'utf8').catch(() => '');
      if (committed !== content) {
        console.error(`${file} is out of date`);
        stale++;
      }
    } else {
      await writeFile(file, content);
      console.log(`wrote ${file}`);
    }
  }
  if (stale > 0) {
    console.error('run pnpm --filter @shopfloor/contracts json-schema');
    process.exit(1);
  }
}
