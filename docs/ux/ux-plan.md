# UX overhaul plan

The issues that take the web app from the [audit](audit.md) to the [design system](design-system.md). One issue is one pull request under ADR-0011: an independent review, the local gate, the coordinator's squash merge. The coordinator creates the issues from this list; the ids here (UX-1a …) go in their titles.

## Rules for every issue

- **UI only.** No behaviour, API or contract change, except the issues marked _behaviour fix_ (UX-B1 … UX-B4), which change exactly what they name.
- **Test contracts.** Keep every `data-testid`, every `data-*` attribute a test reads (raw, #295), every accessible name and role that a spec or unit test uses. "Keep green" below lists what each issue touches: the test ids the browser specs read (from `e2e/browser/**`), the specs, and the colocated unit tests (`apps/web/src/**/*.test.ts(x)`), which also select by role and accessible name. A rename updates the specs in the same pull request and says so in its description.
- **Every state** of each touched screen: loading (skeleton), empty, error, not found where the URL holds an id, data-rich, and each role's view (read-only roles included).
- **Responsive:** checked at 1440, 1280, 1024, 768 and 390; no horizontal page scroll except inside a table's or chart's own frame.
- **Accessibility:** WCAG 2.2 AA per design system section 7; keyboard-only once through the screen; no new axe serious or critical findings on the touched routes (the axe browser extension until UX-F1 lands, its spec after).
- **Screenshots:** before and after at 1440 and 390 (and 1024 for list-and-detail screens) in the pull request description, taken on a disposable stack, never by changing the owner's `shopfloor-demo` data.
- **Gate:** the runbook's rerun table ("Merge gate"). For `apps/web` that is `GATE_STEPS=verify,smoke,reconcile pnpm gate`; plus `pnpm test:console` when `apps/web/src/screens/console*` changes; plus `pnpm demo` when a screen the demo walks through changes (overview, alarms, downtime, OEE and line OEE, orders, SPC, holds, traceability, console, the shell); plus, beyond the table, `pnpm test:resilience` when the connection status or the overview's state badges change, since `e2e/browser/resilience/recovery.spec.ts` reads both. Each suite runs alone under the heavy lock on disposable projects; the host keeps ≥ 25 GiB free.
- **Closes:** each issue lists the audit ids it resolves; the reviewer checks them against the after screenshots.

## Decisions taken in UX-0

- **No headless UI dependency.** Every primitive is built in-house on native `<dialog>`, the Popover API, `inert`, `<details>` and native `<select>` (design system 4.14). So no ADR issue is needed now; an issue that later wants a library writes the ADR first.
- **Dark mode is in scope:** tokens carry both themes from UX-1a, the switch ships in UX-12 once every screen is on tokens (design system section 8).
- **Behaviour defects found by the audit** get their own small issues (UX-B1 … UX-B5) that can merge before the foundation, so the two blockers do not wait for the redesign.

## Order and dependencies

```
UX-B1 … UX-B5 (independent, any time)

UX-1a tokens ──┬── UX-1b shell and page header ──┐
               ├── UX-1c actions and status ─────┤
               ├── UX-1d data and forms ─────────┼── UX-2 … UX-11 (screens, any order;
               ├── UX-1e feedback and overlays ──┤    UX-2 first as the pattern-setter)
               └── UX-1f chart theme ────────────┘
                                                      └── UX-12 dark theme ── UX-F1 a11y ── UX-F2 CSP ── UX-F3 review and re-recording
```

UX-1b … UX-1f depend on UX-1a only and can be reviewed in parallel. A screen issue depends on the foundation issues whose components it uses (listed per issue). UX-2 goes first among the screens and sets the pattern the others copy.

---

## Behaviour fixes (any time)

### UX-B1 SPC chart: draw every point and keep rule labels apart (_behaviour fix_)

- **Closes:** C-03 (blocker), C-02.
- **Scope:** `apps/web/src/chart/spc-options.ts` (`showAllSymbol: true` on the points series, the rule-label lane with `labelLayout.hideOverlap`), `apps/web/src/chart/spc-options.test.ts`.
- **Acceptance:** on the I, MR, X and R charts every point has its marker over the whole range (500 readings, and a range of 2000), provisional points hollow, signalling points diamonds; rule labels never overlap at 1440, 1024 or 390; the table under each chart unchanged. A unit test asserts `showAllSymbol` and the label layout on the option.
- **Keep green:** `spc-options.test.ts`, `screens/spc.test.tsx`; browser: `spc-chart-page`, `spc-baseline`, `signal-row-*` in `demo/walkthrough.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `final/alarm-actions.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** –.

### UX-B2 Alarm raise times with their date (_behaviour fix_)

- **Closes:** A-01 (blocker).
- **Scope:** `apps/web/src/screens/alarm-list.tsx` (the Raised column and the history list use the plant date-time formatter when the day is not the plant clock's current day), `domain/time.ts` (a `formatPlantTimeRelative(at, clock)` helper), tests.
- **Acceptance:** an alarm raised on another plant day shows "Mon 12 Oct, 07:15:00"; one raised today shows "07:15:00" under a column headed "Raised (today)" or with the date, by the content rule (design system 6.2); the `<time dateTime>` stays the raw instant. Unit tests for both cases and for midnight in the plant zone.
- **Keep green:** `screens/alarm-list.test.tsx`, `domain/time.test.ts`; browser: `alarm-list`, `alarm-row-*`, `ack-*`, `details-*` in `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** –.

### UX-B3 Terminal: no "Offline" before sign-on (_behaviour fix_)

- **Closes:** X-03.
- **Scope:** `apps/web/src/screens/terminal.tsx` (`TerminalHeader` renders `ConnectionStatus` only for a signed-on terminal session, or starts the live client when it shows it), `terminal.test.tsx`.
- **Acceptance:** the sign-on page shows the plant clock and no connection state, also with a desk session in the browser; once signed on the status reads "Live" as today. A unit test covers both.
- **Keep green:** `screens/terminal.test.tsx`; browser: `connection-status` and the `terminal-*` ids in `orders/live/terminal-live.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `login.ts`.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** –.

### UX-B4 Show offline instead of loading forever (_behaviour fix_)

- **Closes:** G-20.
- **Scope:** `apps/web/src/app.tsx` (query defaults `networkMode: 'always'`, so a request fails with the network error), `live/live-context.tsx` or the shell (the `online`/`offline` events mark the live connection lost), a shell-level offline bar (a `Callout` restyled later by UX-1e), tests.
- **Acceptance:** with the network cut, a screen opened shows its `QueryError` within the retry budget (about 10 s), the header reads "Offline" and a bar says since when the figures stopped updating; when the network returns, the bar goes, queries refetch and the status returns to "Live" without a reload. Unit tests with a fake offline event.
- **Keep green:** `live/live-context.test.tsx`, `live/live-client.test.ts`, `api/client.test.ts`, `auth/auth.test.tsx`; browser: `connection-status` in `resilience/recovery.spec.ts`, `1-oee-live.spec.ts`, `2-alarms-live.spec.ts`, `3-overview.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm test:resilience` (its recovery spec reads the connection status).
- **Depends on:** –.

### UX-B5 Alarm KPI hours missing from a running shift (investigation)

- **Closes:** K-02 (or turns it into a MES issue).
- **Scope:** find whether `GET /api/v1/alarms/kpi?bucket=hour` omits hours without raises by design (then the screen fills the shift's hours with zero rows marked "no raises", as OEE does) or loses them (then a `mes-server` issue with a failing test). No code in this issue until the cause is known; the finding goes to the coordinator.
- **Acceptance:** a written finding with the request, the response and the code path; either a follow-up web issue (UI only) or a MES issue.
- **Keep green:** –.
- **Gate:** none (no code).
- **Depends on:** –.

---

## UX-1 Foundation

### UX-1a Design tokens

- **Closes:** foundation for G-07, G-09, G-12, G-13, G-15, G-28.
- **Scope:** `apps/web/src/index.css` (`@theme` tokens of design system section 2 for colour, type, spacing, radius, shadow, z-index, motion; the dark values under `:root[data-theme='dark']`, unused until UX-12; `font-variant-numeric` utilities; the focus ring rule with `:focus:not(:focus-visible)`), `apps/web/index.html` (`color-scheme: light dark` stays light until UX-12), `scripts/check-ui-tokens.ts` (lists raw palette classes and hex colours per file under `apps/web/src`, report only), `apps/web/README.md` (a "Design system" paragraph pointing here).
- **Acceptance:** every token of the design system exists as a CSS variable and a Tailwind utility (a unit test reads the built CSS or a token map and checks names and values, including each contrast pair of section 2 recomputed in the test); no screen changes appearance (screenshots of three screens before and after identical but for the focus ring on headings); the check script prints the current raw-colour count per file.
- **Keep green:** all web unit tests; no browser spec reads styles.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** –.

### UX-1b App shell, grouped navigation and page header

- **Closes:** G-01, G-02, G-03, G-04, G-05, G-06 (pattern), G-22, X-04 (the picker side).
- **Scope:** `screens/root-layout.tsx` (top bar, side nav by job and role, the drawer below `xl`, active state for sub-routes), `components/ui/page-header.tsx`, `components/ui/section.tsx`, `components/ui/use-page-title.ts`, `components/ui/icons.tsx`, `auth/shell.tsx` (`SessionPending` inside a minimal shell, the idle warning and re-login on tokens), `NotFound` on the page-header pattern; unit tests for each.
- **Acceptance:**
  - At ≥ 1280 the side nav shows four groups (Monitor, Production, Quality, Admin), only the links the role may use, empty groups hidden; at < 1280 a menu button opens the same nav as a drawer (focus moves in, Escape and backdrop close it, focus returns, `inert` when closed).
  - The link of the current route is active on every sub-route (`aria-current="page"` exact, `"true"` below); Alarms and Alarm KPIs are told apart.
  - The top bar is one 48 px row at every width; roles leave the bar (in the user link's `title` and on the account page); Log out stays visible.
  - Every route sets `document.title` to "<page> · ShopFloor Twin".
  - `PageHeader` renders back link, title, badges, actions, description, meta and filter bar per design system 3.3; adopted by the overview only as the reference (other screens migrate in their issues).
  - Keyboard: skip link, nav, drawer, focus to the `h1` on navigation with no visible ring on the heading.
  - Screenshots at all five widths for the operator, quality and admin roles.
- **Keep green:** test ids `nav-*` (every link, text unchanged), `user-menu`, `nav-account`, `signed-in-user`, `logout`, `plant-clock` (text "Gebze plant time: …"), `connection-status`, `app-page`, `relogin`, `relogin-other`, `idle-warning`, `stay-signed-in`; unit tests `auth/auth.test.tsx`, `screens/login.test.tsx`, `overview.test.tsx` (`plant-clock`), `console.test.tsx` (`nav-console` present and absent), `alarm-list.test.tsx` and `shift-report.test.tsx` (click `nav-overview`, `nav-alarms`, `nav-shifts`), `trace.test.tsx` (`nav-trace` `aria-current="page"`), `spc.test.tsx` (`nav-spc`), `terminal.test.tsx` (`nav-terminal`); browser `login.ts`, `demo/demo.ts` (logout), `demo/walkthrough.spec.ts` (`plant-clock`, `nav-console`), `console/2-actions.spec.ts` (`nav-console` absent for an operator), `console/4-effects.spec.ts`, `console-shift/absence.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (its specs click `nav-console`); `pnpm test:resilience` (the connection status moves).
- **Depends on:** UX-1a.

### UX-1c Primitives: actions and status

- **Closes:** foundation for G-09, G-10, G-11, G-12, G-13, G-15, G-16, G-17.
- **Scope:** `components/ui/`: `Button`, `IconButton`, `Badge`, `Card`, `Stat`, `KpiTile`, `Callout`, `Code`, `DescriptionList`; the domain badges re-based on `Badge` with today's names and attributes (`state-badge.tsx`, `priority-badge.tsx`, `order-badges.tsx`, `quality-ui.tsx` badges, a new `FinalityBadge`, `LossBadge`); `domain/states.ts` palette moved to the tokens (design system 2.4); the formatting components `Duration`, `PlantTime`, `WallTime`, `Percent`, `Ratio`, `Quantity`, `Missing` over `domain/time.ts` and `domain/numbers.ts`; unit tests.
- **Acceptance:** each component's variants, sizes and states (disabled never by opacity, loading with `aria-busy`), accessible name and keyboard focus are unit-tested; badges keep `data-state`, `data-priority`, `data-status` raw; the state and priority badges change look on every screen at once (screenshots of overview, alarms, orders, holds); `Missing` renders "—" with a visually hidden reason; durations follow design system 6.1 (unit tests for each band).
- **Keep green:** `order-status`, `order-flags`, `command-state`, `hold-state`, `signal-status`, `data-flag` (`flag-explanations`), `state-*`; unit tests `domain/states.test.ts`, `domain/orders.test.ts`, `domain/time.test.ts`, `domain/numbers.test.ts`, `overview.test.tsx`, `orders.test.tsx`, `holds.test.tsx`, `spc.test.tsx`, `alarm-list.test.tsx`; browser specs reading `order-status` (`demo/walkthrough`, `orders/dispatch/1-roles`, `orders/dispatch/2-release-dispatch`, `orders/final/1-terminal-close`, `quality/final/1-trace-holds-close`) and `data-state` / `data-status`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:resilience` (the state badges change).
- **Depends on:** UX-1a.

### UX-1d Primitives: data and forms

- **Closes:** foundation for G-14, G-23, G-27, G-30, D-05, N-02, C-07.
- **Scope:** `components/ui/`: `DataTable` (alignment, numeric cells, sticky header, row tone, active row, selection, row actions, empty, paging, narrow `scroll`/`stack`), `Tabs`, `Field`, `TextInput`, `Textarea`, `Select`, `Checkbox`, `CharacterCount`, `FilterBar`, `PlantTimeInput`; `quality-ui.tsx`'s `Table`, `inputClass`, `buttonClass`, `primaryClass`, `CommentInput` re-based on them (their exports kept until the last screen stops importing them); unit tests.
- **Acceptance:** `DataTable` renders `caption`, `th scope="col"`, forwards `rowTestId` and `data-*` per row, keeps `data-count`; keyboard: tabs by arrows with roving tab index, selection by Space, select-all `mixed`; every control has an `id` and a `name`; `PlantTimeInput` parses and formats in the plant zone and shows the UTC instant (unit tests across midnight and a DST-free zone); 24 px hit areas.
- **Keep green:** unit tests of the screens using `quality-ui` (`spc.test.tsx`, `holds.test.tsx`, `trace.test.tsx`); browser: `data-count` reads.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1a.

### UX-1e Primitives: feedback and overlays

- **Closes:** foundation for G-19, G-21, G-29, H-03, K-04, N-05.
- **Scope:** `components/ui/`: `Dialog` (modal and sheet), `ConfirmDialog`, `Toast` and its region, `EmptyState`, `Skeleton` (with the 300 ms delay), `ErrorState` (`components/query-error.tsx` keeps its name and props), `NotFound`, `Tooltip`, `InfoTip`, `Disclosure`, `SectionNav`; the offline bar of UX-B4 restyled; unit tests.
- **Acceptance:** `Dialog` traps focus, returns it, closes on Escape, sets `aria-labelledby`/`aria-describedby`; `ConfirmDialog` repeats the verb; toasts announce politely (alarm tone assertively) and pause on hover and focus; `Skeleton` has `role="status"` with the loading text the screens use today; `QueryError` offers "Try again" only for retryable errors; `Tooltip` opens on focus and hover and closes on Escape; reduced motion honoured. Unit tests for each.
- **Keep green:** every unit test that finds a "Loading …" text or a `QueryError` (`oee-dashboard.test.tsx`, `orders.test.tsx`, `machine-detail.test.tsx`, `alarm-kpi.test.tsx`, `shift-report.test.tsx`, `trace.test.tsx`, …): the texts stay.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1a.

### UX-1f Chart theme

- **Closes:** G-25 (foundation), E-05, E-07, K-03.
- **Scope:** `chart/theme.ts` (tokens read at run time, the ECharts theme `shopfloor`, uPlot options helper), `chart/echarts-view.tsx` (registers and applies it, `animation: false`), `chart/uplot-chart.tsx`, `chart/oee-options.ts`, `chart/alarm-options.ts`, `chart/spc-options.ts` (colours and fonts from the theme; label wrapping; no zero labels; empty data → no option), `chart/echart.tsx` (an `EmptyState` when the option is null for want of data); unit tests on the options.
- **Acceptance:** every chart uses the font, axis, legend and palette of design system section 5; no hex colour left in `chart/`; category labels wrap to two lines; empty charts show an empty state at the chart's height; the `role="img"` description states the main reading; screenshots of the OEE, alarm KPI, SPC, shift report and machine charts before and after.
- **Keep green:** `chart/oee-options.test.ts`, `chart/alarm-options.test.ts`, `chart/spc-options.test.ts` (series names, symbols, `emptyCircle` for provisional), `oee-dashboard.test.tsx`, `alarm-kpi.test.tsx`; browser `pareto`, `pareto-*` (the table beside the chart).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1a (and UX-B1 merged first, to avoid a conflict in `spc-options.ts`).

---

## UX-2 … UX-11 Screen migrations

Each moves its screens onto the shell, `PageHeader`, the primitives and the content rules, and deletes their local `buttonClass`/`inputClass` constants.

### UX-2 Overview and machine detail

- **Closes:** O-01 … O-05, M-01 … M-06, G-13 (on these screens).
- **Scope:** `screens/overview.tsx`, `screens/machine-detail.tsx`, `domain/timeline.ts` (axis ticks with dates), metric display names from the plant model already in `api` (no API change).
- **Acceptance:** a summary strip (machines per state; abnormal first) and machine cards with an abnormal left bar; names before codes, causes as words; the timeline axis has hourly ticks and dates when the range spans days; telemetry names readable, a stale latest value says how old it is; empty charts as empty states; an unknown machine is a `NotFound`; all states and widths.
- **Keep green:** `machine-*`, `state-*`, `connection-status`; `overview.test.tsx`, `machine-detail.test.tsx`, `domain/timeline.test.ts`, `domain/plant.test.ts`; browser `3-overview.spec.ts`, `demo/walkthrough.spec.ts`, `resilience/recovery.spec.ts`, `final/downtime-coding.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:resilience` (its recovery spec reads the overview's `state-*`).
- **Depends on:** UX-1b, UX-1c, UX-1d, UX-1e, UX-1f.

### UX-3 OEE dashboard and line OEE

- **Closes:** E-01 … E-08, G-15 and G-16 on these screens.
- **Scope:** `screens/oee-dashboard.tsx`, `screens/line-oee.tsx`, `components/oee-ui.tsx` (`RatioValue`, `RatioHeadline`, `StatusFlags`).
- **Acceptance:** KPI tiles with percentages, the fraction in `data-fraction` and the tooltip; finality once per section; the idle-shift line card as an empty state with its reason; the machines table on `DataTable` with numeric columns and the narrow layout; waterfall signs fixed; all states and widths.
- **Keep green:** `oee-card-*`, `bottleneck-*`, `oee-machine-*`, `pareto`, `pareto-*`, `line-oee-card`, `line-oee-value`, `line-bottlenecks`, `line-bottleneck-*`, `data-fraction` (read by the reconciliation and `orders/oee/1-order-line-oee.spec.ts`); the visible ratio text if a spec reads it (check `1-oee-live.spec.ts`); `oee-dashboard.test.tsx`, `live/live-oee.test.ts`, `live/live-line-oee.test.ts`; browser `1-oee-live.spec.ts`, `final/downtime-coding.spec.ts`, `orders/oee/1-order-line-oee.spec.ts`, `demo/walkthrough.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1f.

### UX-4a Alarm list

- **Closes:** A-02 … A-06, G-26 and G-27 on this screen, G-10 (Acknowledge selected).
- **Scope:** `screens/alarm-list.tsx`.
- **Acceptance:** `Tabs`; `DataTable` with priority, the unacknowledged row bar and bold, row actions side by side, selection; the detail as a sticky side panel at ≥ 1280 and a sheet below, full-width table when nothing is selected; the stacked layout at 390; shelving and comments on `Field`s; identifiers as names first.
- **Keep green:** `alarm-list`, `alarm-list-empty`, `alarm-row-*`, `ack-*`, `details-*`, `select-all`, `ack-selected`, `alarm-panel`, `close-alarm`, `alarm-state`, `alarm-history`, `history-entry`, `comment`, `comment-text`, `add-comment`, `shelve`, `shelve-reason`, `shelve-duration`, `shelf-state`, `unshelve`, `tab-*`, `flood-banner-*`; `alarm-list.test.tsx`, `live/live-alarms.test.ts`; browser `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`, `console/effects.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (`console/effects.ts` reads the alarm list).
- **Depends on:** UX-1b … UX-1e, UX-B2.

### UX-4b Alarm KPIs

- **Closes:** K-01, K-03, K-04, and K-02's display once UX-B5 decides it.
- **Scope:** `screens/alarm-kpi.tsx`.
- **Acceptance:** per scope a `KpiTile` with the average per 10 min and its EEMUA verdict as the headline, the other measures in a compact list; hourly table on `DataTable`; empty floods and bad actors as empty states; chart on the theme.
- **Keep green:** `kpi-card-*`, `kpi-operator`; `alarm-kpi.test.tsx`; browser `2-alarms-live.spec.ts`, `final/alarm-actions.spec.ts`.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1b … UX-1f, UX-B5.

### UX-5a Downtime coding

- **Closes:** D-01 … D-05, G-26 on this screen.
- **Scope:** `screens/downtime-coding.tsx`.
- **Acceptance:** `DataTable` with state and loss badges, durations by the content rule, no wrapping in time and length columns; the coding panel as sticky side panel or sheet; the split time on `PlantTimeInput`; "View" for roles without `downtime:code`.
- **Keep green:** `machine-filter`, `downtime-row-*`, `code-*`, `coding-panel`, `reason-picker`, `segment-comment`, `split-at`, `split`, `save-coding`, `coding-message`, `draft-conflict`, `audit`, `audit-entry`; `downtime-coding.test.tsx`, `domain/downtime.test.ts`; browser `final/downtime-coding.spec.ts`, `final/alarm-actions.spec.ts`, `demo/walkthrough.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1e.

### UX-5b Shift reports and handover notes

- **Closes:** S-01, S-02, R-01 … R-04.
- **Scope:** `screens/shift-list.tsx`, `screens/shift-report.tsx`, `screens/handover-notes.tsx`, `components/shift-picker.tsx`; the print rules in `index.css` kept and checked.
- **Acceptance:** the list as a `DataTable` (shift, state, finality, revision only when > 0); the report with a `SectionNav`, ratios as percentages like UX-3, names as on alarm KPIs; notes on `Field`s with retraction through `ConfirmDialog` if it is irreversible today; the A4 print still one section per page where it fits (a print preview screenshot).
- **Keep green:** `shift-report`, `report-revised`, `shift-select`, the note ids (`new-note`, `note-category`, `note-text-input`, `add-note`, `new-note-message`, `note-*`, `note-text-*`, `edit-note-*`, `note-editor-*`, `save-note`, `note-history-*`, `note-history-toggle-*`, `note-history-entry`); `shift-report.test.tsx`, `handover-notes.test.tsx`, `live/live-shifts.test.ts`, `domain/shifts.test.ts`; the reconciliation's shift checks (`e2e/src/reconcile.ts` reads `shift-report`); browser `final/shift-report.spec.ts`.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1b … UX-1f.

### UX-6a Order list and order detail

- **Closes:** P-01, P-02, Q-01 … Q-03, Q-05 … Q-08, G-21 (orders).
- **Scope:** `screens/order-list.tsx`, `screens/order-detail.tsx`.
- **Acceptance:** list on `DataTable` (priority as a badge, overdue marked); detail with `PageHeader` (status badges, the primary action beside them), a `DescriptionList` of key facts flowing by column, `SectionNav`, numeric columns right-aligned, ERP messages as a table with a payload disclosure per row, history with "(wall time)" and request ids in a details disclosure; read-only roles see a one-line callout; an unknown order is a `NotFound`.
- **Keep green:** `order-row-*`, `order-link-*`, `order-status`, `order-flags`, `order-read-only`, `action-*`, `action-done`, `command-*`, `command-confirmed`, `command-state`; `orders.test.tsx`, `live/live-orders.test.ts`, `domain/orders.test.ts`; browser `orders/dispatch/1-roles.spec.ts`, `orders/dispatch/2-release-dispatch.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `demo/walkthrough.spec.ts`, `console/2-actions.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`; `pnpm test:console` (its actions spec opens an order).
- **Depends on:** UX-1b … UX-1e.

### UX-6b Order actions and order OEE

- **Closes:** Q-04, G-11 (order actions).
- **Scope:** `screens/order-actions.tsx`, `screens/order-oee.tsx`.
- **Acceptance:** actions as `primary`/`secondary`/`danger` buttons with their inline confirm forms restyled (ids kept); order OEE, FPY and line OEE as `KpiTile`s with percentages, the line OEE window labelled correctly for a completed order; the jobs table on `DataTable`.
- **Keep green:** `action-form-*`, `action-submit`, `action-message`, `action-cnc`, `action-hold-*`, `action-close`, `action-release`, `action-dispatch`, `order-oee`, `order-oee-section`, `order-oee-oee`, `order-oee-availability`, `order-oee-performance`, `order-oee-quality`, `order-oee-job-*`, `order-fpy`, `order-fpy-yield`, `order-fpy-good`, `order-fpy-started`, `order-line-oee`, `order-line-oee-value` and their `data-fraction`; `orders.test.tsx`, `order-oee.test.tsx`; `e2e/src/orders-pass.ts` and `demo-record.ts` read the order OEE; browser `orders/oee/1-order-line-oee.spec.ts`, `orders/dispatch/2-release-dispatch.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `demo/walkthrough.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-6a.

### UX-7 Operator terminal (tablet first)

- **Closes:** X-01, X-02, X-04, X-05.
- **Scope:** `screens/terminal.tsx` (picker and work-center screens).
- **Acceptance:** designed for 1024×768 and 768×1024 touch first: the picker as large work-center tiles (name, machines, crew signed on, the running order and any abnormal machine); the work-center screen with the header naming the work center and a "Change work center" link, the operator's flow top to bottom (who is signed on, the current order and operations with start/pause/resume as `touch` buttons, signals and holds as callouts with their tone, scrap to code); all targets ≥ 56 px; works in both orientations and at 390; the desk shell's components with `size="touch"`.
- **Keep green:** every `terminal-*` id (`terminal-screen`, `terminal-clock`, `terminal-username`, `terminal-password`, `terminal-sign-on`, `terminal-user`, `terminal-sign-off`, `terminal-sign-off-*`, `terminal-crew`, `terminal-order-*`, `terminal-order-status-*`, `terminal-op-*`, `terminal-op-state-*`, `terminal-counts-*`, `terminal-start-*`, `terminal-pause-*`, `terminal-pause-confirm-*`, `terminal-resume-*`, `terminal-reason-*`, `terminal-hold-*`, `terminal-signals`, `terminal-signal-*`, `terminal-scrap-*`, `terminal-scrap-reason-*`, `terminal-scrap-comment-*`, `terminal-scrap-code-*`), `nav-terminal`; `terminal.test.tsx`, `domain/terminal.test.ts`; browser `login.ts` (terminal sign-on), `orders/live/terminal-live.spec.ts`, `orders/final/1-terminal-close.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** UX-1a … UX-1e, UX-B3.

### UX-8 Traceability: search, serial, lot and carton

- **Closes:** T-01 … T-06.
- **Scope:** `screens/trace-search.tsx`, `trace-serial.tsx`, `trace-lot.tsx`, `trace-carton.tsx`, `trace-common.tsx`.
- **Acceptance:** search results as a table grouped by type with status and order; serial status as a badge (Scrapped `alarm`); absent values by the content rule; the lot's units paged (50) with a status filter and the other sections reachable by `SectionNav` above the table; repeated run epochs moved into the header; unknown ids as `NotFound`.
- **Keep green:** `trace-serial`, `trace-lot`, `trace-carton`, `trace-carton-*`, `trace-finality`, `trace-records`, `trace-records-section`, `record-*`, `record-machine`, `record-operator`, `record-crew`, `record-reading`, `lot-link-*`, `serial-link-*`, `carton-unit-*`, `lot-cartons`, `trace-hold-open`, `hold-*`, `hold-link-*`; `trace.test.tsx`, `domain/trace.test.ts`; `e2e/src/demo-record.ts` (it frames the trace pages); browser `demo/walkthrough.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`. The lot paging must keep every unit a spec asserts reachable (check the quality spec's lot assertions; page size or a "Show all" control).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1e.

### UX-9a SPC

- **Closes:** C-01, C-04 … C-07.
- **Scope:** `screens/spc.tsx`.
- **Acceptance:** the characteristics list with unacknowledged episodes as a `warn` count badge; the chart page with a `PageHeader`, the range filter on `PlantTimeInput`, charts on the theme, episodes on `DataTable` with ghost row actions side by side, limit versions with one column per value.
- **Keep green:** `spc-chart-page`, `spc-baseline`, `signal-row-*`, `signal-status`, `ack-*`, `hold-from-*`, `hold-unit-*` and the other `spc.tsx` ids the unit tests read; `spc.test.tsx`, `live/live-quality.test.ts`, `domain/quality.test.ts`; browser `demo/walkthrough.spec.ts`, `quality/live/spc-terminal-live.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`, `final/alarm-actions.spec.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1f, UX-B1.

### UX-9b Quality holds

- **Closes:** H-01 … H-05.
- **Scope:** `screens/holds.tsx`.
- **Acceptance:** list with "Open a hold" as the page's primary action, aligned filters, an empty state with its action; the new-hold form on `Field`s with full option texts; the detail with `PageHeader`, back link, scope counts as `Stat`s, release and reject through `ConfirmDialog` where irreversible (inline forms and ids kept); unknown ids as `NotFound`.
- **Keep green:** `hold-row-*`, `hold-link-*`, `hold-state`, `hold-open-form`, `open-id`, `open-reason`, `open-submit`, `open-result-*`, `hold-suggestion`, `suggest-*`, `hold-reason`, `hold-submit`, `hold-detail`, `hold-summary`, `hold-orders`, `hold-unit-*`, `hold-opened`, `hold-scope-counts`, `hold-form-release`, `hold-action-release`; `holds.test.tsx`; browser `demo/walkthrough.spec.ts`, `quality/final/1-trace-holds-close.spec.ts`; `e2e/src/demo-record.ts`.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1e.

### UX-10 Simulation console and users

- **Closes:** N-01 … N-06, U-01, U-02, G-10 and G-11 on these screens, G-23.
- **Scope:** `screens/console.tsx`, `screens/users.tsx`.
- **Acceptance:** the console in sections with a `SectionNav` (Run, Scenario, Faults, Materials, Operators, Log); every time on `PlantTimeInput` labelled "(simulation time)"; the lots table on `DataTable` with every column headed, the action matching the lot's state emphasised; destructive levers `danger`; the events list with an empty state; users as a `DataTable` with role checkboxes in one column and Disable / Reset password as `danger` through `ConfirmDialog` (the temporary password still shown once, `temporary-password`); no field without `id`/`name`.
- **Keep green:** every console id the specs read (`sim-state`, `sim-speed`, `sim-pause`, `sim-resume`, `sim-step`, `sim-speed-input`, `sim-speed-apply`, `run-outcome`, `failure-machine`, `failure-code`, `failure-at`, `failure-repair`, `failure-inject`, `failure-outcome`, `drift-shift`, `drift-until`, `drift-inject`, `drift-outcome`, `modbus-state`, `modbus-toggle`, `opcua-state-*`, `opcua-toggle-*`, `tool-break-*`, `tool-outcome`, `lot-*`, `lot-block-*`, `lot-release-*`, `lot-outcome`, `absent-date`, `absent-shift`, `absent-submit`, `absent-*`, `absent-outcome`, `scenario-load-*`, `scenario-outcome`, `scenario-name`, `scenario-progress`, `action-list`, `action-*`, `events-connection`, `event-list`, `console-forbidden`), the heading "Simulation console" (read by role and name), the cell "pause" in the progress table; the user ids (`user-list`, `user-*`, `user-roles-*`, `toggle-enabled-*`, `new-username`, `new-role-*`, `create-user`, `temporary-password`); `console.test.tsx`, `login.test.tsx` (`nav-users`); browser `console/1-refusals.spec.ts`, `console/2-actions.spec.ts`, `console/3-stream-lifetime.spec.ts`, `console/4-effects.spec.ts`, `console/effects.ts`, `console-shift/absence.spec.ts`, `orders/dispatch/1-roles.spec.ts`, `demo/walkthrough.spec.ts`. The console's datetime fields are filled by the specs with ISO strings today: the `PlantTimeInput` keeps a way to take them (the specs updated in this pull request if the field changes, and said so).
- **Gate:** `verify,smoke,reconcile`; `pnpm test:console`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1e.

### UX-11 Login and account

- **Closes:** L-01 … L-03, Y-01 … Y-03, G-18 (account).
- **Scope:** `screens/login.tsx`, `screens/account.tsx`.
- **Acceptance:** login card with the product mark, fields marked invalid with the error tied to them, the host-name hint as a small help line; account with plant and wall times by the content rules (no `toLocaleString`), roles as words and permissions grouped by area in a disclosure, the password form at form width, one Log out (the header's).
- **Keep green:** `login-username`, `login-password`, `login-submit`, `login-reason` and the other login ids, the forced-password-change ids; `login.test.tsx`, `auth/auth.test.tsx`; browser `login.ts` (used by every spec), `tls/tls.spec.ts`; the smoke's forced password change (`scripts/stack-smoke*` drives the API, not the page).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-1b … UX-1e.

---

## UX-12 Dark theme

- **Closes:** G-28.
- **Scope:** the switch (System, Light, Dark) in the top bar's user area and on the account page, stored per browser; `index.html` `color-scheme`; the chart theme repaint on change; print forced light.
- **Acceptance:** every screen in dark at 1440 and 390 with no raw colour left (`scripts/check-ui-tokens.ts` reports zero); every text pair of design system section 8 measured on the built page (a unit test over the token values); charts readable; print preview light.
- **Keep green:** all web unit tests; browser specs unaffected (they run in light).
- **Gate:** `verify,smoke,reconcile`; `pnpm demo`.
- **Depends on:** UX-2 … UX-11.

## UX-final

### UX-F1 Accessibility pass with axe on every route

- **Closes:** any remaining a11y findings; makes the AA bar a test.
- **Scope:** `e2e/browser/a11y/` (a Playwright project that visits every route in its data-rich, empty and error state as each role, light and dark, at 1280 and 390, and runs axe with the WCAG 2.2 A and AA rules), run by the reconciliation harness after its passes (the stack there has data and one user per role); `@axe-core/playwright` as an e2e dev dependency (entry in `docs/dependencies.md`, the pnpm `minimumReleaseAge` policy applies; a test-only dependency like Playwright itself, so no ADR); fixes for what it finds, each small; `docs/runbook.md` (the new project in the reconciliation's description).
- **Acceptance:** zero serious or critical violations on every route and state; moderate ones listed in the pull request with a decision each; the spec fails on a new serious or critical one.
- **Keep green:** everything; the reconciliation's existing passes unchanged.
- **Gate:** `verify,smoke,reconcile` (the `e2e/` row: `verify,reconcile`, plus `smoke` for the web fixes).
- **Depends on:** UX-12.

### UX-F2 Console CSP "eval" issue

- **Closes:** G-24.
- **Scope:** `apps/web/src/main.tsx` (`z.config({ jitless: true })` before any schema is used; Zod 4 then skips its `Function("")` capability probe), a unit test that the config is set, `docs/security-review.md` (one line: the probe and its removal).
- **Acceptance:** no CSP issue in the console on any page (checked in Chrome DevTools' Issues panel on the built app); schema parsing unchanged (the web unit tests and the reconciliation pass).
- **Keep green:** all web unit tests, the reconciliation.
- **Gate:** `verify,smoke,reconcile`.
- **Depends on:** – (can merge any time; listed here as the brief places it).

### UX-F3 Consistency review and the demo re-recording

- **Closes:** the overhaul.
- **Scope:** a review of every screen against the design system with screenshots at five widths (a table in the pull request: screen × width × light/dark, each ticked or with its fix); `scripts/check-ui-tokens.ts` turned into a failing check in `pnpm verify`; the demo re-recorded with `pnpm demo:record` per `docs/demo.md` "Re-recording" (new video, captions and screenshots in `docs/demo/`, the SHA-256, commit and length updated); `docs/demo.md`, `docs/README.md`, `CHANGELOG.md`.
- **Acceptance:** every audit id is closed or carried with a reason; no raw colour in `apps/web/src`; every demo assertion green in `pnpm demo` twice in a row and in the recording run; the recording within its limits.
- **Keep green:** everything.
- **Gate:** `verify,smoke,reconcile`; `pnpm demo` (twice in a row, as the rerun table asks for demo files) and `pnpm demo:record`.
- **Depends on:** UX-F1, UX-F2.

## Issue list

| Id    | Title                                               | Scope (one line)                                                              | Depends on      | Gate                                                        |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| UX-B1 | SPC chart: draw every point, keep rule labels apart | `chart/spc-options.ts`: `showAllSymbol`, rule-label lane                      | –               | verify,smoke,reconcile; demo                                |
| UX-B2 | Alarm raise times with their date                   | `alarm-list.tsx`, `domain/time.ts`: dates on non-today times                  | –               | verify,smoke,reconcile; demo                                |
| UX-B3 | Terminal: no "Offline" before sign-on               | `terminal.tsx` header shows the status only when signed on                    | –               | verify,smoke,reconcile                                      |
| UX-B4 | Show offline instead of loading forever             | query `networkMode`, offline events, an offline bar in the shell              | –               | verify,smoke,reconcile; test:resilience                     |
| UX-B5 | Alarm KPI hours missing from a running shift        | investigate `/alarms/kpi?bucket=hour`; finding to the coordinator             | –               | none (no code)                                              |
| UX-1a | Design tokens                                       | `index.css` `@theme` light and dark tokens; raw-colour report script          | –               | verify,smoke,reconcile                                      |
| UX-1b | App shell, grouped navigation and page header       | `root-layout.tsx`, `shell.tsx`, `PageHeader`, page titles, nav drawer         | UX-1a           | verify,smoke,reconcile; demo; test:console; test:resilience |
| UX-1c | Primitives: actions and status                      | Button, Badge and domain badges, Card, Stat, KpiTile, formatters              | UX-1a           | verify,smoke,reconcile; demo; test:resilience               |
| UX-1d | Primitives: data and forms                          | DataTable, Tabs, Field and controls, PlantTimeInput                           | UX-1a           | verify,smoke,reconcile                                      |
| UX-1e | Primitives: feedback and overlays                   | Dialog, Confirm, Toast, Empty, Skeleton, Error, NotFound, Tooltip, Disclosure | UX-1a           | verify,smoke,reconcile                                      |
| UX-1f | Chart theme                                         | `chart/theme.ts` for ECharts and uPlot; options on the theme                  | UX-1a, UX-B1    | verify,smoke,reconcile; demo                                |
| UX-2  | Overview and machine detail                         | `overview.tsx`, `machine-detail.tsx`, timeline axis                           | UX-1b–1f        | verify,smoke,reconcile; demo; test:resilience               |
| UX-3  | OEE dashboard and line OEE                          | `oee-dashboard.tsx`, `line-oee.tsx`, `oee-ui.tsx`                             | UX-1b–1f        | verify,smoke,reconcile; demo                                |
| UX-4a | Alarm list                                          | `alarm-list.tsx`: tabs, table, side panel or sheet                            | UX-1b–1e, UX-B2 | verify,smoke,reconcile; demo; test:console                  |
| UX-4b | Alarm KPIs                                          | `alarm-kpi.tsx`: KPI tiles, hourly table, empty states                        | UX-1b–1f, UX-B5 | verify,smoke,reconcile                                      |
| UX-5a | Downtime coding                                     | `downtime-coding.tsx`: table, coding panel, split time                        | UX-1b–1e        | verify,smoke,reconcile; demo                                |
| UX-5b | Shift reports and handover notes                    | `shift-list.tsx`, `shift-report.tsx`, `handover-notes.tsx`, print             | UX-1b–1f        | verify,smoke,reconcile                                      |
| UX-6a | Order list and order detail                         | `order-list.tsx`, `order-detail.tsx`: header, facts, section nav, tables      | UX-1b–1e        | verify,smoke,reconcile; demo; test:console                  |
| UX-6b | Order actions and order OEE                         | `order-actions.tsx`, `order-oee.tsx`                                          | UX-6a           | verify,smoke,reconcile; demo                                |
| UX-7  | Operator terminal (tablet first)                    | `terminal.tsx`: picker tiles, touch flow                                      | UX-1a–1e, UX-B3 | verify,smoke,reconcile                                      |
| UX-8  | Traceability: search, serial, lot and carton        | `trace-*.tsx`: results table, status badges, lot paging                       | UX-1b–1e        | verify,smoke,reconcile; demo                                |
| UX-9a | SPC                                                 | `spc.tsx`: list, chart page, episodes, limit versions                         | UX-1b–1f, UX-B1 | verify,smoke,reconcile; demo                                |
| UX-9b | Quality holds                                       | `holds.tsx`: list, new hold, detail                                           | UX-1b–1e        | verify,smoke,reconcile; demo                                |
| UX-10 | Simulation console and users                        | `console.tsx`, `users.tsx`                                                    | UX-1b–1e        | verify,smoke,reconcile; test:console; demo                  |
| UX-11 | Login and account                                   | `login.tsx`, `account.tsx`                                                    | UX-1b–1e        | verify,smoke,reconcile; demo                                |
| UX-12 | Dark theme                                          | theme switch, `color-scheme`, chart repaint, print light                      | UX-2 … UX-11    | verify,smoke,reconcile; demo                                |
| UX-F1 | Accessibility pass with axe on every route          | `e2e/browser/a11y/` in the reconciliation; fixes                              | UX-12           | verify,smoke,reconcile                                      |
| UX-F2 | Console CSP "eval" issue                            | `main.tsx`: `z.config({ jitless: true })`                                     | –               | verify,smoke,reconcile                                      |
| UX-F3 | Consistency review and the demo re-recording        | review table, raw-colour check failing, `pnpm demo:record`                    | UX-F1, UX-F2    | verify,smoke,reconcile; demo ×2; demo:record                |
