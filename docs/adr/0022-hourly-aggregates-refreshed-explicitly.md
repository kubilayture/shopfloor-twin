# ADR-0022: Hourly continuous aggregates, refreshed explicitly by their owning modules

- Status: accepted; amended 2026-10-17 by #169 (the refresh as the aggregates' owner role), below
- Date: 2026-10-16
- Deciders: Claude (#118), within the Phase 5 plan ("Storage and aggregation"); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

OEE (Phase 5) is computed on read from two hourly inputs: time per state per (equipment, epoch, hour, shift bucket) and completed cycles per (equipment, epoch, hour, product, result). The Phase 5 plan fixes that both are TimescaleDB continuous aggregates, each in the schema of the module that owns its data (ADR-0016), real-time, without refresh policies, refreshed explicitly off ingest's acknowledgement path. A test of TimescaleDB 2.30.2 during the plan review showed why the refresh needs care: an aggregate has one watermark, and refreshing a later hour moves it past every earlier hour, which from then on is read only from the materialisation. An earlier hour never refreshed, or changed after its refresh, then shows stale or no rows.

Left open by the plan: where the refresh coordinator lives before the `oee` module exists (#120), how "every change below the watermark" is detected without a module reading another's schema, how a reader tells that an hour is final for OEE, and how the cycle-count proposal of #113 (ADR-0018, amendment consequences) fits the module boundaries.

## Considered options

Coordinator: (a) one coordinator in a new `oee` module now; (b) in each owning module, with a small shared helper (`equipment` refreshes `state_hourly`, `ingest` refreshes `cycle_hourly`); (c) `add_continuous_aggregate_policy`.

Detecting changes: (a) let TimescaleDB's invalidation log alone decide and always refresh from the beginning; (b) each owner reports its writes as hour ranges, and the helper marks an hour dirty when it lies below the watermark.

Refresh target for `cycle_hourly`: (a) ingest's own plant clock; (b) the equipment module's latest final hour, passed to ingest through its interface.

## Decision outcome

Coordinator (b), detection (b), target (b).

- **Aggregates** (migration `0006_equipment_ingest_hourly_aggregates.sql`, both `WITH NO DATA` in the runner's transaction, `materialized_only = false`):
  - `equipment.state_hourly` over `equipment.equipment_state_interval`: grouped by (equipment, epoch, `time_bucket('1 hour', start_time)`, shift_key, state), with `ms` and `provisional_ms` (`bigint`). Pieces end on whole milliseconds, so `ms` is exact; a test asserts it over the golden week.
  - `ingest.cycle_hourly` over `ingest.equipment_event` where `event_type = 'cycle'`: grouped by (equipment, epoch, hour, `payload->'value'->>'product'`, `payload->'value'->>'result'`), with `cycles` (`count(*)`).
  - Kysely types and `DECLARED_COLUMNS` list both views; the drift test compares tables and views with `information_schema`.
- **The helper** (`apps/mes-server/src/db/aggregate-refresh.ts`, `AggregateRefresher`, one per aggregate, created by its owning module when `refresh` is given; `main.ts` gives both a pool of their own, two connections, without the API's statement timeout):
  - `changed(from, to)`: the owner reports every write to the raw rows after its commit. An hour is dirty when it lies below the threshold: the aggregate's watermark at start-up, raised to the end of every window refreshed or being refreshed. Before the start-up watermark is read, every change counts as dirty.
  - `through(end)`: buckets are final up to `end`.
  - A refresh covers `[earliest dirty hour, max(latest dirty hour + 1 h, final end, covered end))` in one `CALL refresh_continuous_aggregate`, across all epochs. Without a dirty hour it starts where the last window ended, so the refreshed range stays contiguous. TimescaleDB re-materialises only the invalidated ranges of the window, which the timing test confirms (below).
  - The first refresh is the catch-up: from the beginning (`NULL`) to past the watermark, so changes made before a restart that nobody reported are materialised from TimescaleDB's invalidation log.
  - Debounced: a change schedules a refresh 1 s of wall time later (later changes join it); one runs at a time, from a timer, on the helper's pool, outside a transaction (simple query protocol). A failed refresh puts its hours back and runs again with exponential backoff (the debounce doubled per failure in a row, at most a minute; back to the debounce after a success; `failures` in the status). `flush()` (tests, and the start-up path below) tries five times with a growing pause (0.25 s to 2 s) before it throws, so one transient database error at start-up doesn't stop the MES; a lasting one still fails the start, as a failing migration does. The caller never waits: on ingest's acknowledgement path, `changed` and `through` only update a set and a timer.
  - `isRefreshed(hour)`: a refresh covered the hour after its last reported change (not dirty, not in the running refresh), and the catch-up has finished.
- **What each module reports:**
  - Equipment emits `piecesChanged` (`Equipment.onPiecesChanged`) after every write to the pieces, with the hours touched: a replaced window (the hours of the new pieces and of the deleted ones, read back from the same statement), a promotion of provisional pieces, the start-up flag sync. Its own refresher listens to it. A late fact, a never-refreshed earlier hour and a new epoch at an earlier time are all writes below the watermark, so they are dirty without a special case.
  - Ingest sends a new `cycle` notice (product, result, time) after each stored cycle and an `epoch` notice for the first fact of a device stream's new epoch; for each committed message (or sweep) it first marks the hours of all its `cycle` and `epoch` notices in its own refresher, and only then tells any listener. The equipment module hears of a late cycle through the `sample` notice, which comes before `cycle`, and records the final hour's new revision there; marking every hour of the message before any listener runs means the hour never reads as refreshed (`cyclesRefreshed`) with the new revision while `cycle_hourly` still holds the old count (#132 review). A test reads `cyclesRefreshed` from a listener right behind the equipment module. The duplicate path (a commit applied but reported failed, ADR-0017) re-announces both.
  - The final end is the latest hour in `equipment.bucket_finality` + 1 h, over all equipment and epochs: equipment moves it when it records final hours (and at start-up from the table), and passes it to ingest with `Ingest.refreshCyclesThrough(end)`. So both aggregates are materialised to the same hour, the open hour of a busy machine stays above both watermarks and is read raw, and a lagging machine's open hour below them is refreshed within about a second of each change.
- **Final for OEE.** `Equipment.stateHourly(from, to, …)` returns the rows with `final` = the hour has its `bucket_finality` row and `state_hourly` is refreshed through it (`isRefreshed`), plus `revision`. An hour is final for OEE when that holds and `Ingest.cyclesRefreshed(hour)` is true; #120 combines the two. _Note (#120):_ the `oee` module does so per hour and adds, per bucket, that every member has the bucket's last hour and that no open stop is still counted as a micro-stop. The refresh coordination stays with the owning modules: the `oee` module only reads. `stateAggregate()` and `cycleAggregate()` give `refreshedThrough` and the dirty hours.
- **Cycle counts with the final hours** (the #113 proposal). `equipment.bucket_finality` gains `cycles`: the hour's count when it became final (`Ingest.cycleCounts`, from the facts, since the aggregate may lag a second), raised with the revision when the module hears of a late cycle. At start-up equipment reads `Ingest.hourlyCycleTotals()` (from `cycle_hourly`, after ingest's catch-up and any pending refresh) and raises the revision of every final hour whose count differs; hours recorded before migration 0006 only get their count. Equipment never reads ingest's schema: both calls are on `Ingest`'s interface (`StateSource`).
- **No policies, ever:** a policy's window is relative to wall-clock `now()`, while simulation time runs ahead (at 60× a wall day is two simulated months) and goes back under a new epoch.

Coordinator (a) would create an `oee` module whose only job is plumbing before #120 defines it; (b) keeps each refresh with the data it reflects and lets #120 take the coordination over by calling the same helpers. (c) is ruled out above. Detection (a) works only with a window from the beginning on every refresh, and leaves "is this hour current?" unanswerable. Target (a) refreshes cycles of hours the state aggregate doesn't yet consider final, and a closed epoch's last hour (whose end may come from telemetry) could stay behind the cycle watermark for good.

### Consequences

- Good: the aggregates equal the raw rows after every refresh: the golden week in order and shuffled with duplicates (refreshing in the background throughout) matches the raw pieces and cycles and the ground truth's hourly OEE inputs for every machine and hour, and Σ hours = shift.
- Good: a refresh after a new epoch five days below the watermark took 3 ms against 81 ms for materialising the whole week (six machines, a piece a minute), on a local TimescaleDB.
- Good: OEE reads see the open hour raw, so the live dashboard doesn't wait for a refresh.
- Bad: an hour changed below the watermark reads stale for up to the debounce plus the refresh (about a second); it is reported dirty, so it is never `final` meanwhile.
- Bad: the dirty hours live in memory. A crash loses them; the start-up catch-up covers that, and until it has finished no hour counts as refreshed.
- Bad: a write that bypasses the modules (SQL by hand) is not reported; it is materialised by the next start-up's catch-up. The runbook says so.
- Bad: the first start after migration 0006 materialises everything: the catch-up refresh of `cycle_hourly` scans all of `ingest.equipment_event` (about 30,000 facts a simulated week) and is awaited at start-up, before ingest subscribes, because equipment's cycle-count check needs it; `state_hourly`'s catch-up runs in the background. Later starts re-materialise only what was invalidated.
- Bad: the start-up check reads every final hour's count (rows grow with history, about 1,000 a simulated week); cheap now, and boundable later by checking only hours since the last start.

## Amendment (#169): the refresh under `SET ROLE mes_cagg`

The MES connects as `mes_app`, which owns nothing (ADR-0027), and TimescaleDB lets only an aggregate's owner refresh it, never from a function, a procedure or a transaction (probed on 2.30.2-pg18). So:

- **Ownership.** Both aggregates belong to `mes_cagg` (migration `0017`: moved from the creator as the superuser, the materialisation hypertable and internal views following; `mes_app`'s `SELECT` granted as `mes_cagg`). `mes_cagg` reads the two sources (`equipment.equipment_state_interval`, `ingest.equipment_event`), without which a refresh fails, and has `USAGE` but no `CREATE` on their schemas.
- **The refresh.** `AggregateRefresher` runs `SET ROLE mes_cagg`, `CALL refresh_continuous_aggregate(…)` and `RESET ROLE` as three statements on one connection of its pool (still outside a transaction; the reset in a `finally`, so the connection goes back to the pool as `mes_app`). `mes_app` is a member of `mes_cagg` `WITH INHERIT FALSE, SET TRUE`: without `SET ROLE` it has none of `mes_cagg`'s rights, and a refresh is refused (`must be owner of continuous aggregate`), which a test shows next to one that succeeds and moves `cagg_watermark()`.
- **The watermark** is read as `mes_app` (its `SELECT` on the aggregate is enough), as before.
- **Still no policies:** a policy would need a `LOGIN` owner and a background worker.
- **Accepted cost:** after `SET ROLE mes_cagg` the MES could drop or alter the aggregates; they are derived from raw tables it can't alter, and a refresh rebuilds them.
