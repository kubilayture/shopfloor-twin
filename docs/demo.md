# The demo

One Monday morning of the plant, shown through the real web UI: the console, alarms and downtime, OEE, SPC, a quality hold and traceability (Phase 10 plan, "Demo scenario (P10-06)"; issue #281). `pnpm demo` plays it as a test, asserting what each scene shows; this page is also the script for running it by hand.

## What it runs

| Input                                                                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`config/scenarios/demo-v1.yaml`](../config/scenarios/demo-v1.yaml)             | The timeline, live-playable (no `dispatch` entries, ADR-0037), orders mode, seed 20261012, Monday 06:00, shift A. Its entries: a **pause at 06:14**; a **spindle overload on CNC-01** at 07:15 with a 30-minute repair; **both BLANK-100 lots blocked** 08:15 to 08:30 (OP10 starved, `MATERIAL:BLANK-100`); a **tool breakage on CNC-02** at 09:00; a **leak-test drift on LKT-01** of +0.6 Pa/min from 11:45 to 13:00. |
| [`config/erp/demo-v1.yaml`](../config/erp/demo-v1.yaml)                         | The ERP feed: four VB-100 orders, PO-2610-301 (20 units), -302 (60), -303 (60) and -304 (40), each planned to start at **06:15**.                                                                                                                                                                                                                                                                                        |
| [`compose.demo.yml`](../compose.demo.yml)                                       | The override that runs them: `SIM_PRODUCTION=orders`, `SIM_TIMELINE=demo-v1`, the timeline's seed and start, `SIM_AUTOSTART=false`, `MES_PRODUCTION_MODE=orders` and the ERP dataset. It publishes and mounts nothing of its own.                                                                                                                                                                                        |
| [`config/scenarios/demo-v1-probe.yaml`](../config/scenarios/demo-v1-probe.yaml) | Probe D1's headless-only twin: the same entries plus a `dispatch` per order (below).                                                                                                                                                                                                                                                                                                                                     |

The plant actions are at fixed simulated times. Production depends on when the MES's `LoadOrder`s arrive, so the event log differs between runs; the walkthrough asserts facts, never the log's bytes. Two choices make the facts the same in every run:

- **The orders' planned start (06:15) is the dispatch's `NotBefore`:** a job accepted at any time before it starts at 06:15, with its changeover, whatever the walkthrough's pace.
- **The timeline pauses the run at 06:14:** a walkthrough slower than 14 seconds of wall time still dispatches before 06:15, as the run waits there until scene 3 resumes it from the console. The pause is an infrastructure cue; it never touches the plant model.

**Why its own ERP dataset.** The default `config/erp/orders.yaml` has only 100 units startable before shift B (ORD-1001 and ORD-1002; ORD-1003 is planned for 14:00), and the leak test's SPC baseline is exactly the first 100 first-pass readings (`config/plant/quality.yaml`). A drift after the baseline would have no unit left to show an episode in shift A.

## Running it by hand

