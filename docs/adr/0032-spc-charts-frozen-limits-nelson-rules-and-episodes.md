# ADR-0032: SPC: I-MR and X̄-R on first passes, frozen limit versions, Nelson rules and signal episodes

- Status: accepted (#195; the MES side follows in #200)
- Date: 2026-10-17
- Deciders: Claude (#195), within the Phase 8 plan and its review (PR #207, rounds 1–3); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 8 must show that SPC detects an injected leak-test drift, and only because of it (exit criterion 3): the MES's limits, points, subgroups and episodes must equal the simulator's ground truth (`trace.json`), and the counterfactual readings (the same draws without the drift) must open no episode in the window around the injection. Both programs need the same definitions, and the textbook leaves open:

- which readings form the population (a retest after rework measures a reworked part);
- where limits come from, and whether they may move once data arrives late;
- the exact run rules, their window lengths, and what a tie means (a point on a zone line, on the centre line, an equal pair in a rising run);
- whether a signal is a point or something with a start and an end, and what is acknowledged;
- what happens at a simulator restart (a new device epoch) and at a new limit version;
- which rules are on by default, given that in-control signals must not swamp the chart (probe P4b);
- where the code lives, and in what arithmetic.

## Considered options

Package and arithmetic: (a) SPC inside the MES's `quality` module, floats; (b) a pure package `spc-core` in IEEE doubles; (c) a pure package `spc-core` on `oee-core`'s exact BigInt fractions, readings in whole resolution steps.

Limits: (a) from the configured mean and sigma; (b) estimated from a baseline, then frozen and versioned.

Rules: (a) Western Electric 1–4; (b) Nelson 1–8, some enabled by default.

Signals: (a) one per triggering point; (b) episodes of consecutive triggering points of one chart and rule.

## Decision outcome

**Package and arithmetic: (c).** `@shopfloor/spc-core` is pure (ADR-0024, ADR-0005 amended): it imports only `@shopfloor/oee-core` for the fractions. A reading is an integer count of the instrument's resolution (the leak tester's 0.001 Pa/min), so every mean, limit and zone line is an exact fraction, and a point exactly on a line is decided the same way by the truth and the MES. `spc-core` and `trace-core` join `EXACT_SOURCES` (no float literals, no `/`, no `Math`). `@shopfloor/trace-core` depends on `spc-core` (pure on pure), because `traceAsOf` re-derives the episodes as of a time.

**Definitions** (exact wording, hand-calculated cases and tie cases in `docs/spc-reference-cases.md`, whose tables drive `packages/spc-core/src/reference-cases.test.ts`):

- **Population:** first-pass readings only; retests (pass 2 and later) are listed apart and never charted.
- **Order and segments:** (device epoch, plant time, device sequence). A new epoch starts a segment; moving ranges, subgroups and runs never span one. A segment's trailing readings that don't fill a subgroup are dropped once a later segment exists, and pending in the last.
- **Charts:** I-MR with E2 = 2.66 and D4(2) = 3.267; X̄-R on consecutive subgroups of n (5 in `quality.yaml`) with the ASTM E2587 constants for n = 2–10 (A2 = 0.577, D3 = 0, D4 = 2.114, d2 = 2.326 for n = 5).
- **Limits from a window** [from, to]: I-MR from every reading in it and the moving ranges inside a segment; X̄-R from the complete subgroups wholly inside it. **Version 1** is estimated from the first 20 complete subgroups (the baseline), created at the baseline's last reading, applies from the first reading (baseline points are judged retroactively) and is never re-derived. A version has `from`, `until` and `createdAt`; a point is judged by the highest version whose range holds it, and a point no version covers is not judged.
- **Zones and ties:** σ = (upper − centre)/3. "Beyond kσ" is strictly beyond and "within 1σ" strictly within; a point on a zone line is neither, a point on the centre line is on neither side, a point on a control limit is inside it.
- **Rules (Nelson):** 1 beyond a limit; 2 nine on one side; 3 six points with five successive differences all strictly positive or all strictly negative (an equal pair ends the run); 4 fourteen alternating (an equal pair ends it); 5 two of three beyond 2σ on one side; 6 four of five beyond 1σ on one side (for 5 and 6 the newest point need not be one of those beyond, as in probe P4b); 7 fifteen within 1σ; 8 eight beyond 1σ on both sides. A rule of length L is judged at a point only when its run (one chart, one segment, one limit version) holds L points ending there, and fires at that point.
- **Defaults: rules 1, 2 and 5 on I and X̄, rule 1 on MR and R** (review of PR #207); every rule can be enabled per chart and characteristic.
- **Episodes: (b).** An episode opens at the first point where a rule fires on a chart, takes every following point of the same run where it fires again, and is closed by the chart's next point that doesn't continue it; it is keyed by (characteristic, limit version, chart, rule, first triggering point), pushed and acknowledged once. A **baseline episode** is one whose first point was used by its version's estimate; it exists only once the version does and is not latency-judged.
- **Capability:** σ̂ = R̄/d2; the leak specification is one-sided (an upper limit), so only Cpu = (USL − X̿)/3σ̂ and Cpk = Cpu are given, undefined when R̄ = 0. Shown, not reconciled.

**Everything is derived** from the readings and the limit versions (`spcChart`), so a late reading that moves every later moving range, subgroup and run is a rebuild; property tests show the chart doesn't depend on arrival order and that a prefix of the readings judges every point as the full chart does (rules only look back), which `traceAsOf` and provisional points rely on. Finality, the `baseline-changed` notice and withdrawal stay in the MES (#200).

### False-alarm run length of the defaults

Measured with `spc-core` itself (`pnpm --filter @shopfloor/spc-core false-alarm`, `packages/spc-core/scripts/false-alarm-run-length.ts`): 4,000 replications (seed 195) of in-control leak readings as the simulator draws them, normal(2.0, 0.45) Pa/min in 0.001 steps, version 1 estimated from each replication's own first 20 subgroups of 5, then 1,000 readings judged; 32 s.

| Rule set                                                        | Run length to the first new episode (readings after the baseline): mean / median / 10 % / 90 % | New episodes per 1,000 | Signalling readings per 1,000 | P(none in 20) / (none in 60) | P(signal in readings 120–139): no drift / +0.6 Pa/min |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- | ---------------------------- | ----------------------------------------------------- |
| **Defaults:** 1, 2, 5 on I and X̄; 1 on MR and R                 | **77.0** / 45 / 7 / 179                                                                        | 22.9                   | 26.9                          | 0.73 / 0.41                  | 0.28 / 0.99                                           |
| 1, 2, 5 on I and X̄ only (P4b's measured set)                    | 129.4 / 80 / 12 / 312 (8 censored at 1,000)                                                    | 11.5                   | 16.5                          | 0.84 / 0.59                  | 0.18 / 0.99                                           |
| Draft: 1, 2, 3, 5, 6 on I and X̄; 1 on MR (P4b's "plan default") | 52.6 / 34 / 5 / 124                                                                            | 30.1                   | 36.9                          | 0.65 / 0.29                  | 0.36 / 1.00                                           |

The second and third rows reproduce probe P4b (16.5 and 37.4 signalling readings per 1,000; 0.18 / 0.99 and 0.35 / 1.00), and the first row's 0.41 and 0.73 reproduce P4c (a clean 60-reading window about 40 % of the time, 20 readings 72 %), so the package and the probes agree. **The final defaults raise an in-control false alarm on average every 77 readings after the baseline** (median 45; about one new episode per 44 readings over a long run). Rule 1 on MR and R is what costs most against P4b's set (16.5 → 26.9 signalling readings per 1,000): a moving range or a subgroup range beyond D4 is a variance signal the I and X̄ charts don't give, kept by the review's decision. The run length is wide because each replication estimates its own limits: a tight baseline gives many signals, a wide one few.

### Consequences

- Good: one definition for the ground truth and the MES, exact to the last fraction; ties are written down and pinned by reference cases; a drift can't hide in its own limits; acknowledging an episode instead of every point keeps the operator's list short.
- Good: the measured false-alarm rate is in the ADR, so the counterfactual criterion (#208: a clean 60-reading window, else N = 20) rests on a number the code reproduces.
- Bad: with the defaults a stable process still opens an episode about every 77 readings (roughly 30 a week at the leak tester's rate of about 2,200 first passes a week). Quality users acknowledge them; turning MR and R rule 1 off (per characteristic) would bring it to about 130 readings, at the cost of the variance signal.
- Bad: exact fractions cost more than doubles; a chart of 1,100 readings with the defaults takes a few milliseconds (32 s for the 24,000 charts of the measurement), well inside probe P3's 20 ms budget per reading (to be measured with the database in #200).
- Follow-up: the MES (#200) stores versions append-only, marks episodes provisional until LKT-01 is final through their triggering point, and raises `baseline-changed` instead of re-deriving version 1.
