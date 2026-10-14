# ADR-0006: Simulation time as integer milliseconds

- Status: accepted
- Date: 2026-10-14
- Deciders: Claude, owner on review

## Context and problem statement

Plan section 4 requires a simulation clock with a configurable start date, timestamps on every emitted value, and calculations that never use wall-clock time. How is simulation time represented in `sim-core` and everything built on it?

## Considered options

1. `Date` objects.
2. Floating-point seconds since the simulation start.
3. Integer milliseconds since the Unix epoch (UTC), with calendar logic in `Temporal`.
4. `bigint` nanoseconds.

## Decision outcome

Chosen option: 3.

- `SimTime` is a JavaScript `number` holding an integer count of milliseconds since 1970-01-01T00:00:00Z. The simulation starts at a configured instant, for example Monday 2026-10-12 06:00 Europe/Istanbul = `Date.UTC(2026, 9, 12, 3)`.
- The kernel rejects any time, delay or end time that is not a safe integer. Code that draws a duration from a distribution rounds it to whole milliseconds **before** scheduling, with `Math.round`, so the rounding rule is one rule everywhere.
- Calendar logic (shifts, breaks, the production week in Europe/Istanbul) uses the `Temporal` API built into Node.js 26: `Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO('Europe/Istanbul')`.
- Deterministic code never reads the wall clock. Lint bans `Date.now()`, `new Date()` without arguments, `performance.now()`, `Temporal.Now`, `Math.random()` and `crypto` randomness in `packages/sim-core/src` and `apps/simulator/src/plant` (`packages/eslint-config/src/determinism-rules.ts`).

Why not the others:

- Option 1: `Date` is mutable and invites wall-clock reads.
- Option 2: floating-point sums drift. For example, 0.1 + 0.2 ≠ 0.3, so "same seed, same bytes" could depend on summation order, and timestamps would need a separate conversion.
- Option 4: exact, but `bigint` cannot mix with ordinary arithmetic and is slower, for a resolution nothing in the plant needs.

### Consequences

- Good: exact integer comparison and addition, so event ordering and time accounting are exact. Timestamps convert to ISO 8601 and to OPC UA `DateTime` with no loss beyond the 1 ms resolution.
- Good: integers up to 2^53 ms cover about 285,000 years.
- Bad: 1 ms resolution. Every modelled duration (cycle times of seconds, stops of seconds or more) is far coarser, so this does not limit the model.
