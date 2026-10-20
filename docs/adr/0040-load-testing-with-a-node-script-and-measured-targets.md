# ADR-0040: Load testing with a Node script, targets judged per run

- Status: accepted (#245, P9-18)
- Date: 2026-10-20
- Deciders: Claude, within the Phase 9 plan ("Performance"; review decisions round 1 findings 2, 4, 12, 13 and 22, round 2 finding 5, round 3 finding 4 and the final check); recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The master plan (section 9) asks for "ingest throughput at 60× simulation speed with all machines; UI update latency", with the tool "decided in Phase 9"; section 12 left the load-testing tool and the performance targets open. Until Phase 9 performance was measured piecemeal (ingest about 1,000 stored messages/s in the runbook, the push budgets of Phases 4–8, `pnpm test:trace-perf`), with no ingest lag metric and no stated targets. The Phase 9 plan set targets T1–T6, each with the run that measures it, on the hardened stack (SignAndEncrypt, HTTPS, dynamic security) in a Colima VM of 4 CPUs and 4 GiB. This ADR records the tool, how each target is measured and judged, the new MES metrics and what the runs showed.

## Considered options

1. **k6** (Grafana's load tool): a new binary or image, JavaScript but not Node, MQTT only through an extension, WebSockets with its own API.
2. **A Node script** in `e2e/` (`pnpm test:perf`, as `pnpm test:trace-perf`): Node's built-in `fetch` and `WebSocket`, the repository's clients and judges, no new dependency.

## Decision outcome

Chosen option: 2. The plant itself is the main load (the simulator at 60× through OPC UA, Modbus, the gateway and the broker); what a tool adds is 20 HTTP and WebSocket users, which `fetch` and `WebSocket` do, and the judging, which needs the repository's latency judge (`e2e/src/latency.ts`), Compose stacks (`e2e/src/stack.ts`), the simulator's control API and its plant events. k6 would duplicate those or call out to them.

### The suite

`pnpm test:perf` (`e2e/src/perf.ts`, under the heavy lock) runs three runs, each on its own disposable Compose project with ephemeral ports and the observability profile's Prometheus only (`--profile observability`; Grafana's page cache would count against T5's 80 % rule, #263's review), torn down with `down --volumes` with `compose.observability.yml` loaded; the images it built and Prometheus's image, if it pulled it, are removed at the end.

- **P1, steady:** `orders-01`'s Monday shift A in orders mode at 60×, released and dispatched through the API while the simulator waits at 06:00 (each command confirmed by its device fact), the scenario's injections posted, then resumed. The window runs from the MES's catch-up (the first moment after the resume with `mes_ingest_pending_messages` ≤ 100 and the gateway's outbox empty) to 14:00.
- **P2, drain:** the same start; the MES stopped with SIGTERM at 07:00 for five wall minutes (five simulated hours) and started.
- **P3, headroom:** no simulator and no gateway; `week-01`'s golden feed of Monday and two more hours (26 simulated hours, so every machine has a fact after shift C) published by the gated `mes-server` Vitest entry `apps/mes-server/src/perf-replay.e2e.test.ts` (`PERF_REPLAY_BROKER_URL`, the broker's port published for this run only by `e2e/compose.perf-replay.yml`) at three times the 60× rate, as the gateway's MQTT user, each message's `receivedAt` set to its publication. The feed is the golden harness's, so `e2e/src/perf.ts` imports no MES code (review round 1, finding 22).

### Measurement methods

