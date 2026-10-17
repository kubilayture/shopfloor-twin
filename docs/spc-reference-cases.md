# SPC reference cases

Hand-calculated SPC cases for `spc-core` (Phase 8 plan, exit criterion 3; ADR-0032, ADR-0024). The tables below drive the unit tests in `packages/spc-core/src/reference-cases.test.ts`: the test parses this file, computes every case with `spc-core` and compares the constants, the exact fractions and four-decimal values of every limit, the capability indices, the points each rule fires on, and the episodes. So the documentation and the tests can't disagree. The expected values were worked out by hand (notes after the tables) and recomputed independently by a short Python script written from the definitions below with `fractions.Fraction`; they were not produced by the code under test.

## Definitions used

- **Readings** are whole steps of the instrument's resolution (the leak tester's 0.001 Pa/min: 2.134 Pa/min is 2134 steps), so every statistic is an exact fraction. Four-decimal values round half up.
- **Population:** first-pass readings only (pass 1). A retest after rework (pass 2, 3, …) is listed separately and never charted.
- **Order and segments:** readings are ordered by (device epoch, plant time, device sequence). A new epoch starts a new segment; moving ranges, subgroups and runs never span a segment boundary.
- **Subgroups:** consecutive first-pass readings of one segment, `n` at a time from the segment's first reading. A segment's trailing readings that don't fill a subgroup are dropped when a later segment exists, and pending in the last segment.
- **I-MR:** I chart centre X̄ (mean of the window's readings), limits X̄ ± 2.66·M̄R; MR chart (moving range |xᵢ − xᵢ₋₁| of consecutive readings of a segment, keyed by the later) centre M̄R, upper 3.267·M̄R, lower 0.
- **X̄-R:** X̄ chart centre X̿ (mean of the subgroup means), limits X̿ ± A2·R̄; R chart centre R̄, limits D3·R̄ and D4·R̄. Only subgroups wholly inside the window count.
- **Limit estimation from a window** [from, to] (both ends inclusive): I-MR from every first-pass reading in it and the moving ranges between consecutive ones of a segment; X̄-R from the complete subgroups inside it. **Version 1** is estimated from the first 20 complete subgroups (here: the case's baseline count), applies from the first reading (its baseline points are judged against it retroactively) and is never re-derived.
- **Zones:** σ = (upper − centre) / 3 on each chart, the same on both sides of the centre. "Beyond kσ" is strictly more than kσ from the centre; "within 1σ" is strictly less. A point exactly on a zone line is neither beyond nor within; a point exactly on the centre line is on neither side.
- **Rules** (Nelson), judged at a point when the run holds the rule's L points ending there (rules 5 and 6: up to L, see below); the rule fires at that point:
  1. (L 1) the point is strictly above the upper or strictly below the lower limit (a point on a limit is inside);
  2. (L 9) nine points all strictly above or all strictly below the centre (a point on the centre ends the run);
  3. (L 6) six points whose five successive differences are all strictly positive or all strictly negative (an equal pair ends the run);
  4. (L 14) fourteen points whose thirteen successive differences are all non-zero and alternate in sign (an equal pair ends the run);
  5. (L 3) the point is beyond 2σ, and with it at least two of the last three points of the run are beyond 2σ on its side; at a run's start two of two suffice;
  6. (L 5) the point is beyond 1σ, and with it at least four of the last five points of the run are beyond 1σ on its side; at a run's start four of four suffice;
  7. (L 15) fifteen points all within 1σ;
  8. (L 8) eight points all beyond 1σ, at least one above and one below the centre.
- **Runs:** consecutive points of one chart, one segment and one limit version. A point with no version is not judged.
- **Defaults:** rules 1, 2 and 5 on I and X̄, rule 1 on R, none on MR (review of PR #210, ADR-0032). MR and R take rule 1 only.
- **Episodes:** an episode opens at the first point where a rule fires on a chart, takes every following point of the same run where the same rule fires, and is closed by the chart's next point that doesn't continue it (whatever its run); with none it is open. It is keyed by (characteristic, limit version, chart, rule, first triggering point). A **baseline episode** is one whose first point lies at or before the end of its version's window (so it existed when the version was created, an earlier epoch's points before the window included); it exists only once the version does and is not latency-judged.
- **Capability** (one-sided specification, an upper limit only): σ̂ = R̄ / d2, Cpu = (USL − X̿) / 3σ̂, and Cpk = min(Cpu, Cpl) = Cpu since there is no lower limit. Undefined (`–`) when R̄ = 0.

Notation: readings are steps separated by spaces; `/` starts a new epoch; `rNN` is a retest of NN steps (pass 2). In chart cases, first-pass readings are named `p1`, `p2`, … and retests `r1`, … in order; each token is one minute after the previous one, the first epoch is 1. `v×k` stands for k values v. A minus sign is `−`. Fractions are `num/den`, reduced.

## Constants

| n   | A2    | D3    | D4    | d2    |
| --- | ----- | ----- | ----- | ----- |
| 2   | 1.880 | 0     | 3.267 | 1.128 |
| 3   | 1.023 | 0     | 2.574 | 1.693 |
| 4   | 0.729 | 0     | 2.282 | 2.059 |
| 5   | 0.577 | 0     | 2.114 | 2.326 |
| 6   | 0.483 | 0     | 2.004 | 2.534 |
| 7   | 0.419 | 0.076 | 1.924 | 2.704 |
| 8   | 0.373 | 0.136 | 1.864 | 2.847 |
| 9   | 0.337 | 0.184 | 1.816 | 2.970 |
| 10  | 0.308 | 0.223 | 1.777 | 3.078 |

Individuals: **E2 2.66, MR D4 3.267.**

## Limit cases

| Case | Readings                     | n   | USL |
| ---- | ---------------------------- | --- | --- |
| L1   | 10 12 11 14 13 9 11 12 10 13 | 5   | 20  |
| L2   | 10 12 11 / 14 13 9 11        | 2   | 20  |
| L3   | 5 5 5 5 5                    | 5   | 8   |
| L4   | 1 2 3 4 5 6 7                | 7   | 10  |

## Expected statistics

| Case | Readings used | Moving ranges | Subgroups | X̄    | M̄R   | X̿    | R̄   | σ̂         | Cpu         | Cpu (4 dp) |
| ---- | ------------- | ------------- | --------- | ---- | ---- | ---- | --- | --------- | ----------- | ---------- |
| L1   | 10            | 9             | 2         | 23/2 | 19/9 | 23/2 | 4/1 | 2000/1163 | 19771/12000 | 1.6476     |
| L2   | 7             | 5             | 3         | 80/7 | 2/1  | 23/2 | 5/3 | 625/423   | 2397/1250   | 1.9176     |
| L3   | 5             | 4             | 1         | 5/1  | 0/1  | 5/1  | 0/1 | –         | –           | –          |
| L4   | 7             | 6             | 1         | 4/1  | 1/1  | 4/1  | 6/1 | 375/169   | 338/375     | 0.9013     |

Cpk equals Cpu in every case.

## Expected limits

| Case | Chart | Lower    | Centre | Upper     | Lower (4 dp) | Upper (4 dp) |
| ---- | ----- | -------- | ------ | --------- | ------------ | ------------ |
| L1   | I     | 1324/225 | 23/2   | 3851/225  | 5.8844       | 17.1156      |
| L1   | MR    | 0/1      | 19/9   | 6897/1000 | 0.0000       | 6.8970       |
| L1   | Xbar  | 1149/125 | 23/2   | 1726/125  | 9.1920       | 13.8080      |
| L1   | R     | 0/1      | 4/1    | 1057/125  | 0.0000       | 8.4560       |
| L2   | I     | 1069/175 | 80/7   | 2931/175  | 6.1086       | 16.7486      |
| L2   | MR    | 0/1      | 2/1    | 3267/500  | 0.0000       | 6.5340       |
| L2   | Xbar  | 251/30   | 23/2   | 439/30    | 8.3667       | 14.6333      |
| L2   | R     | 0/1      | 5/3    | 1089/200  | 0.0000       | 5.4450       |
| L3   | I     | 5/1      | 5/1    | 5/1       | 5.0000       | 5.0000       |
| L3   | MR    | 0/1      | 0/1    | 0/1       | 0.0000       | 0.0000       |
| L3   | Xbar  | 5/1      | 5/1    | 5/1       | 5.0000       | 5.0000       |
| L3   | R     | 0/1      | 0/1    | 0/1       | 0.0000       | 0.0000       |
| L4   | I     | 67/50    | 4/1    | 333/50    | 1.3400       | 6.6600       |
| L4   | MR    | 0/1      | 1/1    | 3267/1000 | 0.0000       | 3.2670       |
| L4   | Xbar  | 743/500  | 4/1    | 3257/500  | 1.4860       | 6.5140       |
| L4   | R     | 57/125   | 6/1    | 1443/125  | 0.4560       | 11.5440      |

## Rule cases

Each case is one run on a chart with lower −30, centre 0 and upper 30, so σ = 10: 2σ = 20 and 1σ = 10 are the zone lines. Only the case's rule is judged. Points are numbered from 1; an episode is `first–last (closed by)`, `open` when nothing closes it.

| Case | Rule | Values                                    | Fires at  | Episodes                 |
| ---- | ---- | ----------------------------------------- | --------- | ------------------------ |
| R1a  | 1    | 0 31 30 −30 −31 29                        | 2, 5      | 2–2 (3), 5–5 (6)         |
| R1b  | 1    | 35 40 0                                   | 1, 2      | 1–2 (3)                  |
| R2a  | 2    | 5×10 0 5×9                                | 9, 10, 20 | 9–10 (11), 20–20 (open)  |
| R2b  | 2    | −1×9                                      | 9         | 9–9 (open)               |
| R3a  | 3    | 1 2 3 4 5 6 7                             | 6, 7      | 6–7 (open)               |
| R3b  | 3    | 1 2 3 3 4 5 6 7 8                         | 9         | 9–9 (open)               |
| R3c  | 3    | 6 5 4 3 2 1 0                             | 6, 7      | 6–7 (open)               |
| R4a  | 4    | 1 −1 1 −1 1 −1 1 −1 1 −1 1 −1 1 −1 1      | 14, 15    | 14–15 (open)             |
| R4b  | 4    | 0 1 0 1 0 1 0 0 1 0 1 0 1 0 1 0 1 0 1 0 1 | 21        | 21–21 (open)             |
| R5a  | 5    | 0 21 0 21 0 0 20 25                       | 4         | 4–4 (5)                  |
| R5b  | 5    | 25 25 0 0 −25 0 −25                       | 2, 7      | 2–2 (3), 7–7 (open)      |
| R5c  | 5    | 0 25 25 0                                 | 3         | 3–3 (4)                  |
| R5d  | 5    | 0 25 25 5                                 | 3         | 3–3 (4)                  |
| R6a  | 6    | 11 11 11 10 11 0                          | 5         | 5–5 (6)                  |
| R6b  | 6    | 11 11 −11 11 11                           | 5         | 5–5 (open)               |
| R6c  | 6    | 11 11 11 11 0                             | 4         | 4–4 (5)                  |
| R6d  | 6    | 0 11 11 11 11 5                           | 5         | 5–5 (6)                  |
| R7   | 7    | 0×14 9 10 0×15                            | 15, 31    | 15–15 (16), 31–31 (open) |
| R8   | 8    | 11 −11 11 −11 11 −11 11 −11 12 10 11×8    | 8, 9      | 8–9 (10)                 |

## Chart cases

Version 1 from the baseline, the default rules.

| Case | Readings                               | n   | Baseline subgroups |
| ---- | -------------------------------------- | --- | ------------------ |
| C1   | 10 10 10 10 10 20 11 12 r40 25 24 / 12 | 2   | 3                  |
| C2   | 10 12 10 12 30 / 30 31 32              | 2   | 2                  |
| C3   | 30 / 10 12 10 12 11                    | 2   | 2                  |

## Expected chart limits

| Case | Window | I lower | I centre | I upper | MR upper | Xbar lower | Xbar centre | Xbar upper | R upper  |
| ---- | ------ | ------- | -------- | ------- | -------- | ---------- | ----------- | ---------- | -------- |
| C1   | p1–p6  | 476/75  | 35/3     | 1274/75 | 3267/500 | 27/5       | 35/3        | 269/15     | 1089/100 |
| C2   | p1–p4  | 142/25  | 11/1     | 408/25  | 3267/500 | 181/25     | 11/1        | 369/25     | 3267/500 |
| C3   | p2–p5  | 142/25  | 11/1     | 408/25  | 3267/500 | 181/25     | 11/1        | 369/25     | 3267/500 |

## Expected chart points

| Case | Retests | Pending | Dropped | MR values           | Xbar values        | R values   |
| ---- | ------- | ------- | ------- | ------------------- | ------------------ | ---------- |
| C1   | r1      | p11     | –       | 0 0 0 0 10 9 1 13 1 | 10 10 15 23/2 49/2 | 0 0 10 1 1 |
| C2   | –       | p8      | p5      | 2 2 2 18 1 1        | 11 11 61/2         | 2 2 1      |
| C3   | –       | p6      | p1      | 2 2 2 1             | 11 11              | 2 2        |

## Expected episodes

In the order `spc-core` lists them: by first point, then chart (I, MR, Xbar, R), then rule. An X̄ or R point is named by its subgroup's last reading.

| Case | Chart | Rule | Version | First | Last | Points | Closed by | Baseline |
| ---- | ----- | ---- | ------- | ----- | ---- | ------ | --------- | -------- |
| C1   | I     | 1    | 1       | p6    | p6   | 1      | p7        | yes      |
| C1   | I     | 1    | 1       | p9    | p10  | 2      | p11       | no       |
| C1   | I     | 5    | 1       | p10   | p10  | 1      | p11       | no       |
| C1   | Xbar  | 1    | 1       | p10   | p10  | 1      | open      | no       |
| C2   | I     | 1    | 1       | p5    | p5   | 1      | p6        | no       |
| C2   | I     | 1    | 1       | p6    | p8   | 3      | open      | no       |
| C2   | I     | 5    | 1       | p7    | p8   | 2      | open      | no       |
| C2   | Xbar  | 1    | 1       | p7    | p7   | 1      | open      | no       |
| C3   | I     | 1    | 1       | p1    | p1   | 1      | p2        | yes      |

## Notes on the hand calculations

- **L1:** sum 115 over 10 readings, X̄ = 23/2. Moving ranges 2 1 3 1 4 2 1 2 3, sum 19, M̄R = 19/9. I: 23/2 ± 2.66·19/9 = 23/2 ± 2527/450, so 1324/225 and 3851/225. MR upper 3.267·19/9 = 6897/1000. Subgroups (10 12 11 14 13) mean 12 range 4 and (9 11 12 10 13) mean 11 range 4: X̿ = 23/2, R̄ = 4. X̄: 23/2 ± 0.577·4 = ± 2.308, so 9.192 and 13.808. R upper 2.114·4 = 8.456. σ̂ = 4 / 2.326 = 2000/1163; Cpu = (20 − 11.5) / (3 · 2000/1163) = 8.5 · 1163 / 6000 = 19771/12000.
- **L2:** two epochs. Moving ranges 2 1 in the first and 1 4 2 in the second (none across the `/`), M̄R = 10/5 = 2; X̄ = 80/7 over all seven readings. Subgroups of 2: (10 12), then 11 is dropped (its epoch ended), then (14 13) and (9 11): means 11, 27/2, 10 and ranges 2, 1, 2, so X̿ = (69/2)/3 = 23/2 and R̄ = 5/3. X̄: 23/2 ± 1.880·5/3 = ± 47/15. R upper 3.267·5/3 = 1089/200. σ̂ = (5/3) / 1.128 = 625/423; Cpu = 8.5 · 423 / 1875 = 2397/1250.
- **L3:** no variation: every limit collapses on the centre, R̄ = 0, so σ̂ and Cpu are undefined.
- **L4:** n = 7 has D3 = 0.076: R lower 0.076·6 = 0.456, upper 1.924·6 = 11.544; X̄: 4 ± 0.419·6 = ± 2.514. σ̂ = 6 / 2.704 = 375/169; Cpu = 6 / (3 · 375/169) = 338/375.
- **R1a:** 30 and −30 lie on the limits, so they don't fire; 31 and −31 do. **R2a:** the 0 at point 11 is on the centre and ends the run, so the next nine fives fire only at point 20. **R3b:** the equal pair (3, 3) at points 3–4 ends the rise; points 4–9 rise five times, so only point 9 fires. **R4b:** the equal pair at points 7–8 ends the alternation; points 8–21 are fourteen alternating points. **R5a:** 20 is on the 2σ line, not beyond: at point 8 only 25 is beyond in (0, 20, 25). **R5b:** at the run's start (25, 25) is two of two beyond, so point 2 fires; point 3 (0) is not beyond itself, so it doesn't; two beyond on opposite sides don't count together; (−25, 0, −25) fires at point 7. **R5c:** point 3 completes (0, 25, 25); point 4 (0) is not beyond, so (25, 25, 0) doesn't fire there. **R6a:** 10 is on the 1σ line, not beyond, yet (11 11 11 10 11) still has four beyond, the newest among them. **R6c:** four of four at the run's start fire at point 4. **R5d:** point 4 (5) lies inside 2σ, so (25, 25, 5) doesn't fire although two of its three are beyond: only point 3 fires. **R6d:** point 6 (5) lies inside 1σ, so (11, 11, 11, 11, 5) doesn't fire although four of its five are beyond: only point 5 fires. **R7:** 10 is on the 1σ line, not within, so point 16 ends the run and points 17–31 make the next fifteen. **R8:** points 2–9 are beyond 1σ on both sides, so 9 fires too; 10 is on the line and ends it, and the eight 11s after it are all above, so they never fire.
- **C1:** the baseline is p1–p6 (three subgroups of 2): X̄ = 70/6 = 35/3, moving ranges 0 0 0 0 10, M̄R = 2, I limits 35/3 ± 5.32; subgroups (10 10) (10 10) (10 20), X̿ = 35/3, R̄ = 10/3, X̄ limits 35/3 ± 1.88·10/3. The retest r1 (40) is not charted. p6 = 20 is above 1274/75 ≈ 16.99, judged retroactively: a baseline episode on I. The moving ranges 10 (p6), 9 (p7) and 13 (p9) exceed 6.534, but MR has no rule by default. p9 = 25 and p10 = 24 are above the I limit (one episode) and beyond 2σ = 35/3 + 2·5.32/3 ≈ 15.21, so rule 5 fires at p10 (p8, p9, p10, the newest beyond); at p9 only p9 is beyond in (p7, p8, p9). The subgroup (25 24) has mean 49/2 above 269/15 ≈ 17.93. p11 starts epoch 2: it has no moving range, closes the I episodes and waits alone for its subgroup; the X̄ episode stays open as no later X̄ point exists.
- **C2:** p5 = 30 is above 408/25 = 16.32 (its moving range 18 is above 6.534, not judged by default); p5 is dropped from X̄-R (epoch 1 ends after an odd count). p6 starts epoch 2: a new run, so p5's I episode is closed by p6 and a new one opens there, taking p7 and p8. (30 31) is subgroup p7, mean 61/2 above 369/25; p8 is pending. Rule 5 fires at p7 (two of two beyond 2σ ≈ 14.55 at the start of epoch 2's run) and p8: one episode p7–p8; at p5, (10, 12, 30) has only one beyond.
- **C3:** epoch 1 holds only p1 = 30, dropped from X̄-R; the baseline is epoch 2's first two subgroups, p2–p5, so p1 lies before the window, yet version 1 applies from the first reading: p1 is above 408/25 and its episode is a baseline episode (at or before the window's end), closed by p2, the first point of the next run. p6 is pending.
