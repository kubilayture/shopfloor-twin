# Phase 9 performance results (P9-18, #245)

`pnpm test:perf` (`e2e/src/perf.ts`, ADR-0040): targets T1–T6 of the Phase 9 plan ("Performance"), each in its run, on the hardened stack (OPC UA SignAndEncrypt, HTTPS front, MQTT dynamic security) with Prometheus only. The suite writes `e2e/results/perf/results.json` (raw figures per run) and `results.md`; this file keeps the two runs that matter.

## Environment (both runs)

| Item          | Value                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker VM     | Colima `default`, aarch64, 4 CPUs, 4 GiB configured (3.81 GiB visible to Docker), 100 GiB disk; Ubuntu 24.04.4, kernel 6.8.0-117, Docker 29.5.2                  |
| Host          | Apple M3, 8 CPUs, 16 GiB; Node v26.11.1                                                                                                                          |
| Host load     | Q3: 2.05 / 2.21 / 2.38 at the start, 2.88 / 2.48 / 2.43 at the end; final: 2.68 / 2.55 / 2.51 and 2.65 / 2.39 / 2.37 (1, 5, 15 min)                              |
| Free disk     | Q3: host 41.0 GiB, Docker 81.6 GiB; final: host 33.2 GiB, Docker 78.5 GiB                                                                                        |
| Image digests | Q3 (`6b1818c`): mes-server `7b2beb0c…`, edge-gateway `1f582021…`, simulator `f75d91ff…`, erp-mock `734faa03…`, web `8c12e80a…`; Prometheus `v3.15.0` `efd719c9…` |
|               | Final (`9d7aea0`): in `e2e/results/perf/results.json` of that run; the images were removed after it                                                              |

## Probe Q3: the baseline on `main`

Commit `6b1818c`: the suite on top of `main` `d537d60`, whose MES has no lag histogram and no pending gauge, so those three rows could not be measured. T1's buffer row was then judged literally ("0 at every sample"); see ADR-0040 "Gateway buffer" for why that was changed before the final run.

| Target | Run | What                                       | Target                   | Measured                                            | Result        |
| ------ | --- | ------------------------------------------ | ------------------------ | --------------------------------------------------- | ------------- |
| T1     | P1  | ingest lag p95 / p99 / max                 | ≤ 250 ms / ≤ 1 s / ≤ 5 s | no `mes_ingest_lag_seconds` on `main`               | not measured  |
| T1     | P1  | pending messages at every hour boundary    | ≤ 100                    | no `mes_ingest_pending_messages` on `main`          | not measured  |
| T1     | P1  | gateway buffer over the window (literal)   | 0 at every sample        | max 7 over 479 samples (live traffic in the outbox) | miss (method) |
| T3     | P1  | overview state push p95                    | ≤ 1 s                    | 226 ms (p50 83, max 278; 595 judged, 0 missed)      | pass          |
| T3     | P1  | OEE dashboard push p95                     | ≤ 2 s                    | 1,014 ms (p50 497, max 1,188; 416 judged, 0 missed) | pass          |
| T3     | P1  | SPC page push p95                          | ≤ 2 s                    | 229 ms (p50 182, max 237; 83 judged, 0 missed)      | pass          |
| T3     | P1  | terminal push p95                          | ≤ 2 s                    | 615 ms (p50 313, max 790; 388 judged, 0 missed)     | pass          |
| T4     | P1  | reads p95 (20 users)                       | ≤ 200 ms                 | 16.1 ms over 3,190 reads                            | pass          |
| T4     | P1  | backward traces p95                        | ≤ 100 ms                 | 7.3 ms over 750 traces                              | pass          |
| T4     | P1  | no 5xx, no socket closed by the server     | 0 and 0                  | 0 and 0                                             | pass          |
| T5     | P1  | MES CPU averaged over the shift            | ≤ 0.5 core               | 0.145 core                                          | pass          |
| T5     | P1  | MES CFS throttled share                    | ≤ 5 %                    | 0.36 % of 4,772 periods                             | pass          |
| T5     | P1  | peak memory of every container             | < 80 % of its limit      | highest the ERP mock, 54.0 % (69 of 128 MiB)        | pass          |
| T5     | P1  | no OOM kill, RestartCount 0                | none                     | none                                                | pass          |
| T5     | P1  | gateway buffer at the end                  | 0                        | 0                                                   | pass          |
| T2     | P2  | backlog drain after a 5-minute MES stop    | ≥ 800 msg/s              | 938.1 msg/s (4,229 stored in 4,508 ms)              | pass          |
| T2     | P2  | every machine final again                  | ≤ 3 min                  | 6.3 s                                               | pass          |
| T6     | P3  | replay at 3× ingest lag p95                | ≤ 1 s                    | no `mes_ingest_lag_seconds` on `main`               | not measured  |
| T6     | P3  | every machine final after the last message | ≤ 30 s                   | 0.2 s                                               | pass          |
| T6     | P3  | Monday's shift OEE equal to the truth      | 24 buckets final, equal  | 24 equal                                            | pass          |

**No target missed by the baseline**, so no fix issue P9-F\* was opened: every measurable target passed with margin; the three unmeasurable rows needed this issue's metrics, and the buffer row was a measurement-method problem (ADR-0040).

## Final run on the branch

Commit `9d7aea0` (the metrics, the suite and its two method fixes), clean tree, `PERF-OK`, wall time about 25 minutes (build 31 s from the cache, P1 9.1 min, P2 6.8 min, P3 9.0 min).

