# ADR-0018: Equipment intervals: provisional storage, watermark sources and catch-up

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#96), within the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The Phase 4 plan fixes what an equipment state interval is (from one state fact, or the anchor, to the next fact of the same equipment and device epoch, by `seq`, on `sourceTime`), that every stored piece lies inside one UTC hour and one shift bucket, that the open interval is closed provisionally at the plant watermark, and that a late fact recomputes only the window between its neighbours. Implementing it left these questions open:

- **Provisional storage:** how is the open interval stored, and how often is it rewritten while the watermark moves (at 60× the plant sends about 25 messages a second)?
- **Watermark sources:** device facts carry the device epoch, but telemetry carries the gateway's epoch (`scope: topic`). Which epoch does a telemetry sample advance, and how does the watermark survive a restart?
- **Catch-up:** ingest's notices are a fast path that can be missed (ADR-0017). How does the module notice that, without scanning ingest's tables after every message?
- **Anchor versus facts:** which wins when both are known, and what if a device's time goes back within an epoch?

## Considered options

Provisional storage: (a) store only closed intervals and compute the open one on read; (b) store the open interval as pieces flagged `provisional`, rewritten as the watermark moves; (c) as (b), but in a separate table.

Watermark of telemetry: (a) ignore telemetry; (b) attribute it to the plant's newest device epoch; (c) attribute it to the newest device epoch of its own equipment.

Catch-up: (a) recompute everything at every start; (b) a periodic scan of ingest's tables; (c) record per (equipment, epoch) what the stored intervals were computed from, and compare with a per-epoch summary of ingest's tables at start-up.

## Decision outcome

- **Provisional storage: (b).** The open interval is stored up to the watermark of its epoch, cut at every hour and shift boundary passed, every piece flagged `provisional`; the next fact replaces it in the same statement that stores the closed interval. It is rewritten when the watermark passes an hour or shift boundary, or has moved `provisionalStepMs` (default 60 s of simulation time, one wall second at 60×) since the last write; a new fact always stores the exact watermark, and `flush()` does so for all. Only the pieces from the last stored one on are rewritten. (a) would make every reader (API, OEE, reports) repeat the cutting; (c) would make every query a union.
- **Closing:** a newer epoch of the equipment (any fact, or an anchor naming that device epoch) closes the old epoch's open interval at the old epoch's watermark, as final pieces. The end is always that watermark, so a late fact of the old run on another machine still extends it.
- **Watermark: (c).** The watermark of a device epoch is the latest `sourceTime` of any device fact (state, cycle or alarm, any equipment) in that epoch, and of any telemetry sample whose equipment's newest device epoch it is. All simulated devices share the simulator's epoch, so a busy machine closes a silent one's interval; WSH-01's telemetry carries the simulator clock (`simTime`), so the plant's watermark moves even when every machine is off. (b) would let a sample from the old run, still in flight after a restart, push the new epoch's watermark into the old run's (later) time. There is no watermark table: at start-up it is the maximum of ingest's latest fact per epoch and the stored intervals' ends, so a telemetry-only advance survives through the stored open interval.
- **Catch-up: (c).** `equipment.interval_source` records, per (equipment, epoch), the number of state facts and the last `seq` the stored intervals reflect, the anchor, whether the epoch is closed and whether times had to be clamped. At start-up, `Ingest.factSummary()` (one grouped pass over `ingest.equipment_event`) and `Ingest.anchors()` are compared with it; what differs is recomputed in full, the rest only has its open interval stored up to the watermark. A notice whose handling fails marks the (equipment, epoch) for a full recompute before the next notice. Ingest re-announces a fact that the table had but its cursor didn't (a commit that reported failure but was applied, ADR-0017), so that path no longer loses a notice. (a) grows with history on every start; (b) costs a scan per period forever.
- **Windows:** a fact arriving in order (its `seq` above the last one known, its time not earlier) extends the last interval without reading ingest's tables; otherwise `Ingest.stateFactWindow` returns it with its neighbours by `seq`, and only the pieces starting in [predecessor, successor) are replaced. Without a predecessor the window reaches back to the anchor. The pieces are upserted by key and the window's other pieces deleted in one statement, so a window is stored atomically in one round trip.
- **Anchor versus facts:** the anchor opens the first interval only if it is earlier than the first fact by time; otherwise facts drive the intervals and the anchor is ignored. The first anchor per (equipment, device epoch) wins (ADR-0017).
- **Time going back within an epoch** (a device clock bug, never the simulator): a fact earlier than the one before it is moved up to that time, so the earlier fact's interval is dropped as zero-length; such an (equipment, epoch) is marked `clamped` and always recomputed in full.

### Consequences

- Good: readers see one table of pieces, already cut by hour and shift, with the open interval up to the watermark; provisional time is visible (`provisionalMs` in shift totals).
- Good: a missed notice or an MES restart costs a recompute of the affected (equipment, epoch), found by a single pass over the facts at start-up.
- Good: the in-order path costs one statement per state fact (about 1.4 ms on a local database, measured); a reordered fact one query more.
- Bad: the start-up summary scans `ingest.equipment_event` once; it grows with history (about 30,000 facts per simulated week). Retention or a per-epoch summary table can bound it later.
- Bad: between steps the stored open interval lags the watermark by up to `provisionalStepMs` of simulation time; readers that need the exact end use `currentState().until` or `flush()`.
- Bad: telemetry attributed by its equipment's newest known epoch can still be misattributed if a new run's sample arrives before any fact or snapshot of that run; it can only move a watermark forward, by at most the gap until that run's first fact.