On your Mac, with Docker running and your dev `.env` in the repository (it holds the stack's secrets; the demo uses it as it is). **Use a Compose project of its own, never the dev stack's:** the demo then gets its own containers, volumes and dev CA, and your `shopfloor-twin` data is untouched. Never use `pnpm stack:reset` for the demo: it deletes the dev stack's volumes.

1. Stop the dev stack, keeping its data (the demo publishes the same host ports): `pnpm stack:down`.
2. Start the demo, idle at Monday 06:00 with the timeline loaded:

   ```bash
   docker compose -p shopfloor-demo -f docker-compose.yml -f compose.demo.yml up -d --wait
   ```

3. Trust its dev CA (a new one per project): `COMPOSE_PROJECT_NAME=shopfloor-demo pnpm stack:ca ~/shopfloor-demo-ca.pem`, then import that file as the runbook's "HTTPS and the dev CA" says. Open <https://localhost:8443>.
4. Log in as `admin` with `MES_BOOTSTRAP_ADMIN_PASSWORD` from your `.env` (you set a new password at once), and on **Users** (`/admin/users`) make one user per role: an operator, a maintenance user, a quality user and a supervisor.
5. Play the scenes below. Scene 2 can come before the run starts (the jobs still start at 06:15): as admin, **Console** → **Resume** starts the run.
6. Remove the demo with its volumes, then start your dev stack again:

   ```bash
   docker compose -p shopfloor-demo -f docker-compose.yml -f compose.demo.yml down --volumes
   pnpm stack:up
   ```

## The scenes

Times are plant time (Istanbul). At the default 60× (`SIM_SPEED` in `.env`) one simulated minute is one second, so the walkthrough takes about seven minutes. "Opens at" is when `pnpm demo` opens the scene (it waits for that plant time); by hand, any time after it works.

| #   | Opens at              | Who                      | Open                                                                                             | Do                                                                                                                                                    | It shows (and `pnpm demo` asserts)                                                                                                                                                                                                                                                                                                                                | Illustrates                                                                                              |
| --- | --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | 06:00                 | operator                 | **Overview** (`/`)                                                                               | Watch.                                                                                                                                                | The six machines, each with its live state; the plant clock moving with the run at 60× (or at the timeline's pause, 06:14).                                                                                                                                                                                                                                       | The live plant path: OPC UA and Modbus, the gateway, MQTT, the MES                                       |
| 2   | at once               | supervisor               | **Orders** (`/orders`)                                                                           | Release each of the four orders, then dispatch each (the dispatch rule chooses the CNC).                                                              | The four orders imported from the ERP; each command confirmed by its `accepted` job fact on the CNC the rule chose (PO-2610-301 and -303 on CNC-01, -302 and -304 on CNC-02), accepted by 06:14 and starting at 06:15.                                                                                                                                            | Orders from the ERP, dispatch through OPC UA `LoadOrder`                                                 |
| 3   | at once               | admin                    | **Console** (`/console`)                                                                         | Wait for the timeline's pause; **Resume**, **Pause**, **Resume**.                                                                                     | The run paused at 06:14 by the timeline, its progress list (one row per entry, the pause applied), 60×; each control reaching the simulator. Infrastructure only: nothing that changes the plant outside the timeline.                                                                                                                                            | The simulation console                                                                                   |
| 4   | 07:20                 | maintenance              | **Alarms** (`/alarms`), then **Downtime** (`/downtime`)                                          | Acknowledge the spindle overload; after its repair (07:45), filter CNC-01, code its breakdown record (reason _Spindle overload_, a comment) and save. | `SPINDLE-OVERLOAD` on CNC-01 raised at 07:15, active and unacknowledged, then acknowledged by the maintenance user; its `Down` record 07:15 to 07:45, coded by hand by that user (the audit says so).                                                                                                                                                             | Alarms (ISA-18.2 states), downtime coding                                                                |
| 5   | 09:00                 | supervisor               | **OEE** (`/oee`, CNC-01 in focus), then the first completed order                                | Look at CNC-01's row and Pareto, the line card, then the order's OEE section.                                                                         | CNC-01's availability below 1 with at least 30 minutes of breakdown loss, _Spindle overload_ in its Pareto; the line card's bottleneck per product equal to the MES's derived one (`GET /api/v1/oee/line`): ASM-01 for VB-100 (ADR-0036); the first completed order (PO-2610-301) with its OEE, availability and first-pass yield, final and equal to the MES's.  | Success criterion 3's numbers on screen; ADR-0036                                                        |
| 6   | 12:00                 | quality                  | **Quality** → **SPC** → leak rate (`/quality/spc/leak-rate`)                                     | Find the newest episodes.                                                                                                                             | The baseline's limits (version 1) and the drift's first episode, equal to the simulator's (chart, rule, limit version, triggering unit), after the drift's start.                                                                                                                                                                                                 | SPC (ADR-0032)                                                                                           |
| 7   | 12:00, close at 12:25 | quality, then supervisor | From the episode: **Hold**; then **Holds**; then the held order                                  | Hold the order of the episode's last unit (reason _SPC signal_); open the hold; at 12:25 the supervisor tries to close that order.                    | The hold open on the order, its scope (units, the order, the episode's unit among them) on the holds screen and its detail; once the order is complete, its close refused with `urn:shopfloor:quality-hold`, naming the hold, the order still completed.                                                                                                          | Quality holds and the close guard (ADR-0035)                                                             |
| 8   | at once               | quality                  | **Trace**: the first completed order's carton `…-C01`, a packed serial in it, then its blank lot | Follow the serial link, then the OP10 lot link.                                                                                                       | The carton closed; the serial's records: the blank from a BLANK-100 lot on the CNC the order was dispatched to, the SK-1 and SP-100 lots at ASM-01 with its operator, the leak value under the limit at LKT-01, packing at PCK-01, each equal to the MES's answer and each lot the simulator's; the lot's cartons, the serial's among them, each the simulator's. | **Success criterion 4**: a finished serial traced back to its lots, machines, operators and test results |

## `pnpm demo`

`pnpm demo` (`e2e/src/demo.ts`, under the heavy-suite lock) builds the images (tag `demo`), starts the stack on a disposable Compose project (`DEMO_PROJECT`, default `shopfloor-demo-run`; `docker-compose.yml`, `e2e/compose.reconcile.yml` for ephemeral host ports and no restarts, and `compose.demo.yml`) with an env file of random secrets, makes the bootstrap admin and one user per role through the API, waits for what a presenter would find (the four orders imported, every machine connected and known to the MES), starts the run through the control API, and runs Playwright's project `demo` (`e2e/browser/demo/walkthrough.spec.ts`): the eight scenes on one page, the users changing by logout and login, Chromium pinned to the stack's certificate. The test reads the control API itself (with the token, never the browser) only for the simulated time and, in scenes 6 and 8, the simulator's truth.

Environment: `DEMO_PROJECT` (refuses `shopfloor-twin` and `shopfloor-demo`, which is yours), `DEMO_TAG` (default `demo`), `DEMO_SKIP_BUILD=1`, `DEMO_KEEP_IMAGES=1` (removed by default). Results in `e2e/results/demo/`: `scenes.jsonl` (each scene's wall and plant times and the facts it showed, for P10-07's captions), Playwright traces and, on failure, `compose.log`. The stack is removed with its volumes, also on failure. About 7 minutes after the build.

## Probe D1

`pnpm demo:probe` (`e2e/src/demo-probe.ts`; light, no stack) runs `demo-v1-probe.yaml` headless with every job accepted at a given time: a job accepted at T on an idle CNC starts at T (its changeover first), as one given at the start with `NotBefore` T does, so a variant moves each dispatch's `NotBefore` to the later of the planned start and T. It reads each scene's facts from the variant's ground truth (`summary.json`, `trace.json`, `line-oee.json`, the event log) and compares them with the plant time the walkthrough opens the scene. Inside the envelope (accepted at 06:00, 06:07 and 06:14, the latest the walkthrough can accept, since the run waits paused at 06:14) a missing fact or a negative margin fails the probe; three later variants show what a slower dispatch would do. The walkthrough fails a run whose jobs were accepted after 06:14 (scene 2).

Inside the envelope the three variants are the same run (NotBefore stays 06:15); that a job accepted live before 06:15 behaves the same rests on Line.loadOrder waking the CNC at NotBefore (plant/load-order.test.ts) and on the two live runs.

| Scene | Fact                                                                 | Needed by         | Accepted 06:00, 06:07 or 06:14 | Margin    | Accepted 06:20 | 06:30     | 06:45     |
| ----- | -------------------------------------------------------------------- | ----------------- | ------------------------------ | --------- | -------------- | --------- | --------- |
| 4     | `SPINDLE-OVERLOAD` raised on CNC-01                                  | 07:20             | 07:15:00                       | 5.0 min   | 07:15:00       | 07:15:00  | 07:15:00  |
| 4     | its repair ends (breakdown record closed)                            | 07:50             | 07:45:00                       | 5.0 min   | 07:45:00       | 07:45:00  | 07:45:00  |
| 5     | availability loss on CNC-01 (the breakdown)                          | 09:00             | 07:15:00                       | 105 min   | 07:15:00       | 07:15:00  | 07:15:00  |
| 5     | first order completed (PO-2610-301)                                  | 09:00             | 08:49:04                       | 10.9 min  | 08:58:56       | −9.6 min  | −24.3 min |
| 5     | OP10 starved `MATERIAL:BLANK-100`                                    | 09:00             | 08:18:20                       | 41.7 min  | 08:15:52       | 08:16:28  | 08:15:43  |
| 6     | SPC baseline complete (limit version 1)                              | 11:45 (the drift) | 11:37:27                       | 7.5 min   | −0.4 min       | −13.0 min | −35.1 min |
| 6     | the drift's first episode (I chart, rule 1, latency 3)               | 12:00             | 11:51:13                       | 8.8 min   | 11:49:46       | −2.4 min  | −22.1 min |
| 7     | the held order (PO-2610-302, the episode's last unit's) completed    | 12:25             | 12:17:28                       | 7.5 min   | −2.9 min       | −17.8 min | −37.6 min |
| 8     | its own carton closed (PO-2610-301-C01, the first completed order's) | 12:25             | 08:49:04                       | 215.9 min | 08:58:56       | 09:09:36  | 09:24:15  |

The bottleneck is ASM-01 (VB-100, OP30, 150 s) in every variant. Beyond the envelope the drift starts inside the SPC baseline from 06:20 on, so the pause at 06:14 is what keeps the demo's facts. The tool breakage's `TOOL-CHANGE` setup on CNC-02 starts at 09:01:53 in the envelope.

**Deviation from the plan's estimate.** The plan asked for the alarm, the episode, a completed order and a closed carton "by about 09:30". The alarm (07:15), the first completed order (08:49) and scene 8's carton PO-2610-301-C01 (closed at 08:49 with its order) are; the episode can't be: an episode after the baseline needs the baseline's 100 first-pass readings first, and the line (ASM-01 at 150 s per unit, a 30-minute break at 10:00, the failure and the lot block) has them at 11:37. The drift starts at 11:45 and its episode is at 11:51, so the walkthrough runs to about 12:30.

## Assertion mutants

Each scene's assertions were proved able to fail. One mutant per scene, each a `expect.soft` beside the real assertion that expects a wrong fact, applied together to an uncommitted copy of `e2e/browser/demo/walkthrough.spec.ts` (the walkthrough is one test with a step per scene, so soft failures let every later scene run) and played once against the live stack (`DEMO_SKIP_BUILD=1 pnpm demo`, 2026-10-21, on `a5de2db`). Every mutant was killed; the copy was then restored.

| Scene | Mutant: the walkthrough expects                      | Killed: the run saw                       |
| ----- | ---------------------------------------------------- | ----------------------------------------- |
| 1     | seven machine cards on the overview                  | 6                                         |
| 2     | each job on the other CNC than the dispatch rule's   | cnc-01 and cnc-02 as planned (4 failures) |
| 3     | the timeline's pause at 06:15 (the planned start)    | 06:14:00                                  |
| 4     | the alarm acknowledged by the operator               | `demo-maintenance`                        |
| 5     | CNC-01 as VB-100's bottleneck on the line card       | `asm-01`                                  |
| 6     | the drift's episode on rule 2 (the truth's rule + 1) | rule 1                                    |
| 7     | the close refused with `sign-off-missing`            | `quality-hold`                            |
| 8     | the serial's OP10 lot of `BLANK-200`                 | `BLANK-100`                               |

## The recording

`pnpm demo:record` (#282, P10-07) records the walkthrough above as a video, with a screenshot per scene and captions, into [`docs/demo/`](demo/).

### Size probe (60 s)

The plan asks for a 60 s probe first, with its size extrapolated to the whole walkthrough. It ran as `DEMO_RECORD_PROBE_S=60 pnpm demo:record`, under the heavy lock, on 2026-10-21. That is the walkthrough with Playwright's video on its one page at 1280 × 720 (Playwright's own encoder: VP9, `-crf 8 -deadline realtime`, bitrate cap 2,560 kbit/s at this size), scenes 1 to 3 asserted, then the run until the video was 60 s long. The working tree was main `081d7c8` plus this branch's first changes.

| Video                        | Length | Size     | Per minute | Whole walkthrough (6.5 min) | At 7 min   | Limit  |
| ---------------------------- | ------ | -------- | ---------- | --------------------------- | ---------- | ------ |
| 1280 × 720, Playwright's VP9 | 61.6 s | 7.85 MiB | 7.65 MiB   | ≈ 49.7 MiB                  | ≈ 53.5 MiB | 12 MiB |

The first minute is the busiest part of the walkthrough (three logins, eight order pages, the console), so the extrapolation errs on the high side. Even so, at about four times the limit the recording at 1280 × 720 can't fit. The plan's fallbacks therefore apply, in its order: 960 × 540, then the scripted re-encode (below).

### What `pnpm demo:record` does

It is `pnpm demo` (`e2e/src/demo.ts --record`), the same harness and the same Playwright test, with three additions on the walkthrough's one context and page:

- **Video:** Playwright's video recording on that context, at **960 × 540**, the plan's first fallback (the page is still 1280 × 720; Playwright scales the frames). It is one continuous video from the page's opening to its close, with the users changing by logout and login on that page.
- **Screenshots:** at each scene's end, after its assertions, the scene's last view is held for 3 s (`RECORDING.dwellMs`). Nothing is done on the page during that time. Then the scene's screenshot is taken at 1280 × 720 (`NN-<scene>.png`).
  - The hold came from the first full recording, which showed scene 6 for 0.5 s and scene 8 for 0.65 s, because their facts exist long before they open.
  - A hold before a wait for plant time only shortens that wait.
  - Scenes 1 and 2 are not held (`RECORDING.heldScenes`, after the review of PR #296). They run before the timeline's pause at 06:14, where a hold would take from the dispatch's margin, which stays as in `pnpm demo`. They keep their screenshots.
- **Captions:** after the run, `docs/demo/demo-v1.vtt` is written from the scene log (`scenes.jsonl`) and the video's start. It has one cue per scene, from its start to its end, giving its number, title, plant times and what it shows. Between scenes there is a cue for the wait: "The run goes on at 60× (plant 09:03 to 12:00)". No caption or overlay is injected into the application's pages.

It refuses to start on a tree whose tracked files outside `docs/` and Markdown differ from `HEAD`, so a recording shows exactly its commit. Every scene is asserted exactly as in `pnpm demo`, and the harness checks the scene log the same way (scenes 1 to 8, once each, in order). After `DEMO-OK` it publishes in two steps (after the review of PR #296):

1. **Stage.** It writes the video (re-encoded only when over the limit), the eight screenshots and the captions to `e2e/results/demo/record/publish/`. It writes the record `e2e/results/demo/recording.json`: the commit, SHA-256, size, length, resolution, and the size before any re-encode.
2. **Check, then replace.** It checks the staged files. It refuses the recording, exiting 1, if:
   - the video is over 12 MiB, over 7 minutes, or not 960 × 540;
   - the screenshots together are over 4 MiB;
   - the captions or the record hold any secret of the run: every user's generated password and every `*_PASSWORD` and `*_TOKEN` value of the run's env file (`Stack.secretValues()`).

   Only a recording without a problem replaces the files in `docs/demo/` (`publishStaged`, tested with the file-system steps injected). A refused one leaves `docs/demo/` as it was.

`DEMO_RECORD_PROBE_S=60` stages and checks scenes 1 to 3 the same way and publishes nothing.

**The scripted re-encode** (the plan's second fallback) is in `REENCODE_ARGS` (`e2e/src/demo-record.ts`). It runs Playwright's bundled ffmpeg (`ffmpeg-<revision>` beside the browsers, revision from `playwright-core/browsers.json`), which decodes and encodes VP9 only:

```text
ffmpeg -i walkthrough.webm -c:v libvpx-vp9 -crf 36 -b:v 0 -deadline good -cpu-used 4 -row-mt 1 -an shopfloor-twin-v1.webm
```

That is one pass at constant quality with no bitrate cap, at the same size and frame rate, with no audio. Playwright records in real time at `-crf 8` up to a bitrate cap, so the same pictures take about a fifth of the space. CRF 36 was chosen on the probe's video, scaled to 960 × 540: about 1.2 MiB a minute (CRF 42 gave 0.93 MiB) with the UI's text still sharp. The re-encode runs only when the recording is over 12 MiB. At 960 × 540 Playwright's video of the whole walkthrough is about 26 MiB, so every recording so far has been re-encoded. The plan's third fallback, a shorter walkthrough, was not needed for size. For length, it would cut waits or asserted scenes; the coordinator decision below (Length) replaces it with a 7-minute limit for the owner's review.

### Length: at most 7 minutes (a deviation)

The plan's limit is 6 minutes. The walkthrough can't meet it at 60× without cutting asserted scenes. Its last scenes need plant time 12:25 (scene 7's close, once the held order has completed) and the run starts at 06:00. That is 385 minutes of plant time, so at least 385 s, or 6 min 25 s, of wall time at 60×, before any scene's own work. The recording shows a real run at 60× (the plan), so no speed-up of the run is possible within the harness. The only idle wait that isn't plant time is the timeline's pause at 06:14, which scene 3 resumes as soon as it has asserted it (about 9 s here).

**Coordinator decision (#282), for the owner's review:** the limit is **at most 7 minutes**. No scene is cut and the video is not edited by hand. `RECORDING.limits.seconds` is 420, and `pnpm demo:record` refuses a longer video. It is listed in STATUS's owner items and the Phase 10 log.

### The committed recording

| File                                                                            | What                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`shopfloor-twin-v1.webm`](demo/shopfloor-twin-v1.webm)                         | The video, 6 min 36.5 s (396.5 s), 960 × 540, VP9, 4,866,985 bytes (4.64 MiB); SHA-256 `c365ab9ab3bc20f07c4d64a9a04f9b2747d3af4937ac7a63a4925f2feefed3a4` |
| [`demo-v1.vtt`](demo/demo-v1.vtt)                                               | The WebVTT captions: one cue per scene, one per wait                                                                                                      |
| [`01-overview.png`](demo/01-overview.png) … [`08-trace.png`](demo/08-trace.png) | The eight scenes' screenshots, 1280 × 720, 969,618 bytes together (0.92 MiB)                                                                              |

**To be replaced:** #295 (P10-F2) changes what scenes 3 and 6 show. Once it has merged, the recording is made once more on this branch with the review's changes, and this table, the Phase 10 log, STATUS and the CHANGELOG get its values. The present one also predates the review's changes: it holds scenes 1 and 2 for 3 s, and was published without staging.

It was recorded by `pnpm demo:record` on **`577d8ce`** (main `6f345bf` plus this branch's code; `apps/`, `packages/`, `config/` and `e2e/` unchanged from it) on 2026-10-21, under the heavy lock. The video was 26.50 MiB from Playwright and was re-encoded as above. In the walkthrough's scene log the jobs were accepted at 06:07 and PO-2610-301 was the first completed order (OEE 0.5446, availability 0.5488, first-pass yield 1.0000). The drift's first episode was on the I chart, rule 1, at 11:51:13 on unit 106. The hold was on PO-2610-302 (60 units) and its close was refused. Serial VB-100-000001 of carton PO-2610-301-C01 traced back to BL100-2610-01, SK1-2610-01 and SP100-2610-01, operator op-a1, leak value 2.46. These are the facts of #281's runs.

**Secrets.** The demo's secrets are generated per run and thrown away with its stack, and none can appear in the recording:

- Passwords are typed only into the login form's password field. Every Playwright login checks that the field is `type="password"` before filling it: `logIn` and `signOnAtTerminal` in `e2e/browser/login.ts`, after the review of PR #296. Before that review, only the demo's own `switchTo` checked it. Frames of the committed video taken at each login showed the field masked.
- The control token and the other secrets never reach the browser: the test reads the control API itself.
- The captions are generated from scene titles and plant times only. For the committed recording, `pnpm demo:record` searched the captions and its record for the users' passwords, the bootstrap admin's, the control token, the ERP token and the database passwords, and found none. Since the review of PR #296 it searches every `*_PASSWORD` and `*_TOKEN` of the run's env file as well.
- The eight screenshots were looked at: user names and plant data only.

### Re-recording

Re-record only when a scene's visible behaviour changed; at most one recording on `main` per release. A change to a scene's assertions that changes nothing on screen, or a new UI detail outside the scenes, is not a reason.

To re-record, start from a clean checkout of the commit to record, with the heavy lock free and Docker's VM at 4 GiB. Run `pnpm demo:record`; it refuses a tree with uncommitted changes outside the docs. It replaces the files in `docs/demo/` only when the staged recording passes its checks (`RECORD-OK`). Then copy the values from `e2e/results/demo/recording.json` (commit, SHA-256, length, size) into the table above and into the final report. Commit the video, captions and screenshots together. Never edit, cut or re-encode the video by hand: if it is over a limit, change the committed parameters (`e2e/src/demo-record.ts`) in the plan's order and record again.

**Narration** is for the owner to add, if wanted: Claude can't record it in his voice. The captions file is the script it can follow.

## Run records

All on `a5de2db` (main `13f8faf` plus #281), 2026-10-21, under the heavy-suite lock, Node 26.11.1, Docker 29.5.2.

| Run                          | What                                                                                                 | Result                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate                         | `GATE_STEPS=verify,golden,e2e,reconcile GATE_PROJECT=gate281 GATE_TAG=pr281 TURBO_FORCE=1 pnpm gate` | `GATE-OK`: verify 596.5 s, golden 1.5 s (the four goldens byte-identical), e2e 1,499.2 s, reconcile 1,754 s; host 36.1 GiB, Docker 75.5 GiB free at the start |
| Mutants                      | `DEMO_SKIP_BUILD=1 pnpm demo` with the eight mutants                                                 | 8 of 8 killed (above)                                                                                                                                         |
| `pnpm demo`, first           | build, run, images removed                                                                           | `DEMO-OK` in 499 s, the walkthrough 6.5 min; jobs accepted at 06:04; host 58.6 GiB free                                                                       |
| `pnpm demo`, second in a row | build, run, images removed                                                                           | `DEMO-OK` in 443 s, the walkthrough 6.4 min; jobs accepted at 06:03; host 52.2 GiB free                                                                       |

**After the review of PR #290**, on `828e3cd`: `GATE_STEPS=verify GATE_PROJECT=gate281b GATE_TAG=pr281b TURBO_FORCE=1 pnpm gate` gave `GATE-OK` (verify 598.1 s; host 45.1 GiB free); `pnpm demo:probe` gave `D1-OK` with the table above; `pnpm demo` twice in a row gave `DEMO-OK` (440 s and 441 s, each with the scene log of scenes 1 to 8). The harness's scene-log check was proved by a mutant: with the walkthrough forced to skip (Playwright exits 0, `1 skipped`), the run fails with "the scene log must record scenes 1, 2, 3, 4, 5, 6, 7, 8 once each, in order; it has nothing".

Both runs showed the facts probe D1 gives inside the envelope: the alarm raised at 07:15 and its 30-minute `Down` record, PO-2610-301 the first completed order (OEE 0.5446, availability 0.5488, first-pass yield 1.0000), ASM-01 the bottleneck, the drift's first episode on the I chart, rule 1, at 11:51:13 on unit 106 (`I~1~1~106/1`), the hold on PO-2610-302 (60 units) and its close refused, serial VB-100-000001 of carton PO-2610-301-C01 back to BL100-2610-01, SK1-2610-01 and SP100-2610-01, operator op-a1, leak value 2.46. CNC-01's shift availability so far differed in the fourth decimal (0.5986, 0.5983): it is read live, at the plant time scene 5 reached.

**The recording (#282)**, all under the heavy lock with Node 26.11.1, each building its images and removing them at the end:

| Run                     | Commit                                                                   | What                                                  | Result                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Size probe              | `dcac1b1` (on main `081d7c8`; `5479ff1` after the rebase onto `6f345bf`) | `DEMO_RECORD_PROBE_S=60 pnpm demo:record`, 1280 × 720 | `PROBE-OK`: 61.6 s, 7.85 MiB ("Size probe" above); host 29.5 GiB free                                                                                                                 |
| First recording         | `2b80665`                                                                | `pnpm demo:record` at 960 × 540, no hold              | `DEMO-OK`, `RECORD-OK`: 25.50 MiB from Playwright, 4.59 MiB re-encoded, 388.6 s. Not committed: it showed scene 6 for 0.5 s and scene 8 for 0.65 s, hence the 3 s hold                |
| Second recording        | `a66eede`                                                                | with the hold, the screenshot before it               | `DEMO-OK`, `RECORD-OK`: 26.37 MiB, 4.68 MiB re-encoded, 396.4 s. Not committed: scene 6's screenshot showed the SPC charts still loading, hence the screenshot after the hold         |
| **Committed recording** | `577d8ce`                                                                | the screenshot after the hold                         | `DEMO-OK`, `RECORD-OK` in 612 s: 26.50 MiB from Playwright, re-encoded to 4.64 MiB, 396.5 s, 960 × 540; screenshots 0.92 MiB; jobs accepted at 06:07; host 37.4 GiB free at the start |

Then `pnpm demo` once, on `577d8ce`: `DEMO-OK` in 440 s, jobs accepted at 06:04. And `GATE_STEPS=verify` (`gate282`, `pr282`, `TURBO_FORCE=1`) on `f7fb86f`, the recording's commit: `GATE-OK`, verify 591.7 s.

During the first recording's build the host fell to 24 GiB free: Colima's disk image had grown with the probe's and the recording's images, which Docker had already removed. `colima ssh -- sudo fstrim -av` returned 24.7 GiB to the host (40 GiB free); the later runs started at 37.4 GiB and up.
