import { parseMigrateEnv } from '../env.ts';
import { createDatabase } from './database.ts';
import { migrate } from './migrate.ts';

/**
 * The `migrate` step (#169, ADR-0027; ADR-0016 amended): `pnpm --filter @shopfloor/mes-server
 * migrate`, or the Compose service `migrate` (the MES image running this file). Connects as the
 * bootstrap superuser, creates or updates the roles (`mes_app`'s password from `DB_APP_PASSWORD`),
 * and runs the pending migrations as `mes_owner`. The MES waits until it has finished.
 */
const parsed = parseMigrateEnv(process.env);
if (!parsed.ok) {
  console.error(`invalid environment:\n  ${parsed.issues.join('\n  ')}`);
  process.exit(2);
}
const db = createDatabase(parsed.env.DATABASE_URL, 1);
try {
  const result = await migrate(db, parsed.env.MIGRATIONS_DIR, {
    appPassword: parsed.env.DB_APP_PASSWORD,
  });
  const password =
    parsed.env.DB_APP_PASSWORD === undefined
      ? '; mes_app password unchanged (no DB_APP_PASSWORD)'
      : '; mes_app password set';
  console.log(
    `applied ${String(result.applied.length)} migrations (${result.applied.join(', ') || 'none'}); ${String(result.skipped)} already applied${password}`,
  );
} finally {
  await db.destroy();
}
