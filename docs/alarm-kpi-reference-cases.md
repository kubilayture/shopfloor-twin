# Alarm KPI reference cases

Hand-calculated alarm KPI cases for `alarm-core` (Phase 6 plan, ADR-0024). The tables below drive the unit tests in `packages/alarm-core/src/reference-cases.test.ts`: the test parses this file, computes every case with `alarm-core` and compares counts, exact fractions, four-decimal values, flood episodes, bad actors and revised hours. So the documentation and the tests can't disagree. The expected values were worked out by hand (notes after the tables) and recomputed independently by a brute-force Python script written from the definitions, which counts the raises in the window at every instant; they were not produced by the code under test.

## Definitions used

- **Thresholds**, as in `config/plant/alarms.yaml`: **floodThreshold 10, windowMs 600 000, chatterCount 3, chatterWindowMs 60 000, fleetingMs 1 000, standingMs 86 400 000.**
- **What counts is a raise.** Every device `active` transition is one occurrence; a raise belongs to the bucket that contains its `raisedAt`. Buckets are half-open, [from, to), on whole UTC hours.
- **Raise order:** time, then `seq`, then equipment and code. Several raises in one millisecond all count, in that order.
- **Window convention** (floods and chattering alike): the window ending at t is (t − window, t]. A raise exactly one window earlier has left it.
- **Rate per 10 min** = raises × 600 000 / bucket length, an exact fraction of the whole bucket (an hour has 6 windows, a shift of 8 h 48).
- **Fixed windows** are 10 minutes aligned on the hour. `Peak 10` is the most raises in one; a flood window has more than 10 (11 is a flood, 10 is not).
- **Flood episodes** (sliding): a flood starts at the raise that makes the count in (t − 600 000, t] exceed 10, and ends at the first instant where the count is back at 10 or below, which is when the oldest counted raise leaves the window. At one instant the raises that leave go first, then the raises of that instant arrive in order; the flood state at an instant is the count after all of them, so an episode whose last counted raise leaves exactly when another arrives goes on. An episode is identified by its start and starting raise (`equipment#seq`).
- **Per bucket**, every episode that overlaps it is listed with its flood time clipped to the bucket, its peak from its start to the bucket's end, and `open` when it is still in flood at the bucket's end. The final attributes (end, peak, raises from the starting raise) appear in the bucket where it ends; an episode that ends exactly on a boundary ends in the earlier bucket.
- **Chattering:** a raise is chattering when its point raised at least 3 times in (t − 60 000, t], itself included.
- **Fleeting:** an occurrence whose device clear comes less than 1 000 ms after its raise, in the bucket of its raise. An open occurrence that could still clear in time is `undecided`, and its bucket is provisional.
- **Standing:** active at the bucket's end and raised at least 86 400 000 ms before it. **Active at end** counts every occurrence active then.
- **Active ms:** each occurrence's active time clipped to the bucket; an open one counts up to `as of`.
- **Lost transitions:** an occurrence still open at its point's next raise ends there (superseded); in a closed epoch, what is open ends at the close (epoch ended), and so does a flood episode.
- **Horizon:** every fact at or before `as of` is known. A bucket that is not over at `as of` is measured to `as of` and is provisional; a closed epoch is known to its close.
- **Bad actors:** points with raises in the range, ranked by raises descending, then active ms descending, then equipment and code ascending; the top 10, with their share of the scope's raises.
- **Revised hours** of a late fact (ADR-0024): every UTC hour with an instant in one of its spans, up to `as of`. A late raise at t: [t, t + max(600 000, 60 000)]; its active span; the span of an earlier occurrence of its point that it now supersedes; and every flood episode in flood during [t, t + 600 000], to its end. A moved end (a late clear, a snapshot closing a lost clear, or a real clear replacing it): from the raise to the later of the two ends, where an open end is `as of`. The occurrences of such a case are the state after the fact.

