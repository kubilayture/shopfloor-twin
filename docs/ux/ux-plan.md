# UX overhaul plan

The issues that take the web app from the [audit](audit.md) to the [design system](design-system.md). One issue is one pull request under ADR-0011: an independent review, the local gate, the coordinator's squash merge. The coordinator creates the issues from this list; the ids here (UX-1a …) go in their titles.

## Rules for every issue

- **UI only.** No behaviour, API or contract change, except the issues marked _behaviour fix_ (UX-B1 … UX-B4), which change exactly what they name.
- **Test contracts.** Keep every `data-testid`, every `data-*` attribute a test reads (raw, #295), every accessible name and role that a spec or unit test uses. "Keep green" below lists what each issue touches: the test ids the browser specs read (from `e2e/browser/**`), the specs, and the colocated unit tests (`apps/web/src/**/*.test.ts(x)`), which also select by role and accessible name. A rename updates the specs in the same pull request and says so in its description.
- **Structural selectors and asserted texts.** Test ids are not the whole contract. The specs also count elements by type and id prefix (`article[data-testid^="machine-"]`), find sections by element id (`#line-title`, `#machines-title`), read cells by position (`td.nth(1)`, `tbody tr`, `li`), read child elements (`plant-clock`'s `<time>`), assert literal texts (`'30.0 min'`, `'(3)'` in `ack-selected`, `'You: working'`, `'OPC UA offline'`, `'Enable'`) and assert that some ids stay **absent** (`operator-name`, `coded-by`, `note-author`, `order-read-only` for supervisors, `nav-console` for operators). Each issue lists the ones it touches under "Structural selectors and asserted texts"; the list was taken by grepping `e2e/browser` for `locator(`, `nth(`, `toHaveText(`, `toContainText(`, `textContent()` and `toHaveCount(0)`, and an issue re-greps before it merges.
- **Every state** of each touched screen: loading (skeleton), empty, error, not found where the URL holds an id, data-rich, and each role's view (read-only roles included).
- **Responsive:** checked at 1440, 1280, 1024, 768 and 390; no horizontal page scroll except inside a table's or chart's own frame.
- **Accessibility:** WCAG 2.2 AA per design system section 7; keyboard-only once through the screen; no new axe serious or critical findings on the touched routes, read from the harness report (UX-1g) once it lands.
- **Screenshots:** before and after at 1440 and 390 (and 1280 for list-and-detail screens) in the pull request description, taken on a disposable stack (the UX-1g harness produces them), never by changing the owner's `shopfloor-demo` data.
- **Gate:** the runbook's rerun table ("Merge gate"). For `apps/web` that is `GATE_STEPS=verify,smoke,reconcile pnpm gate`; plus `pnpm test:console` when `apps/web/src/screens/console*` changes; plus `pnpm demo` when a screen or shared component the demo walks through changes (overview, alarms, downtime, OEE and line OEE, orders, SPC, holds, traceability, console, the shell, and the primitives they use); plus, beyond the table, `pnpm test:resilience` when the connection status or the overview's state badges change, since `e2e/browser/resilience/recovery.spec.ts` reads both. A change under `e2e/` adds the `e2e/` row (`verify,reconcile`, inside the above). Each suite runs alone under the heavy lock on disposable projects; the host keeps ≥ 25 GiB free.
- **Closes:** each issue lists the audit ids it resolves; the reviewer checks them against the after screenshots.

## Decisions taken in UX-0

- **No headless UI dependency.** Every primitive is built in-house on native `<dialog>`, the Popover API, `inert`, `<details>` and native `<select>` (design system 4.14, with the supported-browser matrix: Safari and iPadOS 17 or later). So no ADR issue is needed now; an issue that later wants a library writes the ADR first.
- **Dark mode is in scope:** tokens carry both themes from UX-1a, the switch ships in UX-12 once every screen is on tokens (design system section 8).
- **List and detail:** the detail is a side panel only from 1440 px; below, including 1280 where the specs and the demo run, it is a sheet (design system 3.4).
- **Behaviour defects found by the audit** get their own small issues (UX-B1 … UX-B5) that can merge before the foundation, so the blockers that are bugs do not wait for the redesign.
- **A visual and accessibility harness lands early** (UX-1g, right after the shell), report-only, so every later pull request has axe results and five-width screenshots of the routes it touches; UX-F1 turns it into a failing check.

## Order and dependencies

```
UX-B1 … UX-B5            independent, any time (B1 before UX-1f and UX-9a; B2 before UX-4a; B3 before UX-7)

UX-1a tokens + icons
  └─ UX-1c actions and status (Button, Badge, Callout, Card, Stat, formatters, data-decimal)
       ├─ UX-1b shell, nav, page header ── UX-1g harness (report-only)
       └─ UX-1e feedback and overlays (Dialog, Toast, Empty, Skeleton, Error, NotFound, Tooltip, Menu)
            ├─ UX-1d1 DataTable and Tabs
            ├─ UX-1d2 fields and PlantTimeInput
            └─ UX-1f chart theme (also after UX-B1)

UX-2 … UX-11             after the foundation pieces each uses (listed per issue); UX-2 first, as the pattern
UX-12 dark theme         after UX-2 … UX-11
UX-F1 a11y gate ── UX-F2 CSP ── UX-F3 review and re-recording   (UX-F2 can also merge any time)
```

UX-1b and UX-1e can be reviewed in parallel once UX-1c is in; so can UX-1d1, UX-1d2 and UX-1f once UX-1e is in.

---

## Behaviour fixes (any time)

### UX-B1 SPC chart: every point drawn, rule labels apart (_behaviour fix_)

- **Closes:** C-03 (blocker), C-02.
- **Scope:** reproduce first. The cause is unknown: `showAllSymbol` has no effect on the time axis the SPC charts use in ECharts 6.1; the suspect is the symbol animation restarting when live updates call `setOption(…, { notMerge: true })` in `chart/echarts-view.tsx`. Then fix in `chart/echarts-view.tsx` and/or `chart/spc-options.ts` (for example merge updates instead of replacing the option, or `animation: false` on the series), and give the rule labels a lane with `labelLayout.hideOverlap`. A test file under `apps/web/src/chart/`.
- **Acceptance:** a rendered check, not an option check: a unit test renders the I chart with ECharts' server-side renderer (`echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })` then `renderToSVGString()`) and counts the point symbols in the SVG, once after the initial option (500 readings: 500 symbols, provisional ones hollow) and again after a live update applied the way `EChartsView` applies it (still every symbol). The test fails on today's code before the fix. Rule labels do not overlap at 1440, 1024 or 390 (screenshots); the table under each chart unchanged.
- **Keep green:** `chart/spc-options.test.ts`, `screens/spc.test.tsx`; browser: `spc-chart-page`, `spc-baseline`, `signal-row-*` in `demo/walkthrough.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `final/alarm-actions.spec.ts`.
- **Structural selectors and asserted texts:** `spc-baseline` `data-baseline`, the chart page's `data-limits` (walkthrough 605–612).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** –.

### UX-B2 Alarm raise times with their date (_behaviour fix_)

- **Closes:** A-01 (blocker).
- **Scope:** `apps/web/src/screens/alarm-list.tsx` (the Raised column and the history list), `domain/time.ts` (one helper), tests.
- **Acceptance:** one rule: a row whose time is on the plant clock's current day shows the time only ("07:15:00"); any other row shows the date and time ("Mon 12 Oct, 07:15:00"). Every row's `<time>` has the full instant in `dateTime` and the full plant date and time in its `title` (tooltip). Unit tests for today, yesterday and an instant just after plant midnight.
- **Keep green:** `screens/alarm-list.test.tsx`, `domain/time.test.ts`; browser: `alarm-list`, `alarm-row-*`, `ack-*`, `details-*` in `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`.
- **Structural selectors and asserted texts:** none on the time text; `alarm-row-*` `data-state`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** –.

### UX-B3 Terminal: no "Offline" before sign-on (_behaviour fix_)

- **Closes:** X-03.
- **Scope:** `apps/web/src/screens/terminal.tsx` (`TerminalHeader` renders `ConnectionStatus` only for a signed-on terminal session), `terminal.test.tsx`.
- **Acceptance:** the sign-on page shows the plant clock and no connection state, also with a desk session in the browser; once signed on the status reads "Live" as today. Unit tests for both.
- **Keep green:** `screens/terminal.test.tsx`; browser: `connection-status` on the terminal (`quality/live/spc-terminal-live.spec.ts` waits for `data-status="open"` after sign-on) and the `terminal-*` ids in `orders/live/terminal-live.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `login.ts`.
- **Structural selectors and asserted texts:** `terminal-signals` keeps `aria-live="polite"`.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** –.

### UX-B4 Show offline instead of loading forever (_behaviour fix_)

- **Closes:** G-20.
- **Scope:** `apps/web/src/app.tsx` (query and mutation defaults `networkMode: 'always'`), `live/live-context.tsx` (the browser's `offline` and `online` events mark the live connection lost and found), an offline bar in the shell (restyled later by UX-1e), tests.
- **Acceptance:**
  - Reads: with the network cut, a screen opened shows its `QueryError` within the retry budget (about 10 s); the header reads "Offline" and a bar says since when the figures stopped updating; when the network returns, the bar goes, queries refetch and the status returns to "Live" without a reload.
  - Writes: a write sent while offline fails at once with the network error shown where that form shows a refused write today (`FailureMessage` or the form's message element); it is never queued and never retried automatically; the draft stays in the form (and counts as unsaved input, so a session lost meanwhile keeps the page); the user sends it again when back online.
  - Unit tests with fake `offline`/`online` events, for a query and a mutation.
- **Keep green:** `live/live-context.test.tsx`, `live/live-client.test.ts`, `api/client.test.ts`, `auth/auth.test.tsx`; browser: `connection-status` in `resilience/recovery.spec.ts`, `1-oee-live.spec.ts`, `2-alarms-live.spec.ts`, `3-overview.spec.ts`.
- **Structural selectors and asserted texts:** `connection-status` `data-status` values (`open` …) unchanged.
- **Gate:** `verify,smoke,reconcile`; `pnpm test:resilience`.
- **Depends on:** –.

### UX-B5 Alarm KPI hours missing from a running shift (investigation)

- **Closes:** K-02 (or turns it into a MES issue).
- **Scope:** find whether `GET /api/v1/alarms/kpi?bucket=hour` omits hours without facts by design (then the screen fills the shift's hours with rows marked "no raises", as OEE does) or loses them (then a `mes-server` issue with a failing test). No code until the cause is known; the finding goes to the coordinator.
- **Acceptance:** a written finding with the request, the response and the code path; a follow-up web issue (UI only) or a MES issue.
- **Keep green, structural selectors:** –.
- **Gate:** none (no code).
- **Depends on:** –.

---

## UX-1 Foundation

### UX-1a Design tokens and icons

- **Closes:** foundation for G-07, G-09, G-12, G-13, G-15, G-22, G-28.
- **Scope:** `apps/web/src/index.css` (`@theme` tokens of design system section 2: colour light and dark, type, spacing, radius, shadow, z-index, motion, the `wide` breakpoint; the dark values under `:root[data-theme='dark']`, unused until UX-12; the focus ring and the G-22 rule `h1[tabindex='-1']:focus-visible, main[tabindex='-1']:focus { outline: none }`), `components/ui/icons.tsx` (the in-house SVG set), `scripts/check-ui-tokens.ts` (lists raw palette classes and hex colours per file under `apps/web/src`, report only), `apps/web/README.md` (a "Design system" paragraph).
- **Acceptance:** every token exists as a CSS variable and a Tailwind utility (a unit test over a token map checks names, values and every contrast pair of design system sections 2 and 8, recomputed); icons render with `aria-hidden` and `currentColor`; no screen changes appearance except that a heading focused after navigation no longer shows a ring (screenshots of three screens before and after); the check script prints the raw-colour count per file.
- **Keep green:** all web unit tests; no browser spec reads styles.
- **Structural selectors and asserted texts:** none touched.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** –.

### UX-1c Primitives: actions and status

- **Closes:** foundation for G-09, G-10, G-11, G-12, G-13, G-15, G-16, G-17; prepares E-02.
- **Scope:** `components/ui/`: `Button`, `IconButton`, `Badge`, `Card`, `Stat`, `KpiTile`, `Callout`, `Code`, `DescriptionList`; the domain badges re-based on `Badge` with today's names and attributes (`state-badge.tsx` with the `StaleTag` beside it, its full reason visible, `priority-badge.tsx`, `order-badges.tsx`, the `quality-ui.tsx` badges, new `FinalityBadge` and `LossBadge`); `domain/states.ts` palette on the tokens (design system 2.4); the formatting components `Duration`, `PlantTime`, `WallTime`, `Percent`, `Ratio`, `Quantity`, `Missing`. **`data-decimal`**: a raw four-decimal attribute added to every ratio element (`RatioValue`, `RatioHeadline` in `oee-ui.tsx`, the order OEE, FPY and line OEE values in `order-oee.tsx` and `line-oee.tsx`), additive only: no visible text changes here.
- **Acceptance:** each component's variants, sizes and states (disabled never by opacity, loading with `aria-busy`), accessible name and focus are unit-tested; badges keep `data-state`, `data-priority`, `data-status` raw and their visible words; the state and priority badges change look on every screen at once (screenshots of overview, alarms, orders, holds); `data-decimal` equals today's visible decimal on every ratio element (unit tests); `Missing` renders "—" with a visually hidden reason; durations follow design system 6.1.
- **Keep green:** `order-status`, `order-flags`, `command-state`, `hold-state`, `signal-status`, `flag-explanations`, `state-*`, `data-fraction`; unit tests `domain/states.test.ts`, `domain/orders.test.ts`, `domain/time.test.ts`, `domain/numbers.test.ts`, `overview.test.tsx`, `orders.test.tsx`, `order-oee.test.tsx`, `oee-dashboard.test.tsx`, `holds.test.tsx`, `spc.test.tsx`, `alarm-list.test.tsx`; the browser specs reading `order-status` (`demo/walkthrough`, `orders/dispatch/1-roles`, `orders/dispatch/2-release-dispatch`, `orders/final/1-terminal-close`, `quality/final/1-trace-holds-close`) and `data-state` / `data-status`.
- **Structural selectors and asserted texts:** the badge words read by specs (`order-status` text is not asserted, its `data-status` is); `stale-<id>` keeps its test id and its whole visible text, exactly "Stale: live connection lost" or "Stale: from an earlier run" (`overview.test.tsx` 102 and 113), never shortened to "Stale" with the reason in a tooltip; the ratio texts stay as today (walkthrough 483–485, `1-order-line-oee.spec.ts` `ratio()`).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:resilience` (the state badges change).
- **Depends on:** UX-1a.

### UX-1b App shell, grouped navigation and page header

- **Closes:** G-01, G-02, G-03, G-04, G-05 (blocker), G-06 (pattern), X-04 (the picker side).
- **Scope:** `screens/root-layout.tsx` (top bar, side nav by job and role with real group headings, the drawer below `xl`, active state for sub-routes, `print:hidden` and the print offset), `components/ui/page-header.tsx`, `components/ui/section.tsx`, `components/ui/use-page-title.ts`, `auth/shell.tsx` (`SessionPending` inside a minimal shell; the idle warning and re-login cover on the tokens); unit tests. `NotFound` is not here (UX-1e).
- **Acceptance:**
  - At ≥ 1280 the side nav shows four groups (Monitor, Production, Quality, Admin) under visible `h2` headings, only the links the role may use, empty groups hidden; below 1280 a menu button opens the same nav as a drawer (focus moves in, Escape and backdrop close it, focus returns, `inert` when closed; containment checked in a real browser by UX-1g).
  - The current route's link is active on every sub-route (`aria-current="page"` exact, `"true"` below; `nav-active` background with white text 9.46:1 and the `#38bdf8` bar); Alarms and Alarm KPIs told apart.
  - The top bar is one 48 px row at every width; roles leave it; Log out stays visible.
  - Every route sets `document.title` to "<page> · ShopFloor Twin" (G-05); a unit test walks the routes.
  - `PageHeader` per design system 3.3, adopted by the overview only as the reference.
  - Print: the shell hides itself and `main` drops the nav offset (a print-preview screenshot of the shift report).
  - Screenshots at all five widths for the operator, quality and admin roles.
- **Keep green:** `nav-*` (every link, text unchanged), `user-menu`, `nav-account`, `signed-in-user`, `logout`, `plant-clock`, `connection-status`, `app-page`, `relogin`, `relogin-other`, `idle-warning`, `stay-signed-in`, `login-reason`; unit tests `auth/auth.test.tsx`, `screens/login.test.tsx`, `overview.test.tsx` (`plant-clock` text), `console.test.tsx` (`nav-console` present and absent), `alarm-list.test.tsx` and `shift-report.test.tsx` (click `nav-overview`, `nav-alarms`, `nav-shifts`), `trace.test.tsx` (`nav-trace` `aria-current="page"`), `spc.test.tsx` (`nav-spc`), `terminal.test.tsx` (`nav-terminal`); browser `login.ts`, `demo/demo.ts` (logout), `demo/walkthrough.spec.ts`, `console/2-actions.spec.ts`, `console/4-effects.spec.ts`, `console-shift/absence.spec.ts`.
- **Structural selectors and asserted texts:** `plant-clock` keeps its `<time>` child (walkthrough 210) and the "Gebze plant time" text; `nav-console` absent for an operator (`console/2-actions.spec.ts` 191); `signed-in-user` text is exactly the username (`login.ts` 83).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (its specs click `nav-console`); `pnpm test:resilience` (the connection status moves).
- **Depends on:** UX-1a, UX-1c.

### UX-1e Primitives: feedback and overlays

- **Closes:** foundation for G-19, G-21, G-29, G-31, G-32, H-03, K-04, N-05, N-07.
- **Scope:** `components/ui/`: `Dialog` (modal and sheet), `ConfirmDialog`, `Toast` and its region, `EmptyState`, `Skeleton` (300 ms delay), `ErrorState` (`components/query-error.tsx` keeps its name and props), `NotFound` (and the router's "Page not found" on it), `Forbidden` (the console's and users' no-permission view, keeping their text), `Tooltip`, `InfoTip`, `Disclosure`, `SectionNav`, `Menu`, `SegmentedLinks`; the offline bar of UX-B4, the idle warning and the re-login cover restyled; `src/test/setup.ts` stubs for `showModal`/`close`, the Popover methods and `inert` (design system 4.14); unit tests.
- **Acceptance:** `Dialog` sets `aria-labelledby`/`aria-describedby`, calls `showModal`, returns focus to the opener; `ConfirmDialog` repeats the verb; `Menu` follows the menu-button pattern (arrows, Home/End, type-ahead, Escape, focus return); `SegmentedLinks` renders links with `aria-current`; toasts announce politely (alarm tone assertively) and pause on hover and focus; `Skeleton` has `role="status"` with the loading text the screens use today; `QueryError` offers "Try again" only for retryable errors; reduced motion honoured. Unit tests for each over the jsdom stubs; focus containment, `inert` and light dismiss are checked in Chromium by the UX-1g harness on a gallery route or the first screen that uses them.
- **Keep green:** every unit test that finds a "Loading …" text or a `QueryError` (`oee-dashboard.test.tsx`, `orders.test.tsx`, `machine-detail.test.tsx`, `alarm-kpi.test.tsx`, `shift-report.test.tsx`, `trace.test.tsx`, …); `relogin`, `relogin-other`, `idle-warning`, `stay-signed-in` (`auth/auth.test.tsx`, `login.test.tsx`); `console-forbidden`, `users-forbidden`.
- **Structural selectors and asserted texts:** `console-forbidden` contains `sim:control` (`console/2-actions.spec.ts` 193).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` (the loading, error and empty states of demo screens change look).
- **Depends on:** UX-1c.

### UX-1d1 Primitives: DataTable and Tabs

- **Closes:** foundation for G-14, G-27, G-30, G-33.
- **Scope:** `components/ui/data-table.tsx` (alignment, numeric cells, the two sticky-header modes of design system 4.5, row tone, active row, selection with native `indeterminate`, row actions, focus after a row disappears, "Skip to the details", empty, paging, narrow `scroll`/`stack`), `components/ui/tabs.tsx`; `quality-ui.tsx`'s `Table` re-based on `DataTable` (export kept until the last screen stops importing it); unit tests.
- **Acceptance:** `caption`, `th scope="col"`, `rowTestId` and `data-*` per row, `data-count` kept; tabs move by arrows with a roving tab index; select-all `indeterminate` when some rows are selected; focus moves to the next row's action when a row disappears (unit test); the header sticks in both modes (checked in Chromium by the harness: a long table that fits and one that scrolls sideways); 24 px hit areas.
- **Keep green:** unit tests of the screens using `quality-ui` (`spc.test.tsx`, `holds.test.tsx`, `trace.test.tsx`); browser `data-count` reads (`final/alarm-actions.spec.ts` 174).
- **Structural selectors and asserted texts:** `quality-ui` tables keep `table` → `tbody` → `tr` → `td` (positional reads elsewhere depend on real table markup, never a grid of divs).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` (the quality tables are on demo screens).
- **Depends on:** UX-1e.

### UX-1d2 Primitives: fields and PlantTimeInput

- **Closes:** foundation for G-23, D-05, N-02, C-07, L-01.
- **Scope:** `components/ui/`: `Field`, `TextInput`, `Textarea`, `Select`, `Checkbox`, `CharacterCount`, `FilterBar`, `PlantTimeInput`; `quality-ui.tsx`'s `inputClass`, `buttonClass`, `primaryClass` and `CommentInput` re-based on them (exports kept for now); unit tests.
- **Acceptance:** every control has an `id` and a `name`; errors set `aria-invalid` and `aria-describedby`; `PlantTimeInput` parses and formats in the plant zone, shows the UTC instant, and **also accepts a whole value typed or filled into its time field** (`hh:mm:ss`, as `final/downtime-coding.spec.ts` fills `split-at`) and, in its console variant, an ISO 8601 string (as the console specs fill `failure-at`, `drift-until`): unit tests across plant midnight; 24 px hit areas.
- **Keep green:** `CommentInput` users (`spc.test.tsx`, `holds.test.tsx`).
- **Structural selectors and asserted texts:** the fill formats above; `hold-reason` stays a native `<select>` whose `option` elements a spec lists (`quality/final/1-trace-holds-close.spec.ts` 245).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1e.

### UX-1f Chart theme

- **Closes:** G-25 (foundation), E-05, E-07, K-03.
- **Scope:** `chart/theme.ts` (tokens read at run time, the ECharts theme `shopfloor`, the uPlot options helper), `chart/echarts-view.tsx` (registers and applies it, `animation: false`, `tooltip.renderMode: 'richText'`), `chart/uplot-chart.tsx`, `chart/oee-options.ts`, `chart/alarm-options.ts`, `chart/spc-options.ts` (colours and fonts from the theme; label wrapping; no zero labels), `chart/echart.tsx` (an `EmptyState` when there is no data); unit tests on the options.
- **Acceptance:** every chart follows design system section 5; no hex colour left in `chart/`; tooltips render as rich text (no HTML tooltip node: a unit test on the option, and no inline-style CSP report in the harness); category labels wrap to two lines; empty charts show an empty state at the chart's height; the `role="img"` description states the main reading; screenshots of the OEE, alarm KPI, SPC, shift report and machine charts before and after.
- **Keep green:** `chart/oee-options.test.ts`, `chart/alarm-options.test.ts`, `chart/spc-options.test.ts` (series names, symbols, `emptyCircle` for provisional), UX-B1's rendered symbol test, `oee-dashboard.test.tsx`, `alarm-kpi.test.tsx`; browser `pareto`, `pareto-*`.
- **Structural selectors and asserted texts:** the Pareto table beside the chart keeps its cells (walkthrough 482: `td.nth(2)` reads `'30.0 min'`).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1a, UX-1e, UX-B1.

### UX-1g Visual and accessibility harness (report-only)

- **Closes:** makes G-05, G-33 and the a11y rules measurable from here on.
- **Scope:** `e2e/browser/a11y/` (its own Playwright project, `a11y`, run by the reconciliation harness after its passes, so the stack has data and one user per role, and **only when opted in** with `RECONCILE_A11Y=1`; off by default so the reconciliation gate of unrelated pull requests stays as fast as today; a UX pull request sets it and records the run; time budget 15 minutes, past which the project stops and reports what it covered): every route in its data-rich, empty and not-found state, as each role, at 1440, 1280, 1024, 768 and 390; axe with the WCAG 2.2 A and AA rules on each; a screenshot of each; a check that each route's `document.title` is distinct; Tab-order and focus-visibility sampling (as the UX-0 keyboard pass did); for each overlay the first screens use (nav drawer, dialogs, sheets, menus, tooltips) a containment, `inert`, Escape and outside-click check. Writes `e2e/results/a11y/report.json` and the screenshots; **does not fail** on findings (it fails only if it cannot run). `@axe-core/playwright` as an e2e dev dependency (entry in `docs/dependencies.md`; the pnpm `minimumReleaseAge` policy applies; test-only like Playwright, so no ADR); `docs/runbook.md` (the project in the reconciliation's description, where the report lands).
- **Acceptance:** the report lists every route × width × role with its axe findings by impact and a screenshot path; the baseline report (before the screens migrate) is attached to the pull request; later UX pull requests attach their diff of it.
- **Keep green:** the reconciliation's existing passes unchanged (the new project runs after them and reads only).
- **Structural selectors and asserted texts:** none (it reads pages, asserts nothing of theirs).
- **Gate:** `verify,smoke,reconcile` (the `e2e/` row, `verify,reconcile`, plus `smoke` for the dependency).
- **Depends on:** UX-1b.

---

## UX-2 … UX-11 Screen migrations

Each moves its screens onto the shell, `PageHeader`, the primitives and the content rules, deletes their local `buttonClass`/`inputClass` constants, and attaches the UX-1g report diff for its routes.

### UX-2 Overview and machine detail

- **Closes:** O-01 … O-05, M-01 … M-06, G-13 (on these screens).
- **Scope:** `screens/overview.tsx`, `screens/machine-detail.tsx`, `domain/timeline.ts` (axis ticks with dates), metric display names from the plant model already in the API (no API change).
- **Acceptance:** a summary strip (machines per state; abnormal first) and machine cards with an abnormal left bar and, when stale, the `warn` outline Stale tag with its full reason visible; names before codes, causes as words; the range switch as `SegmentedLinks`; the timeline axis has hourly ticks and dates when the range spans days; telemetry names readable, a stale latest value says how old it is; empty charts as empty states; an unknown machine is a `NotFound`; all states and widths.
- **Keep green:** `machine-*`, `state-*`, `connection-status`; `overview.test.tsx`, `machine-detail.test.tsx` (the range links by role link with `aria-current`), `domain/timeline.test.ts`, `domain/plant.test.ts`; browser `3-overview.spec.ts`, `demo/walkthrough.spec.ts`, `resilience/recovery.spec.ts`, `final/downtime-coding.spec.ts`.
- **Structural selectors and asserted texts:** the walkthrough counts `article[data-testid^="machine-"]` (196): machine cards stay `article` elements, and the summary strip must not use an id starting with `machine-` (use `overview-summary`, `summary-state-*`); `state-*` `data-state="no-data"` before the first report; `stale-<id>` present only when stale, with the exact visible text "Stale: live connection lost" or "Stale: from an earlier run" (`overview.test.tsx` 102 and 113); machine detail's tables (time per state, intervals, metrics) on `DataTable`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:resilience`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f.

### UX-3 OEE dashboard and line OEE

- **Closes:** E-01 … E-08, G-15 and G-16 on these screens.
- **Scope:** `screens/oee-dashboard.tsx`, `screens/line-oee.tsx`, `components/oee-ui.tsx`; `e2e/browser/demo/walkthrough.spec.ts` lines 483–485 moved from the visible text to `data-decimal` (same assertions: `/^0\.\d{4}$/` and `'1.0000'`).
- **Acceptance:** KPI tiles with percentages, the decimal in `data-decimal`, the exact fraction in `data-fraction` and the tooltip; finality once per section; the idle-shift line card as an empty state with its reason; the machines table on `DataTable` with numeric columns and the narrow layout; waterfall signs fixed; all states and widths.
- **Keep green:** `oee-card-*`, `bottleneck-*`, `oee-machine-*`, `pareto`, `pareto-*`, `line-oee-card`, `line-oee-value`, `line-bottlenecks`, `line-bottleneck-*`, `data-fraction`, `data-decimal`, `data-final`; `oee-dashboard.test.tsx`, `live/live-oee.test.ts`, `live/live-line-oee.test.ts`; browser `1-oee-live.spec.ts`, `final/downtime-coding.spec.ts`, `orders/oee/1-order-line-oee.spec.ts`, `demo/walkthrough.spec.ts`.
- **Structural selectors and asserted texts:** walkthrough 482–485: within `oee-machine-*` / `pareto-*` rows, `td.nth(1)` (the ratio, now via `data-decimal`) and `td.nth(2)` (`'30.0 min'`): the column order and real `td` cells stay; 495 `[data-testid^="line-bottleneck-"]`; 508–509 the sections keep the element ids `line-title` and `machines-title` on their headings; `1-order-line-oee.spec.ts` 94 and 101 `[data-testid^="line-bottleneck-"]`, `[data-testid^="bottleneck-"]`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` (and the `e2e/` row, inside it).
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f.

### UX-4a Alarm list

- **Closes:** A-02 … A-06, G-26, G-27 and G-33 on this screen, G-10 (Acknowledge selected).
- **Scope:** `screens/alarm-list.tsx`.
- **Acceptance:** `Tabs`; `DataTable` with priority, the unacknowledged row bar and bold, row actions side by side, selection; the detail as a sticky side panel from 1440 and a sheet below (1280 included); "Skip to the details"; focus to the next row after an acknowledgement removes a row; the stacked layout at 390; shelving and comments on `Field`s; names first.
- **Keep green:** `alarm-list`, `alarm-list-empty`, `alarm-row-*`, `ack-*`, `details-*`, `select-all`, `ack-selected`, `alarm-panel`, `close-alarm`, `alarm-state`, `alarm-history`, `history-entry`, `comment`, `comment-text`, `add-comment`, `shelve`, `shelve-reason`, `shelve-duration`, `shelf-state`, `unshelve`, `tab-*`, `flood-banner-*`; `alarm-list.test.tsx`, `live/live-alarms.test.ts`; browser `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`, `console/effects.ts`.
- **Structural selectors and asserted texts:** `ack-selected` contains `(N)` (`final/alarm-actions.spec.ts` 184: the label stays "Acknowledge selected (N)"); `alarm-history` contains `by <actor>` (254); `comment` contains the comment text (152); `alarm-list` `data-view`, `data-count`; rows' `data-state`, `data-shelved`; `alarm-row-*` absent after acknowledgement.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (`console/effects.ts` reads the alarm list).
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-B2.

### UX-4b Alarm KPIs

- **Closes:** K-01, K-03, K-04, and K-02's display once UX-B5 decides it.
- **Scope:** `screens/alarm-kpi.tsx`.
- **Acceptance:** per scope a `KpiTile` with the average per 10 min and its EEMUA verdict as the headline, the other measures in a compact list; the hourly table on `DataTable`; empty floods and bad actors as empty states; the chart on the theme.
- **Keep green:** `kpi-card-*`, `kpi-operator`; `alarm-kpi.test.tsx`; browser `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`.
- **Structural selectors and asserted texts:** inside `kpi-operator`, the element `[data-measure="acknowledged"]` whose text is exactly the count (`final/alarm-actions.spec.ts` 315): keep the attribute on the value element and no unit or label inside it.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f, UX-B5.

### UX-5a Downtime coding

- **Closes:** D-01 … D-05, G-26 and G-33 on this screen.
- **Scope:** `screens/downtime-coding.tsx`.
- **Acceptance:** `DataTable` with state and loss badges, durations by the content rule, no wrapping in time and length columns at 1280; the coding panel as side panel from 1440 and a sheet below; "Skip to the details"; the split time on `PlantTimeInput`; "View" for roles without `downtime:code`.
- **Keep green:** `machine-filter`, `downtime-row-*`, `code-*`, `coding-panel`, `reason-picker`, `segment-comment`, `split-at`, `split`, `save-coding`, `coding-message`, `draft-conflict`, `audit`, `audit-entry`; `downtime-coding.test.tsx`, `domain/downtime.test.ts`; browser `final/downtime-coding.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`.
- **Structural selectors and asserted texts:** `split-at` accepts `fill('hh:mm:ss')` (112); two `reason-picker` native selects after a split, read by `nth(0)`/`nth(1)`; `coded-by` and `draft-conflict` stay absent (119, 122); `audit-entry` contains `coded by <user>` (127); `coding-message` `data-kind="saved"`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e.

### UX-5b Shift reports and handover notes

- **Closes:** S-01, S-02, R-01 … R-05.
- **Scope:** `screens/shift-list.tsx`, `screens/shift-report.tsx`, `screens/handover-notes.tsx`, `components/shift-picker.tsx`; the print rules in `index.css` kept and checked.
- **Acceptance:** the list as a `DataTable` (shift, state, finality, revision only when above 0); the report with a `SectionNav`, ratios as percentages like UX-3, names as on alarm KPIs; notes on `Field`s; the A4 print one section per page where it fits, the chart snapshot present, no raw epoch in the printed header (a PDF in the pull request).
- **Keep green:** `shift-report`, `report-revised`, `shift-select`, `handover-notes`, `new-note`, `note-category`, `note-text-input`, `add-note`, `cancel-note`, `new-note-message`, `note-*`, `note-text-*`, `edit-note-*`, `note-editor-*`, `save-note`, `reload-note`, `note-history-*`, `note-history-toggle-*`, `note-history-entry`, `note-limit`, `note-retracted`, `note-stale`, `notes-empty`, `notes-read-only`; `shift-report.test.tsx`, `handover-notes.test.tsx`, `live/live-shifts.test.ts`, `domain/shifts.test.ts`; `e2e/src/reconcile.ts` (reads `shift-report`); browser `final/shift-report.spec.ts`.
- **Structural selectors and asserted texts:** `shift-report` `data-final`, `data-revision-inputs`, `data-inputs`; notes' `data-version`; `note-text-*` text is exactly the note (110); `note-author` stays absent.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-1f.

### UX-6a Order list and order detail

- **Closes:** P-01, P-02, Q-01 … Q-03, Q-05 … Q-08, G-21 (orders).
- **Scope:** `screens/order-list.tsx`, `screens/order-detail.tsx`.
- **Acceptance:** the list on `DataTable` (priority as a badge, overdue marked); the detail with `PageHeader` (status badges, the primary action beside them, more in a `Menu` only where no spec clicks them by id), a `DescriptionList` flowing by column, `SectionNav`, numeric columns right-aligned, ERP messages as a table with a payload disclosure per row, history with "(wall time)" and request ids in a disclosure; read-only roles see a one-line callout; an unknown order is a `NotFound`.
- **Keep green:** `order-row-*`, `order-link-*`, `order-status`, `order-flags`, `order-read-only`, `action-*`, `action-done`, `command-*`, `command-confirmed`, `command-state`; `orders.test.tsx`, `live/live-orders.test.ts`, `domain/orders.test.ts`; browser `orders/dispatch/1-roles.spec.ts`, `orders/dispatch/2-release-dispatch.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `demo/walkthrough.spec.ts`, `console/2-actions.spec.ts`.
- **Structural selectors and asserted texts:** `order-status` `data-status` values; `order-read-only` present for operators and absent for supervisors, `action-*` absent where the role cannot act (`orders/dispatch/1-roles.spec.ts`); every `action-*` a spec clicks stays a visible button.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (its actions spec opens an order).
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1e.

### UX-6b Order actions and order OEE

- **Closes:** Q-04, G-11 (order actions), E-02 (order OEE).
- **Scope:** `screens/order-actions.tsx`, `screens/order-oee.tsx`; `e2e/browser/orders/oee/1-order-line-oee.spec.ts` `ratio()` (lines 27–31) reads `data-decimal` instead of `textContent()`, so `orders-pass.ts`'s `checkOeeScreen` still compares the decimal.
- **Acceptance:** actions as `primary`/`secondary`/`danger` buttons with their inline confirm forms restyled (ids kept); order OEE, FPY and line OEE as `KpiTile`s with percentages, the window labelled correctly for a completed order; the jobs table on `DataTable`.
- **Keep green:** `action-form-*`, `action-submit`, `action-message`, `action-cnc`, `action-hold-*`, `action-close`, `action-release`, `action-dispatch`, `order-oee`, `order-oee-section`, `order-oee-oee`, `order-oee-availability`, `order-oee-performance`, `order-oee-quality`, `order-oee-job-*`, `order-fpy`, `order-fpy-yield`, `order-fpy-good`, `order-fpy-started`, `order-line-oee`, `order-line-oee-value`, their `data-fraction`, `data-decimal`, `data-final`; `orders.test.tsx`, `order-oee.test.tsx`; `e2e/src/orders-pass.ts`, `e2e/src/demo-record.ts`; browser `orders/oee/1-order-line-oee.spec.ts`, `orders/dispatch/2-release-dispatch.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `demo/walkthrough.spec.ts`.
- **Structural selectors and asserted texts:** `1-order-line-oee.spec.ts` 55–56 also read `textContent()` of the FPY values (moved to `data-decimal` or kept textual: decided and stated in the PR); 63 `[data-testid^="order-oee-job-"]`; `action-message` `data-kind`/`data-type` on a refused close (`quality/final/1-trace-holds-close.spec.ts` 236–237).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` (the `e2e/` row inside).
- **Depends on:** UX-6a, UX-1d2.

### UX-7 Operator terminal (tablet first)

- **Closes:** X-01, X-02, X-04, X-05.
- **Scope:** `screens/terminal.tsx` (picker and work-center screens).
- **Acceptance:** designed for 1024×768 and 768×1024 touch first: the picker as large work-center tiles (name, machines, crew signed on, the running order, any abnormal machine); the work-center header naming the work center with a "Change work center" link; the operator's flow top to bottom (who is signed on, the current order and operations with start, pause and resume as `touch` buttons, signals and holds as callouts with their tone, scrap to code); targets ≥ 56 px; both orientations and 390; checked by hand on an iPad (Safari 17+).
- **Keep green:** every `terminal-*` id (`terminal-screen`, `terminal-clock`, `terminal-username`, `terminal-password`, `terminal-sign-on`, `terminal-user`, `terminal-sign-off`, `terminal-sign-off-*`, `terminal-crew`, `terminal-order-*`, `terminal-order-status-*`, `terminal-op-*`, `terminal-op-state-*`, `terminal-counts-*`, `terminal-start-*`, `terminal-pause-*`, `terminal-pause-confirm-*`, `terminal-resume-*`, `terminal-reason-*`, `terminal-hold-*`, `terminal-signals`, `terminal-signal-*`, `terminal-scrap-*`, `terminal-scrap-reason-*`, `terminal-scrap-comment-*`, `terminal-scrap-code-*`), `nav-terminal`; `terminal.test.tsx`, `domain/terminal.test.ts`; browser `login.ts`, `orders/live/terminal-live.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`.
- **Structural selectors and asserted texts:** raw values: `terminal-order-status-*` carries `data-status="in-progress"` (`terminal-live.spec.ts` 85; the text, `'in-progress'` until UX-7, is the desk's word since); the operation state reads `'You: working'` and `'You: paused ('` (188–194); operations contain `'Complete'` (`1-terminal-close.spec.ts` 47, 117; `1-trace-holds-close.spec.ts` 48) and `'Signed off by'` (52); `terminal-user` text is exactly the username and `terminal-crew` contains it (`login.ts` 104–106); scrap reasons are buttons with `aria-pressed` and ids `terminal-scrap-reason-<scrap>-<reason>` (65–83); `[data-testid^="terminal-signal-"]`, `[data-testid^="terminal-hold-"]`; `terminal-signals` `aria-live="polite"`; `operator-name` stays absent; password inputs keep `type="password"` (`login.ts` 100).
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1b, UX-1c, UX-1d2, UX-1e, UX-B3.

### UX-8 Traceability: search, serial, lot and carton

- **Closes:** T-01 … T-06.
- **Scope:** `screens/trace-search.tsx`, `trace-serial.tsx`, `trace-lot.tsx`, `trace-carton.tsx`, `trace-common.tsx`.
- **Acceptance:** search results as a table grouped by type with status and order; serial status as a badge (Scrapped `alarm`); absent values by the content rule; the lot's units paged (50) with a status filter and the other sections reachable by `SectionNav` above the table; repeated run epochs moved into the header; unknown ids as `NotFound`.
- **Keep green:** `trace-serial`, `trace-lot`, `trace-carton`, `trace-carton-*`, `trace-finality`, `trace-records`, `trace-records-section`, `record-*`, `record-machine`, `record-operator`, `record-crew`, `record-reading`, `lot-link-*`, `serial-link-*`, `carton-unit-*`, `lot-cartons`, `trace-hold-open`, `hold-*`, `hold-link-*`; `trace.test.tsx`, `domain/trace.test.ts`; `e2e/src/demo-record.ts`; browser `demo/walkthrough.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`.
- **Structural selectors and asserted texts:** `record-operator` text is exactly the operator (walkthrough 766; `1-trace-holds-close.spec.ts` 103) and stays a raw user name, not "—"; `record-machine` contains the machine id (90); `record-crew` holds `[data-user="<name>"]` elements (108); `[data-testid^="carton-unit-"][data-status="packed"]` count (walkthrough 734), `[data-testid^="serial-link-"]`, `[data-testid^="lot-link-"]`, `[data-testid^="trace-carton-"]` counts (739–812): paging must keep every link a spec counts on the page (page size above the demo's counts, or the spec's count read from `data-count`, decided in the PR); `trace-finality` `data-final`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1e.

### UX-9a SPC

- **Closes:** C-01, C-04 … C-07.
- **Scope:** `screens/spc.tsx`.
- **Acceptance:** the characteristics list with unacknowledged episodes as a `warn` count badge; the chart page with a `PageHeader`, the range filter on `PlantTimeInput`, charts on the theme, episodes on `DataTable` with ghost row actions side by side, limit versions with one column per value.
- **Keep green:** `spc-chart-page`, `spc-baseline`, `signal-row-*`, `signal-status`, `ack-*`, `hold-from-*`, `hold-unit-*` and the other `spc.tsx` ids the unit tests read; `spc.test.tsx`, `live/live-quality.test.ts`, `domain/quality.test.ts`; browser `demo/walkthrough.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `final/alarm-actions.spec.ts`.
- **Structural selectors and asserted texts:** `spc-chart-page` `data-limits`, `spc-baseline` `data-baseline`, episodes' `data-final`, `signal-status` text "Final" kept.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-1f, UX-B1.

### UX-9b Quality holds

- **Closes:** H-01 … H-05.
- **Scope:** `screens/holds.tsx`.
- **Acceptance:** the list with "Open a hold" as the page's primary action, aligned filters, an empty state with its action; the new-hold form on `Field`s with full option texts; the detail with `PageHeader`, back link, scope counts as `Stat`s, release and reject through their inline forms restyled (ids kept); unknown ids as `NotFound`.
- **Keep green:** `hold-row-*`, `hold-link-*`, `hold-state`, `hold-open-form`, `open-id`, `open-reason`, `open-submit`, `open-result-*`, `hold-suggestion`, `suggest-*`, `hold-reason`, `hold-submit`, `hold-detail`, `hold-summary`, `hold-orders`, `hold-unit-*`, `hold-opened`, `hold-scope-counts`, `hold-form-release`, `hold-action-release`; `holds.test.tsx`; browser `demo/walkthrough.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`; `e2e/src/demo-record.ts`.
- **Structural selectors and asserted texts:** `hold-detail` `data-subject`, `data-state`; `hold-scope-counts` `data-orders`; `hold-orders` text is exactly the order id (walkthrough 684); `hold-reason` options listed by `locator('option')`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e.

### UX-10 Simulation console and users

- **Closes:** N-01 … N-07, U-01, U-02, G-10 and G-11 on these screens, G-23.
- **Scope:** `screens/console.tsx`, `screens/users.tsx`.
- **Acceptance:** the console in sections with a `SectionNav` (Run, Scenario, Faults, Materials, Operators, Log); every time on `PlantTimeInput` labelled "(simulation time)"; the lots table on `DataTable` with every column headed, the action matching the lot's state emphasised; destructive levers `danger`; the events list with an empty state; users as a `DataTable` with role checkboxes in one column and Disable or Reset password through `ConfirmDialog` (the temporary password still shown once); no field without `id`/`name`; the forbidden view on the shared pattern.
- **Keep green:** the console ids the specs read (`sim-state`, `sim-speed`, `sim-pause`, `sim-resume`, `sim-step`, `sim-speed-input`, `sim-speed-apply`, `run-outcome`, `failure-machine`, `failure-code`, `failure-at`, `failure-repair`, `failure-inject`, `failure-outcome`, `drift-shift`, `drift-until`, `drift-inject`, `drift-outcome`, `modbus-state`, `modbus-toggle`, `opcua-state-*`, `opcua-toggle-*`, `tool-break-*`, `tool-outcome`, `lot-*`, `lot-block-*`, `lot-release-*`, `lot-outcome`, `absent-date`, `absent-shift`, `absent-submit`, `absent-*`, `absent-outcome`, `scenario-load-*`, `scenario-outcome`, `scenario-name`, `scenario-progress`, `action-list`, `action-*`, `events-connection`, `event-list`, `console-forbidden`), the heading "Simulation console" by role and name; the user ids (`user-list`, `user-*`, `user-roles-*`, `toggle-enabled-*`, `new-username`, `new-role-*`, `create-user`, `temporary-password`, `temporary-password-value`, `hide-temporary-password`, `users-forbidden`); `console.test.tsx`, `login.test.tsx` (`nav-users`); browser `console/1-refusals.spec.ts`, `console/2-actions.spec.ts`, `console/3-stream-lifetime.spec.ts`, `console/4-effects.spec.ts`, `console/effects.ts`, `console-shift/absence.spec.ts`, `orders/dispatch/1-roles.spec.ts`, `demo/walkthrough.spec.ts`.
- **Structural selectors and asserted texts:** `scenario-progress tbody tr` and a row with the cell `'pause'` (walkthrough 308–321; `2-actions.spec.ts` 68); `action-list li` count (172); `event-list li` (182); `sim-speed` reads `"N×"` (walkthrough 323); `opcua-state-*` reads `'OPC UA offline'` / `'OPC UA online'`, `modbus-state` `'Modbus silent'` / `'Modbus answering'` (127–133); `*-outcome` lines match the specs' regexes and carry `data-kind` (`done`, `failed`); `sim-state` `data-state`, `events-connection` `data-connected`; `console-forbidden` contains `sim:control`; `toggle-enabled-*` reads `'Enable'` for a disabled user and `user-*` contains its roles as words (`1-roles.spec.ts` 81–83); time fields accept the ISO strings and the `yyyy-mm-dd` date the specs fill (`failure-at`, `drift-until`, `absent-date`).
- **Gate:** `verify,smoke,reconcile`; `pnpm test:console`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e.

### UX-11 Login and account

- **Closes:** L-01 … L-03, Y-01 … Y-03, G-18 (account).
- **Scope:** `screens/login.tsx`, `screens/account.tsx`.
- **Acceptance:** the login card with the product mark, fields marked invalid with the error tied to them, the host-name hint as a small help line; the forced password change on the same card pattern; the account page with plant and wall times by the content rules (no `toLocaleString`), roles as words and permissions grouped by area in a disclosure, the password form at form width, one Log out (the header's).
- **Keep green:** `login-username`, `login-password`, `login-submit`, `login-reason`, `login-message`, `must-change`, `current-password`, `new-password`, `confirm-password`, `change-password`, `password-problems`; `login.test.tsx`, `auth/auth.test.tsx`; browser `login.ts` (every spec logs in through it), `tls/tls.spec.ts`.
- **Structural selectors and asserted texts:** password fields keep `type="password"` (`login.ts` 79, 100); `signed-in-user` text exactly the user name after login.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b, UX-1c, UX-1d2, UX-1e.

---

## UX-12 Dark theme

- **Closes:** G-28.
- **Scope:** the switch (System, Light, Dark) in the top bar's user area and on the account page, stored per browser; `index.html` `color-scheme`; the chart theme repainting on change; print forced light, with `EChartsView` re-theming its chart light on `beforeprint` before `getDataURL` and back on `afterprint`.
- **Acceptance:** every screen in dark at 1440 and 390 with no raw colour left (`scripts/check-ui-tokens.ts` reports zero); the dark pairs of design system section 8 measured on the built page (a unit test over the token values); charts readable; the shift report printed from dark mode is light, chart included (a PDF).
- **Keep green:** all web unit tests; browser specs unaffected (they run in light).
- **Structural selectors and asserted texts:** none touched.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-2, UX-3, UX-4a, UX-4b, UX-5a, UX-5b, UX-6a, UX-6b, UX-7, UX-8, UX-9a, UX-9b, UX-10, UX-11.

## UX-final

### UX-F1 Accessibility gate

- **Closes:** any remaining a11y findings; makes the AA bar a test.
- **Scope:** the UX-1g project turned failing (still opt-in with `RECONCILE_A11Y=1`; the runbook's rerun table gets a row asking for it on pull requests that touch `apps/web/src`): zero serious or critical axe violations on every route, state, role, width and both themes; distinct page titles; the overlay checks; fixes for what it finds, each small; `docs/runbook.md`.
- **Acceptance:** the spec fails on a new serious or critical violation; moderate ones listed in the pull request with a decision each.
- **Keep green:** everything; the reconciliation's existing passes unchanged.
- **Structural selectors and asserted texts:** per fix, as in the screen issues.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1g, UX-12.

### UX-F2 Console CSP "eval" issue

- **Closes:** G-24.
- **Scope:** a side-effect module `apps/web/src/zod-config.ts` (`import { z } from 'zod'; z.config({ jitless: true });`) made the **very first import** of `src/main.tsx`, so it runs before `@shopfloor/contracts` builds any schema (Zod reads the setting when a schema is built, which happens while the contracts module is imported; a call in `main.tsx`'s body would be too late); a unit test that the setting is on after importing `main`'s import chain; `docs/security-review.md` (one line: the probe and its removal).
- **Acceptance:** zero `securitypolicyviolation` events in a real browser, a failing check of the reconciliation (not a UX-1g report): `e2e/browser/csp/csp.spec.ts` in the `orders-dispatch` project registers a listener before the app loads (`page.addInitScript`) and expects none on every list and desk route (signed out, supervisor, admin, quality), on a machine's, an order's and an SPC characteristic's detail (asserted present) and on a hold's and a shift report's detail when one exists; schema parsing unchanged (the web unit tests and the reconciliation pass).
- **Keep green:** all web unit tests, the reconciliation.
- **Structural selectors and asserted texts:** none.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** – (can merge any time; its browser check is its own reconciliation spec, not UX-1g).

### UX-F3 Consistency review and the demo re-recording

- **Closes:** the overhaul.
- **Scope:** a review of every screen against the design system with the harness screenshots at five widths in both themes (a table in the pull request: screen × width × theme, each ticked or with its fix); `scripts/check-ui-tokens.ts` turned into a failing check in `pnpm verify`; the demo re-recorded with `pnpm demo:record` per `docs/demo.md` "Re-recording" (new video, captions and screenshots in `docs/demo/`, the SHA-256, commit and length updated); `docs/demo.md`, `docs/README.md`, `CHANGELOG.md`.
- **Acceptance:** every audit id closed or carried with a reason; no raw colour in `apps/web/src`; every demo assertion green in `pnpm demo` twice in a row and in the recording run; the recording within its limits.
- **Keep green:** everything.
- **Structural selectors and asserted texts:** the walkthrough's, all of them, through the recording.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` twice in a row and `pnpm demo:record`. "Twice in a row" follows the precedent of PR #290 (P10-06, which introduced `pnpm demo` and ran it twice to show it is stable), not the rerun table, whose row for `apps/web` does not ask for `pnpm demo` at all.
- **Depends on:** UX-F1, UX-F2.

## Issue list

| Id     | Title                                           | Scope (one line)                                                                                                | Depends on                                                                                   | Gate                                                             |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| UX-B1  | SPC chart: every point drawn, rule labels apart | reproduce, then fix `echarts-view.tsx` / `spc-options.ts`; SSR symbol-count test                                | –                                                                                            | verify,smoke,reconcile; demo                                     |
| UX-B2  | Alarm raise times with their date               | `alarm-list.tsx`, `time.ts`: date unless today, full time in the tooltip                                        | –                                                                                            | verify,smoke,reconcile; demo                                     |
| UX-B3  | Terminal: no "Offline" before sign-on           | `terminal.tsx` header shows the status only when signed on                                                      | –                                                                                            | verify,smoke,reconcile                                           |
| UX-B4  | Show offline instead of loading forever         | `networkMode`, offline events, offline bar; writes fail at once, drafts kept                                    | –                                                                                            | verify,smoke,reconcile; test:resilience                          |
| UX-B5  | Alarm KPI hours missing from a running shift    | investigate `/alarms/kpi?bucket=hour`; finding to the coordinator                                               | –                                                                                            | none (no code)                                                   |
| UX-1a  | Design tokens and icons                         | `index.css` `@theme` light and dark, G-22 rule, `icons.tsx`, raw-colour report                                  | –                                                                                            | verify,smoke,reconcile                                           |
| UX-1c  | Primitives: actions and status                  | Button, Badge and domain badges, Card, Stat, KpiTile, Callout, formatters, `data-decimal`                       | UX-1a                                                                                        | verify,smoke,reconcile; demo; test:resilience                    |
| UX-1b  | App shell, grouped navigation and page header   | `root-layout.tsx`, `shell.tsx`, PageHeader, page titles, nav drawer, print                                      | UX-1a, UX-1c                                                                                 | verify,smoke,reconcile; demo; test:console; test:resilience      |
| UX-1e  | Primitives: feedback and overlays               | Dialog, Confirm, Toast, Empty, Skeleton, Error, NotFound, Forbidden, Tooltip, Menu, SegmentedLinks, jsdom stubs | UX-1c                                                                                        | verify,smoke,reconcile; demo                                     |
| UX-1d1 | Primitives: DataTable and Tabs                  | DataTable (sticky modes, selection, focus, paging, narrow), Tabs                                                | UX-1e                                                                                        | verify,smoke,reconcile; demo                                     |
| UX-1d2 | Primitives: fields and PlantTimeInput           | Field and controls, FilterBar, PlantTimeInput                                                                   | UX-1e                                                                                        | verify,smoke,reconcile; demo                                     |
| UX-1f  | Chart theme                                     | `chart/theme.ts` for ECharts and uPlot, rich-text tooltips, empty charts                                        | UX-1a, UX-1e, UX-B1                                                                          | verify,smoke,reconcile; demo                                     |
| UX-1g  | Visual and accessibility harness (report-only)  | `e2e/browser/a11y/` in the reconciliation: axe, titles, overlays, 5-width shots                                 | UX-1b                                                                                        | verify,smoke,reconcile                                           |
| UX-2   | Overview and machine detail                     | `overview.tsx`, `machine-detail.tsx`, timeline axis                                                             | UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f                                                           | verify,smoke,reconcile; demo; test:resilience                    |
| UX-3   | OEE dashboard and line OEE                      | `oee-dashboard.tsx`, `line-oee.tsx`, `oee-ui.tsx`; walkthrough 483–485 to `data-decimal`                        | UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f                                                           | verify,smoke,reconcile; demo                                     |
| UX-4a  | Alarm list                                      | `alarm-list.tsx`: tabs, table, panel from 1440 or sheet                                                         | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-B2                                                   | verify,smoke,reconcile; demo; test:console                       |
| UX-4b  | Alarm KPIs                                      | `alarm-kpi.tsx`: KPI tiles, hourly table, empty states                                                          | UX-1b, UX-1c, UX-1d1, UX-1e, UX-1f, UX-B5                                                    | verify,smoke,reconcile                                           |
| UX-5a  | Downtime coding                                 | `downtime-coding.tsx`: table, coding panel or sheet, split time                                                 | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e                                                          | verify,smoke,reconcile; demo                                     |
| UX-5b  | Shift reports and handover notes                | `shift-list.tsx`, `shift-report.tsx`, `handover-notes.tsx`, print                                               | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-1f                                                   | verify,smoke,reconcile                                           |
| UX-6a  | Order list and order detail                     | `order-list.tsx`, `order-detail.tsx`: header, facts, section nav, tables                                        | UX-1b, UX-1c, UX-1d1, UX-1e                                                                  | verify,smoke,reconcile; demo; test:console                       |
| UX-6b  | Order actions and order OEE                     | `order-actions.tsx`, `order-oee.tsx`; `1-order-line-oee.spec.ts` `ratio()` to `data-decimal`                    | UX-6a, UX-1d2                                                                                | verify,smoke,reconcile; demo                                     |
| UX-7   | Operator terminal (tablet first)                | `terminal.tsx`: picker tiles, touch flow                                                                        | UX-1b, UX-1c, UX-1d2, UX-1e, UX-B3                                                           | verify,smoke,reconcile                                           |
| UX-8   | Traceability: search, serial, lot and carton    | `trace-*.tsx`: results table, status badges, lot paging                                                         | UX-1b, UX-1c, UX-1d1, UX-1e                                                                  | verify,smoke,reconcile; demo                                     |
| UX-9a  | SPC                                             | `spc.tsx`: list, chart page, episodes, limit versions                                                           | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e, UX-1f, UX-B1                                            | verify,smoke,reconcile; demo                                     |
| UX-9b  | Quality holds                                   | `holds.tsx`: list, new hold, detail                                                                             | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e                                                          | verify,smoke,reconcile; demo                                     |
| UX-10  | Simulation console and users                    | `console.tsx`, `users.tsx`                                                                                      | UX-1b, UX-1c, UX-1d1, UX-1d2, UX-1e                                                          | verify,smoke,reconcile; test:console; demo                       |
| UX-11  | Login and account                               | `login.tsx`, `account.tsx`                                                                                      | UX-1b, UX-1c, UX-1d2, UX-1e                                                                  | verify,smoke,reconcile; demo                                     |
| UX-12  | Dark theme                                      | theme switch, `color-scheme`, chart repaint, light print via `beforeprint`                                      | UX-2, UX-3, UX-4a, UX-4b, UX-5a, UX-5b, UX-6a, UX-6b, UX-7, UX-8, UX-9a, UX-9b, UX-10, UX-11 | verify,smoke,reconcile; demo                                     |
| UX-F1  | Accessibility gate                              | UX-1g turned failing; fixes                                                                                     | UX-1g, UX-12                                                                                 | verify,smoke,reconcile                                           |
| UX-F2  | Console CSP "eval" issue                        | `src/zod-config.ts` as `main.tsx`'s first import; no CSP violation events                                       | – (browser check in the reconciliation, `e2e/browser/csp`)                                   | verify,smoke,reconcile                                           |
| UX-F3  | Consistency review and the demo re-recording    | review table, raw-colour check failing, `pnpm demo:record`                                                      | UX-F1, UX-F2                                                                                 | verify,smoke,reconcile; demo ×2 (PR #290 precedent); demo:record |
