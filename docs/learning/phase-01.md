# Phase 01 – Simulation core: learning notes

Phase 1 built the "physical world" of the project: a deterministic simulation of the Orbis Components line that everything later is tested against. This file explains its ideas, gives a reading order, and offers review questions and an exercise. In Phase 0 the owner chose to skip the learning step; these notes are here for when they are useful.

## 1. Concepts

### Discrete-event simulation

Time jumps from event to event instead of ticking: a priority queue holds future events ordered by (time, sequence), and handling one event schedules others. A week of plant runs in a fraction of a second. Read `packages/sim-core/src/simulation.ts` (about 70 lines) and its tests.

### Determinism

Same seed + same configuration = the same bytes, always. Three things make that possible:

- integer-millisecond time (ADR-0006);
- per-entity random streams derived from the seed (ADR-0007);
- one canonical serializer.

A lint rule bans wall-clock reads and `Math.random` in model code. Determinism is what lets the MES later be tested against known truth.

### Stochastic models

- **Weibull:** time to failure in running hours (wear-out when the shape is above 1).
- **Log-normal:** repairs and cycle times, which are positive and skewed.
- **Exponential gaps:** a Poisson process, for minor stops.
- **Normal with drift:** leak-test readings.

All of them use inverse-transform or Box–Muller sampling with a fixed number of draws per call. Read `docs/simulation-model.md` → "Random numbers and distributions".

### Bottlenecks, blocking and starving

The slowest station (ASM-01, 150 s) paces the line. Faster stations upstream fill their buffers and end up `Blocked`; those downstream wait, `Starved`. These are availability losses with an external cause, which is why the MES will separate them from a machine's own losses.

### Running-time clocks

A cycle, each failure mode and the next minor stop are countdowns that advance only while a machine is `Running`. That single idea gives three things: failures in running hours, no failure while blocked, and interrupted cycles resuming exactly. Read `apps/simulator/src/plant/running-clock.ts`.

### Planned vs unplanned time

Breaks (`PlannedStop`) and weekends (`Off`) are planned and leave OEE untouched. A breakdown during a shift is a loss, even when its repair runs into a break. Shifts follow the wall clock in Istanbul time, computed with `Temporal`.

### Quality and traceability facts

- Tool wear drives OP10 scrap.
- Leak readings drift until calibration.
- A failed part gets one rework.
- Every material consumption records its lot.

Together with serials, these events are the raw facts the MES turns into genealogy and SPC in Phase 8.

### Validating a simulator

A simulator can't be compared with "the real answer", so it is validated in four layers:

- invariants at every step: conservation of parts and material, time accounting from two sources;
- statistical tests with fixed seeds, proven sensitive by mutation checks;
- golden snapshots;
- a domain expert's realism check (exit criterion 5).

## 2. Reading order

| #   | File                                                                                                                     | Look for                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1   | `docs/phases/phase-01-realism-check.md`                                                                                  | What a simulated week looks like in numbers         |
| 2   | `docs/simulation-model.md`                                                                                               | Every model, its parameters and how it is validated |
| 3   | `packages/sim-core/src/simulation.ts`, `event-queue.ts`                                                                  | The whole DES kernel                                |
| 4   | `packages/sim-core/src/random.ts`, `distributions.ts`                                                                    | Seeded streams and sampling                         |
| 5   | `config/plant/*.yaml`                                                                                                    | The plant as data; which numbers are assumptions    |
| 6   | `apps/simulator/src/plant/line.ts`: start with `#tryStart`, `#finishCycle`, `#unload`, then `#onClockDue`, `#onCalendar` | How parts move and how interruptions work           |
| 7   | `apps/simulator/src/headless/run.ts`, `summary.ts`, `invariants.ts`                                                      | Output, ground truth, invariants                    |
| 8   | `apps/simulator/golden/week-01/summary.json`                                                                             | The reference week                                  |

## 3. Review questions

1. Why does the event queue need a sequence number besides the time? What could go wrong without it?
2. A new failure mode is added to CNC-02. Why doesn't that change the random numbers any other machine receives?
3. Why is the ideal cycle time of ASM-01, and not that of the CNCs, what determines weekly output? What happens to output if OP10 gets 10% faster?
4. A CNC is blocked for 20 hours a week. Is that an availability problem of the CNC? How should the MES classify it?
5. A machine breaks down at 09:55 and the break starts at 10:00. Which states does it go through until production resumes, and which of that time is a loss?
6. Why can't a machine break down while it is `Starved`?
7. Why does the invariant checker run after each simulation step and not after each emitted event?
8. Which events would you need to answer "which cartons contain seal-kit lot SK1-2610-01"? Which of them exist already?
9. The golden snapshot fails after you change a failure rate in `failures.yaml`. Is that a bug? What do you do?
10. Why does the scrap-rate test use 10× higher probabilities than the real configuration?

## 4. Hands-on exercise

Make LKT-01's calibration interval configurable per day of the week, or simpler: change the default to 5 days and observe the effect.

1. Branch `feat/<issue>-calibration-interval`.
2. Change `calibrationIntervalDays` in `config/plant/process.yaml` to 5.
3. Run `pnpm sim:headless --seed 20261012 --days 7 --out runs/cal5` and compare the leak first-test failure rate in the new summary with `apps/simulator/golden/week-01/summary.json`.
4. Run `pnpm test:golden`, read the failure, then run `pnpm test:golden --update` and write in the PR what changed in the numbers and why.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
