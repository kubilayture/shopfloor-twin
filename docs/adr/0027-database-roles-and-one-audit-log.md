# ADR-0027: Database roles, a separate migrate step and one audit log

- Status: accepted
- Date: 2026-10-17
- Deciders: Claude (#169), within the Phase 7 plan ("Database roles", "Identity", review decisions B1 and M1); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Until Phase 7 the MES connects as the TimescaleDB image's bootstrap superuser (`DB_USER`) and migrates the database at start-up (ADR-0016). It owns every table, so the append-only triggers of its audits bind it only as long as it chooses: one `ALTER TABLE … DISABLE TRIGGER` and the audit is rewritable. ADR-0023 promised role separation once identity exists. With users (ADR-0026) the audits also become worth more: they name who did what. Three module audits (`equipment.downtime_audit`, `alarms.alarm_transition`, `shifts.handover_audit`) record names as typed; `identity.audit_log` (#168) records users.

Questions:

- Which roles, who owns what, and how does the MES still refresh the continuous aggregates, which TimescaleDB lets only their owner refresh, and never from a function, a procedure or a transaction (probed on 2.30.2-pg18: `review180/tsdb`, `tsdb2`)?
- How does an existing database, every object owned by `DB_USER`, get there? `REASSIGN OWNED BY` fails (`2BP01`, "required by the database system").
- How do three module audits become one log without losing a row, and what stays of them?
- How do writes take their actor from the session without breaking any client before #170 removes the typed fields?

## Considered options

Roles: (a) one owner role that the MES is a member of; (b) an owner role, an application role that owns nothing, and the aggregates owned by the owner, refreshed through a `SECURITY DEFINER` procedure; (c) as (b), the aggregates owned by a role of their own that the application role may assume (`SET ROLE`) but does not inherit.

Migrations: (a) the MES keeps migrating at start-up, as the owner; (b) a separate `migrate` step as the bootstrap superuser, the MES only waits for it.

Existing databases: (a) `pnpm stack:reset`; (b) a migration that moves each object (`ALTER … OWNER TO`).

Audits: (a) keep three module audits and add user columns; (b) one `identity.audit_log`, the module audits backfilled into it and frozen; the alarm transition log kept because it is more than an audit.

## Decision outcome

Roles (c), migrations (b), existing databases (b) with (a) as the documented fallback, audits (b).

**Roles** (created and kept up to date by `ensureRoles`, `apps/mes-server/src/db/roles.ts`, before any migration; roles are shared by the server's databases, so a concurrent creation is tolerated and attributes are altered only when they differ). It also enforces what the roles must not have (review of PR #185): no superuser, `CREATEDB`, `CREATEROLE`, `BYPASSRLS` or `REPLICATION`, `CONNECTION LIMIT -1`, `VALID UNTIL 'infinity'`, and exactly one membership: every `pg_auth_members` row whose member is one of the three roles, other than `mes_cagg` granted to `mes_app` WITH ADMIN FALSE, INHERIT FALSE, SET TRUE, is revoked by its grantor (`GRANTED BY … CASCADE`), so a second grant of `mes_cagg` by another grantor, `mes_owner` granted to `mes_app` or `pg_write_all_data` can't survive a `migrate`. On the database, `PUBLIC` loses `CONNECT` and `TEMPORARY`, `mes_app` gets `CONNECT`, `mes_owner` `CREATE`; the owner and the superuser connect as such:

| Role        | Login | Owns                                                      | Notes                                                                                     |
| ----------- | ----- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DB_USER`   | yes   | the database                                              | The image's bootstrap superuser: creates the roles and runs `migrate`; nothing else       |
| `mes_owner` | no    | every schema, table, view, sequence, function and trigger | Migrations run as it; `CREATE` on the database (it creates the schemas)                   |
| `mes_cagg`  | no    | `equipment.state_hourly`, `ingest.cycle_hourly`           | `SELECT` on their two sources and `USAGE` on their schemas; never `CREATE` on a schema    |
| `mes_app`   | yes   | nothing                                                   | The MES (`DB_APP_PASSWORD`); member of `mes_cagg` `WITH INHERIT FALSE, SET TRUE` (PG 16+) |

`mes_app`'s grants: `USAGE` on the module schemas; `SELECT, INSERT, UPDATE, DELETE` on ordinary tables; `SELECT, INSERT, UPDATE` on `shifts.handover_note` (retracted, never deleted, ADR-0025); `SELECT, INSERT` on the append-only `identity.audit_log`, `alarms.alarm_transition` and `alarms.occurrence_state`; `SELECT` on the two frozen audits, on both aggregates and on `public.schema_migrations`. They are listed per role and object in `DECLARED_GRANTS` (`apps/mes-server/src/db/grants.ts`, typed from `Database` like `DECLARED_COLUMNS`), which a test compares with the ACLs of the MES schemas and their tables and views, the aggregates included, without an owner's implicit rights; `_timescaledb_internal` (chunks and materialisation tables, which inherit and whose names aren't stable) is not compared. `docs/data-model.md` prints them. Each later migration grants what its objects need.

**The aggregates (B1).** Only an aggregate's owner may refresh it, and `refresh_continuous_aggregate()` refuses to run inside a function, a `SECURITY DEFINER` procedure or a transaction (25001), so option (b) is impossible and (a) would let the MES alter every table. `mes_cagg` owns the aggregates. Migration `0017` gets there as the probe did: the aggregate was created as `mes_owner` (`0006`, or by the superuser on an older database), then `ALTER MATERIALIZED VIEW … OWNER TO mes_cagg` as the superuser (the materialisation hypertable and internal views follow; `mes_cagg` has no `CREATE` on the schema, so it could neither create the aggregate itself nor take it over as a non-superuser), then `GRANT SELECT … TO mes_app` under `SET ROLE mes_cagg`, because after the transfer `mes_owner` can't grant on it. The refresher (ADR-0022, amended) runs `SET ROLE mes_cagg`, the `CALL`, `RESET ROLE` as three statements on one connection of its pool, outside a transaction; `cagg_watermark()` is read as `mes_app` with its `SELECT` on the aggregate. No refresh policies: they would need a `LOGIN` owner and a background worker, and ADR-0022 refreshes explicitly.

Accepted cost (corrected in the review of PR #185): as a member, `mes_app` can `SET ROLE mes_cagg` and then do anything an owner of the two aggregates may: drop or alter them, flip `materialized_only`, grant on them to another role, and `UPDATE` or `DELETE` rows of their materialisation hypertables in `_timescaledb_internal`, which it owns. A falsified materialisation is not repaired by the next incremental refresh: TimescaleDB re-materialises only ranges invalidated by a change of the raw table, so an hour edited directly stays wrong until it is refreshed in full. The runbook's recovery is `CALL refresh_continuous_aggregate('<aggregate>', NULL, NULL, force => true)` (as `mes_cagg`, or the superuser), or dropping and recreating the aggregate from `0006`'s definition with the `0017` ownership and grant. The aggregates are derived data only: the raw tables, which `mes_cagg` can only read, stay the source of OEE's reconciliation. The audit tables belong to `mes_owner`, of which `mes_app` is not a member: `ALTER TABLE … DISABLE TRIGGER`, `TRUNCATE`, `UPDATE` and `DELETE` on them and `CREATE` in a module schema are refused (42501) with or without `SET ROLE mes_cagg` (tested, and on the stack by the smoke).

**The migrate step.** `pnpm --filter @shopfloor/mes-server migrate` and the Compose service `migrate` (the MES image, `node apps/mes-server/src/db/cli.ts`, one-shot) connect as `DB_USER`, create or update the roles (`mes_app`'s password from `DB_APP_PASSWORD`: only its SCRAM-SHA-256 verifier, computed with `node:crypto` (4096 iterations, a random salt), reaches the server, in an `ALTER ROLE` with `log_statement`, `log_min_error_statement` and `log_min_duration_statement` off for its transaction; printable ASCII only, which SASLprep leaves as it is, so the verifier is the one libpq would derive), create TimescaleDB if needed (only a superuser may), and run each pending migration in its transaction under `SET LOCAL ROLE mes_owner`; the history row is written as the superuser after the migration's own statements. A migration that needs the superuser resets the role itself (`0017`). The MES starts after `migrate` succeeded (`depends_on: condition: service_completed_successfully`), connects as `mes_app`, and is not ready while the database's migration history differs from its own files (`migrationStatus`: pending, unknown or changed), logging what differs every 30 s. Compose requires `DB_APP_PASSWORD` (`:?`), and `.env.example` holds only the placeholder.

**Existing databases (M1).** Migration `0017_public_roles_owners_grants.sql` moves, object by object, every schema of the MES, every table and view in them (a hypertable carries its chunks), every sequence no column owns (an identity sequence follows its table), every function, and `public.schema_migrations` to `mes_owner`, leaving extension members (TimescaleDB's own in `public`) alone, then the aggregates to `mes_cagg`. It is idempotent and, being a migration, recorded in `schema_migrations`. On a fresh database (migrated as `mes_owner` from `0001`) it moves only the runner's history table and the aggregates. A test migrates a database to `0015` the way the MES did before (as the superuser, no roles), writes rows into the three module audits as the Phase 5 and 6 code wrote them, runs `migrate`, and asserts every owner, the grants and every backfilled row field by field; the stack smoke ran over a Compose database migrated to `0016` that way. `pnpm stack:reset` stays the fallback.

**One audit log.** Every module write is a row of `identity.audit_log` written by `Identity.audit(trx, …entries)` inside the write's transaction: user id, user name and roles at that moment, `authenticated`, action, entity type and id, before, after, request id, plant time. Entities and actions:

| Module    | Entity                                                                      | Actions                                                        | `after` adds                             |
| --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| equipment | `downtime-coding-set` `{equipment}~{epoch}`                                 | `downtime.code`, `downtime.clear`, `downtime.orphan` (system)  | `recordId`, `from`, `to`, `version`      |
| alarms    | `alarm-occurrence` `{equipment}~{epoch}~{seq}`, `alarm-point` `{eq}/{code}` | `alarm.ack`, `alarm.comment`, `alarm.shelve`, `alarm.unshelve` | the shelf's `version` for a point action |
| shifts    | `handover-note` `{id}`                                                      | `note.create`, `note.edit`                                     | the note's `version`                     |

Migration `0018_identity_audit_log_backfill.sql` copies into it, in that shape (`legacy`, the typed name as user name, no user id, `authenticated` as stored), every row of the three module audits that the MES would write there today: every coding and note row and the alarm operator transitions, not the module's own `expire` and `epoch-ended`, which stay only in the transition log as they do at runtime. Rows are copied per module audit in id order, so each history keeps its order; their ids are `identity.audit_log`'s from then on, so a history entry's `id` changes with the migration (the API never promised it beyond the entry). The migration refuses to commit unless the counts per module audit match. Rows identity already wrote (#168: logins, user changes) stay as they are, `legacy = false`. It then freezes `equipment.downtime_audit` and `shifts.handover_audit`: `mes_app` loses `INSERT`, and a statement trigger refuses an insert by anyone. The downtime and note history endpoints read `identity.audit_log` (`Identity.auditEntries`), legacy rows included, and answer in their old shape. `alarms.alarm_transition` stays the alarm module's transition log: its system expiry and epoch ends are not user actions and its lists and comment counts read it; an operator's transition writes both, the system's only the transition log.

**Actors (H4).** With `MES_AUTH=on` a write's actor is the session's user and the request's `codedBy`, `actor` or `author` is ignored; with `off` the typed name is used, recorded as unauthenticated, and is required (422 without it). The request fields are optional from #169 and removed by #170 with the web's name fields, so no merge breaks a client.

**`shifts.crew_assignment`** (migration `0019`, the first one written as `mes_owner` from the start): user, work center, shift instance, the terminal session, wall and plant time of sign-on and end, why it ended; at most one open row per user and work center. The terminal writes it from #177.

### Consequences

- Good: the MES can no longer disable a trigger, truncate an audit or change the schema; a grant a module needs and a migration forgets fails a test, because the test harness hands the module code an `mes_app` connection (`freshDatabase`), and the grants test fails when the database and `DECLARED_GRANTS` differ.
- Good: one log names who did what across modules, with roles and the request id, written in the same transaction as the change; the old rows are in it, counted.
- Good: an existing database migrates in place; the only manual step is `DB_APP_PASSWORD` in `.env`.
- Bad: after `SET ROLE mes_cagg` the MES may drop, alter or falsify the two aggregates, which an incremental refresh doesn't repair (derived data; accepted, with a forced full refresh as the recovery).
- Bad: a database user (`DB_USER`) and a password more to manage; `DB_APP_PASSWORD` must stay what `migrate` last set, or the MES can't log in until `migrate` runs again (it runs on every `up`).
- Bad: tests that inject faults with DDL need the superuser's connection (`ownerOf`), and every new table needs its grants in two places (the migration and `DECLARED_GRANTS`).
- Bad: `identity.audit_log` holds `plant_epoch` of alarm transitions only in the transition log, and `after` mixes state with a few keys of the change (`recordId`, `from`, `to`, `version`); the history endpoints strip them.

## Notes (#170)

- **Actors.** The two-step removal planned under "Actors (H4)" is complete: `codedBy`, `actor` and `author` are gone from the request schemas (a request that still sends one is refused, 400), and every write needs a session also with `MES_AUTH=off` (ADR-0026, notes), so every new row of `identity.audit_log` written through the API has a user id, the roles and `authenticated: true`. Rows with `authenticated: false` are the legacy backfill of `0018` and rows written with `MES_AUTH=off` before #170. The modules still accept a typed name (`WriteBy`) for their own tests, which write without the HTTP layer; the API never passes one.