Notation: times are UTC in the week of Monday 2026-10-12 (`Mon 10:00:00.000`), durations in ms with spaces between thousands. A point is `equipment/code`. `Repeat n × step` stands for n raises `step` ms apart, with `seq` rising by one; `Cleared` is the time from each raise to its clear, `–` while open. Every case is one scope (a position or the plant): only its own occurrences are listed.

## Occurrences

| Case | Point                   | Priority | Seq | Raised           | Repeat (n × step ms) | Cleared (after raise, ms) |
| ---- | ----------------------- | -------- | --- | ---------------- | -------------------- | ------------------------- |
| 1    | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 10:00:00.000 | 10 × 60 000          | +5 000                    |
| 2    | cnc-02/SPINDLE-OVERLOAD | high     | 1   | Mon 10:00:00.000 | 11 × 54 000          | +2 000                    |
| 3    | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 10:05:00.000 | 4 × 120 000          | +3 000                    |
| 3    | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:06:00.000 | 4 × 120 000          | +3 000                    |
| 3    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:09:30.000 | 3 × 150 000          | +3 000                    |
| 4    | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 10:54:00.000 | 3 × 150 000          | +10 000                   |
| 4    | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:54:30.000 | 3 × 150 000          | +10 000                   |
| 4    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:55:00.000 | 3 × 150 000          | +10 000                   |
| 4    | cnc-01/SPINDLE-OVERLOAD | high     | 101 | Mon 10:55:30.000 | 3 × 150 000          | +10 000                   |
| 4    | cnc-02/SPINDLE-OVERLOAD | high     | 101 | Mon 10:56:00.000 | 2 × 150 000          | +10 000                   |
| 5    | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 10:54:00.000 | 3 × 150 000          | +10 000                   |
| 5    | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:54:30.000 | 3 × 150 000          | +10 000                   |
| 5    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:55:00.000 | 3 × 150 000          | +10 000                   |
| 5    | cnc-01/SPINDLE-OVERLOAD | high     | 101 | Mon 10:55:30.000 | 3 × 150 000          | +10 000                   |
| 5    | cnc-02/SPINDLE-OVERLOAD | high     | 101 | Mon 10:56:00.000 | 2 × 150 000          | +10 000                   |
| 6    | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:11:00.000 | 9 × 60 000           | +1 000                    |
| 6    | cnc-01/COOLANT-PRESSURE | medium   | 7   | Mon 10:20:00.000 | –                    | –                         |
| 6    | cnc-01/COOLANT-PRESSURE | medium   | 8   | Mon 10:20:00.000 | –                    | –                         |
| 6    | cnc-01/COOLANT-PRESSURE | medium   | 9   | Mon 10:20:00.000 | –                    | +5 000                    |
| 7    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:30:00.000 | –                    | +2 000                    |
| 7    | wsh-01/HEATER-FAULT     | high     | 2   | Mon 10:30:30.000 | –                    | +2 000                    |
| 7    | wsh-01/HEATER-FAULT     | high     | 3   | Mon 10:30:59.999 | –                    | +2 000                    |
| 8    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:30:00.000 | –                    | +2 000                    |
| 8    | wsh-01/HEATER-FAULT     | high     | 2   | Mon 10:30:30.000 | –                    | +2 000                    |
| 8    | wsh-01/HEATER-FAULT     | high     | 3   | Mon 10:31:00.000 | –                    | +2 000                    |
| 9    | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:30:00.000 | –                    | +2 000                    |
| 9    | wsh-01/HEATER-FAULT     | high     | 2   | Mon 10:30:30.000 | –                    | +2 000                    |
| 9    | wsh-01/HEATER-FAULT     | high     | 3   | Mon 10:31:00.001 | –                    | +2 000                    |
| 10   | lkt-01/FIXTURE-SEAL     | medium   | 1   | Mon 10:40:00.000 | –                    | +999                      |
| 10   | pck-01/PRINTER-FAULT    | medium   | 1   | Mon 10:41:00.000 | –                    | +1 000                    |
| 10   | asm-01/PRESS-FAULT      | medium   | 1   | Mon 10:59:59.500 | –                    | –                         |
| 11   | pck-01/PRINTER-FAULT    | medium   | 1   | Mon 11:00:00.000 | –                    | –                         |
| 11   | lkt-01/CALIBRATION-DUE  | low      | 1   | Mon 11:00:00.001 | –                    | –                         |
| 11   | asm-01/PRESS-FAULT      | medium   | 1   | Mon 10:59:59.999 | –                    | –                         |
| 12   | cnc-01/SPINDLE-OVERLOAD | high     | 1   | Mon 10:30:00.000 | –                    | –                         |
| 13   | pck-01/PRINTER-FAULT    | medium   | 1   | Sat 10:15:00.000 | –                    | +60 000                   |
| 13   | pck-01/PRINTER-FAULT    | medium   | 2   | Sat 11:15:00.000 | –                    | +60 000                   |
| 13   | pck-01/PRINTER-FAULT    | medium   | 3   | Sat 11:45:00.000 | –                    | +60 000                   |
| 14   | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 10:00:00.000 | 3 × 20 000           | +10 000                   |
| 14   | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:10:00.000 | 3 × 300 000          | +20 000                   |
| 14   | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:20:00.000 | 3 × 300 000          | +20 000                   |
| 14   | lkt-01/FIXTURE-SEAL     | medium   | 1   | Mon 11:30:00.000 | –                    | +600 000                  |
| 15   | cnc-02/COOLANT-PRESSURE | medium   | 1   | Mon 10:10:00.000 | –                    | –                         |
| 15   | cnc-02/COOLANT-PRESSURE | medium   | 2   | Mon 10:40:00.000 | –                    | +600 000                  |
| 16   | pck-01/PRINTER-FAULT    | medium   | 1   | Mon 10:30:00.000 | –                    | –                         |
| 16   | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:40:00.000 | 11 × 20 000          | +5 000                    |
| 17   | cnc-01/SPINDLE-OVERLOAD | high     | 1   | Mon 10:30:00.000 | –                    | +1 200 000                |
| 18   | wsh-01/HEATER-FAULT     | high     | 1   | Mon 10:55:00.000 | –                    | +30 000                   |
| 19   | cnc-02/SPINDLE-OVERLOAD | high     | 1   | Mon 10:40:00.000 | –                    | +6 000 000                |
| 20   | cnc-01/COOLANT-PRESSURE | medium   | 1   | Mon 11:00:00.000 | 151 × 60 000         | +1 000                    |
| 20   | pck-01/PRINTER-FAULT    | medium   | 1   | Mon 11:55:30.000 | –                    | +1 000                    |
| 20   | pck-01/PRINTER-FAULT    | medium   | 2   | Mon 12:15:30.000 | 5 × 600 000          | +1 000                    |
| 20   | wsh-01/HEATER-FAULT     | high     | 1   | Mon 12:05:30.000 | –                    | +1 000                    |