| Target | Run | What                                       | Target                                   | Measured                                                                                                                               | Result |
| ------ | --- | ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T1     | P1  | ingest lag p95                             | ≤ 250 ms (≥ 95 % at or below 0.25 s)     | 46.2 ms (100 % ≤ 250 ms; 6,404 observations; p50 20.5, mean 24.3)                                                                      | pass   |
| T1     | P1  | ingest lag p99                             | ≤ 1 s (≥ 99 % at or below 1 s)           | 49.5 ms (100 % ≤ 1 s)                                                                                                                  | pass   |
| T1     | P1  | ingest lag max                             | ≤ 5 s (all at or below 5 s)              | 130 ms (`mes_ingest_lag_max_seconds` sampled every second; 100 % ≤ 5 s)                                                                | pass   |
| T1     | P1  | pending messages at every hour boundary    | ≤ 100                                    | 0, 0, 1, 5, 0, 0, 1, 0 at 07:00–14:00                                                                                                  | pass   |
| T1     | P1  | no replayed delivery in the window         | session up, depth ≤ 200, nothing dropped | session down at 0 of 479 samples; depth max 5 (0 at 351 samples); 0 dropped                                                            | pass   |
| T3     | P1  | overview state push p95                    | ≤ 1 s                                    | 244 ms (p50 84, max 309; 595 judged, 0 missed)                                                                                         | pass   |
| T3     | P1  | OEE dashboard push p95                     | ≤ 2 s                                    | 1,066 ms (p50 515, max 1,299; 416 judged, 0 missed)                                                                                    | pass   |
| T3     | P1  | SPC page push p95                          | ≤ 2 s                                    | 231 ms (p50 183, max 247; 83 judged, 0 missed)                                                                                         | pass   |
| T3     | P1  | terminal push p95                          | ≤ 2 s                                    | 613 ms (p50 327, max 810; 388 judged, 0 missed)                                                                                        | pass   |
| T4     | P1  | reads p95 (20 users)                       | ≤ 200 ms                                 | 17.9 ms over 3,189 reads                                                                                                               | pass   |
| T4     | P1  | backward traces p95                        | ≤ 100 ms                                 | 7.9 ms over 749 traces                                                                                                                 | pass   |
| T4     | P1  | no 5xx, no socket closed by the server     | 0 and 0                                  | 0 and 0                                                                                                                                | pass   |
| T5     | P1  | MES CPU averaged over the shift            | ≤ 0.5 core                               | 0.145 core                                                                                                                             | pass   |
| T5     | P1  | MES CFS throttled share                    | ≤ 5 %                                    | 0.29 % of 4,792 periods                                                                                                                | pass   |
| T5     | P1  | peak memory of every container             | < 80 % of its limit                      | ERP mock 51.7 %, simulator 43.4 %, gateway 33.8 %, MES 27.5 % (141 of 512 MiB), Prometheus 17.4 %, web 17.1 %, db 16.7 %, broker 3.9 % | pass   |
| T5     | P1  | no OOM kill, RestartCount 0                | none                                     | none                                                                                                                                   | pass   |
| T5     | P1  | gateway buffer at the end                  | 0 within 10 s of the pause               | 0 at the pause                                                                                                                         | pass   |
| T2     | P2  | backlog drain after a 5-minute MES stop    | ≥ 800 msg/s                              | 1,053.2 msg/s (4,220 stored in 4,007 ms; 743 msg/s counted from the container's start)                                                 | pass   |
| T2     | P2  | every machine final again                  | ≤ 3 min                                  | 5.7 s                                                                                                                                  | pass   |
| T6     | P3  | replay at 3× ingest lag p95                | ≤ 1 s (≥ 95 % at or below 1 s)           | 32.5 ms (100 % ≤ 1 s; 7,177 observations; p99 46.9; host-to-VM clock skew −33.5 ± 35.5 ms)                                             | pass   |
| T6     | P3  | every machine final after the last message | ≤ 30 s                                   | 0.2 s                                                                                                                                  | pass   |
| T6     | P3  | Monday's shift OEE equal to the truth      | 24 buckets final and equal               | 24 equal (A, B, C × 6 machines and 2 work centers)                                                                                     | pass   |

`exit criterion 6` also needs `pnpm test:trace-perf` over HTTPS (≤ 100 ms p95): recorded in the phase log for this issue.

## Reading the figures

- **Excluded deliveries in P1's window:** 0 of each reason. The anchors and snapshots arrive at the gateway's start, before the window; no duplicate was delivered in a fault-free shift.
- **T4 per screen** (final run, p95 ms): overview 7.6, shift OEE 26.3, hourly OEE 9.7, line OEE 10.5, the line's orders 22.8, order list 3.4, order 10.9, order execution 12.1, order OEE 9.0, terminal view 51.4, trace search 9.2, backward trace 7.9. The order screens (#245's first two comments) stay far below 200 ms at shift scale.
- **T2's window is short:** five simulated hours of `orders-01` are about 4,200 messages (the gateway had published 5,067 at the start), drained in about 4 s while `mes_ingest_pending_messages` peaked at 46; the rate is sampled every 0.5 s, so it carries about ±10 %.
- **P3's message rate:** the golden feed carries the device facts and no telemetry, so 180× is 13.8 messages/s against about 17/s live at 60× (P2's gateway: 5,067 messages in 5 wall minutes). T6 checks pacing three times faster than live, not three times the messages.
- **Prometheus's view** agrees with the direct readings: `histogram_quantile(0.95, …increase(mes_ingest_lag_seconds_bucket[480s]))` at the end of P1 gave 46.1 ms.
