# Phase 10 – Release 1.0: learning notes

Phase 10 built almost nothing into the plant or the MES. It turned a working system into a release a stranger can check:

- a fresh clone that starts with one documented command line, and a harness that proves it on a clone of the commit without touching the owner's stack;
- property-test seeds printed by every `pnpm verify`, so a random run can be replayed;
- the documentation made current against the code, with C4-style architecture views that a script checks against Compose, the module folders, the imports and the packages;
- a scripted demo of eight scenes that asserts what each one shows, and a headless recording of it;
- a final report that names, for each of the six v1 success criteria, the command, the commit, the counts and a deliberate break that shows the check can fail;
- the release mechanics (one product version, the CHANGELOG, the runbook's "Releasing"), with the tag left to the owner.

These notes explain the ideas behind that work as questions with full answers, give a reading order and one exercise. They are reference material: nothing here waits for an answer, and the learning step stays optional, as in earlier phases.

## 1. Concepts in one page

- **The release candidate** is a commit, not a tag: the last commit on `main` that changes anything outside `docs/` and `CHANGELOG.md`. Every proof of the release is a run on that commit; whatever is merged after it may change documentation only, and a command shows that it did.
- **Releasing is the owner's act.** Claude prepares the candidate, the closing gate and the records; only the owner pushes `v1.0.0`, after signing off the phases in his own comments. A version tag set by an agent would claim a criterion that isn't met.
- **"One command" is defined, not assumed.** `sh scripts/stack-init.sh && docker compose up -d --wait` is one command line whose first part runs once. The definition is written in the README, the master plan and the final report, marked for the owner's review.
- **Isolation by process environment.** The fresh-clone test runs the README's line verbatim; it never edits a file to make it safe. The environment it gives the shell decides the project, the image tag and the ports, because Compose prefers the environment over `.env` and `COMPOSE_PROJECT_NAME` over the file's `name:`.
- **A random test is evidence only if its randomness is recorded.** One drawn seed per workspace and run, printed, applied with `fc.configureGlobal`, and reproducible with `FC_SEED`.
- **Documentation that a script checks stays true.** The architecture views are parsed by node id and compared with the code in every `pnpm verify`; prose and sequence diagrams are kept by review.
- **A demo is a test.** Each scene asserts what it shows; the recording is that test with a camera on, so nothing is staged that isn't asserted.
- **A success criterion is met when a check that could fail didn't.** Each criterion's falsifiability probe breaks the property on purpose in a throwaway worktree and shows the check go red for the right reason.
- **Plant time and wall time are different clocks.** The simulator's clock runs 60× faster than the wall clock; every time on a screen says which one it is.

## 2. Reading order

| #   | File                                                                                          | Look for                                                                                                    |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `docs/phases/phase-10-plan.md`                                                                | "Success criterion 1: what 'one command' means", "Success criterion 6 and the tag", the three review rounds |
| 2   | `docs/final-report.md`                                                                        | Each criterion's claim, evidence fields, probe and honest limits; the register of decisions                 |
| 3   | `scripts/stack-init.sh`, `scripts/required-secrets.ts`, `e2e/src/stack-init.test.ts`          | `umask 077`, `set -C`, the shared key list, the `od` fallback, "missing" and "weak" by name only            |
| 4   | `e2e/src/fresh-clone.ts`, `e2e/src/fresh-clone-checks.ts`, runbook "Fresh-clone test"         | The isolation environment, the placeholder `config` check, the Node-free `PATH`, the cleanup with `-p`      |
| 5   | `packages/fc-seed/src/`, runbook "Property seeds"                                             | `globalSetup` and `provide`/`inject`, `fc.configureGlobal`, `FC_SEED` in `turbo.json`                       |
| 6   | `docs/architecture.md`, `scripts/check-architecture.ts`, `e2e/src/check-architecture.test.ts` | Node-id prefixes, the marked views, why an edge's end needs a node line of its own                          |
| 7   | `config/scenarios/demo-v1.yaml`, `e2e/src/demo.ts`, `e2e/browser/demo/`, `docs/demo.md`       | Probe D1's margins, the scene log check, the recording's staging and limits                                 |
| 8   | `apps/web/src/domain/numbers.ts`, `apps/web/src/domain/time.ts`                               | The precision rule (R10-15), `plantTimeText` and `wallTimeText`                                             |
| 9   | `apps/mes-server/src/version.ts`, `CHANGELOG.md` (1.0.0), runbook "Releasing"                 | One product version, the candidate command, the docs-only check, the release notes' size limit              |
| 10  | `docs/phases/phase-10-report.md`, "The closing gate" and "Falsifiability probes"              | What each probe broke and which assertion failed                                                            |

## 3. Questions, with answers

### Release engineering

**1. Why is the release candidate a commit and not a release-candidate tag such as `v1.0.0-rc.1`?**

Because any version tag is a release act, and releasing is the owner's call (ADR-0011; the plan's alternative (b) was rejected for that reason). A commit hash names the tested code exactly and claims nothing. The candidate is found by a command, not chosen by hand: `git log -1 --first-parent --format='%H %s' origin/main -- . ':!docs' ':!CHANGELOG.md'`, the last first-parent commit that touches anything outside the documentation. For 1.0.0 it was first `dd78dcd`, PR #298's merge (P10-09); the fix P10-F3 moved it to `a32d71a`, PR #301's merge, because only a P10-F fix may change code after the candidate, and each such merge becomes the new one.