## Horizons

| Case | As of            | Closed           |
| ---- | ---------------- | ---------------- |
| 1    | Mon 12:00:00.000 | –                |
| 2    | Mon 12:00:00.000 | –                |
| 3    | Mon 12:00:00.000 | –                |
| 4    | Mon 19:00:00.000 | –                |
| 5    | Mon 11:03:00.000 | –                |
| 6    | Mon 12:00:00.000 | –                |
| 7    | Mon 12:00:00.000 | –                |
| 8    | Mon 12:00:00.000 | –                |
| 9    | Mon 12:00:00.000 | –                |
| 10   | Mon 11:00:00.000 | –                |
| 11   | Tue 12:00:00.000 | –                |
| 12   | Mon 11:20:00.000 | –                |
| 13   | Sun 00:00:00.000 | –                |
| 14   | Mon 12:00:00.000 | –                |
| 15   | Mon 12:00:00.000 | –                |
| 16   | Mon 10:50:00.000 | Mon 10:45:00.000 |
| 17   | Mon 13:30:00.000 | –                |
| 18   | Mon 13:00:00.000 | –                |
| 19   | Mon 13:30:00.000 | –                |
| 20   | Mon 14:00:00.000 | –                |

## Expected buckets

| Case | Bucket          | Raises (H/M/L) | Rate per 10 min | Rate (4 dp) | Peak 10 | Flood windows | Floods (flood ms)                                                                           | Active at end | Standing                                     | Chattering                  | Fleeting        | Active ms  | Flags       |
| ---- | --------------- | -------------- | --------------- | ----------- | ------- | ------------- | ------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------- | --------------------------- | --------------- | ---------- | ----------- |
| 1    | Mon 10:00–11:00 | 10 (0/10/0)    | 5/3             | 1.6667      | 10      | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 50 000     | –           |
| 2    | Mon 10:00–11:00 | 11 (11/0/0)    | 11/6            | 1.8333      | 11      | 1 of 6        | Mon 10:09:00.000 cnc-02#11: 60 000 ms, peak 11, ended Mon 10:10:00.000 (peak 11, raises 1)  | 0             | –                                            | 0                           | 0               | 22 000     | –           |
| 3    | Mon 10:00–11:00 | 11 (3/8/0)     | 11/6            | 1.8333      | 6       | 0 of 6        | Mon 10:14:30.000 wsh-01#3: 30 000 ms, peak 11, ended Mon 10:15:00.000 (peak 11, raises 1)   | 0             | –                                            | 0                           | 0               | 33 000     | –           |
| 4    | Mon 10:00–11:00 | 12 (6/6/0)     | 2/1             | 2.0000      | 12      | 1 of 6        | Mon 10:59:00.000 cnc-01#3: 60 000 ms, peak 12, open                                         | 0             | –                                            | 0                           | 0               | 120 000    | –           |
| 4    | Mon 11:00–12:00 | 2 (2/0/0)      | 1/3             | 0.3333      | 2       | 0 of 6        | Mon 10:59:00.000 cnc-01#3: 330 000 ms, peak 14, ended Mon 11:05:30.000 (peak 14, raises 4)  | 0             | –                                            | 0                           | 0               | 20 000     | –           |
| 4    | Mon 03:00–11:00 | 12 (6/6/0)     | 1/4             | 0.2500      | 12      | 1 of 48       | Mon 10:59:00.000 cnc-01#3: 60 000 ms, peak 12, open                                         | 0             | –                                            | 0                           | 0               | 120 000    | –           |
| 4    | Mon 11:00–19:00 | 2 (2/0/0)      | 1/24            | 0.0417      | 2       | 0 of 48       | Mon 10:59:00.000 cnc-01#3: 330 000 ms, peak 14, ended Mon 11:05:30.000 (peak 14, raises 4)  | 0             | –                                            | 0                           | 0               | 20 000     | –           |
| 5    | Mon 10:00–11:00 | 12 (6/6/0)     | 2/1             | 2.0000      | 12      | 1 of 6        | Mon 10:59:00.000 cnc-01#3: 60 000 ms, peak 12, open                                         | 0             | –                                            | 0                           | 0               | 120 000    | –           |
| 5    | Mon 11:00–12:00 | 2 (2/0/0)      | 1/3             | 0.3333      | 2       | 0 of 6        | Mon 10:59:00.000 cnc-01#3: 180 000 ms, peak 14, open                                        | 0             | –                                            | 0                           | 0               | 20 000     | provisional |
| 6    | Mon 10:00–11:00 | 12 (0/12/0)    | 2/1             | 2.0000      | 9       | 0 of 6        | Mon 10:20:00.000 cnc-01#8: 120 000 ms, peak 12, ended Mon 10:22:00.000 (peak 12, raises 2)  | 0             | –                                            | 1 (cnc-01/COOLANT-PRESSURE) | 0               | 14 000     | –           |
| 7    | Mon 10:00–11:00 | 3 (3/0/0)      | 1/2             | 0.5000      | 3       | 0 of 6        | –                                                                                           | 0             | –                                            | 1 (wsh-01/HEATER-FAULT)     | 0               | 6 000      | –           |
| 8    | Mon 10:00–11:00 | 3 (3/0/0)      | 1/2             | 0.5000      | 3       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 6 000      | –           |
| 9    | Mon 10:00–11:00 | 3 (3/0/0)      | 1/2             | 0.5000      | 3       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 6 000      | –           |
| 10   | Mon 10:00–11:00 | 3 (0/3/0)      | 1/2             | 0.5000      | 2       | 0 of 6        | –                                                                                           | 1             | –                                            | 0                           | 1 (1 undecided) | 2 499      | provisional |
| 11   | Mon 10:00–11:00 | 1 (0/1/0)      | 1/6             | 0.1667      | 1       | 0 of 6        | –                                                                                           | 1             | –                                            | 0                           | 0               | 1          | –           |
| 11   | Tue 10:00–11:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 3             | asm-01/PRESS-FAULT#1; pck-01/PRINTER-FAULT#1 | 0                           | 0               | 10 800 000 | –           |
| 12   | Mon 10:00–11:00 | 1 (1/0/0)      | 1/6             | 0.1667      | 1       | 0 of 6        | –                                                                                           | 1             | –                                            | 0                           | 0               | 1 800 000  | –           |
| 12   | Mon 11:00–12:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 1             | –                                            | 0                           | 0               | 1 200 000  | provisional |
| 13   | Sat 10:00–12:00 | 3 (0/3/0)      | 1/4             | 0.2500      | 1       | 0 of 12       | –                                                                                           | 0             | –                                            | 0                           | 0               | 180 000    | –           |
| 14   | Mon 10:00–12:00 | 10 (3/7/0)     | 5/6             | 0.8333      | 3       | 0 of 12       | –                                                                                           | 0             | –                                            | 1 (cnc-01/COOLANT-PRESSURE) | 0               | 750 000    | –           |
| 15   | Mon 10:00–11:00 | 2 (0/2/0)      | 1/3             | 0.3333      | 1       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 2 400 000  | –           |
| 16   | Mon 10:00–11:00 | 12 (11/1/0)    | 2/1             | 2.0000      | 11      | 1 of 6        | Mon 10:43:20.000 wsh-01#11: 100 000 ms, peak 11, ended Mon 10:45:00.000 (peak 11, raises 1) | 0             | –                                            | 9 (wsh-01/HEATER-FAULT)     | 0               | 955 000    | –           |
| 16   | Mon 11:00–12:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 0          | –           |
| 17   | Mon 10:00–11:00 | 1 (1/0/0)      | 1/6             | 0.1667      | 1       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 1 200 000  | –           |
| 17   | Mon 12:00–13:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 0          | –           |
| 18   | Mon 10:00–11:00 | 1 (1/0/0)      | 1/6             | 0.1667      | 1       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 30 000     | –           |
| 19   | Mon 12:00–13:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 1 200 000  | –           |
| 19   | Mon 13:00–14:00 | 0 (0/0/0)      | 0/1             | 0.0000      | 0       | 0 of 6        | –                                                                                           | 0             | –                                            | 0                           | 0               | 0          | provisional |
| 20   | Mon 12:00–13:00 | 66 (1/65/0)    | 11/1            | 11.0000     | 11      | 6 of 6        | Mon 11:55:30.000 pck-01#1: 3 600 000 ms, peak 11, open                                      | 0             | –                                            | 0                           | 0               | 66 000     | –           |
| 20   | Mon 13:00–14:00 | 31 (0/31/0)    | 31/6            | 5.1667      | 10      | 0 of 6        | Mon 11:55:30.000 pck-01#1: 330 000 ms, peak 11, ended Mon 13:05:30.000 (peak 11, raises 77) | 0             | –                                            | 0                           | 0               | 31 000     | –           |

