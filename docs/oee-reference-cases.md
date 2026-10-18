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

## Phase 9: bottleneck, order OEE and line OEE

Cases B1–B4, H1–H17, O1–O11, F1 and L1–L13 (#229, ADR-0036; H17 and O11 from #230, its amendment) check the derived bottleneck, the head time of a job, the order OEE over job windows, the first-pass yield across the routing and the line throughput OEE. They drive `packages/oee-core/src/order-line-reference-cases.test.ts` as the tables above drive theirs. The micro-stop threshold is the one above; order cases use `scheduledTime: orders`.

Times are plant clock times of one day (`hh:mm` or `hh:mm:ss`), read as ms from its midnight: only differences matter. A range `06:00–14:00` is half-open. Ideal cycle times are those of `config/plant/products.yaml`: OP10 VB-100 240 000 ms and VB-200 330 000 ms; OP30 VB-100 150 000 ms and VB-200 210 000 ms.

Definitions:

- **Bottleneck** of a product: the operation with the largest **effective cycle**, its ideal cycle ÷ the number of machines that run it (`plant.yaml`), ties to the earlier operation of the routing. Effective cycles are exact fractions.
- **Head time** of a job: `max(accepted, previous job's completed, notBefore)` on its CNC (`notBefore` from #230, the ADR-0036 amendment: the dispatch's earliest start, `–` when it has none; when it is the latest of the three the source is `notBefore`), where `accepted` is the device's `accepted` fact, or the command result's `acceptedAt` when the fact is unknown, and the previous job's completion is its `completed` fact or, when that fact is lost and all its `quantity` OP10 cycles are known, the end of the last of them (ADR-0030: `completed` is the end of the last OP10 cycle; `previous-last-cycle`). Unknown (`headTimeUnknown`) when neither acceptance is known (`accepted-unknown`, or `accepted-lost` when the fact is lost), or when the previous job's completion is lost (`previous-completed-lost`) or missing while this job has started (`previous-completed-missing`). A job whose predecessor has not completed and which has not started is `waiting`.
- **Job window:** from the head time to the job's completion, or to the cut-off (`Until`) while it is open. With an unknown head time it starts at the job's `started` fact, which leaves the changeover out: provisional. When the job's `completed` fact is lost and its cycles don't tell its end (`endLost`), the window ends at the next job's `started` fact, or at the cut-off (`open`) while there is none. **`lost`** marks a window that needs a fact lost for good (`accepted-lost`, `previous-completed-lost`, `endLost`): provisional and never final. `accepted-unknown` and `previous-completed-missing` are transient: final again once the fact arrives. `Accepted` `lost` in the tables is a lost `accepted` fact; `Quantity` and `OP10 cycle ends` are the job's blanks and its cycles known so far.
- **Order OEE:** the equipment rules (definitions above, `orders` rule) applied to the CNC's states inside each window and summed over the order's jobs; produced and good are the job's OP10 cycles, given here by job (the MES attributes them by unit, ADR-0031). A Stopped interval is judged by its whole length, also where the window cuts it.
- **First-pass yield:** units packed good at OP50 with every record good (no rework, no retest) ÷ units started (blanks taken).
- **Line planned busy time:** the bucket's scheduled time minus planned stops (breaks, planned maintenance on the bottleneck); in orders mode only where at least one order is in progress, from its first job's head time to its completion. `–` in `Orders in progress` is schedule mode (no such restriction); `none` is orders mode with no order in progress.
- **Line OEE:** Σ good packed × the bottleneck's effective cycle ÷ line planned busy time; null (`–`) when the planned busy time is 0; not capped: above 1 it is flagged `aboveOne`. Per order, the same ratio over the order's in-progress time with its own good units; orders overlap, so per-order values are **not additive**.

## Bottleneck, Phase 9

| Case | Equipment per operation                                                         | Product | Ideal cycle (ms)                                                  | Bottleneck | Machines               | Effective cycle (ms) |
| ---- | ------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- | ---------- | ---------------------- | -------------------- |
| B1   | OP10 cnc-01, cnc-02; OP20 wsh-01; OP30 asm-01; OP40 lkt-01; OP50 pck-01         | VB-100  | OP10 240 000; OP20 60 000; OP30 150 000; OP40 90 000; OP50 30 000 | OP30       | asm-01                 | 150000/1             |
| B2   | OP10 cnc-01, cnc-02; OP20 wsh-01; OP30 asm-01; OP40 lkt-01; OP50 pck-01         | VB-200  | OP10 330 000; OP20 60 000; OP30 210 000; OP40 90 000; OP50 30 000 | OP30       | asm-01                 | 210000/1             |
| B3   | OP10 cnc-01, cnc-02; OP20 wsh-01; OP30 asm-01; OP40 lkt-01; OP50 pck-01         | VB-300  | OP10 300 000; OP20 60 000; OP30 150 000; OP40 90 000; OP50 30 000 | OP10       | cnc-01, cnc-02         | 150000/1             |
| B4   | OP10 cnc-01, cnc-02, cnc-03; OP20 wsh-01; OP30 asm-01; OP40 lkt-01; OP50 pck-01 | VB-100  | OP10 500 000; OP20 60 000; OP30 150 000; OP40 90 000; OP50 30 000 | OP10       | cnc-01, cnc-02, cnc-03 | 500000/3             |

## Head times, Phase 9

Rows of one case and machine are that CNC's queue in acceptance order. `Accepted at` is the command result's `acceptedAt`.

| Case | Machine | Job | Accepted | Accepted at | Not before | Started | Completed | Quantity | OP10 cycle ends     | Until | Head time                          | Window                           |
| ---- | ------- | --- | -------- | ----------- | ---------- | ------- | --------- | -------- | ------------------- | ----- | ---------------------------------- | -------------------------------- |
| H1   | cnc-01  | J1  | 06:00    | 06:00       | –          | 06:25   | 07:40     | –        | –                   | 12:00 | 06:00 accepted                     | 06:00–07:40                      |
| H2   | cnc-01  | J1  | 06:00    | 06:00       | –          | 06:25   | 07:40     | –        | –                   | 12:00 | 06:00 accepted                     | 06:00–07:40                      |
| H2   | cnc-01  | J2  | 06:05    | 06:05       | –          | 08:05   | 10:00     | –        | –                   | 12:00 | 07:40 previous-completed           | 07:40–10:00                      |
| H3   | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | 07:40     | –        | –                   | 12:00 | 06:00 accepted                     | 06:00–07:40                      |
| H3   | cnc-01  | J2  | 08:00    | –           | –          | 08:25   | 10:00     | –        | –                   | 12:00 | 08:00 accepted                     | 08:00–10:00                      |
| H4   | cnc-02  | J1  | lost     | 06:00       | –          | 06:25   | 07:40     | –        | –                   | 12:00 | 06:00 acceptedAt                   | 06:00–07:40                      |
| H5   | cnc-02  | J1  | –        | –           | –          | 06:25   | 07:40     | –        | –                   | 12:00 | unknown accepted-unknown           | 06:25–07:40 headTimeUnknown      |
| H6   | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | lost      | –        | –                   | 12:00 | 06:00 accepted                     | 06:00–08:05 endLost lost         |
| H6   | cnc-01  | J2  | 06:05    | –           | –          | 08:05   | 10:00     | –        | –                   | 12:00 | unknown previous-completed-lost    | 08:05–10:00 headTimeUnknown lost |
| H7   | cnc-02  | J1  | 06:00    | –           | –          | 06:25   | –         | –        | –                   | 07:00 | 06:00 accepted                     | 06:00–07:00 open                 |
| H7   | cnc-02  | J2  | 06:05    | –           | –          | –       | –         | –        | –                   | 07:00 | waiting                            | –                                |
| H8   | cnc-02  | J1  | 06:00    | –           | –          | 06:25   | –         | –        | –                   | 09:00 | 06:00 accepted                     | 06:00–09:00 open                 |
| H8   | cnc-02  | J2  | 06:05    | –           | –          | 08:05   | –         | –        | –                   | 09:00 | unknown previous-completed-missing | 08:05–09:00 open headTimeUnknown |
| H9   | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | lost      | 3        | 06:55, 07:15, 07:40 | 12:00 | 06:00 accepted                     | 06:00–07:40                      |
| H9   | cnc-01  | J2  | 06:05    | –           | –          | 08:05   | 10:00     | –        | –                   | 12:00 | 07:40 previous-last-cycle          | 07:40–10:00                      |
| H10  | cnc-02  | J1  | lost     | –           | –          | 06:25   | 07:40     | –        | –                   | 12:00 | unknown accepted-lost              | 06:25–07:40 headTimeUnknown lost |
| H11  | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | lost      | 3        | 06:55, 07:15        | 09:00 | 06:00 accepted                     | 06:00–09:00 open endLost lost    |
| H11  | cnc-01  | J2  | 06:05    | –           | –          | –       | –         | –        | –                   | 09:00 | unknown previous-completed-lost    | –                                |
| H12  | cnc-02  | J1  | 07:00    | –           | –          | –       | –         | –        | –                   | 07:00 | 07:00 accepted                     | 07:00–07:00 open                 |
| H13  | cnc-02  | J1  | 06:00    | –           | –          | 06:25   | 07:40     | –        | –                   | 07:40 | 06:00 accepted                     | 06:00–07:40                      |
| H14  | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | lost      | 2        | 06:55, 08:30        | 09:00 | 06:00 accepted                     | 06:00–09:00 open endLost lost    |
| H14  | cnc-01  | J2  | 06:05    | –           | –          | –       | –         | –        | –                   | 09:00 | unknown previous-completed-lost    | –                                |
| H15  | cnc-02  | J1  | 06:00    | –           | –          | 06:25   | –         | 2        | 06:55, 07:15, 07:40 | 09:00 | 06:00 accepted                     | 06:00–09:00 open                 |
| H15  | cnc-02  | J2  | 06:05    | –           | –          | –       | –         | –        | –                   | 09:00 | waiting                            | –                                |
| H16  | cnc-01  | J1  | 06:00    | –           | –          | 06:25   | lost      | 2        | 06:55, 07:15        | 09:00 | 06:00 accepted                     | 06:00–09:00 open endLost lost    |
| H16  | cnc-01  | J2  | lost     | –           | –          | –       | –         | –        | –                   | 09:00 | unknown previous-completed-lost    | –                                |
| H17  | cnc-01  | J1  | 06:00    | 06:00       | –          | 06:25   | 07:40     | –        | –                   | 12:00 | 06:00 accepted                     | 06:00–07:40                      |
| H17  | cnc-01  | J2  | 06:05    | 06:05       | 09:00      | 09:25   | 11:00     | –        | –                   | 12:00 | 09:00 notBefore                    | 09:00–11:00                      |
| H17  | cnc-01  | J3  | 06:10    | 06:10       | 08:00      | 11:25   | 12:00     | –        | –                   | 12:00 | 11:00 previous-completed           | 11:00–12:00                      |

## Inputs, Phase 9 order OEE

`Previous completed` is the `completed` fact of the job before this one on its CNC (`–`: the first job, `lost`: a written-off gap); `Next started` is the `started` fact of the job after it (`–`: none). `States` are the CNC's state facts (`time state [cause]`); the last state lasts until `Until`, open. `Cycles` are the job's OP10 cycles, `product result count @time`, the time deciding whether they are scheduled.

| Case | Job | Machine | Accepted | Accepted at | Not before | Previous completed | Started | Completed | Next started | Until | Scheduled                | States                                                                                                                          | Cycles                                       |
| ---- | --- | ------- | -------- | ----------- | ---------- | ------------------ | ------- | --------- | ------------ | ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| O1   | J1  | cnc-01  | 06:00    | 06:00       | –          | –                  | 06:00   | 07:00     | –            | 12:00 | 06:00–14:00              | 06:00 Running; 07:00 Idle NO-ORDER                                                                                              | VB-100 good 14 @07:00                        |
| O2   | J1  | cnc-01  | 06:00    | 06:00       | –          | –                  | 06:25   | 08:05     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 08:05 Idle NO-ORDER                                                                      | VB-100 good 23 @08:05; VB-100 scrap 1 @08:05 |
| O3   | J1  | cnc-01  | 06:00    | 06:00       | –          | 06:30              | 06:55   | 08:15     | –            | 12:00 | 06:00–14:00              | 06:00 Running; 06:30 Setup CHANGEOVER; 06:55 Running; 08:15 Idle NO-ORDER                                                       | VB-200 good 14 @08:15                        |
| O3   | J2  | cnc-02  | 06:00    | 06:00       | –          | –                  | 06:25   | 07:45     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 07:45 Idle NO-ORDER                                                                      | VB-200 good 13 @07:45; VB-200 scrap 1 @07:45 |
| O4   | J1  | cnc-02  | 13:00    | 13:00       | –          | –                  | 13:25   | 19:05     | –            | 20:00 | 06:00–14:00; 14:00–22:00 | 13:00 Setup CHANGEOVER; 13:25 Running; 18:00 PlannedStop BREAK; 18:30 Running; 19:05 Idle NO-ORDER                              | VB-100 good 8 @13:59; VB-100 good 67 @19:05  |
| O5   | J1  | cnc-01  | 06:00    | 06:00       | –          | –                  | 06:25   | 09:00     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 07:00 Stopped JAM; 07:01 Running; 07:30 Down SPINDLE; 08:00 Running; 09:00 Idle NO-ORDER | VB-200 good 21 @09:00; VB-200 scrap 1 @09:00 |
| O6   | J1  | cnc-01  | 06:00    | 06:00       | –          | –                  | 06:25   | 07:05     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 07:05 Idle NO-ORDER                                                                      | VB-100 good 9 @07:05; VB-100 scrap 1 @07:05  |
| O7   | J1  | cnc-01  | –        | 06:00       | –          | –                  | 06:25   | 08:05     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 08:05 Idle NO-ORDER                                                                      | VB-100 good 23 @08:05; VB-100 scrap 1 @08:05 |
| O8   | J1  | cnc-01  | lost     | –           | –          | –                  | 06:25   | 08:05     | –            | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 08:05 Idle NO-ORDER                                                                      | VB-100 good 23 @08:05; VB-100 scrap 1 @08:05 |
| O9   | J1  | cnc-01  | 06:00    | 06:00       | –          | –                  | 06:25   | –         | –            | 07:25 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running                                                                                           | VB-100 good 14 @07:24                        |
| O10  | J1  | cnc-01  | 06:00    | –           | –          | –                  | 06:25   | lost      | 08:05        | 12:00 | 06:00–14:00              | 06:00 Setup CHANGEOVER; 06:25 Running; 07:45 Setup CHANGEOVER; 08:05 Running                                                    | VB-100 good 20 @07:45                        |
| O11  | J1  | cnc-01  | 06:00    | 06:00       | 08:00      | –                  | 08:25   | 09:45     | –            | 12:00 | 06:00–14:00              | 06:00 Idle NO-ORDER; 08:00 Setup CHANGEOVER; 08:25 Running; 09:45 Idle NO-ORDER                                                 | VB-100 good 18 @09:45; VB-100 scrap 1 @09:45 |

## Expected totals, Phase 9 order OEE

| Case | PBT        | APT        | Own availability loss | External availability loss | Micro-stops | Speed loss | Ideal time | Good | Produced |
| ---- | ---------- | ---------- | --------------------- | -------------------------- | ----------- | ---------- | ---------- | ---- | -------- |
| O1   | 3 600 000  | 3 600 000  | 0                     | 0                          | 0           | 240 000    | 3 360 000  | 14   | 14       |
| O2   | 7 500 000  | 6 000 000  | 1 500 000             | 0                          | 0           | 240 000    | 5 760 000  | 23   | 24       |
| O3   | 12 600 000 | 9 600 000  | 3 000 000             | 0                          | 0           | 360 000    | 9 240 000  | 27   | 28       |
| O4   | 20 100 000 | 18 600 000 | 1 500 000             | 0                          | 0           | 600 000    | 18 000 000 | 75   | 75       |
| O5   | 10 800 000 | 7 500 000  | 3 300 000             | 0                          | 60 000      | 180 000    | 7 260 000  | 21   | 22       |
| O6   | 3 900 000  | 2 400 000  | 1 500 000             | 0                          | 0           | 0          | 2 400 000  | 9    | 10       |
| O7   | 7 500 000  | 6 000 000  | 1 500 000             | 0                          | 0           | 240 000    | 5 760 000  | 23   | 24       |
| O8   | 6 000 000  | 6 000 000  | 0                     | 0                          | 0           | 240 000    | 5 760 000  | 23   | 24       |
| O9   | 5 100 000  | 3 600 000  | 1 500 000             | 0                          | 0           | 240 000    | 3 360 000  | 14   | 14       |
| O10  | 7 500 000  | 4 800 000  | 2 700 000             | 0                          | 0           | 0          | 4 800 000  | 20   | 20       |
| O11  | 6 300 000  | 4 800 000  | 1 500 000             | 0                          | 0           | 240 000    | 4 560 000  | 18   | 19       |

## Expected results, Phase 9 order OEE

| Case | A     | P       | Q     | OEE    | A (4 dp) | P (4 dp) | Q (4 dp) | OEE (4 dp) | Flags                              |
| ---- | ----- | ------- | ----- | ------ | -------- | -------- | -------- | ---------- | ---------------------------------- |
| O1   | 1/1   | 14/15   | 1/1   | 14/15  | 1.0000   | 0.9333   | 1.0000   | 0.9333     | –                                  |
| O2   | 4/5   | 24/25   | 23/24 | 92/125 | 0.8000   | 0.9600   | 0.9583   | 0.7360     | –                                  |
| O3   | 16/21 | 77/80   | 27/28 | 99/140 | 0.7619   | 0.9625   | 0.9643   | 0.7071     | –                                  |
| O4   | 62/67 | 30/31   | 1/1   | 60/67  | 0.9254   | 0.9677   | 1.0000   | 0.8955     | –                                  |
| O5   | 25/36 | 121/125 | 21/22 | 77/120 | 0.6944   | 0.9680   | 0.9545   | 0.6417     | –                                  |
| O6   | 8/13  | 1/1     | 9/10  | 36/65  | 0.6154   | 1.0000   | 0.9000   | 0.5538     | –                                  |
| O7   | 4/5   | 24/25   | 23/24 | 92/125 | 0.8000   | 0.9600   | 0.9583   | 0.7360     | –                                  |
| O8   | 1/1   | 24/25   | 23/24 | 23/25  | 1.0000   | 0.9600   | 0.9583   | 0.9200     | provisional, headTimeUnknown, lost |
| O9   | 12/17 | 14/15   | 1/1   | 56/85  | 0.7059   | 0.9333   | 1.0000   | 0.6588     | provisional, open                  |
| O10  | 16/25 | 1/1     | 1/1   | 16/25  | 0.6400   | 1.0000   | 1.0000   | 0.6400     | provisional, endLost, lost         |
| O11  | 16/21 | 19/20   | 18/19 | 24/35  | 0.7619   | 0.9500   | 0.9474   | 0.6857     | –                                  |

## First-pass yield, Phase 9

`Units` lists unit routes as `n × records`, each record `operation result` in plant-time order.

| Case | Started | Units                                                                                                                                                                                                                                 | First-pass good | FPY  | FPY (4 dp) |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---- | ---------- |
| F1   | 10      | 1 × OP10 scrap; 7 × OP10 good, OP20 good, OP30 good, OP40 good, OP50 good; 1 × OP10 good, OP20 good, OP30 good, OP40 rework, OP30 good, OP40 good, OP50 good; 1 × OP10 good, OP20 good, OP30 good, OP40 rework, OP30 good, OP40 scrap | 7               | 7/10 | 0.7000     |

## Line OEE, Phase 9

`Bottleneck cycle` is the effective cycle per product (cases B1 and B2). Planned stops are the shift break (10:00–10:30 in shift A, 18:00–18:30 in shift B) and any planned maintenance on the bottleneck.

| Case | Bucket      | Scheduled   | Planned stops            | Orders in progress                 | Good packed         | Bottleneck cycle (ms)          |
| ---- | ----------- | ----------- | ------------------------ | ---------------------------------- | ------------------- | ------------------------------ |
| L1   | 13:00–14:00 | 06:00–14:00 | 10:00–10:30              | PO-1 06:00–12:40                   | –                   | VB-100 150 000; VB-200 210 000 |
| L2   | 08:00–09:00 | 06:00–14:00 | 10:00–10:30              | PO-1 06:00–08:30; PO-2 08:15–12:00 | VB-100 14; VB-200 3 | VB-100 150 000; VB-200 210 000 |
| L3   | 06:00–08:30 | 06:00–14:00 | 10:00–10:30              | PO-1 06:00–08:30                   | VB-100 50           | VB-100 150 000; VB-200 210 000 |
| L4   | 08:15–12:00 | 06:00–14:00 | 10:00–10:30              | PO-2 08:15–12:00                   | VB-200 45           | VB-100 150 000; VB-200 210 000 |
| L5   | 12:00–13:00 | 06:00–14:00 | 10:00–10:30              | PO-2 08:15–12:10; PO-3 12:30–14:00 | VB-200 1            | VB-100 150 000; VB-200 210 000 |
| L6   | 15:00–16:00 | 14:00–22:00 | 18:00–18:30              | PO-4 13:00–20:00                   | VB-100 25           | VB-100 150 000; VB-200 210 000 |
| L7   | 18:00–19:00 | 14:00–22:00 | 18:00–18:30              | PO-4 13:00–20:00                   | VB-100 14           | VB-100 150 000; VB-200 210 000 |
| L8   | 18:00–19:00 | 14:00–22:00 | 18:00–18:30              | PO-4 13:00–20:00                   | VB-100 12           | VB-100 150 000; VB-200 210 000 |
| L9   | 09:00–10:00 | 06:00–14:00 | 10:00–10:30              | PO-5 06:00–14:00                   | VB-200 10           | VB-100 150 000; VB-200 210 000 |
| L10  | 06:00–14:00 | 06:00–14:00 | 10:00–10:30; 12:00–12:15 | –                                  | VB-100 160          | VB-100 150 000; VB-200 210 000 |
| L11  | 22:00–23:00 | 06:00–14:00 | 10:00–10:30              | PO-6 21:00–23:30                   | –                   | VB-100 150 000; VB-200 210 000 |
| L12  | 13:00–15:00 | 06:00–14:00 | 10:00–10:30              | –                                  | VB-100 20           | VB-100 150 000; VB-200 210 000 |
| L13  | 12:00–15:00 | 06:00–14:00 | 10:00–10:30              | PO-7 12:00–15:00                   | VB-200 30           | VB-100 150 000; VB-200 210 000 |

## Expected line OEE, Phase 9

| Case | Line PBT   | Ideal time | Good | Line OEE | Line OEE (4 dp) | Flags    |
| ---- | ---------- | ---------- | ---- | -------- | --------------- | -------- |
| L1   | 0          | 0          | 0    | –        | –               | –        |
| L2   | 3 600 000  | 2 730 000  | 17   | 91/120   | 0.7583          | –        |
| L3   | 9 000 000  | 7 500 000  | 50   | 5/6      | 0.8333          | –        |
| L4   | 11 700 000 | 9 450 000  | 45   | 21/26    | 0.8077          | –        |
| L5   | 2 400 000  | 210 000    | 1    | 7/80     | 0.0875          | –        |
| L6   | 3 600 000  | 3 750 000  | 25   | 25/24    | 1.0417          | aboveOne |
| L7   | 1 800 000  | 2 100 000  | 14   | 7/6      | 1.1667          | aboveOne |
| L8   | 1 800 000  | 1 800 000  | 12   | 1/1      | 1.0000          | –        |
| L9   | 3 600 000  | 2 100 000  | 10   | 7/12     | 0.5833          | –        |
| L10  | 26 100 000 | 24 000 000 | 160  | 80/87    | 0.9195          | –        |
| L11  | 0          | 0          | 0    | –        | –               | –        |
| L12  | 3 600 000  | 3 000 000  | 20   | 5/6      | 0.8333          | –        |
| L13  | 7 200 000  | 6 300 000  | 30   | 7/8      | 0.8750          | –        |

## Step-by-step arithmetic, Phase 9

### Cases B1 and B2 – parallel machines: the largest raw cycle is not the bottleneck

OP10 runs on two CNCs, so one VB-100 costs the line 240 000 ÷ 2 = 120 000 ms of OP10 time; OP20 60 000, OP30 150 000 (one machine), OP40 90 000, OP50 30 000. The largest effective cycle is OP30's 150 000: ASM-01, although OP10's raw 240 000 is the largest ideal cycle. VB-200: OP10 330 000 ÷ 2 = 165 000 against OP30's 210 000: ASM-01 again. So the plant's designed bottleneck is ASM-01 for both products, and the line OEE's numerator uses 150 000 and 210 000 ms per good unit.

### Case B3 – a tie goes to the earlier operation

A product with OP10 300 000 ms on two CNCs has an effective OP10 cycle of 150 000, equal to OP30's 150 000. The tie goes to the earlier operation of the routing: OP10, on CNC-01 and CNC-02, effective cycle 150 000.

### Case B4 – a fractional effective cycle

Three CNCs on OP10 at 500 000 ms: 500 000 ÷ 3 = 166 666.67 ms, kept exact as 500000/3, above OP30's 150 000: the bottleneck is OP10 on all three CNCs.

### Cases H1–H8 – head times and windows

- **H1:** the first job on the CNC is head from its acceptance, 06:00; it completes at 07:40, so its window is 06:00–07:40, its 25-minute changeover included.
- **H2:** J2 is accepted at 06:05 while J1 runs; it becomes head when J1 completes: max(06:05, 07:40) = 07:40. Its changeover 07:40–08:05 is in its window, 07:40–10:00.
- **H3:** J2 is accepted at 08:00, after J1 completed at 07:40: max(08:00, 07:40) = 08:00. The CNC's Idle `NO-ORDER` from 07:40 to 08:00 belongs to no job.
- **H4:** the `accepted` fact is lost; the command result's `acceptedAt` (06:00) gives the same instant, so the head time is known and the order can be final.
- **H5:** neither the fact nor `acceptedAt` has arrived: the head time is unknown and the window starts at the `started` fact, 06:25, leaving out the changeover: `headTimeUnknown`, provisional until the fact arrives.
- **H6:** J1's `completed` fact is lost and its cycles are not known: J1's window ends at J2's `started` fact, 08:05 (`endLost`), so it never overlaps J2's; J2's head time is unknown and its window starts at its `started` fact, 08:05. Both are `lost`: never final.
- **H7:** at 07:00 J1 is still running (open window 06:00–07:00) and J2 waits: no window yet.
- **H8:** J1's `completed` fact has not arrived but J2 has started: J2's head time is unknown until the fact arrives; its window runs from its `started` fact to the cut-off, open. Transient: not `lost`.
- **H9:** J1's `completed` fact is lost, but all 3 of its OP10 cycles are known: its last ends at 07:40, which is its completion (ADR-0030). J1's window is 06:00–07:40 and J2 is head from 07:40 (`previous-last-cycle`), exactly as if the fact had arrived.
- **H10:** the `accepted` fact is lost and the command result is not known: `accepted-lost`, the window starts at `started` and is `lost`, never final.
- **H11:** J1's `completed` fact is lost and only 2 of its 3 cycles are known; J2 has not started: J1's window runs to the cut-off (`open`, `endLost`, `lost`), and J2 has no window.
- **H12:** a head time exactly at the cut-off: an empty, open window.
- **H13:** a `completed` fact exactly at the cut-off: the window is closed.
- **H14:** J1's `completed` fact and J2's `started` fact are lost in one gap. By attribution (ADR-0031) J2's first cycle (08:30) lands in J1's cycles, so J1 shows 2 cycles for a quantity of 2, one of them J2's. Its cycles are not trusted while J2's `started` is missing (the attribution boundary is open): J1 stays `endLost` and `lost`, open to the cut-off, never closed on J2's cycle; J2 has no window.
- **H15:** the same under plain reordering, nothing lost: J1's `completed` fact and J2's `started` fact have not arrived, and J2's first cycle (07:40) is counted in J1's three. J1's window is simply open, and J2 waits; nothing throws, and the arrival of the two facts settles both.
- **H16:** one written-off gap covers J1's last cycle, J1's `completed` fact and J2's `accepted` and `started` facts (and no command result is known). J2 is still in the queue: the queue holds every job dispatched to the CNC whose acceptance isn't refuted (the orders module's commands), not only the jobs whose facts arrived. J2's `started` is unknown, so J1's attribution boundary stays open and its 2 attributed cycles, `quantity` of them, are not trusted (one may be J2's): J1 stays `endLost` and `lost`, open to the cut-off. Built from the job facts alone, the queue would hold J1 only, and J1 would close at 07:15, possibly on a cycle of J2, with nothing flagged.
- **H17** (ADR-0036 amendment, #230): J2 is dispatched with `notBefore` 09:00. J1 completes at 07:40, but J2 waits for demand, not for the machine, until 09:00: max(06:05, 07:40, 09:00) = 09:00 (`notBefore`). The CNC's Idle `NO-ORDER` 07:40–09:00 belongs to no job, and J2's window 09:00–11:00 holds its changeover 09:00–09:25. J3's `notBefore` 08:00 is earlier than J2's completion: max(06:10, 11:00, 08:00) = 11:00 (`previous-completed`), so a `notBefore` that doesn't bind changes nothing.
- The recovery from cycles (H9) needs the boundary closed: the next job's `started` fact known, or no later job on the CNC, and exactly `quantity` cycles attributed.

### Case O1 – one job

CNC-01 starts the job at once (no changeover) and runs 60 minutes for 14 VB-100.

- PBT = APT = 3 600 000. Ideal time = 14 × 240 000 = 3 360 000. Speed loss = 240 000.
- A = 1/1. P = 3 360 000 / 3 600 000 = 14/15 → 0.9333. Q = 1/1. OEE = 14/15 → 0.9333.

### Case O2 – a changeover before `started`

The job is head from 06:00 (its acceptance; the first job of the run changes over from `none`). The changeover 06:00–06:25 lies before its `started` fact and inside its window, so it counts against this order. Running 06:25–08:05 = 6 000 000; 24 cycles, one scrap.

- PBT = 1 500 000 + 6 000 000 = 7 500 000. APT = 6 000 000. Own loss = Setup = 1 500 000.
- Ideal time = 24 × 240 000 = 5 760 000. Speed loss = 240 000.
- A = 6 000 000 / 7 500 000 = 4/5 = 0.8000. P = 5 760 000 / 6 000 000 = 24/25 = 0.9600. Q = 23/24 = 0.95833… → 0.9583.
- OEE = (5 760 000 × 23) / (7 500 000 × 24) = 92/125 = 0.7360. Check: 4/5 × 24/25 × 23/24 = 92/125.

### Case O3 – two jobs on two CNCs

The order's two jobs run in parallel. On CNC-01 the previous job (another order) runs until 06:30, so J1 is head from max(06:00, 06:30) = 06:30; CNC-01's Running before 06:30 is the other order's. J1: Setup 1 500 000 and Running 4 800 000 in 06:30–08:15; J2 on CNC-02: Setup 1 500 000 and Running 4 800 000 in 06:00–07:45.

- PBT = 6 300 000 + 6 300 000 = 12 600 000. APT = 9 600 000. Own loss = 3 000 000.
- Ideal time = 28 × 330 000 = 9 240 000. Speed loss = 360 000. Good = 14 + 13 = 27, produced 28.
- A = 9 600 000 / 12 600 000 = 16/21 = 0.76190… → 0.7619. P = 9 240 000 / 9 600 000 = 77/80 = 0.9625. Q = 27/28 = 0.96428… → 0.9643.
- OEE = (9 240 000 × 27) / (12 600 000 × 28) = (11 × 27) / (15 × 28) = 297/420 = 99/140 = 0.70714… → 0.7071. Check: 16/21 × 77/80 × 27/28 = 33 264/47 040 = 99/140.

### Case O4 – across a shift boundary and a break

The job runs from shift A into shift B; the shift boundary at 14:00 splits nothing in the sum, and shift B's break (PlannedStop 18:00–18:30) is excluded as in every bucket. Running 13:25–18:00 and 18:30–19:05 = 16 500 000 + 2 100 000 = 18 600 000. Eight cycles complete in shift A (13:25–13:59 holds 34 minutes, eight cycles of 4 minutes), the other 67 in shift B, at the job's end for this case.

- PBT = 1 500 000 + 18 600 000 = 20 100 000 (PlannedStop 1 800 000 excluded). APT = 18 600 000. Own loss = 1 500 000.
- Ideal time = 75 × 240 000 = 18 000 000. Speed loss = 600 000.
- A = 18 600 000 / 20 100 000 = 62/67 = 0.92537… → 0.9254. P = 18 000 000 / 18 600 000 = 30/31 = 0.96774… → 0.9677. Q = 1/1.
- OEE = 18 000 000 / 20 100 000 = 60/67 = 0.89552… → 0.8955. Check: 62/67 × 30/31 = 1 860/2 077 = 60/67.

### Case O5 – a micro-stop and a breakdown

A 60-second jam (below the threshold: performance loss) and a 30-minute spindle breakdown (Down: availability loss). Running 35 + 29 + 60 minutes = 7 440 000.

- PBT = 10 800 000 (06:00–09:00). APT = 7 440 000 + 60 000 = 7 500 000. Own loss = Setup 1 500 000 + Down 1 800 000 = 3 300 000.
- Ideal time = 22 × 330 000 = 7 260 000. Speed loss = 7 500 000 − 60 000 − 7 260 000 = 180 000.
- A = 7 500 000 / 10 800 000 = 25/36 = 0.69444… → 0.6944. P = 7 260 000 / 7 500 000 = 121/125 = 0.9680. Q = 21/22 → 0.9545.
- OEE = (7 260 000 × 21) / (10 800 000 × 22) = (33 × 21) / 1 080 = 693/1 080 = 77/120 = 0.64166… → 0.6417.

### Case O6 – a short order

Ten blanks, one OP10 scrap: the order is short (case F1 follows its units). Running 06:25–07:05 = 2 400 000.

- PBT = 3 900 000. APT = 2 400 000. Own loss = 1 500 000. Ideal time = 10 × 240 000 = 2 400 000. Speed loss = 0.
- A = 2 400 000 / 3 900 000 = 8/13 = 0.61538… → 0.6154. P = 1/1. Q = 9/10 = 0.9000.
- OEE = 8/13 × 9/10 = 36/65 = 0.55384… → 0.5538.

### Case O7 – the `accepted` fact replaced by `acceptedAt`

O2 with its `accepted` fact lost: the command result's `acceptedAt` (06:00) is the plant time of that same fact, so the head time, the window and every value equal O2's, and nothing is provisional.

### Case O8 – the head time lost

O2 with its `accepted` fact lost and no command result: the window starts at `started` (06:25), so the changeover is left out and the order looks better than it is. Flagged `headTimeUnknown` and `lost`: provisional, never final (with the fact merely not received yet it would be provisional only until it arrives).

- PBT = APT = 6 000 000. Ideal time = 5 760 000. Speed loss = 240 000.
- A = 1/1. P = 24/25 = 0.9600. Q = 23/24 → 0.9583. OEE = 24/25 × 23/24 = 23/25 = 0.9200.

### Case O9 – an open window

At 07:25 the job is still running: its window runs to the cut-off and is provisional (`open`).

- PBT = 1 500 000 + 3 600 000 = 5 100 000. APT = 3 600 000. Own loss = 1 500 000. Ideal time = 14 × 240 000 = 3 360 000. Speed loss = 240 000.
- A = 3 600 000 / 5 100 000 = 12/17 = 0.70588… → 0.7059. P = 14/15 → 0.9333. Q = 1/1.
- OEE = 3 360 000 / 5 100 000 = 56/85 = 0.65882… → 0.6588. Check: 12/17 × 14/15 = 168/255 = 56/85.

### Case O10 – a lost `completed` capped at the next job's start

The job's `completed` fact is lost and its cycles are not all known, so its window ends at the next job's `started` fact, 08:05 (H6). The cap charges the next job's changeover (07:45–08:05) to this order; the value is flagged `endLost` and `lost`, provisional and never final.

- PBT = 7 500 000 (06:00–08:05). APT = Running 06:25–07:45 = 4 800 000. Own loss = Setup 1 500 000 + 1 200 000 = 2 700 000.
- Ideal time = 20 × 240 000 = 4 800 000. Speed loss = 0.
- A = 4 800 000 / 7 500 000 = 16/25 = 0.6400. P = 1/1. Q = 1/1. OEE = 16/25 = 0.6400.

### Case O11 – an order window that starts at `notBefore`

The job is the only one on CNC-01 and accepted at 06:00, but dispatched with `notBefore` 08:00 (ADR-0036 amendment, #230): its head time is max(06:00, 08:00) = 08:00 (`notBefore`), so its window is 08:00–09:45, and its in-progress time for the line starts at 08:00 too, not at 06:00. Until then the CNC is Idle `NO-ORDER` and the order waits for demand. At 08:00 the CNC changes over (08:00–08:25), then runs 08:25–09:45 = 4 800 000 for 19 VB-100, one scrap.

- PBT = 1 500 000 + 4 800 000 = 6 300 000. APT = 4 800 000. Own loss = Setup = 1 500 000.
- Ideal time = 19 × 240 000 = 4 560 000. Speed loss = 240 000.
- A = 4 800 000 / 6 300 000 = 16/21 = 0.76190… → 0.7619. P = 4 560 000 / 4 800 000 = 19/20 = 0.9500. Q = 18/19 = 0.94736… → 0.9474.
- OEE = (4 560 000 × 18) / (6 300 000 × 19) = 24/35 = 0.68571… → 0.6857. Check: 16/21 × 19/20 × 18/19 = 288/420 = 24/35.
- Under `scheduledTime: orders` the Idle `NO-ORDER` 06:00–08:00 would have been excluded from the order's PBT anyway, so the order OEE is the same as with the unamended head time; what changes is the window (no longer 06:00–09:45) and, through it, the line's planned busy time, which no longer counts 06:00–08:00 as an order in progress.

### Case F1 – first-pass yield of a short order

O6's order: 10 blanks; one OP10 scrap; 7 units straight through; one fails the leak test, is reworked and packs good on its second pass; one fails twice and is scrapped. Packed good = 8, first-pass good = 7 (the reworked unit packs, but not on its first pass).

- FPY = 7/10 = 0.7000. The order OEE's Q (9/10) sees only OP10; the leak test's scrap and rework show here.

### Case L1 – no order in progress

PO-1 completed at 12:40, and no other order is in progress in 13:00–14:00: line planned busy time 0, so line OEE is null, not 0 (the line's counterpart of Idle `NO-ORDER`).

### Case L2 – two overlapping orders

PO-1 is in progress until 08:30 and PO-2 from 08:15: the union covers the whole hour, so line PBT = 3 600 000 (the overlap counts once).

- Ideal time = 14 × 150 000 + 3 × 210 000 = 2 100 000 + 630 000 = 2 730 000.
- Line OEE = 2 730 000 / 3 600 000 = 91/120 = 0.75833… → 0.7583.

### Cases L3 and L4 – per-order line OEE is not additive

- **L3:** PO-1 over its in-progress time 06:00–08:30: PBT = 9 000 000, ideal time = 50 × 150 000 = 7 500 000, line OEE = 5/6 = 0.8333.
- **L4:** PO-2 over 08:15–12:00 minus the break: PBT = 225 − 30 = 195 minutes = 11 700 000; ideal time = 45 × 210 000 = 9 450 000; line OEE = 21/26 = 0.80769… → 0.8077.
- Their PBTs sum to 20 700 000, but the line was planned busy for 06:00–12:00 minus the break = 19 800 000: 08:15–08:30 belongs to both orders. Per-order line OEE is therefore not additive, and the shift's line OEE is never a sum of them.

### Case L5 – a rework that packs in a later bucket

PO-2's last unit was reworked and packs at 12:10, which is its completion, so PO-2 is in progress until 12:10; PO-3 is in progress from 12:30. Line PBT in 12:00–13:00 = 10 + 30 minutes = 2 400 000. The reworked unit counts where it is packed:

- Ideal time = 1 × 210 000. Line OEE = 210 000 / 2 400 000 = 7/80 = 0.0875.

### Case L6 – above 1 from a fast operator

Shift B's ASM-01 operator `op-b1` works at speed factor 0.95: a VB-100 assembly takes 142.5 s instead of 150 s, about 25.3 an hour, so with the line fed 25 are packed in an hour against the bottleneck's ideal 24.

- Ideal time = 25 × 150 000 = 3 750 000. Line OEE = 3 750 000 / 3 600 000 = 25/24 = 1.04166… → 1.0417, flagged `aboveOne`, not capped.

### Cases L7 and L8 – above 1 from buffer drain, and exactly 1

The 18:00–19:00 hour holds shift B's break, so line PBT = 1 800 000. After the break the buffers before OP40 and OP50 drain into the half hour:

- **L7:** 14 VB-100 packed: 2 100 000 / 1 800 000 = 7/6 = 1.16666… → 1.1667, `aboveOne`.
- **L8:** 12 packed: 1 800 000 / 1 800 000 = 1/1 = 1.0000, not above 1, no flag.

Capping L6 or L7 at 1 would make the hours of the shift sum to less ideal time than the shift itself holds.

### Case L9 – only one CNC working

Only CNC-01 has a job (PO-5, VB-200); CNC-02 is Idle `NO-ORDER`. One CNC makes about 3 600 000 / 330 000 = 10.9 parts an hour, so 10 are packed. The designed bottleneck stays ASM-01 (210 000 ms per VB-200):

- Ideal time = 10 × 210 000 = 2 100 000. Line OEE = 2 100 000 / 3 600 000 = 7/12 = 0.58333… → 0.5833.
- The CNC is the actual constraint, and that shows as the lower value. Taking the working CNC as the bottleneck (330 000 ms) would have given 3 300 000 / 3 600 000 = 0.9167 and changed what the numerator means from bucket to bucket.

### Case L10 – a schedule-mode shift with planned maintenance on the bottleneck

Shift A in schedule mode (`–`: no in-progress restriction), the break 10:00–10:30 and a planned maintenance of ASM-01 12:00–12:15:

- Line PBT = 480 − 30 − 15 = 435 minutes = 26 100 000. Ideal time = 160 × 150 000 = 24 000 000.
- Line OEE = 24 000 000 / 26 100 000 = 80/87 = 0.91954… → 0.9195.

### Case L11 – outside the schedule

22:00–23:00 lies outside the scheduled shift A, although PO-6 is in progress over it: line PBT = 0 and line OEE is null. Only scheduled time is planned.

### Case L12 – a schedule-mode bucket reaching past the schedule

13:00–15:00 in schedule mode against shift A 06:00–14:00: only 13:00–14:00 is scheduled, so line PBT = 3 600 000, not 7 200 000.

- Ideal time = 20 × 150 000 = 3 000 000. Line OEE = 3 000 000 / 3 600 000 = 5/6 = 0.8333.

### Case L13 – a per-order value across unscheduled time

PO-7 is in progress 12:00–15:00, but only 12:00–14:00 is scheduled: its per-order line PBT is 7 200 000.

- Ideal time = 30 × 210 000 = 6 300 000. Line OEE = 6 300 000 / 7 200 000 = 7/8 = 0.8750.