**2. What does the docs-only check prove, and why is its pathspec stricter than the plan's?**

That the commit the owner tags differs from the tested candidate in documentation only, so every run of the closing gate still describes the tagged code. `git diff --stat <candidate> <target> -- . ':!docs' ':!CHANGELOG.md'` must print nothing, and the candidate must be an ancestor of the target. The plan excluded `*.md` too, but `README.md` holds the quick-start block that the fresh-clone test runs verbatim: a README change after the candidate could change SC1's evidence without a new run. So every Markdown file outside `docs/` counts as code (P10-09's review, D1); only `docs/` and `CHANGELOG.md` may change after the candidate. P10-10's own pull request is checked the same way.

**3. Why one product version instead of `1.0.0` in every `package.json`?**

The workspaces are private and never published; a version in each would have to be kept in step and would mean nothing. What a user meets is the product: the tag, the CHANGELOG section, the MES's OpenAPI `info.version` and the gateway's `_sys` status. All four come from the root `package.json`. The MES and the gateway read it at start (there is no build step, ADR-0003, so no build-time constant), each through a small identical `version.ts`. Contracts keep their own versions (UNS 1.5, OPC UA address space 1.3, control API 1.11, `sim-summary/4`, …) because they version interfaces, which change at a different pace from the product.

**4. Why are the GitHub release notes only the summary of the 1.0.0 section?**

GitHub limits a release body to 125,000 characters, and the 1.0.0 section, which keeps every entry since Phase 0 unchanged, is about 200 KB. The notes are the section's summary by capability (everything above its first `###`) with a link to the full CHANGELOG at the tag. The command is in the runbook, so the owner doesn't have to cut the text by hand.

**5. Why was the CHANGELOG date left as `<date set at sign-off>`?**

Because the release date is the day the owner signs off and tags, which nobody knows yet. Writing today's date would make the CHANGELOG claim a release that hasn't happened. The docs-only pull request that records the sign-off replaces the placeholder.

### The fresh clone and its isolation

**6. Why couldn't "one command" be literally `docker compose up`?**

Compose interpolates `${VAR:?}` before any service runs, so it can't generate a secret it needs to interpolate, and a committed default secret would be shared by every clone (checklist S7). Probe F1 showed the old README failing exactly there: Compose refused to start, naming `OPCUA_GATEWAY_PASSWORD`, `OPCUA_READER_PASSWORD` and `SIM_CONTROL_TOKEN`. A one-shot service writing secrets into a volume, read through `*_FILE`, would make `up` alone enough, but it changes every service's secret handling in the release phase; it is deferred past v1.0. So the init writes `.env` once, and the README says plainly that the line's first part runs once.

**7. How can the test run the README's line verbatim on a stack whose Compose file says `name: shopfloor-twin`, without reaching the owner's project?**

By the order of precedence Compose applies. The process environment wins over `.env` in interpolation, and `COMPOSE_PROJECT_NAME` wins over the file's top-level `name:`. The harness gives the shell `COMPOSE_PROJECT_NAME=fresh-<hex>`, `IMAGE_TAG=fresh-<hex>` and a free port in every host-port variable, so the clone's `.env` stays exactly as the init wrote it and nothing in the clone is edited. Editing a file would have tested a different README from the one a user follows.

**8. The standing rule forbids `docker compose config` without `--no-interpolate`. Why may the fresh-clone harness run it, and only in one form?**