## Expected flood episodes

| Case | Start            | Starting raise | End              | Peak | Raises |
| ---- | ---------------- | -------------- | ---------------- | ---- | ------ |
| 2    | Mon 10:09:00.000 | cnc-02#11      | Mon 10:10:00.000 | 11   | 1      |
| 3    | Mon 10:14:30.000 | wsh-01#3       | Mon 10:15:00.000 | 11   | 1      |
| 4    | Mon 10:59:00.000 | cnc-01#3       | Mon 11:05:30.000 | 14   | 4      |
| 5    | Mon 10:59:00.000 | cnc-01#3       | – (open)         | 14   | 4      |
| 6    | Mon 10:20:00.000 | cnc-01#8       | Mon 10:22:00.000 | 12   | 2      |
| 16   | Mon 10:43:20.000 | wsh-01#11      | Mon 10:45:00.000 | 11   | 1      |
| 20   | Mon 11:55:30.000 | pck-01#1       | Mon 13:05:30.000 | 11   | 77     |

## Expected bad actors

| Case | Range           | Rank | Point                   | Raises | Share | Share (4 dp) | Active ms | Chattering |
| ---- | --------------- | ---- | ----------------------- | ------ | ----- | ------------ | --------- | ---------- |
| 14   | Mon 10:00–12:00 | 1    | cnc-02/COOLANT-PRESSURE | 3      | 3/10  | 0.3000       | 60 000    | 0          |
| 14   | Mon 10:00–12:00 | 2    | wsh-01/HEATER-FAULT     | 3      | 3/10  | 0.3000       | 60 000    | 0          |
| 14   | Mon 10:00–12:00 | 3    | cnc-01/COOLANT-PRESSURE | 3      | 3/10  | 0.3000       | 30 000    | 1          |
| 14   | Mon 10:00–12:00 | 4    | lkt-01/FIXTURE-SEAL     | 1      | 1/10  | 0.1000       | 600 000   | 0          |