| Target                                                                                               | Run | How it is measured and judged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1: ingest lag p95 ≤ 250 ms, p99 ≤ 1 s, max ≤ 5 s; pending ≤ 100 at every hour; no replayed delivery | P1  | Two readings of the MES's own `/metrics` at the window's ends, subtracted: exactly judged on the bucket edges (≥ 95 % of observations at or below 0.25 s, ≥ 99 % at or below 1 s, all at or below 5 s); the max also from `mes_ingest_lag_max_seconds` sampled every second; the excluded counts beside it. Pending read straight from `/metrics` at the first status reading past each simulated hour (a 5 s scrape can miss a peak). No replay: the gateway's broker session up at every sample, its outbox depth within one live window (≤ 200) and nothing dropped (see "Gateway buffer" below). |
| T2: drain ≥ 800 msg/s; every machine final again within 3 min                                        | P2  | `mes_ingest_messages_total{outcome="stored"}` from the session's subscription to the catch-up (the MES's plant clock within 60 simulated seconds of the simulator's); final: every machine's device stream settled in `ingest.source_cursor` through the last fact the simulator's live event log (`SIM_EVENT_LOG`) shows it raised before the start.                                                                                                                                                                                                                                                |
| T3: push ≤ 1 s (overview), ≤ 2 s (OEE dashboard, SPC page, terminal), p95                            | P1  | Client side, Node WebSockets through nginx's HTTPS front: the overview (`states`) and the Line A1 terminal (`terminal:line-a1`) with the latency judge of Phases 4–8 against the simulator's plant events (the control API's event WebSocket, the truth's wall time being its arrival); the OEE dashboard (`oee:<machine>`) by the time until a pushed shift bucket counts each completed cycle; the SPC page by the time until the chart it reads on a `readings` push holds each first-pass reading. A change not shown within 10 s counts as infinite.                                            |
| T4: reads p95 ≤ 200 ms, backward traces p95 ≤ 100 ms, no 5xx, no socket closed by the server         | P1  | Client side (the MES has no HTTP latency histogram): 10 desks (overview, shift and hourly OEE, line OEE, the line's orders, the order list every 30 s; an order's detail, execution and order OEE every 10 s; the screens' topics open), 5 terminals (their topic, the view every 60 s), 5 trace users (a search and a backward trace every 3 s), each read timed to its last byte.                                                                                                                                                                                                                  |
| T5: MES CPU ≤ 0.5 core, throttled ≤ 5 %, peak memory < 80 % of every limit, no OOM, no restart       | P1  | The containers' cgroup v2 files read inside each container: `cpu.stat` (`usage_usec`, `nr_periods`, `nr_throttled` at the window's ends), `memory.peak` against `memory.max`, `memory.events`' `oom_kill`; `docker inspect`'s `RestartCount` and `OOMKilled`. Not process RSS: page cache counts toward a limit.                                                                                                                                                                                                                                                                                     |
| T6: lag p95 ≤ 1 s at 3×; every machine final within 30 s; Monday's OEE equal to the truth            | P3  | The lag histogram over the replay; each machine's stream settled through the replay's last number for it; `GET /shifts/2026-10-12/{A,B,C}/oee` final and equal to `week-01`'s `summary.json` for six machines and two work centers each (24 buckets).                                                                                                                                                                                                                                                                                                                                                |

### New MES metrics