Because the interpolated output prints every secret. The harness needs it to prove, before anything is built, that the project resolves to `fresh-<hex>` and every image to `:fresh-<hex>`. It is allowed only with `--env-file <tmp>/placeholder.env`, a file outside the clone in which every secret is the literal `placeholder`, while the clone has no `.env` yet, and with the output parsed in memory, never printed. Round 3 of the plan's review removed a version that repeated the check with the clone's real `.env`: a failing exec's error message could have leaked it.

**9. Why does the README's line run with a `PATH` of links rather than the usual directories?**

The claim is "no Node.js, no pnpm". On a Homebrew machine `docker` and `node` usually live in the same directory, so a `PATH` of "the directories of the tools we need" would carry Node along and the check `command -v node` would fail for the wrong reason, or pass for the wrong one. A fresh directory of links to exactly `sh`, `git`, `docker`, the init's utilities and any configured credential helper proves the line needs nothing else. Compose itself is found through `~/.docker/cli-plugins`, so `HOME` and the Docker context are kept.

**10. Why does the clone live under `~/.cache/shopfloor-twin/fresh-clone/` and not the OS temporary directory?**

Colima shares only the home directory with its VM. A clone under `/var/folders/…` started a broker that never became healthy: the bind mount of `config/mosquitto` was empty inside the VM. The first failing run found it, and its cleanup removed everything it had made, which exercised the cleanup path for free (R10-9).

**11. What makes the cleanup safe even when the harness is interrupted?**

Every cleanup names the project explicitly (`docker compose -p fresh-<hex> down --volumes`) and refuses `shopfloor-twin` and the tag `dev`. A signal is passed to the harness's process group; the harness then starts nothing new except the cleanup's own commands. The review of PR #289 found that the first guard refused the cleanup's own `down` (it ran before the variable it checked was assigned); the fix marks the cleanup's two calls explicitly and tests that only they carry the mark.

**12. Why does `FRESH_CLONE_NO_CACHE=1` matter for the closing run, and what does it still not prove?**

A cached build can pass on layers a clean machine would have to build; `--no-cache --pull` rebuilds every image and re-pulls their bases. It does not empty the Docker host: the `db` and broker images are used as they are on the machine, and their digests are recorded. A truly clean machine isn't simulated; the record says so.

### Property seeds and `@shopfloor/fc-seed`

**13. Why print a seed if a failing fast-check run already prints one?**

Because a passing run is evidence too, and before P10-01 the evidence was "some random seeds passed". The Phase 9 close could only say the seeds were random and unrecorded. Now each `pnpm verify` prints `fast-check seed <workspace>: <seed>` once per workspace, so a reviewer can rerun exactly what passed, and a property that fails only in combination with others in the same workspace can be replayed with `FC_SEED`.

**14. Why one seed per workspace and run rather than one per property?**

One global seed, applied with `fc.configureGlobal`, needed no change to the 41 `fc.assert` calls, and one line per workspace keeps the log readable. Coverage across runs is as before: every run draws a new seed, so the properties explore new values each time; what changed is only that a run can be repeated exactly. An explicit per-call seed still wins, which is why the two `fc.sample` calls in `alarm-writes.test.ts` keep 156 and 1156.

**15. Why is the helper a new package, `@shopfloor/fc-seed`, and not part of `test-kit`?**

`test-kit` depends on `contracts` and `pki` and pulls in Testcontainers. `contracts` uses fast-check, so `contracts → test-kit → contracts` would be a cycle, and the pure packages would gain heavy dependencies. A leaf package with only `fast-check` and `vitest` has neither problem.

**16. Why is `FC_SEED` part of turbo's cache key, and what does a cached run print?**

A pinned seed changes what the tests do, so a result cached under one seed must not be replayed for another; listing it in the `test` task's `env` puts it into the hash. A drawn seed is not an input, so it isn't hashed, and a cached replay prints the log of the run that made the cache, including its seed, which is what that log reports. That is why the closing gate's three runs are uncached (`TURBO_FORCE=1`): each must draw and print its own.

**17. The closing gate's `pnpm audit --prod` failed on a test helper. Why did a test runner count as a production dependency, and why are peer dependencies the fix?**

