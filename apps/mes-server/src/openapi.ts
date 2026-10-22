import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildMesHttp } from './http.ts';
import { clientMessageSchema, serverMessageSchema } from './modules/realtime/index.ts';

const DOCS = resolve(import.meta.dirname, '../../../docs/api');
export const OPENAPI_FILE = resolve(DOCS, 'mes.openapi.json');
export const REALTIME_SCHEMA_FILE = resolve(DOCS, 'mes-realtime.schema.json');

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The OpenAPI 3.1 description of the MES API, from the route schemas, as committed. */
export async function generateOpenApi(): Promise<string> {
  // As deployed: MES_COOKIE_SECURE=on (the default since #241), so the routes describe the
  // `__Host-sft_session` cookie with its Secure attribute.
  const { app } = await buildMesHttp({ ready: () => Promise.resolve(false), cookieSecure: true });
  await app.ready();
  const document = app.swagger();
  await app.close();
  return text(document);
}

/** JSON Schema of the WebSocket messages (OpenAPI can't describe them), as committed. */
export function generateRealtimeSchema(): string {
  return text({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'MES WebSocket messages (/api/v1/ws, docs/api/realtime.md)',
    $defs: {
      ClientMessage: z.toJSONSchema(clientMessageSchema, { io: 'input' }),
      ServerMessage: z.toJSONSchema(serverMessageSchema, { io: 'output' }),
    },
  });
}

if (import.meta.main) {
  const files: [string, string][] = [
    [OPENAPI_FILE, await generateOpenApi()],
    [REALTIME_SCHEMA_FILE, generateRealtimeSchema()],
  ];
  const check = process.argv.includes('--check');
  for (const [file, generated] of files) {
    if (check) {
      if ((await readFile(file, 'utf8').catch(() => '')) !== generated) {
        console.error(`${file} is out of date; run pnpm --filter @shopfloor/mes-server openapi`);
        process.exitCode = 1;
      }
    } else {
      await writeFile(file, generated);
      console.log(`wrote ${file}`);
    }
  }
}