## Expected revisions

| Case | Late fact                                                             | Revised hours                              |
| ---- | --------------------------------------------------------------------- | ------------------------------------------ |
| 17   | end raised Mon 10:30:00.000 from – to Mon 12:15:00.000                | Mon 10:00; Mon 11:00; Mon 12:00; Mon 13:00 |
| 17   | end raised Mon 10:30:00.000 from Mon 12:15:00.000 to Mon 10:50:00.000 | Mon 10:00; Mon 11:00; Mon 12:00            |
| 18   | raise wsh-01/HEATER-FAULT Mon 10:55:00.000 cleared +30 000            | Mon 10:00; Mon 11:00                       |
| 19   | end raised Mon 10:40:00.000 from – to Mon 12:20:00.000                | Mon 10:00; Mon 11:00; Mon 12:00; Mon 13:00 |
| 20   | raise wsh-01/HEATER-FAULT Mon 12:05:30.000 cleared +1 000             | Mon 11:00; Mon 12:00; Mon 13:00            |

## Worked cases

1. **10 raises in a window.** Raises at 10:00 … 10:09, one a minute: the window 10:00–10:10 holds 10, which is not more than 10, so no flood window and no episode. The sliding count never exceeds 10 either. Rate 10 × 600 000 / 3 600 000 = 5/3. Active 10 × 5 000 = 50 000 ms. Chattering: one raise per minute, and the raise exactly 60 000 ms earlier has left the window.
2. **11 raises in a window.** Raises 54 000 ms apart from 10:00:00 to 10:09:00 (the 11th at 10 × 54 000 = 540 000 ms). The window 10:00–10:10 holds 11: one flood window. The 11th raise sees all 11 in (09:59:00, 10:09:00], so a flood starts at 10:09:00 with raise `cnc-02#11`; the first raise leaves at 10:10:00 and the count drops to 10: the episode ends there, 60 000 ms, peak 11, 1 raise. Rate 11/6. Chattering: 54 000 ms apart, a point has at most 2 raises in 60 000 ms.
3. **A sliding flood across two windows, with no flood window.** 6 raises in 10:00–10:10 (10:05, 10:06, 10:07, 10:08, 10:09, 10:09:30) and 5 in 10:10–10:20 (10:10, 10:11, 10:12, 10:12, 10:14:30): no fixed window exceeds 10 (peak 6). At 10:14:30 the window (10:04:30, 10:14:30] holds all 11: a flood starts with `wsh-01#3`, and ends at 10:15:00 when 10:05 leaves: 30 000 ms.
4. **A flood across an hour and a shift boundary.** 14 raises every 30 s from 10:54:00 to 11:00:30; shift A ends at 11:00 UTC (14:00 Istanbul). The 11th raise, 10:59:00 (`cnc-01#3`), makes 11: the flood starts. The count reaches 12 at 10:59:30, 13 at 11:00:00 and 14 at 11:00:30. Raises leave from 11:04:00 (10:54:00 + 10 min): 13 at 11:04:00, 12 at 11:04:30, 11 at 11:05:00, 10 at 11:05:30: the end. Hour 10 and shift A: 60 000 ms, peak so far 12, open. Hour 11 and shift B: 330 000 ms, peak 14, ended 11:05:30 with peak 14 and 4 raises (10:59:00 to 11:00:30). Shift A's rate is 12 × 600 000 / 28 800 000 = 1/4, and its 48 windows have one flood window (10:50–11:00 with 12).
5. **A flood open at an hour's end, before it ends.** Case 4 at 11:03:00: hour 10 is the same and final; hour 11 holds 11:00:00–11:03:00 = 180 000 ms, peak 14, still open, provisional. The episode has no end yet.
6. **Three raises in the same millisecond.** 9 raises of `cnc-02/COOLANT-PRESSURE` from 10:11 to 10:19, then `cnc-01#7`, `#8` and `#9` at 10:20:00.000. In order, they see 10, 11 and 12 in (10:10:00, 10:20:00]: the flood starts at `cnc-01#8`, the second of the three. 10:11 leaves at 10:21 (11), 10:12 at 10:22 (10): the end, 120 000 ms, peak 12, raises 2. The windows hold 9 (10:10–10:20) and 3 (10:20–10:30): no flood window. Chattering: `#9` sees three raises of its point, `#7` one and `#8` two. `#7` and `#8` are superseded at 10:20:00.000 (0 ms active): active 9 × 1 000 + 5 000 = 14 000 ms.
7. **Chattering at 59 999 ms.** Raises at 10:30:00.000, 10:30:30.000 and 10:30:59.999: the third sees (10:29:59.999, 10:30:59.999], all three: chattering.
8. **Chattering at 60 000 ms.** The third raise at 10:31:00.000 sees (10:30:00.000, 10:31:00.000]: the first has left. 2 raises: not chattering.
9. **Chattering at 60 001 ms.** As case 8, one millisecond later: not chattering.
10. **Fleeting at 999 and 1 000 ms, and undecided.** `FIXTURE-SEAL` clears after 999 ms: fleeting. `PRINTER-FAULT` after 1 000 ms: not. `PRESS-FAULT`, raised at 10:59:59.500, is open at 11:00:00.000 after 500 ms: a clear before 11:00:00.500 (raise + 1 000 ms) could still make it fleeting, so it is undecided and the hour is provisional although it is over. Active 999 + 1 000 + 500 = 2 499 ms; `PRESS-FAULT` is active at the end.
11. **Standing at 24 h ± 1 ms.** At Tue 11:00:00.000 (the end of Tue 10:00–11:00): `PRESS-FAULT` raised 24 h + 1 ms earlier and `PRINTER-FAULT` exactly 24 h earlier are standing; `CALIBRATION-DUE`, 24 h − 1 ms, is not. All three are active: 3 × 3 600 000 ms. Mon 10:00–11:00 holds only the raise at 10:59:59.999, active 1 ms; a raise exactly at 11:00:00.000 belongs to the later hour.
12. **An alarm open at a bucket's end.** Raised 10:30, open. Hour 10: active 1 800 000 ms and active at the end; final. Hour 11 at 11:20: active 1 200 000 ms up to `as of`, provisional.
13. **A no-shift bucket.** Saturday 10:00–12:00 has no shift: 3 raises over 7 200 000 ms is 3 × 600 000 / 7 200 000 = 1/4 per 10 minutes, over 12 windows.
14. **Bad actors with a tie on raises.** Three points with 3 raises each: `cnc-02/COOLANT-PRESSURE` and `wsh-01/HEATER-FAULT` both 60 000 ms active (3 × 20 000), so equipment decides (`cnc-02` before `wsh-01`); `cnc-01/COOLANT-PRESSURE` 30 000 ms comes third, with one chattering raise (10:00:00, 10:00:20, 10:00:40). `lkt-01/FIXTURE-SEAL` has the most active time (600 000 ms) but one raise: fourth. Shares out of 10 raises.
15. **A superseded occurrence.** `cnc-02/COOLANT-PRESSURE` raised at 10:10 never clears (lost) and raises again at 10:40: the first ends at 10:40 (1 800 000 ms), the second clears at 10:50 (600 000 ms): 2 400 000 ms, nothing active at the end.
16. **An epoch end.** The epoch closes at 10:45:00 (`as of` 10:50). 11 raises of `HEATER-FAULT` every 20 s from 10:40:00: the 11th, 10:43:20, makes 11 in (10:33:20, 10:43:20] (`PRINTER-FAULT` at 10:30 is outside): a flood, ended by the close at 10:45:00: 100 000 ms, peak 11, raises 1. `PRINTER-FAULT` ends at the close: 900 000 ms; with 11 × 5 000 the hour has 955 000 ms. 9 raises chatter (the third to the eleventh each see 3 in 60 000 ms). Both hours are final, and nothing is active after the close.
17. **A lost clear closed by a resync snapshot, then the real clear.** `SPINDLE-OVERLOAD` raised at 10:30. A snapshot at 12:15 shows it inactive while it was open (as of 13:30): its end moves from open (13:30) to 12:15, so hours 10 to 13 change (hour 13 showed it active). The real clear, 10:50, then arrives: the end moves from 12:15 to 10:50, and hours 10, 11 and 12 change (the plan's "hours between the two ends" with the raise's hour). After both: active 1 200 000 ms in hour 10, nothing in hour 12.
18. **A late raise whose window spans an hour boundary.** `HEATER-FAULT` at 10:55:00 arrives late, cleared after 30 s: [10:55:00, 11:05:00] reaches hour 11 (the windows, floods and chattering of raises up to 11:05:00 can change). Hours 10 and 11.
19. **A late clear spanning three hours.** `SPINDLE-OVERLOAD` raised 10:40, open while its clear (12:20) was missing; it arrives at `as of` 13:30. Hours 10, 11 and 12 (raise to clear: active time, active at end and standing, and the clear's hour), and also 13, which showed it active.
20. **A late raise that joins two flood episodes.** A steady raise every minute from 11:00 keeps the count at exactly 10. `PRINTER-FAULT` at 11:55:30 makes 11 until it leaves at 12:05:30; then five `PRINTER-FAULT` raises from 12:15:30, 10 minutes apart, keep the count at 11 from 12:15:30 to 13:05:30. Without the late raise there are two episodes, the second starting at 12:15:30 (`pck-01#2`). `HEATER-FAULT` at 12:05:30 arrives late: at 12:05:30 the first `PRINTER-FAULT` leaves and it arrives, and at 12:15:30 it leaves and `pck-01#2` arrives, so the count never drops to 10: one episode, 11:55:30 to 13:05:30, 77 raises. Hour 13 now lists that episode instead of the second one, although it lies beyond [12:05:30, 12:15:30]; the episode's span gives hours 11, 12 and 13. Hour 12 is in flood throughout (3 600 000 ms, 11 raises in every window).