`pnpm audit --prod` audits every workspace package's `dependencies`, whether or not anything ships it. P10-01 declared `vitest` and `fast-check` as `@shopfloor/fc-seed`'s `dependencies`, so when two moderate advisories against `@vitest/mocker` < 4.1.12 were published on 2026-10-21, the production audit reported them through `packages__fc-seed>vitest>@vitest/mocker`, although no image contains Vitest (the apps take `fc-seed` as a development dependency and install `--prod`). A test helper doesn't need its own copy of the test runner: it must run inside the consumer's. Declaring both as `peerDependencies` says exactly that (the consumer provides them, one copy per run), and `devDependencies` let the helper test itself; neither is a production dependency, so the audit no longer counts them. P10-F3 (#300) made that change and moved Vitest to the patched 4.1.12, which was past Renovate's three-day minimum release age. The candidate moved from `dd78dcd` to `a32d71a`, and the whole closing gate ran again: the first run's records stay as evidence that the gate can fail.

### Architecture as code

**18. How can a script check a diagram?**

By giving the diagram's nodes ids that name real things. Every service node is `svc_<name>`, every volume `vol_`, every MES module `mod_`, every package `pkg_`. `scripts/check-architecture.ts` reads the Mermaid blocks, collects the prefixed ids and compares them with `docker-compose.yml`'s services and volumes, the folders under `apps/mes-server/src/modules/`, the cross-module imports of their sources and the workspace `package.json` files. A renamed service or a new import fails `pnpm verify`. What it can't check, the labels, the sequences and the prose, is kept by review.

**19. Two mutants survived the script's first version. What were they, and what did they teach?**

Removing the node line of `svc_erp`, or of `vol_pki_ca`, while their edges stayed. Mermaid draws an edge's missing end as a bare box, so the diagram still showed something and the id still appeared. The rule became "a checked id needs a node definition of its own". It is Phase 9's lesson in a new place: a check is trusted only after it has been shown to fail on the wrong answer.

### The demo and its recording

**20. Why does the demo assert facts instead of comparing an event log?**

It is a live run: the MES dispatches the orders through OPC UA, and the time a `LoadOrder` arrives depends on the wall clock, so the event log differs between runs. What doesn't differ, inside the envelope probe D1 measured, are the facts each scene shows: the alarm, the episode, the completed order, the carton. The walkthrough asserts those against the MES's API and, where it matters, the simulator's truth, and the probe records each scene's margin in the worst variant.

**21. Why is the recording the same test with video on, in one browser page?**

So that the video can't show anything the test doesn't assert, and so that it is one continuous real run, waits included. Roles change by logging out and in on that page. Nothing is injected into the application's pages; captions live in a separate WebVTT file. The only additions are a 3 s hold on the last view of scenes 3 to 8 (R10-10), without any action on the page, so that a reader can see them.

**22. How were the size and length limits met, and why is the length limit 7 minutes, not 6?**

A 60 s probe extrapolated about 50 MiB for the whole walkthrough at 1280 × 720, four times the 12 MiB limit. The plan's fallbacks were taken in order: 960 × 540, then a scripted VP9 re-encode with Playwright's bundled ffmpeg, its parameters committed; the result is 4.79 MiB. Length is a different matter: the scenes need plant time 06:00 to 12:25, which at 60× is at least 6 min 25 s before any scene does its work. Meeting 6 minutes would have meant cutting asserted scenes or speeding the plant up beyond the real run. The coordinator set the limit at 7 minutes instead (R10-11, for the owner's review).

**23. How does the recording avoid leaking a password?**

Passwords are typed only into a field the helper first asserts to be `type="password"`, so the browser masks it. Frames at every login were checked. The control token never reaches the browser (nginx adds it). Before anything is published, `pnpm demo:record` searches the captions and its record for every secret of the run's env file and every user's password, and it stages the files and checks them before replacing `docs/demo/`.

### Honest success criteria

**24. Why is SC6 "not met" in a report that otherwise reads like a release?**

Because SC6 is "every phase closes with … owner sign-off", and the owner hasn't signed off Phases 4 to 10 (and Phases 2 and 3 are to confirm). Claude can prepare everything around the sign-off, but `gh` runs as the owner's account, so a comment from an agent session would look like his. The plan's answer is procedural: Claude never comments on, edits or ticks the owner's issue #286, every Claude comment starts with `Claude (coordinator):`, and no agent-session comment counts, whatever it says. Until the owner writes his own comments, the row stays "not met" and there is no `v1.0.0`.

**25. What is a falsifiability probe, and what counts as a good one?**

A deliberate break of the property a criterion claims, in a throwaway worktree that is never committed, run against the same check that proved the criterion. A good probe fails the check **at the assertion that guards the property**, not somewhere else. For SC2 the final report demanded the byte-identity assertion itself, not just a red suite, because a perturbation that makes the simulator throw would show only that the code can crash. For SC5 the probe dropped every second outbox entry stored while the broker was down, rather than all of them, so the test's earlier steps ("messages in the buffer", "facts in the buffer at the crash") still pass and the failure lands on the exactly-once comparison.

**26. Why is SC2 met "by the local gate, not CI", and why is that said in the criterion itself?**

The master plan says "golden-scenario test in CI". The job exists, but GitHub Actions hasn't run since PR #149 (the spending limit). The proof is the gate on the owner's machine, recorded with its commit and image digests. Writing the difference into the criterion's row, rather than into a footnote, keeps a reader from assuming a CI log exists that no one can open. The same goes for the two golden regenerations made without the owner's approval: SC2 is met by the test, with the snapshots' provenance pending the owner.

**27. Why does the report list 70-odd decisions for the owner rather than just the important ones?**

Because "important" is the owner's judgement, not the coordinator's. Under the standing instruction the coordinator took every decision the plans hadn't, so the work wouldn't stop. A register that lists each, with where it is recorded and a column for the owner's answer, lets him approve or reject each one; a rejection becomes an issue he marks release-blocking or not. Leaving some out would have decided for him that they didn't matter.

### Wall time and plant time

**28. Why did the console show `03:17:07Z` beside a header clock that said `06:17`?**

The console printed the simulator's time as raw UTC ISO, while the header shows plant time in the plant's zone (Istanbul, UTC+3). Both were the same instant in different notations, which a user can't tell at a glance. P10-F2 (#295) runs every console time through the header's own formatter (`plantTimeText`), so the console and the header say the same thing.

**29. Then why are some times now labelled "(wall time)"?**

Because they are a different clock, not a different notation. The simulator's plant clock runs at 60×, so after six wall minutes of the demo the plant is six hours ahead; and the demo's plant day is 12 October while the wall clock was on 22 October. A command's delivery, an ERP import, a hold's opening or an acknowledgement happen at a wall-clock instant: the contract fields say "Wall time". Formatting them like the plant clock (the first version of P10-F2) made a ten-day-old-looking event seem current. Now every wall-clock field is labelled, with the plant time beside it where one exists.

**30. Why is a leak reading shown as `3.381` and a control limit as `3.3812`?**

The characteristic carries its own precision: the leak test's `resolution` is 0.001 Pa/min, and every SPC value comes with its exact number of steps. A reading or a range of readings is shown with the resolution's decimals; anything averaged or estimated (X̄, centre lines, control limits, σ̂) with one decimal more, the usual SPC practice; Cpk with two. Values are rounded from the exact steps, half away from zero, never with `Number.toFixed` (`1.005.toFixed(2)` is `1.00` because the double is just below 1.005). Before the fix the SPC table showed `3.3810000000000002`, the double's noise (R10-15).

## 4. Hands-on exercise

Check the release's own claims by hand, without a stack.

1. Find the candidate: `git fetch origin && git log -1 --first-parent --format='%H %s' origin/main -- . ':!docs' ':!CHANGELOG.md'`. It should print `a32d71a…` (P10-F3's merge) until a later fix moves it.
2. Show that `main` differs from it in documentation only: `git diff --stat a32d71a origin/main -- . ':!docs' ':!CHANGELOG.md'` prints nothing; `git diff --name-only a32d71a origin/main` lists only files under `docs/`.
3. Copy `scripts/stack-init.sh` and `.env.example` into an empty directory under your home directory and run `sh stack-init.sh` there. Open the `.env` it wrote (it is throwaway): every `*_PASSWORD` and `*_TOKEN` has a 32-hex value. Delete the `SIM_CONTROL_TOKEN` line and run the init again: it names the key as missing and changes nothing. Delete the directory.
4. Run one workspace's tests twice with the same seed: `FC_SEED=123 pnpm --filter @shopfloor/sim-core test`, and note the printed line. Then run it without `FC_SEED` and see a new seed drawn.
5. In `docs/architecture.md`, find the node `svc_erp` in the container view. Without saving, think through what `pnpm check:architecture` would report if its node line were removed but its edges kept, and why the script requires a node line of its own.

## 5. Owner's answers and notes

_Optional; to be filled in by the owner._
