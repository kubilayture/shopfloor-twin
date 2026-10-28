# Consistency review of the web app (UX-F3)

The last pass of the UX overhaul (#339, [`ux-plan.md`](ux-plan.md) UX-F3): every screen after its migration and the dark theme (#381), compared with every other screen and with the [design system](design-system.md). It records what was checked, what was found, and what was fixed or decided. A finding fixed here names its change; one left as it is says why.

## How it was done

- **Where:** `vite dev` from the branch, its `/api` proxied to the owner's demo stack (`shopfloor-demo`, read-only: nothing was acknowledged, coded, released or held), so every screen had five days of real data. States the stack cannot show on demand were made in the browser with Playwright's `page.route`: every read answering 503 (error), every read left pending (loading), synthetic state intervals (the timeline bands).
- **Roles:** `ux-explorer` (every role), `demo-operator` and `demo-quality`, each in its own browser context.
- **Widths and themes:** every route at 1440, 1024 and 390 px, in light and in dark (156 full-page captures, before and after); the list-and-detail screens and the charts also at 1280 and 768 where a finding needed it.
- **Side by side:** the captures were cut to the same region (the page header, the first section, a chart) and laid next to each other, so headers, gutters, sections and badges were compared screen against screen, not one screen at a time.
- **Measured, not only looked at:** per route and width, the `h1`'s size and weight and position, the content's left edge and width, every `h2`'s size and weight, the back links' `aria-current`, horizontal page scroll, and the console's errors and warnings; a keyboard pass (60 Tab presses per route, both themes) checking that every focused control draws a ring; print media from the dark theme.
- **Screenshots:** `ux-audit-shopfloor/339/` (`sweep-before/` and `sweep-after/`, one file per route, theme and width, with `metrics.json`; the before and after of each fix beside them).

## What was checked

| Screen                                   | 1440 light | 1440 dark | 1024 light | 1024 dark | 390 light | 390 dark  | States                                                                               |
| ---------------------------------------- | ---------- | --------- | ---------- | --------- | --------- | --------- | ------------------------------------------------------------------------------------ |
| Login                                    | ✓          | ✓         | –          | –         | ✓         | ✓         | form                                                                                 |
| Overview                                 | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, loading, error                                                                 |
| Machine detail                           | ✓ (fix 6)  | ✓ (fix 6) | ✓          | ✓         | ✓         | ✓         | data, loading, error, empty                                                          |
| OEE and line OEE                         | ✓          | ✓         | ✓          | ✓         | ✓ (fix 1) | ✓ (fix 1) | data, loading, error, empty                                                          |
| Downtime coding                          | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, read-only, error                                                               |
| Alarms                                   | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, error                                                                          |
| Alarm KPIs                               | ✓          | ✓         | ✓          | ✓         | ✓ (fix 7) | ✓ (fix 7) | data, empty, loading, error                                                          |
| Shift reports, shift report, print       | ✓ (fix 2)  | ✓         | ✓ (fix 1)  | ✓         | ✓ (fix 1) | ✓         | data, loading, error, print                                                          |
| Orders, order detail                     | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, read-only, loading, error, not found                                           |
| Terminal picker, sign-on                 | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, error                                                                          |
| Traceability search, serial, lot, carton | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | empty, data, loading, error                                                          |
| SPC list, SPC chart                      | ✓ (fix 10) | ✓         | ✓          | ✓         | ✓         | ✓         | data, read-only, loading, error                                                      |
| Holds list, open a hold                  | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | empty, read-only, loading                                                            |
| Console                                  | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | forbidden (operator); the dev proxy has no simulator, so its data states are UX-10's |
| Users, account                           | ✓          | ✓         | ✓          | ✓         | ✓         | ✓         | data, forbidden, loading                                                             |
| Not found (an order, an address)         | ✓ (fix 3)  | ✓ (fix 3) | ✓          | ✓         | ✓         | ✓         | not found                                                                            |

No route scrolls sideways at any width, and every focused control draws the 2 px ring in both themes (the terminal picker's tiles draw theirs on the tile, by design).

## Findings and what was done

### From the issue's comments

1. **The shift picker's day** wrote "Mon 6 Jan" where the shift span and every other date write "Mon 06 Jan" (#368 review). Fixed: two digits (`shift-picker.tsx`); a test checks the picker's label and the span on the same single-digit day.
2. **The `1-oee-live` latency margin** (#368 review: 1442 ms of 2000 ms once during UX-3). Checked, not changed. The 30 `oee-latency.json` results of the gate runs since UX-1d2 have a page latency of at most 1519 ms (p95 at most 946 ms); in every run the WebSocket's own latency is within 20 ms of the page's, so the time is the MES's push pacing (one delta a second per topic), not the page (it draws a push within about 20 ms). The 2 s limit is Phase 5's exit criterion; it stays.
3. **Hand-rolled back links** (#372 review): the order, hold and trace pages, and also the machine detail and the shift report, drew their own "‹ …" link while their subject loaded, with the router's loose matching, so the parent was announced as the current page (the machine's "‹ Plant overview" on every page). Fixed: one `BackLink` (`page-header.tsx`) for the header and for every loading page; a test renders each detail route with nothing answering and checks the link, its target and that it is not current.
4. **Running and Planned stop bands** (#345 review) differ only by an edge colour (`#334155` against `#64748b`) over near-equal fills. Fixed: the Planned stop band has a double edge (its glyph is ‖), and the legend shows each band's own swatch beside its badge, so a reader can match them. Design system 2.4.
5. **`scrollbar-gutter`** (#351 review): with visible scrollbars the page shifted sideways when the drawer or a dialog set `overflow: hidden`. Fixed: `scrollbar-gutter: stable` on `html`. Overlay scrollbars (macOS, iPadOS, phones) are unchanged; with classic scrollbars a page shorter than the window keeps an empty gutter beside the top bar, the usual price of this rule.
6. **The nav's colour column** (#358 review) is now in design system 3.2.
7. **The "Flood threshold" label** lay over the bars at 390 (UX-12). Fixed: the threshold is named in the chart's legend as a dashed sample, at every width, and the line has no label on the plot. Design system section 5 ("Reference lines").

### Found in the review

1. **The downtime Pareto went blank on phones** (OEE dashboard, shift report): at a chart width of 480 px or less its `media` option applies, and ECharts drops the series and axes that a live update replace-merges into such an option, so the first push left an empty frame (dev builds warned "Own series not exists" on every update). Fixed in `echarts-view.tsx`: a live update of an option with `media` is a plain merge; a rendered test draws the narrow Pareto through three updates. _This is a rendering defect, not a layout one; it is in its own commit so it can go in its own pull request if preferred._
2. **Thousands on chart axes:** ECharts grouped every thousand ("1,500" on the shift report's Pareto) under a table that writes "1800.0 min". Fixed: value-axis ticks follow the number rule of 6.1 (grouped from 10,000 only, a true minus) through the chart theme.
3. **Not-found pages had a header of their own:** a chevron icon instead of "‹ ", no rule under the title, the title 4 px lower. Fixed: `NotFound` and `PageNotFound` use the `PageHeader`. Their back link's accessible name gains the "‹ " every other back link has (unit tests updated; no browser spec reads them).
4. **Title weight:** the page header, the login card and the re-login cover drew their `h1` at 700, the not-found pages at 600; design system 2.7 says 600 for titles (700 is for the one headline figure). Fixed: 600 everywhere.
5. **Monospace numbers** (G-15): SPC values and statistics, the top bar's plant clock and the offline bar's time were monospace; every other number is sans with tabular figures. Fixed. The terminal's clock gains tabular figures, so it no longer jitters.
6. **SPC episode bars:** an unacknowledged episode's row bar was `warn` whether the episode was final (red badge) or provisional. Fixed: the bar takes the badge's tone (final `alarm`, provisional `warn`), as an alarm's bar takes its priority's.
7. **Read-only and hint notes in four colours:** "Your role cannot …" was `neutral` on downtime and `info` (blue) on orders, holds and handover notes; the trace search's "only the first 50 are shown" and the serial's "Which one?" were `info`. Design system 4.13 says a neutral line; `info` is a state (planned intervention, in progress). Fixed: all `neutral`. The shift report's "changed after it became final" stays `info`: a revision is `info` by 2.6.
8. **Bold OEE column** on the shift report only. Fixed: plain, as on the OEE dashboard, the hourly tables and the order's jobs.
9. **The alarm KPIs' weekly table** showed the MES's raw key for a stretch outside every shift ("no-shift/2027-07-17T03:00:00.000Z"). Fixed: "No shift" with its span.
10. **Empty chart states:** without data an ECharts figure showed a bare sentence ending in a full stop, while the trend charts and every other empty state have an icon and a title without one. Fixed: the info icon, and no full stops in empty-state titles.
11. **Errors said "HTTP 503"** when an answer had no problem body (the proxy's own 502 or 504, a bare 503): protocol talk, against 6.4. Fixed in `ErrorState`: words per status ("The MES cannot be reached.", "The MES is not available at the moment."); the MES's own problem detail is shown as before.
12. **"No shift yet" while loading:** the shift list (and the other shift pickers' screens) took the current shift's answer as the end of loading, so for as long as the list of shifts was on its way the shift list said "No shift yet: the plant clock has not started". Fixed: `useShiftSelection` is pending until the list is in; a test holds `/shifts` and checks for the skeleton. _A loading-state fix; in the same separate commit as 1._
13. **`raw colours` check:** none left, so `pnpm check:ui-tokens` is now a failing check in `pnpm verify` (runbook, `apps/web/README.md`).

### Checked and consistent

- **Page header:** every page has one `h1` at 20 px (24 px on the overview, OEE and alarm KPIs), 600; the header starts 24 px under the top bar; the back link sits 4 px above the title on every detail page; descriptions are one line in `ink-secondary`; the rule under the header and the filter row are the same everywhere.
- **Gutters and widths:** 32 px from `xl` (beside the 232 px nav), 24 px at 1024, 16 px at 390; content to the right edge minus the gutter; no page scrolls sideways.
- **Sections:** every `h2` 18 px 600; tables in the `DataTable` frame, facts in cards, never a bare table beside cards.
- **Tables:** numbers right-aligned with tabular figures, units in each duration cell, headers right over right-aligned columns, the same row height and dividers.
- **Badges and tone:** colour only for abnormal states (Starved, Blocked, Down, alarms by priority, open holds, signals); Final, Provisional, Completed, Running and Idle neutral; the same word always in the same badge.
- **Dates and times:** "Mon 12 Oct, 07:15:00" with the date unless today, planning times without seconds, wall times labelled "(wall time)", shift spans "Mon 12 Oct, 06:00 – 14:00".
- **Buttons:** one primary per page or form, destructive actions `danger`, row actions ghost and side by side, disabled buttons in the disabled look.
- **Focus rings:** 2 px in `focus`, `focus-on-dark` on the top bar and nav, in both themes.
- **Charts:** one theme (font, axes, legend top-left, tooltips on the canvas), dark repainted; print draws them light.
- **Print:** the shift report and the order print light from the dark theme, without the shell, the in-page index or the forms.

### Left as they are, with a reason

- **The order's facts in three columns** where 3.4 says 1 / 2 / 4 (the SPC chart's four). They flow by column, so the reading order holds; a fourth column would leave the order's eight facts in two short rows beside the actions. Worth a decision in 3.4 rather than a change here.
- **The shift picker truncates** "… – current" at 390 px in a native `select`: the option text is what the browser shows; shortening it would change a text the walkthrough selects by. The span under the picker says the same.
- **One error per failed read:** with every read failing, the alarms page shows one callout per tab count and the OEE page three. Each says what it could not load and retries on its own (design system 10, partial error); one summary alert would need a screen-level error model, larger than this review.
- **"Loading chart…"** is a line of text for the moment the chart library's chunk loads (once per session); `e2e/browser/csp/csp.spec.ts` waits for that text to go.
- **History lines** on the order show the MES's event names ("order.dispatch"): they are the audit record's own words; the request ids are already in a disclosure (Q-07).
- **uPlot's value axis** (machine telemetry) groups thousands with the browser's number format; no telemetry metric reaches 10,000 today.

## Audit ids

Every audit id is closed by the issue that lists it in [`ux-plan.md`](ux-plan.md), all merged. The 36 ids no issue listed were checked on the after screenshots:

| Ids                    | State                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A-03, A-04, A-05       | Closed (UX-4a, #371): unacknowledged rows bold with a priority bar; underline tabs that scroll at 390; the detail in a sticky panel or sheet |
| C-05                   | Closed by decision (design system 2.6): a final signal stays `alarm` soft with the word "Final"; the tone, not the word, says it is a signal |
| C-06                   | Closed (UX-9a): Acknowledge and Open a hold are ghost buttons side by side                                                                   |
| D-02, D-03, D-04       | Closed (UX-5a): state badge and loss badge; the selected row's accent fill and bar; "View" for a role without `downtime:code`                |
| E-03, E-04, E-06       | Closed (UX-3): finality once per section; aligned table columns; waterfall steps drawn from their base with a true minus                     |
| G-08                   | Closed: one-line descriptions, longer text in "What this page shows" disclosures                                                             |
| H-02, H-04             | Closed (UX-9b, and fix 3 above): one filter row; the hold's not-found page has the header and its back link                                  |
| L-02                   | Closed (UX-11): the host-name hint is a footnote of the login card                                                                           |
| M-02, M-03, M-04, M-05 | Closed (UX-2): metric names with their ids; tables in frames; the range as `SegmentedLinks`; empty trends say when the last sample was       |
| N-03, N-04, N-06       | Closed (UX-10)                                                                                                                               |
| O-02, O-03             | Closed (UX-2): "No order" with its code; area `h3`, work center `h4`                                                                         |
| O-04                   | Partly: the overview's "Machines by state" summary is there; an OEE and alarm summary for the shift is not (a feature, not a defect)         |
| Q-02                   | Closed: facts flow by column (three columns, see above)                                                                                      |
| Q-06, Q-07             | Closed (UX-6a): no HTTP codes in the holds section; plant time beside wall time, request ids in a disclosure                                 |
| R-02, R-03, R-04       | Closed (UX-5b): percentages; "Cell M1"; the actions in the header                                                                            |
| T-02, T-03, T-04, T-05 | Closed (UX-8): status badges; one spelling for absence; lot units paged; the run in the header                                               |
| Y-02                   | Closed (UX-11): permissions behind "What your roles allow", in words                                                                         |
