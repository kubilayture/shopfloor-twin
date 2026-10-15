import { parseEnv } from '../env.ts';
import { createDatabase } from './database.ts';
import { migrate } from './migrate.ts';

const parsed = parseEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const db = createDatabase(parsed.env.DATABASE_URL, 1);
try {
  const result = await migrate(db, parsed.env.MIGRATIONS_DIR);
  console.log(
    `applied ${String(result.applied.length)} migrations (${result.applied.join(', ') || 'none'}); ${String(result.skipped)} already applied`,
  );
} finally {
  await db.destroy();
}
