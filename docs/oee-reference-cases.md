# OEE reference cases

Hand-calculated OEE cases for `oee-core` (plan sections 7 and 9, ADR-0021). The three tables below drive the unit tests in `packages/oee-core/src/reference-cases.test.ts`: the test parses this file, computes every case with `oee-core` and compares the totals, the exact fractions and the four-decimal values. So the documentation and the tests can't disagree. The expected values were worked out by hand, step by step, in the sections after the tables; they were not produced by the code under test.

## Definitions used

- **Micro-stop threshold:** 120 000 ms, as in `config/plant/oee.yaml`. A Stopped interval is a micro-stop when its **whole** length is below the threshold; the threshold applies to the interval, not to the piece that lies in the bucket.
- **PBT** (planned busy time) = time in every state except PlannedStop, Maintenance and Off; 0 in an unscheduled bucket (`no-shift`).
- **APT** (actual production time) = Running + micro-stops.
- **Ideal time** = Σ over products of (ideal cycle ms at the machine's operation × produced count). Produced = good + scrap + rework.
- **Own availability loss** = Stopped at or above the threshold + Down + Setup + Idle. **External** = Starved + Blocked. So PBT = APT + own + external.
- **Speed loss** = APT − micro-stops − ideal time (scheduled cycles only). It is negative when the cycles credited to the bucket hold more ideal time than its APT.
- **A** = APT / PBT, **P** = ideal time / APT (not clamped), **Q** = good / produced, **OEE** = (ideal time × good) / (PBT × produced).
- **Edge cases:** PBT = 0: A, P, Q, OEE and every loss are null (written `–`). APT = 0: P is null; with counts, OEE is null too and the case is flagged `anomaly`. Produced = 0: Q is null and OEE is 0.
- **Unplanned cycles:** cycles in an unscheduled bucket are reported as unplanned good, produced and ideal time, and are not part of the ideal time, good and produced counts that feed P and Q. So a sum over shift and no-shift buckets keeps the shifts' P, Q and OEE.
- **Rounding:** half-up to four decimals, in integers: a tie such as 0.03125 becomes 0.0313.
- **Flags:** `anomaly` (counts with APT = 0) and `provisional` (an open Stopped interval below the threshold counted as a micro-stop for now).

Every case is one hour bucket (3 600 000 ms per machine) unless it says otherwise. A case with several equipment rows is a work-center aggregate: the sum of its machines' inputs.

Input notation: states and times in ms, with spaces between thousands; a stop is `piece / whole` ms, followed by `open` while the interval is still open; cycles are `product result count`; ideal cycle times are `product ms` at the row's operation.

## Inputs

| Case | Equipment | Operation | Scheduled | States (ms)                                            | Stopped pieces (piece / whole ms)  | Cycles                                          | Ideal cycle (ms)               |
| ---- | --------- | --------- | --------- | ------------------------------------------------------ | ---------------------------------- | ----------------------------------------------- | ------------------------------ |
| 1    | cnc-01    | OP10      | yes       | Running 3 600 000                                      | –                                  | VB-100 good 15                                  | VB-100 240 000                 |
| 2    | cnc-01    | OP10      | yes       | Running 2 100 000; Setup 1 500 000                     | –                                  | VB-100 good 4; VB-200 good 2; VB-200 scrap 1    | VB-100 240 000; VB-200 330 000 |
| 3    | cnc-02    | OP10      | yes       | Running 3 480 000; Stopped 120 000                     | 120 000 / 120 000                  | VB-200 good 10                                  | VB-200 330 000                 |
| 4    | cnc-02    | OP10      | yes       | Running 3 480 001; Stopped 119 999                     | 119 999 / 119 999                  | VB-200 good 10                                  | VB-200 330 000                 |
| 5    | cnc-01    | OP10      | yes       | Running 3 560 000; Stopped 40 000                      | 40 000 / 100 000                   | VB-100 good 14                                  | VB-100 240 000                 |
| 6    | cnc-01    | OP10      | yes       | Running 3 550 000; Stopped 50 000                      | 50 000 / 150 000                   | VB-100 good 14                                  | VB-100 240 000                 |
| 7    | cnc-01    | OP10      | yes       | Running 3 570 000; Stopped 30 000                      | 30 000 / 30 000 open               | VB-100 good 14                                  | VB-100 240 000                 |
| 8    | asm-01    | OP30      | yes       | Down 1 200 000; PlannedStop 600 000; Running 1 800 000 | –                                  | VB-100 good 11                                  | VB-100 150 000                 |
| 9    | lkt-01    | OP40      | yes       | Running 3 240 000; Starved 360 000                     | –                                  | VB-100 good 32; VB-100 rework 3; VB-100 scrap 1 | VB-100 90 000                  |
| 10   | cnc-01    | OP10      | no        | Off 3 600 000                                          | –                                  | –                                               | VB-100 240 000                 |
| 11   | lkt-01    | OP40      | yes       | PlannedStop 1 800 000; Maintenance 1 800 000           | –                                  | –                                               | VB-100 90 000                  |
| 12   | pck-01    | OP50      | yes       | Running 600 000; Starved 3 000 000                     | –                                  | VB-100 good 21                                  | VB-100 30 000                  |
| 13   | cnc-01    | OP10      | yes       | Down 3 600 000                                         | –                                  | VB-100 good 1                                   | VB-100 240 000                 |
| 14   | cnc-02    | OP10      | yes       | Running 600 000; Setup 3 000 000                       | –                                  | –                                               | VB-200 330 000                 |
| 15   | cnc-01    | OP10      | yes       | Running 3 000 000; Down 600 000                        | –                                  | VB-100 good 12                                  | VB-100 240 000                 |
| 15   | cnc-02    | OP10      | yes       | Running 3 300 000; Stopped 300 000                     | 60 000 / 60 000; 240 000 / 240 000 | VB-200 good 9; VB-200 scrap 1                   | VB-200 330 000                 |
| 16   | wsh-01    | OP20      | yes       | Running 3 600 000                                      | –                                  | VB-100 good 58                                  | VB-100 60 000                  |
| 16   | asm-01    | OP30      | yes       | Running 3 000 000; Blocked 600 000                     | –                                  | VB-200 good 14                                  | VB-200 210 000                 |
| 17   | pck-01    | OP50      | yes       | Running 112 500; Down 3 487 500                        | –                                  | VB-100 good 3                                   | VB-100 30 000                  |
| 18   | cnc-01    | OP10      | no        | Running 3 000 000; Off 600 000                         | –                                  | VB-100 good 10; VB-100 scrap 1                  | VB-100 240 000                 |
| 19   | cnc-01    | OP10      | yes       | Running 3 500 000; Stopped 100 000                     | 100 000 / 130 000 open             | VB-100 good 14                                  | VB-100 240 000                 |

## Expected totals

| Case | PBT       | APT       | Own availability loss | External availability loss | Micro-stops | Speed loss | Ideal time | Good | Produced | Unplanned good | Unplanned produced | Unplanned ideal time |
| ---- | --------- | --------- | --------------------- | -------------------------- | ----------- | ---------- | ---------- | ---- | -------- | -------------- | ------------------ | -------------------- |
| 1    | 3 600 000 | 3 600 000 | 0                     | 0                          | 0           | 0          | 3 600 000  | 15   | 15       | 0              | 0                  | 0                    |
| 2    | 3 600 000 | 2 100 000 | 1 500 000             | 0                          | 0           | 150 000    | 1 950 000  | 6    | 7        | 0              | 0                  | 0                    |
| 3    | 3 600 000 | 3 480 000 | 120 000               | 0                          | 0           | 180 000    | 3 300 000  | 10   | 10       | 0              | 0                  | 0                    |
| 4    | 3 600 000 | 3 600 000 | 0                     | 0                          | 119 999     | 180 001    | 3 300 000  | 10   | 10       | 0              | 0                  | 0                    |
| 5    | 3 600 000 | 3 600 000 | 0                     | 0                          | 40 000      | 200 000    | 3 360 000  | 14   | 14       | 0              | 0                  | 0                    |
| 6    | 3 600 000 | 3 550 000 | 50 000                | 0                          | 0           | 190 000    | 3 360 000  | 14   | 14       | 0              | 0                  | 0                    |
| 7    | 3 600 000 | 3 600 000 | 0                     | 0                          | 30 000      | 210 000    | 3 360 000  | 14   | 14       | 0              | 0                  | 0                    |
| 8    | 3 000 000 | 1 800 000 | 1 200 000             | 0                          | 0           | 150 000    | 1 650 000  | 11   | 11       | 0              | 0                  | 0                    |
| 9    | 3 600 000 | 3 240 000 | 0                     | 360 000                    | 0           | 0          | 3 240 000  | 32   | 36       | 0              | 0                  | 0                    |
| 10   | 0         | 0         | –                     | –                          | –           | –          | 0          | 0    | 0        | 0              | 0                  | 0                    |
| 11   | 0         | 0         | –                     | –                          | –           | –          | 0          | 0    | 0        | 0              | 0                  | 0                    |
| 12   | 3 600 000 | 600 000   | 0                     | 3 000 000                  | 0           | -30 000    | 630 000    | 21   | 21       | 0              | 0                  | 0                    |
| 13   | 3 600 000 | 0         | 3 600 000             | 0                          | 0           | -240 000   | 240 000    | 1    | 1        | 0              | 0                  | 0                    |
| 14   | 3 600 000 | 600 000   | 3 000 000             | 0                          | 0           | 600 000    | 0          | 0    | 0        | 0              | 0                  | 0                    |
| 15   | 7 200 000 | 6 360 000 | 840 000               | 0                          | 60 000      | 120 000    | 6 180 000  | 21   | 22       | 0              | 0                  | 0                    |
| 16   | 7 200 000 | 6 600 000 | 0                     | 600 000                    | 0           | 180 000    | 6 420 000  | 72   | 72       | 0              | 0                  | 0                    |
| 17   | 3 600 000 | 112 500   | 3 487 500             | 0                          | 0           | 22 500     | 90 000     | 3    | 3        | 0              | 0                  | 0                    |
| 18   | 0         | 0         | –                     | –                          | –           | –          | 0          | 0    | 0        | 10             | 11                 | 2 640 000            |
| 19   | 3 600 000 | 3 500 000 | 100 000               | 0                          | 0           | 140 000    | 3 360 000  | 14   | 14       | 0              | 0                  | 0                    |

## Expected results

| Case | A     | P       | Q     | OEE     | A (4 dp) | P (4 dp) | Q (4 dp) | OEE (4 dp) | Flags       |
| ---- | ----- | ------- | ----- | ------- | -------- | -------- | -------- | ---------- | ----------- |
| 1    | 1/1   | 1/1     | 1/1   | 1/1     | 1.0000   | 1.0000   | 1.0000   | 1.0000     | –           |
| 2    | 7/12  | 13/14   | 6/7   | 13/28   | 0.5833   | 0.9286   | 0.8571   | 0.4643     | –           |
| 3    | 29/30 | 55/58   | 1/1   | 11/12   | 0.9667   | 0.9483   | 1.0000   | 0.9167     | –           |
| 4    | 1/1   | 11/12   | 1/1   | 11/12   | 1.0000   | 0.9167   | 1.0000   | 0.9167     | –           |
| 5    | 1/1   | 14/15   | 1/1   | 14/15   | 1.0000   | 0.9333   | 1.0000   | 0.9333     | –           |
| 6    | 71/72 | 336/355 | 1/1   | 14/15   | 0.9861   | 0.9465   | 1.0000   | 0.9333     | –           |
| 7    | 1/1   | 14/15   | 1/1   | 14/15   | 1.0000   | 0.9333   | 1.0000   | 0.9333     | provisional |
| 8    | 3/5   | 11/12   | 1/1   | 11/20   | 0.6000   | 0.9167   | 1.0000   | 0.5500     | –           |
| 9    | 9/10  | 1/1     | 8/9   | 4/5     | 0.9000   | 1.0000   | 0.8889   | 0.8000     | –           |
| 10   | –     | –       | –     | –       | –        | –        | –        | –          | –           |
| 11   | –     | –       | –     | –       | –        | –        | –        | –          | –           |
| 12   | 1/6   | 21/20   | 1/1   | 7/40    | 0.1667   | 1.0500   | 1.0000   | 0.1750     | –           |
| 13   | 0/1   | –       | 1/1   | –       | 0.0000   | –        | 1.0000   | –          | anomaly     |
| 14   | 1/6   | 0/1     | –     | 0/1     | 0.1667   | 0.0000   | –        | 0.0000     | –           |
| 15   | 53/60 | 103/106 | 21/22 | 721/880 | 0.8833   | 0.9717   | 0.9545   | 0.8193     | –           |
| 16   | 11/12 | 107/110 | 1/1   | 107/120 | 0.9167   | 0.9727   | 1.0000   | 0.8917     | –           |
| 17   | 1/32  | 4/5     | 1/1   | 1/40    | 0.0313   | 0.8000   | 1.0000   | 0.0250     | –           |
| 18   | –     | –       | –     | –       | –        | –        | –        | –          | –           |
| 19   | 35/36 | 24/25   | 1/1   | 14/15   | 0.9722   | 0.9600   | 1.0000   | 0.9333     | –           |

## Step-by-step arithmetic

### Case 1 – one product at ideal speed

CNC-01 runs the whole hour and finishes 15 VB-100 at the ideal 240 s.

- PBT = 3 600 000. APT = Running = 3 600 000.
- Ideal time = 15 × 240 000 = 3 600 000. Speed loss = 3 600 000 − 0 − 3 600 000 = 0.
- A = 3 600 000 / 3 600 000 = 1/1; P = 3 600 000 / 3 600 000 = 1/1; Q = 15/15 = 1/1.
- OEE = (3 600 000 × 15) / (3 600 000 × 15) = 1/1 = 1.0000.

### Case 2 – mixed products with a changeover

CNC-01 changes over from VB-100 to VB-200 (25 min Setup) and finishes 4 VB-100 and 3 VB-200, one of them scrap.

- PBT = 2 100 000 + 1 500 000 = 3 600 000. APT = 2 100 000. Own loss = Setup = 1 500 000.
- Ideal time = 4 × 240 000 + 3 × 330 000 = 960 000 + 990 000 = 1 950 000 (the scrap part is produced, so it counts). Speed loss = 2 100 000 − 1 950 000 = 150 000.
- A = 2 100 000 / 3 600 000 = 21/36 = 7/12 = 0.58333… → 0.5833.
- P = 1 950 000 / 2 100 000 = 195/210 = 13/14 = 0.928571… → 0.9286.
- Q = good / produced = 6/7 = 0.857142… → 0.8571.
- OEE = (1 950 000 × 6) / (3 600 000 × 7) = 11 700 000 / 25 200 000 = 117/252 = 13/28 = 0.464285… → 0.4643. Check: 7/12 × 13/14 × 6/7 = 546/1176 = 13/28.

### Case 3 – a stop exactly at the threshold

CNC-02 has one Stopped interval of exactly 120 000 ms. It is not shorter than the threshold, so it is availability loss.

- PBT = 3 600 000. APT = Running = 3 480 000. Own loss = 120 000.
- Ideal time = 10 × 330 000 = 3 300 000. Speed loss = 3 480 000 − 3 300 000 = 180 000.
- A = 3 480 000 / 3 600 000 = 348/360 = 29/30 = 0.96666… → 0.9667.
- P = 3 300 000 / 3 480 000 = 330/348 = 55/58 = 0.948275… → 0.9483.
- Q = 10/10 = 1/1.
- OEE = (3 300 000 × 10) / (3 600 000 × 10) = 33/36 = 11/12 = 0.91666… → 0.9167. Check: 29/30 × 55/58 = 1595/1740 = 11/12.

### Case 4 – a stop one millisecond below the threshold

As case 3, but the stop lasts 119 999 ms, so it is a micro-stop and stays in APT. OEE is unchanged; the loss moves from availability to performance.

- PBT = 3 600 000. APT = 3 480 001 + 119 999 = 3 600 000. Micro-stops = 119 999.
- Ideal time = 3 300 000. Speed loss = 3 600 000 − 119 999 − 3 300 000 = 180 001.
- A = 3 600 000 / 3 600 000 = 1/1.
- P = 3 300 000 / 3 600 000 = 11/12 → 0.9167.
- Q = 1/1. OEE = (3 300 000 × 10) / (3 600 000 × 10) = 11/12 → 0.9167.

### Case 5 – a micro-stop across an hour boundary

A Stopped interval of 100 000 ms starts 40 000 ms before the end of the hour: 40 000 ms lie in this bucket, 60 000 ms in the next. The whole interval is below the threshold, so this piece is a micro-stop (and so is the next hour's piece).

- PBT = 3 600 000. APT = 3 560 000 + 40 000 = 3 600 000. Micro-stops = 40 000.
- Ideal time = 14 × 240 000 = 3 360 000. Speed loss = 3 600 000 − 40 000 − 3 360 000 = 200 000.
- A = 1/1. P = 3 360 000 / 3 600 000 = 336/360 = 14/15 = 0.93333… → 0.9333. Q = 1/1.
- OEE = 3 360 000 / 3 600 000 = 14/15 → 0.9333.

### Case 6 – a long stop across an hour boundary

A Stopped interval of 150 000 ms has 50 000 ms in this bucket. The piece alone is shorter than the threshold, but the interval isn't, so the piece is availability loss.

- PBT = 3 600 000. APT = Running = 3 550 000. Own loss = 50 000.
- Ideal time = 14 × 240 000 = 3 360 000. Speed loss = 3 550 000 − 3 360 000 = 190 000.
- A = 3 550 000 / 3 600 000 = 355/360 = 71/72 = 0.986111… → 0.9861.
- P = 3 360 000 / 3 550 000 = 336/355 = 0.946478… → 0.9465.
- Q = 1/1. OEE = 3 360 000 / 3 600 000 = 14/15 → 0.9333. Check: 71/72 × 336/355 = 23 856/25 560 = 14/15.

### Case 7 – an open stop, counted as a micro-stop for now

The bucket ends while a Stopped interval is open at 30 000 ms. Below the threshold it counts as a micro-stop provisionally; the result is flagged `provisional`.

- PBT = 3 600 000. APT = 3 570 000 + 30 000 = 3 600 000. Micro-stops = 30 000.
- Ideal time = 3 360 000. Speed loss = 3 600 000 − 30 000 − 3 360 000 = 210 000.
- A = 1/1, P = 14/15 → 0.9333, Q = 1/1, OEE = 14/15 → 0.9333.

### Case 8 – Down during a break

The 10:00–11:00 hour of shift A, with the break at 10:00–10:30. ASM-01 broke down at 09:50 and is repaired at 10:20, inside the break: the simulator keeps a Down machine Down through the break, so those 20 minutes stay in PBT as availability loss. It then waits in PlannedStop until the break ends and runs from 10:30.

- PBT = 1 200 000 + 1 800 000 = 3 000 000 (PlannedStop 600 000 excluded). APT = 1 800 000. Own loss = Down = 1 200 000.
- Ideal time = 11 × 150 000 = 1 650 000. Speed loss = 1 800 000 − 1 650 000 = 150 000.
- A = 1 800 000 / 3 000 000 = 3/5 = 0.6000.
- P = 1 650 000 / 1 800 000 = 165/180 = 11/12 → 0.9167.
- Q = 1/1. OEE = 1 650 000 / 3 000 000 = 11/20 = 0.5500.

### Case 9 – rework and retests at the leak test

LKT-01 tests 36 parts: 3 fail and go to rework, 1 is scrap, 32 pass. Two of the 32 passes are retests of parts reworked earlier: a retest is a produced cycle like any other (first-pass yield), so it is counted as good, and the failed first passes as rework.

- PBT = 3 240 000 + 360 000 = 3 600 000. APT = 3 240 000. External loss = Starved = 360 000.
- Produced = 32 + 3 + 1 = 36. Ideal time = 36 × 90 000 = 3 240 000. Speed loss = 0.
- A = 3 240 000 / 3 600 000 = 9/10 = 0.9000. P = 3 240 000 / 3 240 000 = 1/1.
- Q = 32/36 = 8/9 = 0.88888… → 0.8889.
- OEE = (3 240 000 × 32) / (3 600 000 × 36) = 103 680 000 / 129 600 000 = 4/5 = 0.8000. Check: 9/10 × 8/9 = 4/5.

### Case 10 – zero PBT: the no-shift bucket

A weekend hour: no shift is scheduled, so under `scheduledTime: shift-calendar` PBT is 0 whatever the state.

- PBT = 0, so A, P, Q, OEE and every loss are null ("not applicable"), never 0. Every count is 0.

### Case 11 – zero PBT inside a shift

An hour of shift A in which LKT-01 is half in PlannedStop and half in its planned calibration (Maintenance). Both are excluded from PBT.

- PBT = 3 600 000 − 1 800 000 − 1 800 000 = 0, so A, P, Q, OEE and every loss are null.

### Case 12 – performance above 1

PCK-01 runs only 10 minutes but finishes 21 boxes: cycles are credited to the hour in which they complete, so some of their running time lay in the previous hour. P is not clamped.

- PBT = 600 000 + 3 000 000 = 3 600 000. APT = 600 000. External loss = Starved = 3 000 000.
- Ideal time = 21 × 30 000 = 630 000. Speed loss = 600 000 − 630 000 = −30 000.
- A = 600 000 / 3 600 000 = 1/6 = 0.16666… → 0.1667.
- P = 630 000 / 600 000 = 21/20 = 1.0500.
- Q = 1/1. OEE = 630 000 / 3 600 000 = 63/360 = 7/40 = 0.1750.

### Case 13 – counts with zero APT (anomaly)

CNC-01 is Down the whole hour, yet one good cycle is credited to it (the cycle completed at the instant the machine broke down, recorded in this hour). A·P·Q is undefined, so the closed form is not used.

- PBT = 3 600 000. APT = 0. Own loss = Down = 3 600 000.
- Ideal time = 240 000. Speed loss = 0 − 0 − 240 000 = −240 000.
- A = 0 / 3 600 000 = 0/1 = 0.0000. P = null (APT = 0). Q = 1/1.
- OEE = null, flagged `anomaly`.

### Case 14 – nothing produced

CNC-02 sets up for 50 minutes and runs 10 minutes without finishing a part.

- PBT = 3 600 000. APT = 600 000. Own loss = Setup = 3 000 000.
- Ideal time = 0. Speed loss = 600 000 − 0 = 600 000.
- A = 600 000 / 3 600 000 = 1/6 → 0.1667. P = 0 / 600 000 = 0/1 = 0.0000.
- Q = null (produced = 0). OEE = 0/1 = 0.0000: nothing good was made in planned time.

### Case 15 – work center Cell M1 (CNC-01 + CNC-02)

The cell is the sum of its machines' inputs. CNC-02 has two stops: 60 000 ms (a micro-stop) and 240 000 ms (availability loss).

- PBT = 3 600 000 + 3 600 000 = 7 200 000.
- APT = (3 000 000) + (3 300 000 + 60 000) = 6 360 000. Micro-stops = 60 000.
- Own loss = Down 600 000 + long stop 240 000 = 840 000. Check: 6 360 000 + 840 000 = 7 200 000.
- Ideal time = 12 × 240 000 + 10 × 330 000 = 2 880 000 + 3 300 000 = 6 180 000. Speed loss = 6 360 000 − 60 000 − 6 180 000 = 120 000.
- Good = 12 + 9 = 21, produced = 12 + 10 = 22.
- A = 6 360 000 / 7 200 000 = 636/720 = 53/60 = 0.88333… → 0.8833.
- P = 6 180 000 / 6 360 000 = 618/636 = 103/106 = 0.971698… → 0.9717.
- Q = 21/22 = 0.954545… → 0.9545.
- OEE = (6 180 000 × 21) / (7 200 000 × 22) = 618 × 21 / (720 × 22) = 12 978 / 15 840; gcd 18 → 721/880 = 0.819318… → 0.8193. Check: 53/60 × 103/106 × 21/22 = (103 × 21) / (60 × 2 × 22) = 2163/2640 = 721/880.

### Case 16 – work center across operations (WSH-01 + ASM-01)

Each machine's ideal time uses its own operation: OP20 for the washer, OP30 for assembly.

- PBT = 7 200 000. APT = 3 600 000 + 3 000 000 = 6 600 000. External loss = Blocked = 600 000.
- Ideal time = 58 × 60 000 + 14 × 210 000 = 3 480 000 + 2 940 000 = 6 420 000. Speed loss = 6 600 000 − 6 420 000 = 180 000.
- A = 6 600 000 / 7 200 000 = 66/72 = 11/12 → 0.9167.
- P = 6 420 000 / 6 600 000 = 642/660 = 107/110 = 0.972727… → 0.9727.
- Q = 72/72 = 1/1. OEE = 6 420 000 / 7 200 000 = 642/720 = 107/120 = 0.891666… → 0.8917.

### Case 17 – a rounding tie

PCK-01 runs 112.5 s in a hour otherwise lost to a breakdown. A is exactly 0.03125, a tie at four decimals: half-up gives 0.0313 (half-even would give 0.0312).

- PBT = 112 500 + 3 487 500 = 3 600 000. APT = 112 500. Own loss = Down = 3 487 500.
- Ideal time = 3 × 30 000 = 90 000. Speed loss = 112 500 − 90 000 = 22 500.
- A = 112 500 / 3 600 000 = 1125/36 000 = 1/32 = 0.03125 → 0.0313.
- P = 90 000 / 112 500 = 4/5 = 0.8000. Q = 1/1.
- OEE = 90 000 / 3 600 000 = 1/40 = 0.0250.

### Case 18 – cycles in an unscheduled bucket

A Saturday hour with no shift, in which CNC-01 nevertheless runs 50 minutes and finishes 11 VB-100 (one scrap). PBT is 0, so nothing is planned and nothing is lost: the cycles are reported as unplanned and stay out of P and Q, so a day's sum over shift and no-shift buckets keeps the shifts' OEE.

- PBT = 0 (unscheduled), APT = 0. A, P, Q, OEE and all losses are null.
- Ideal time, good and produced (planned) = 0.
- Unplanned good = 10, unplanned produced = 10 + 1 = 11, unplanned ideal time = 11 × 240 000 = 2 640 000.

### Case 19 – an open stop at or above the threshold that runs into the next hour

A Stopped interval started 100 000 ms before the end of this hour and is still open, 130 000 ms long so far (30 000 ms of it in the next hour). It has reached the threshold, so it is availability loss in both hours, and the classification is final: an open interval can only grow. The result is not provisional.

- PBT = 3 600 000. APT = Running = 3 500 000. Own loss = 100 000. Micro-stops = 0.
- Ideal time = 14 × 240 000 = 3 360 000. Speed loss = 3 500 000 − 3 360 000 = 140 000.
- A = 3 500 000 / 3 600 000 = 35/36 = 0.97222… → 0.9722.
- P = 3 360 000 / 3 500 000 = 336/350 = 24/25 = 0.9600.
- Q = 1/1. OEE = 3 360 000 / 3 600 000 = 14/15 → 0.9333. Check: 35/36 × 24/25 = 840/900 = 14/15.

## Phase 7: the `orders` scheduled-time rule

Cases 20–25 (#172, ADR-0021 amendment) check `scheduledTime: orders` beside `shift-calendar`. Under `orders`, inside a scheduled bucket, the part of Idle with cause `NO-ORDER` (an orders-mode CNC with no startable job: an empty queue, or a head job waiting for its `NotBefore`) is excluded from planned busy time, like a planned stop; everything else is as under `shift-calendar`. So PBT = elapsed − PlannedStop − Maintenance − Off − Idle `NO-ORDER`, and Idle with any other cause (`SCHEDULE-COMPLETE`, `NO-OPERATOR`, none) stays own availability loss. The no-shift bucket stays unscheduled. `shift-calendar` ignores the cause: `NO-ORDER` is then Idle like any other.

The tables below have the same columns as the ones above plus `Rule`; `Idle NO-ORDER x` in the states is Idle time of x ms with cause `NO-ORDER` (`BucketInput.noOrderIdleMs`), and counts in `Idle` too. A case with two rows of the same equipment is two consecutive hours, summed as their shift bucket sums them.

## Inputs, Phase 7

| Case | Rule           | Equipment | Operation | Scheduled | States (ms)                                               | Stopped pieces (piece / whole ms) | Cycles         | Ideal cycle (ms) |
| ---- | -------------- | --------- | --------- | --------- | --------------------------------------------------------- | --------------------------------- | -------------- | ---------------- |
| 20   | orders         | cnc-01    | OP10      | yes       | Running 1 200 000; Setup 1 500 000; Idle NO-ORDER 900 000 | –                                 | VB-100 good 5  | VB-100 240 000   |
| 21   | shift-calendar | cnc-01    | OP10      | yes       | Running 1 200 000; Setup 1 500 000; Idle NO-ORDER 900 000 | –                                 | VB-100 good 5  | VB-100 240 000   |
| 22   | orders         | cnc-02    | OP10      | yes       | Running 3 000 000; Idle NO-ORDER 600 000                  | –                                 | VB-200 good 9  | VB-200 330 000   |
| 22   | orders         | cnc-02    | OP10      | yes       | Idle NO-ORDER 1 200 000; Setup 1 500 000; Running 900 000 | –                                 | VB-200 good 2  | VB-200 330 000   |
| 23   | orders         | cnc-01    | OP10      | no        | Off 2 400 000; Idle NO-ORDER 1 200 000                    | –                                 | –              | VB-100 240 000   |
| 24   | orders         | cnc-01    | OP10      | yes       | Running 2 400 000; Idle 1 200 000                         | –                                 | VB-100 good 10 | VB-100 240 000   |
| 25   | orders         | asm-01    | OP30      | yes       | Idle 3 600 000                                            | –                                 | –              | VB-100 150 000   |

## Expected totals, Phase 7

| Case | PBT       | APT       | Own availability loss | External availability loss | Micro-stops | Speed loss | Ideal time | Good | Produced | Unplanned good | Unplanned produced | Unplanned ideal time |
| ---- | --------- | --------- | --------------------- | -------------------------- | ----------- | ---------- | ---------- | ---- | -------- | -------------- | ------------------ | -------------------- |
| 20   | 2 700 000 | 1 200 000 | 1 500 000             | 0                          | 0           | 0          | 1 200 000  | 5    | 5        | 0              | 0                  | 0                    |
| 21   | 3 600 000 | 1 200 000 | 2 400 000             | 0                          | 0           | 0          | 1 200 000  | 5    | 5        | 0              | 0                  | 0                    |
| 22   | 5 400 000 | 3 900 000 | 1 500 000             | 0                          | 0           | 270 000    | 3 630 000  | 11   | 11       | 0              | 0                  | 0                    |
| 23   | 0         | 0         | –                     | –                          | –           | –          | 0          | 0    | 0        | 0              | 0                  | 0                    |
| 24   | 3 600 000 | 2 400 000 | 1 200 000             | 0                          | 0           | 0          | 2 400 000  | 10   | 10       | 0              | 0                  | 0                    |
| 25   | 3 600 000 | 0         | 3 600 000             | 0                          | 0           | 0          | 0          | 0    | 0        | 0              | 0                  | 0                    |

## Expected results, Phase 7

| Case | A     | P       | Q   | OEE     | A (4 dp) | P (4 dp) | Q (4 dp) | OEE (4 dp) | Flags |
| ---- | ----- | ------- | --- | ------- | -------- | -------- | -------- | ---------- | ----- |
| 20   | 4/9   | 1/1     | 1/1 | 4/9     | 0.4444   | 1.0000   | 1.0000   | 0.4444     | –     |
| 21   | 1/3   | 1/1     | 1/1 | 1/3     | 0.3333   | 1.0000   | 1.0000   | 0.3333     | –     |
| 22   | 13/18 | 121/130 | 1/1 | 121/180 | 0.7222   | 0.9308   | 1.0000   | 0.6722     | –     |
| 23   | –     | –       | –   | –       | –        | –        | –        | –          | –     |
| 24   | 2/3   | 1/1     | 1/1 | 2/3     | 0.6667   | 1.0000   | 1.0000   | 0.6667     | –     |
| 25   | 0/1   | –       | –   | 0/1     | 0.0000   | –        | –        | 0.0000     | –     |

## Step-by-step arithmetic, Phase 7

### Case 20 – NO-ORDER inside a shift

CNC-01 runs 20 minutes (5 VB-100 at ideal speed), changes over for 25 minutes and then has no startable job for 15 minutes. Under `orders` those 15 minutes are not planned busy time.

- PBT = 3 600 000 − 900 000 (Idle `NO-ORDER`) = 2 700 000. APT = 1 200 000. Own loss = Setup = 1 500 000. Check: 1 200 000 + 1 500 000 = 2 700 000.
- Ideal time = 5 × 240 000 = 1 200 000. Speed loss = 0.
- A = 1 200 000 / 2 700 000 = 4/9 = 0.4444… → 0.4444. P = 1/1. Q = 1/1. OEE = 1 200 000 / 2 700 000 = 4/9.

### Case 21 – the same hour under `shift-calendar`

The inputs of case 20 under the Phases 1–6 rule: the cause is not looked at, so the 900 000 ms of `NO-ORDER` are Idle loss like any other.

- PBT = 3 600 000. APT = 1 200 000. Own loss = 1 500 000 + 900 000 = 2 400 000.
- A = 1 200 000 / 3 600 000 = 1/3 → 0.3333. P = 1/1. Q = 1/1. OEE = 1/3.

### Case 22 – NO-ORDER across an hour boundary

CNC-02 finishes its job 50 minutes into the first hour and waits 30 minutes for the next job's `NotBefore`: 10 minutes in the first hour and 20 in the second. It then changes over for 25 minutes and runs 15. Each hour excludes its own piece of the interval; the shift sums the hours.

- Hour 1: PBT = 3 600 000 − 600 000 = 3 000 000, APT = 3 000 000. Hour 2: PBT = 3 600 000 − 1 200 000 = 2 400 000, APT = 900 000, own loss = Setup 1 500 000.
- PBT = 5 400 000. APT = 3 900 000. Own loss = 1 500 000. Check: 3 900 000 + 1 500 000 = 5 400 000.
- Ideal time = 11 × 330 000 = 3 630 000. Speed loss = 3 900 000 − 3 630 000 = 270 000.
- A = 3 900 000 / 5 400 000 = 13/18 = 0.7222… → 0.7222.
- P = 3 630 000 / 3 900 000 = 363/390 = 121/130 = 0.93076… → 0.9308.
- Q = 1/1. OEE = 3 630 000 / 5 400 000 = 121/180 = 0.6722… → 0.6722. Check: 13/18 × 121/130 = 1 573/2 340 = 121/180.

### Case 23 – NO-ORDER in the no-shift bucket

An unscheduled bucket stays unscheduled under `orders`, whatever its states: PBT = 0, so A, P, Q, OEE and every loss are null, and there are no cycles to report as unplanned.

### Case 24 – SCHEDULE-COMPLETE unchanged

A schedule-mode CNC whose schedule is done (Idle `SCHEDULE-COMPLETE`) for the last 20 minutes. Only `NO-ORDER` is excluded, so under `orders` this Idle stays own availability loss, exactly as under `shift-calendar`.

- PBT = 3 600 000. APT = 2 400 000. Own loss = Idle = 1 200 000. Ideal time = 10 × 240 000 = 2 400 000. Speed loss = 0.
- A = 2 400 000 / 3 600 000 = 2/3 → 0.6667. P = 1/1. Q = 1/1. OEE = 2/3.

### Case 25 – NO-OPERATOR unchanged

ASM-01 has no operator this shift and stays Idle `NO-OPERATOR` for the whole hour: own availability loss under both rules.

- PBT = 3 600 000. APT = 0. Own loss = 3 600 000. Ideal time = 0, nothing produced.
- A = 0/1. P is null (APT = 0). Q is null (nothing produced). OEE = 0/1: nothing was produced in planned time. Not an anomaly: there are no counts.