- `mes_ingest_lag_seconds{class}` (`state`, `cycle`, `alarm`, `job`, `telemetry`): the gateway's `receivedAt` to the MES's commit, observed right after the commit, only for live device facts stored for the first time over the session (never `deliver()`'s replays); buckets 5 ms to 60 s with edges at 0.25, 1 and 5 s, so T1 and T6 are judged exactly, not interpolated.
- `mes_ingest_lag_excluded_total{reason}`: `retained` (a retained copy of a fact topic), `anchor` (a retained state or alarm delivery), `snapshot` (a state or alarm snapshot), `duplicate` (a dedup hit). There is no `replayed` reason: ingest can't tell a delivery from the gateway's store-and-forward buffer from a live one, so P1 asserts no replay can be in the window (review round 3, finding 4).
- `mes_ingest_lag_max_seconds`: the largest observation of the last 5 to 10 s, since a histogram has no max (#263's review).
- `mes_ingest_pending_messages`: PUBLISH packets read from the session's socket and not yet committed. MQTT.js hands the MES one delivery at a time, so the waiting ones are on the socket: a small reader of MQTT's fixed headers (`modules/ingest/wire.ts`) counts them as they arrive. **Bounded by the receive maximum (100)** the broker honours, and the socket is read only while MQTT.js keeps up, so the gauge can't show a backlog beyond that: the broker holds it, and Mosquitto reports no per-client queue. The plan's "≤ 100" is therefore met by construction once the gauge exists; the lag histogram, not the gauge, is what shows a backlog. Recorded here so nobody reads the hour-boundary check as stronger than it is.

### Gateway buffer (deviation from the plan's wording)

The plan says `gateway_buffer_messages` "stays 0 over the whole T1 window". Every UNS message passes through the gateway's SQLite outbox (ADR-0014: committed, sent, deleted after its PUBACK, with up to 100 in flight and 20 ms commit batches), so a 1 s sample of live traffic sees a depth of a few messages without any replay (the Q3 baseline: 7 at most). A replay needs the broker session lost or the gateway restarted. The suite therefore judges the window on what excludes a replay: the gateway's broker session (`gateway_mqtt_connected`) up at every sample, the depth within one live window (≤ 200, never accumulating), no message dropped, and T5's `RestartCount` 0; the depth is reported. The intent is the plan's; the literal "0 at every sample" was unfailable only on an idle plant.

### Results

Probe Q3 (P1–P3 before any change to the MES: commit `6b1818c`, the suite on `main` `d537d60`; Colima VM 4 CPUs, 4 GiB (3.81 GiB visible), 100 GiB disk, Ubuntu 24.04, kernel 6.8, Docker 29.5.2; host load average 2.05–2.88):

| Target | Q3 on `main`                                                                                  |
| ------ | --------------------------------------------------------------------------------------------- |
| T1     | lag and pending not measurable (no metric on `main`); the literal buffer rule missed (max 7)  |
| T2     | 938 msg/s; final again after 6.3 s                                                            |
| T3     | overview 226 ms, OEE dashboard 1,014 ms, SPC page 229 ms, terminal 615 ms (p95)               |
| T4     | reads 16.1 ms, backward traces 7.3 ms (p95); no 5xx, no socket closed                         |
| T5     | MES 0.145 core, 0.36 % throttled; highest peak memory the ERP mock's 54 %; no OOM, no restart |
| T6     | lag not measurable; final 0.2 s after the last message; 24 OEE buckets equal                  |

No measurable target was missed, so no fix issue P9-F\* was opened.

The final run on this branch (with the new metrics):

| Target | Final run (`9d7aea0`, `PERF-OK`)                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| T1     | lag p95 46.2 ms, p99 49.5 ms, max 130 ms (6,404 observations, all ≤ 0.25 s); pending ≤ 5 at every hour; no replay |
| T2     | 1,053 msg/s; final again after 5.7 s                                                                              |
| T3     | overview 244 ms, OEE dashboard 1,066 ms, SPC page 231 ms, terminal 613 ms (p95)                                   |
| T4     | reads 17.9 ms, backward traces 7.9 ms (p95); no 5xx, no socket closed                                             |
| T5     | MES 0.145 core, 0.29 % throttled; highest peak memory the ERP mock's 51.7 % (MES 27.5 %); no OOM, no restart      |
| T6     | lag p95 32.5 ms (7,177 observations); final 0.2 s after the last message; 24 OEE buckets equal                    |

Every figure, the VM, the host load and the image digests: `docs/phases/phase-09-perf-results.md`.

### Consequences

- Good: every target has a run, a method and a pass rule written down, judged by the script, with the VM, host load and image digests in `e2e/results/perf/results.json`; the exit code fails on any miss, and a target is never relaxed silently (Q3 first).
- Good: the lag histogram and its exclusions make the ingest path's delay visible in Prometheus for every later change; the runbook has the PromQL for each target.
- Bad: T3 and T4 are client side and their truth's clock is the event's arrival at the harness, not the simulator's emission: a few milliseconds of WebSocket transit count against the MES.
- Bad: P2's backlog is small (five simulated hours of `orders-01` are about 4,200 messages, drained in about 4.5 s), so T2's rate rests on a short window sampled every 0.5 s; and P3's golden feed has no telemetry, so "three times 60×" is about 14 messages/s, below live P1's message rate. Both measure what the plan defined; a heavier synthetic load is not in this issue.
- Bad: `mes_ingest_pending_messages` is bounded by the receive maximum (above).
- Neutral: the scalability follow-ups of #245's comments (`OrderOee.lineOrders` bounded to the open window, `GET /oee/line/orders` paginated, the `#finals` maps evicted) are not required by T4 or T5 at shift scale (the order screens' reads p95 ≤ 23 ms, the MES at 0.145 core and 27.5 % of its memory limit); they stay open for month-scale data.
