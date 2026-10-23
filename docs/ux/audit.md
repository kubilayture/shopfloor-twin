# UX audit of the web app (UX-0)

The state of `apps/web` on `main` at `a669468` (v1.0.0), toured screen by screen before the UI overhaul. Every defect has an id, a severity, a category and the screenshot that shows it. The design answers are in [`design-system.md`](design-system.md); the issues that fix them are in [`ux-plan.md`](ux-plan.md), which names the ids each issue closes.

## How it was done

- **Where:** the owner's demo stack (`shopfloor-demo`, `https://localhost:8443`), read-only. Nothing was acknowledged, coded, released, held or signed on; the forms were opened, never sent.
- **Who:** `ux-explorer` (every role), then `demo-operator` and `demo-quality` in their own browser contexts to see the role-limited navigation and the read-only variants. The maintenance and supervisor navigation follows from the same code (`RootLayout`: Terminal for `terminal:operate`, Users for `user:admin`, Console for `sim:control`) and the permission matrix in `packages/contracts/src/identity.test.ts`.
- **Viewports:** 1440×900 (desktop), 1280, 1024×768 (laptop, tablet landscape), 768×1024 (tablet portrait, touch) and 390×844 (phone, touch).
- **States:** data-rich (order PO-2610-303, lot BL100-2610-01, carton PO-2610-303-C01, serial VB-100-000110, the SPC chart `leak-rate`), empty (holds, floods, bad actors, telemetry samples, the line card during an idle shift), loading (Slow 3G), offline (the network cut after load) and error (unknown machine, order, carton and hold ids, a wrong login).
- **Tools:** chrome-devtools (snapshots, screenshots, console and network, Lighthouse accessibility on the overview and the console), the code in `apps/web/src`, and a contrast script for the colour pairs.
- **What the demo data could not show:** no quality hold exists on the demo stack, so the hold detail with data was reviewed from `holds.tsx` and `11-holds.png`; the signed-on terminal would add crew facts to the owner's demo, so it was reviewed from `terminal.tsx` and its tests. The plant was idle or starved for the whole tour (shift C, 21–22 Oct): the screens' empty states were easy to see, their busy states come from the order and SPC pages and the coordinator's `01…16` screenshots.

**Screenshots** live beside the brief in the owner's audit folder (`ux-audit-shopfloor/`, not committed): `01…16-*.png` are the coordinator's "before" set (1440×900, 16 at 390), `a01…a43-*.png` were taken for this audit. Each UX issue's pull request attaches its own before and after images.

**Severity.** _Blocker_: the screen misleads or a task cannot be done, or a WCAG 2.2 level A failure. _Major_: a real cost in use (a wrong reading, a slow scan, an inconsistency across screens, a WCAG AA failure, a broken layout at a supported width). _Minor_: polish.

**Category.** layout, hierarchy, consistency, a11y, responsive, content, bug.

## Summary

| Severity  | Count   |
| --------- | ------- |
| Blocker   | 2       |
| Major     | 45      |
| Minor     | 70      |
| **Total** | **117** |

The two blockers are wrong readings: an alarm's raise time shown without its date (A-01) and the SPC chart dropping its point markers partway along the series (C-03). The app's accessibility groundwork is good: Lighthouse scores 100 on the overview, every state has a text label, the skip link, the `aria-live` connection status, the heading focus on navigation and `prefers-reduced-motion` all work, and no grey text below AA was found (`text-slate-300` appears only on the dark header). What is missing is one system: the shell, the page header, the controls, the badges, the tables and the charts each exist in three to six variants.

Three findings are behaviour, not styling, and go to the coordinator as well as into the plan: G-20 (offline leaves every screen "Loading…" and the header "Live"), K-02 (the alarm KPIs show one hour of an eight-hour shift) and X-03 (the terminal shows "Offline" before sign-on).

## Global (every screen)

| Id   | Defect                                                                                                                                                                                                                                                                                                                                                                              | Severity | Category    | Screenshot                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------------------------- |
| G-01 | The header holds 13 flat links, the plant clock, the live status, the user with every role and Log out. It takes two rows at 1440 and 1024 (86 and 114 px), four at 768 (162 px) and six at 390 (about 230 px of an 844 px screen) before any content.                                                                                                                              | Major    | responsive  | a03, a36, a34, 16            |
| G-02 | Nothing groups the screens by job (monitor, production, quality, admin); a supervisor scans 13 equal links.                                                                                                                                                                                                                                                                         | Major    | hierarchy   | a03                          |
| G-03 | The active link is lost on every sub-page: `activeOptions: { exact: true }` marks Orders on `/orders` but not on `/orders/PO-2610-303`, and the same on machine, shift report, serial, lot, carton, SPC chart and hold pages.                                                                                                                                                       | Major    | bug         | a13, a15, a26                |
| G-04 | The full role list sits beside the user name on every page ("ux-explorer (Operator, Maintenance, Quality, Supervisor, Admin)") and wraps on narrow screens.                                                                                                                                                                                                                         | Minor    | content     | a03, a34                     |
| G-05 | Every route has the same document title, "ShopFloor Twin MES": tabs, history and screen readers cannot tell the pages apart (WCAG 2.4.2 Page Titled).                                                                                                                                                                                                                               | Major    | a11y        | page list in every run       |
| G-06 | No shared page header. Filters sit inline beside their labels (OEE, downtime, alarm KPIs), under stacked labels (orders, holds) or in a card (SPC); the back link above the title reads "All orders", "← Plant overview", "Trace search", "All holds", "All characteristics", or is missing (hold detail). Primary actions sit in the body ("Open a hold", "Print", "Close order"). | Major    | consistency | a04, a12, a13, a20, a25, a26 |
| G-07 | Page canvases differ: grey canvas with white cards (overview, OEE), bare tables (alarms, downtime), one card per row (shift list, users), a long stack of cards (console), a darker canvas on the terminal (`slate-100` against `slate-50`).                                                                                                                                        | Major    | consistency | a03, a07, a10, a31, a29      |
| G-08 | Explanations run as body text across the full width (lines of 160–190 characters on OEE, holds, orders, SPC, traceability and console), or as small grey text inside cards.                                                                                                                                                                                                         | Minor    | hierarchy   | a04, a12, a24, a25           |
| G-09 | Every screen defines its own `buttonClass`, `primaryClass` and `inputClass` (alarm list, console, downtime, handover notes, login, order actions, shift report, terminal, users, account, `quality-ui`): primary, outline, muted grey and dark-filled variants appear for the same kind of action.                                                                                  | Major    | consistency | a07, a21, a31, a32           |
| G-10 | Disabled controls read as enabled: `disabled:opacity-50` on a filled blue button ("Acknowledge selected (0)", "Mark absent for that shift") looks like a pale primary; disabled outline buttons ("Save roles", "Resume", "Load") look like secondary ones.                                                                                                                          | Major    | a11y        | a07, a31, a32                |
| G-11 | Destructive and irreversible actions look like any other: Disable, Reset password, Close order, Hold this order, Block, Take offline, Break tool, End (limit version) are all neutral outline buttons, often beside harmless ones.                                                                                                                                                  | Major    | consistency | a13, a31, a32                |
| G-12 | Six badge styles: machine state (filled, no border, 14 px), alarm priority (filled with a glyph), order status and flags (outline, 12 px), quality states (tinted fill and border), OEE status flags (outline), the "External" loss chip (filled amber, no border). The word "Final" is green on OEE and orders, red on SPC signals and plain text on shift reports.                | Major    | consistency | a04, a05, a07, a10, a12, a24 |
| G-13 | The machine-state palette spends colour on normal states (Running emerald, Setup sky, Maintenance violet, Off zinc, Planned stop indigo) and nothing raises an abnormal machine: a Starved or Down card looks like a Running one apart from its small badge.                                                                                                                        | Major    | hierarchy   | a03, a22                     |
| G-14 | Tables disagree: numbers left-aligned in some (order operations In/Good, carton Part, lot Part), right in others; header weight, zebra, hover and padding vary; no table has a sticky header; dates and durations wrap inside narrow columns ("1 h 40 / min", "Mon 12 Oct, / 11:25:50").                                                                                            | Major    | layout      | a05, a13, a15, a16, a17      |
| G-15 | Numbers mix fonts: ratios in monospace (`0.0000`) beside a sans percentage, the header clock in bold monospace, counts in sans. On one card the eye jumps between three digit shapes.                                                                                                                                                                                               | Minor    | consistency | a04, a09                     |
| G-16 | Absent values have many spellings: "–", "—", "none", "None", "n/a", "Not reported", "Nobody signed on", "no data yet", and an empty cell.                                                                                                                                                                                                                                           | Major    | content     | a03, a04, a13, a15           |
| G-17 | Durations have many formats: "4 h 54 min", "44 min 03 s", "93.1 min", "1800.0 min", "2 d 12 h"; large minute values are not carried into hours.                                                                                                                                                                                                                                     | Minor    | content     | a03, a11, a37                |
| G-18 | Dates break the plant-time rule (#295) in three ways: a clock time without its date for an event days old (A-01); the account page uses the browser's locale ("Oct 23, 2026, 8:48 PM", `toLocaleString(undefined, …)`) where everything else is en-GB; native date inputs show the OS locale ("21.10.2026", "dd.mm.yyyy, --:--:--").                                                | Major    | content     | a07, a24, a31, a33           |
| G-19 | Loading is a line of text ("Checking your session…", "Loading OEE…") with no reserved layout, so the page jumps when data arrives; the session check renders without the app shell.                                                                                                                                                                                                 | Minor    | layout      | a41, a42                     |
| G-20 | Offline is never shown: with the network cut, a screen opened afterwards stays "Loading orders…" for over 40 s and the header keeps "Live" (TanStack Query's default `networkMode: 'online'` pauses queries while the browser is offline; the open WebSocket is not yet seen as lost).                                                                                              | Major    | bug         | a43                          |
| G-21 | Not-found and error states disagree: an unknown machine shows a red alert "Could not load machine xyz-99. Not Found…" with a "Try again" that cannot help and no heading; an unknown order, carton or hold shows a heading as if it existed ("Order PO-NOPE", "Carton NOPE-123") and one sentence; an unknown route shows "Page not found".                                         | Major    | consistency | a18, a19, a20, a26           |
| G-22 | After a navigation the focused `h1` draws a 3 px ring across the full content width; the ring is meant for keyboard focus on controls.                                                                                                                                                                                                                                              | Minor    | a11y        | a43                          |
| G-23 | Form fields without `id` or `name`: Chrome reports "A form field element should have an id or name attribute" (9 on the console).                                                                                                                                                                                                                                                   | Minor    | a11y        | console issue list           |
| G-24 | "Content Security Policy of your site blocks the use of `eval`" on every page load, not only the console. Source: the main bundle at `Function("")`, which is Zod 4's JIT capability probe (`allowsEval`); it is caught, so nothing breaks. Ours to fix with `z.config({ jitless: true })` at start-up.                                                                             | Minor    | bug         | console issue list           |
| G-25 | Charts have no shared theme: ECharts (OEE, alarm KPIs, SPC, shift report) and uPlot (machine telemetry) differ in font, colour, axis and legend; legends sit above or below; category labels are cut ("Starved by the upstream st…"); per-bar value labels print "0.0000" on empty hours; Pareto axis labels overlap at 390 ("0 50100150200250").                                   | Major    | consistency | a04, a09, a11, a24, a35      |
| G-26 | List-plus-detail screens (downtime, alarms) keep an empty placeholder pane ("Choose a record to code it.") at 40–50 % of the width at 1024 and 1440 while the table beside it wraps every cell.                                                                                                                                                                                     | Major    | responsive  | a05, a07, a37                |
| G-27 | At 390 wide tables scroll sideways with the row actions off-screen and no sign that there is more (alarms' Acknowledge and Details, OEE's P, Q and losses).                                                                                                                                                                                                                         | Major    | responsive  | a34, a35                     |
| G-28 | No dark theme; `index.html` declares `color-scheme: light`. A control-room screen at night is a bright white page.                                                                                                                                                                                                                                                                  | Minor    | consistency | –                            |
| G-29 | Role-limited pages show controls a role cannot use or headings with nothing under them: quality sees "Code" on every downtime row (the panel opens read-only); an operator sees an "Actions" heading on an order with one sentence under it.                                                                                                                                        | Minor    | content     | a39, a40                     |
| G-30 | Small checkboxes (13 px) in table rows (alarm selection) and the users' role lists; they pass WCAG 2.5.8 through spacing but are hard to hit on a tablet.                                                                                                                                                                                                                           | Minor    | a11y        | a07, a32                     |

## Login (`/login`)

| Id   | Defect                                                                                                                                                       | Severity | Category  | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- | ---------- |
| L-01 | A refused login shows an alert but marks neither field (`aria-invalid` missing), so a screen reader user returning to the fields hears no error on them.     | Minor    | a11y      | a02        |
| L-02 | The host-name hint ("Open the app as localhost every time…") reads as a developer note in the user's face; it belongs in a smaller help line or the runbook. | Minor    | content   | a01        |
| L-03 | The product name is a 14 px line above the heading; the page has no visual identity shared with the app shell.                                               | Minor    | hierarchy | a01        |

## Overview (`/`)

| Id   | Defect                                                                                                                                                | Severity | Category   | Screenshot |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- |
| O-01 | All six machine cards have equal weight; abnormal machines (five Starved) are not raised, and there is no count of machines per state.                | Major    | hierarchy  | a03, 01    |
| O-02 | "Cause —" on every card without a cause; causes show as raw codes ("NO-ORDER").                                                                       | Minor    | content    | a03        |
| O-03 | Two heading levels (area "Machining", cell "Cell M1") with little difference in weight; the cell label is grey body text.                             | Minor    | hierarchy  | a03        |
| O-04 | At 1440 half the screen is empty under the cards; nothing summarises the shift (OEE so far, active alarms, open holds) for a supervisor's first look. | Minor    | hierarchy  | a03        |
| O-05 | At 390 the cards stack under a 230 px header (G-01); a card's facts table keeps a fixed label column.                                                 | Minor    | responsive | 16         |

## Machine detail (`/equipment/:id`)

| Id   | Defect                                                                                                                                                  | Severity | Category    | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| M-01 | The state timeline's axis has two labels, start and end; for "Last 24 h" both read "01:32", with no date and no ticks between.                          | Major    | content     | a22        |
| M-02 | Telemetry names are raw ids (`coolant-temperature`, `leak-rate`) and the latest value is ten days old (Mon 12 Oct) with no stale cue.                   | Major    | content     | a21, a22   |
| M-03 | Tables ("Time per state", "Metrics and latest values") have no container while the charts beside them are cards; the metrics table stops at half width. | Minor    | consistency | a21        |
| M-04 | The range links are dark filled pills, a style used nowhere else.                                                                                       | Minor    | consistency | a21        |
| M-05 | Chart cards with no samples are small boxes with one sentence; nothing says when the last sample was.                                                   | Minor    | content     | a21        |
| M-06 | An unknown machine shows an error with "Try again" and no `h1` (G-21).                                                                                  | Minor    | consistency | a20        |

## OEE dashboard and line OEE (`/oee`)

| Id   | Defect                                                                                                                                                                                               | Severity | Category   | Screenshot |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---------- |
| E-01 | The empty line card is "n/a" at headline size, "none", "0.0 min" and an eight-row table of "n/a / none"; an idle shift is not designed as a state ("No order in progress this shift").               | Major    | hierarchy  | a04, 02    |
| E-02 | A, P and Q are four-decimal fractions (`0.0000`) under a percentage headline; the machines table is all fractions. People read percentages; the fraction belongs in the tooltip and `data-fraction`. | Major    | content    | a04        |
| E-03 | "Provisional (93.1 min)" repeats on all six machine rows and both work-center cards.                                                                                                                 | Minor    | hierarchy  | a04        |
| E-04 | The "Line OEE per hour" table puts a right-aligned "Packed good" against a left-aligned "Status" with no gap.                                                                                        | Minor    | layout     | a04        |
| E-05 | The OEE-per-hour chart labels empty bars "0.0000"; its card is stretched to the waterfall's height and is half empty.                                                                                | Minor    | layout     | a04        |
| E-06 | The waterfall's "External" step is labelled "−93.1" but drawn as a positive bar, and the table writes "– 93.1 min" with a space after the sign.                                                      | Major    | content    | a04        |
| E-07 | The Pareto reason is truncated ("Starved by the upstream st…") with the full text only in the table below (G-25).                                                                                    | Minor    | content    | a04        |
| E-08 | At 390 the machines table hides P, Q and the losses off-screen (G-27).                                                                                                                               | Minor    | responsive | a35        |

## Downtime coding (`/downtime`)

| Id   | Defect                                                                                                                                | Severity | Category    | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| D-01 | The record table wraps machine, start, length and reason into two-line cells while the empty coding pane takes the other half (G-26). | Major    | layout      | a05, a37   |
| D-02 | State is plain text here and a coloured badge everywhere else; the "External" chip is a style of its own.                             | Minor    | consistency | a05        |
| D-03 | The selected row's highlight (`sky-50`) is barely visible next to the open panel.                                                     | Minor    | a11y        | a06        |
| D-04 | Roles without `downtime:code` still see "Code" (G-29).                                                                                | Minor    | content     | a40        |
| D-05 | The split time is a native `time` input with seconds and a clock icon, with no hint that it is plant time beyond the label.           | Minor    | content     | a06        |

## Alarms and alarm KPIs (`/alarms`, `/alarms/kpi`)

| Id   | Defect                                                                                                                                                                                                                                                                                                   | Severity | Category    | Screenshot |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| A-01 | "Raised" shows the clock time only: SPINDLE-OVERLOAD raised Mon 12 Oct 07:15 reads "07:15:00" in a list seen on Thu 22 Oct, so a ten-day-old standing alarm looks like this morning's.                                                                                                                   | Blocker  | content     | a07, a08   |
| A-02 | Row actions are stacked ("Acknowledge" over "Details"), doubling every row's height.                                                                                                                                                                                                                     | Major    | layout      | a07, 04    |
| A-03 | Unacknowledged alarms are a text state ("Cleared, unacknowledged") with no emphasis; ISA-18.2 asks that unacknowledged alarms stand out from acknowledged ones.                                                                                                                                          | Major    | hierarchy   | a07        |
| A-04 | The tabs are boxed buttons that wrap to two rows at 390; the detail heading breaks inside the alarm code ("SPINDLE- / OVERLOAD").                                                                                                                                                                        | Minor    | layout      | a08, a34   |
| A-05 | The detail panel scrolls away with the page; on a long list the actions are out of sight.                                                                                                                                                                                                                | Minor    | layout      | a08        |
| A-06 | "Shelf of cnc-01 SPINDLE-OVERLOAD" and "fact seq 18 · opcua" are raw identifiers in headings and history.                                                                                                                                                                                                | Minor    | content     | a08        |
| K-01 | Each KPI card is ten label/value rows with wrapping labels ("Raises (high / / medium / low)"); the headline measure (average per 10 min against the EEMUA target) is no bigger than the rest, and its "Acceptable" verdict is 12 px green text.                                                          | Major    | hierarchy   | a09, 05    |
| K-02 | The hourly table and chart show one hour (00:00–01:00) of a shift that started at 22:00: the MES returned a single bucket and the page does not say why the hours before are missing; OEE lists every hour of the same shift. To confirm with the coordinator whether the MES or the screen is at fault. | Major    | bug         | a09        |
| K-03 | The flood threshold's label sits mid-chart over the plot area.                                                                                                                                                                                                                                           | Minor    | layout      | a09        |
| K-04 | Empty tables (floods, bad actors) show column headers over one sentence instead of an empty state.                                                                                                                                                                                                       | Minor    | consistency | a09        |

## Shift reports (`/shifts`, `/shifts/:date/:shift`)

| Id   | Defect                                                                                                                                                                                       | Severity | Category    | Screenshot |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| S-01 | The list is one card per shift with badges floating after links of different widths, so nothing lines up; "Final Final" is said twice; "Revision: inputs 0, content 0" repeats on every row. | Major    | consistency | a10, 06    |
| S-02 | No table semantics or filter for a week of 15 shifts; the weekend gap is not explained.                                                                                                      | Minor    | layout      | a10        |
| R-01 | The report is one 2800 px column of nine sections with no in-page navigation; sections switch between tables, cards and bare figures.                                                        | Major    | hierarchy   | a11        |
| R-02 | OEE is a percentage here and a four-decimal fraction on the OEE dashboard for the same shift.                                                                                                | Major    | consistency | a11, a04   |
| R-03 | Alarm cards say "Position Cell M1" where the alarm KPI page says "Cell M1".                                                                                                                  | Minor    | content     | a11        |
| R-04 | The action row mixes buttons (Print, Download JSON, Read again) with a long explanatory sentence.                                                                                            | Minor    | layout      | a11        |

## Orders (`/orders`, `/orders/:id`)

| Id   | Defect                                                                                                                                                                             | Severity | Category    | Screenshot |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| P-01 | The status filter has its label above it, unlike the inline filters elsewhere (G-06).                                                                                              | Minor    | consistency | a12        |
| P-02 | Priority is a bare number beside the alarm screens' priority badges; an overdue order is not marked.                                                                               | Minor    | content     | a12        |
| Q-01 | The detail is 3000 px of ten sections with no tabs or in-page navigation; the action (Close order) is far from the status it changes, and "Hold this order" is in another section. | Major    | hierarchy   | a13        |
| Q-02 | The header facts are a three-column "Label: value" grid that flows by rows, so the reading order changes with the width; unused fields ("Cancelled: –", "Closed: –") take space.   | Minor    | layout      | a13, a36   |
| Q-03 | Numbers are left-aligned in "Operations and quantities" (G-14).                                                                                                                    | Minor    | layout      | a13        |
| Q-04 | The line OEE card of a completed order says "In progress" beside its window, and "Packed good VB-100 59" runs product and count together.                                          | Major    | content     | a13        |
| Q-05 | Ten near-identical boxed ERP messages, each with its own "Payload" disclosure; a table would be a fifth of the height.                                                             | Minor    | layout      | a13        |
| Q-06 | The holds section explains itself with HTTP codes ("409 quality-hold", "409 genealogy-pending").                                                                                   | Minor    | content     | a13        |
| Q-07 | History lines mix wall and plant time and end with raw request UUIDs.                                                                                                              | Minor    | content     | a13        |
| Q-08 | For a role that cannot act, the "Actions" heading holds one sentence (G-29).                                                                                                       | Minor    | content     | a39        |

## Operator terminal (`/terminal`, `/terminal/:workCenter`)

| Id   | Defect                                                                                                                                                                                                 | Severity | Category    | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- | ---------- |
| X-01 | The picker is two plain outlined boxes on an empty canvas, inside the desk shell with its 13 links; a work center shows no crew, order or state to choose by.                                          | Major    | layout      | a28, 12    |
| X-02 | The terminal header shows the raw id ("Terminal cell-m1") in monospace, not the work center's name.                                                                                                    | Minor    | content     | a29, a30   |
| X-03 | Before sign-on, with a desk session in the same browser, the header shows a red "Offline": the standalone route never starts the live client but renders `ConnectionStatus` whenever a session exists. | Major    | bug         | a29, a30   |
| X-04 | Nothing leads back from a work center's terminal to the picker or the desk.                                                                                                                            | Minor    | layout      | a29        |
| X-05 | The terminal's own button and input constants (56 px targets, good for touch) share nothing with the desk's, so the two drift apart.                                                                   | Minor    | consistency | code       |

## Traceability (`/trace`, serial, lot, carton)

| Id   | Defect                                                                                                                                          | Severity | Category  | Screenshot |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ---------- |
| T-01 | Search results are a run of inline links with no type, order or status per result.                                                              | Major    | layout    | a14, 09    |
| T-02 | A scrapped serial's status is plain text ("Status: Scrapped"); the abnormal outcome is not raised, only the leak readings are red.              | Major    | hierarchy | a15        |
| T-03 | One table spells absence four ways: "None", "Not reported", "Nobody signed on", "–" (G-16); dates wrap in a narrow column.                      | Minor    | content   | a15        |
| T-04 | The lot page is a 180-row table with no paging, filter or sticky header; its orders, cartons, where-used and holds sections start 6000 px down. | Major    | layout    | a16        |
| T-05 | "Run" repeats the same device epoch on every row of the lot and carton tables.                                                                  | Minor    | content   | a16, a17   |
| T-06 | An unknown carton shows "Carton NOPE-123" as its heading with the carton description under it (G-21).                                           | Minor    | content   | a18        |

## SPC (`/quality/spc`, `/quality/spc/:char`)

| Id   | Defect                                                                                                                                                                                                                                                                   | Severity | Category    | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- | ---------- |
| C-01 | The characteristic card says "10 not acknowledged" in body text; ten unacknowledged signal episodes are the reason to open the page.                                                                                                                                     | Major    | hierarchy   | a23        |
| C-02 | Rule labels at the top of the I and X charts overlap ("Rule 1 RuRule 2…").                                                                                                                                                                                               | Major    | layout      | a24, 10    |
| C-03 | The I and MR charts draw point markers for the first part of the series only (to about 10:30); after that only the line remains, so the later points and their rule markers cannot be read. Likely ECharts' `showAllSymbol: 'auto'` thinning symbols on a category axis. | Blocker  | bug         | a24        |
| C-04 | UCL, LCL, rule bands and signal markers are all red, the centre green; the legend mixes marker shapes.                                                                                                                                                                   | Minor    | consistency | a24        |
| C-05 | A final signal episode is a red "Final" badge, while "Final" is green on OEE and orders (G-12).                                                                                                                                                                          | Minor    | consistency | a24        |
| C-06 | Each episode row ends with a button and an underlined link side by side ("Acknowledge", "Hold from this episode").                                                                                                                                                       | Minor    | consistency | a24        |
| C-07 | The limit versions table packs triples into cells ("0.7647 / 2.0485 / 3.3323").                                                                                                                                                                                          | Minor    | layout      | a24        |

## Quality holds (`/quality/holds`, `/new`, `/:id`)

| Id   | Defect                                                                             | Severity | Category    | Screenshot |
| ---- | ---------------------------------------------------------------------------------- | -------- | ----------- | ---------- |
| H-01 | The page's primary action ("Open a hold") is a secondary button above the filters. | Minor    | hierarchy   | a25        |
| H-02 | The "Id" filter label sits 2 px above "State" and "Subject".                       | Minor    | layout      | a25        |
| H-03 | The empty list is one sentence ("No hold matches.").                               | Minor    | consistency | a25        |
| H-04 | An unknown hold has no back link and no active navigation (G-03, G-21).            | Minor    | consistency | a26        |
| H-05 | On the new-hold form the reason select cuts its option text ("…(SUSPEC").          | Minor    | layout      | a27        |

## Simulation console (`/console`)

| Id   | Defect                                                                                                                                                                                       | Severity | Category  | Screenshot |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ---------- |
| N-01 | "Material lots": the right-aligned "Remaining" header has no padding and runs into "State" ("RemainingState", "720Free"); the actions column has no header (Lighthouse/axe `td-has-header`). | Major    | bug       | a31, 13    |
| N-02 | Times are raw ISO 8601 UTC text fields ("2026-10-12T05:00:00Z") beside a native date picker in the OS locale; labels are long ("At (simulation time, optional; UTC, ISO 8601)").             | Major    | content   | a31        |
| N-03 | Block and Release are both offered for every lot, whatever its state, with the same weight.                                                                                                  | Minor    | hierarchy | a31        |
| N-04 | The scenario list interleaves Load buttons with paragraphs, so the four scenarios do not scan as a list.                                                                                     | Minor    | layout    | a31        |
| N-05 | "Plant events" with nothing yet shows only its caption.                                                                                                                                      | Minor    | content   | a31        |
| N-06 | Cards in the two-column rows have unequal heights and inconsistent inner spacing.                                                                                                            | Minor    | layout    | a31        |

## Users and account (`/admin/users`, `/account`)

| Id   | Defect                                                                                                                               | Severity | Category    | Screenshot |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------- | ---------- |
| U-01 | Each user shows its roles twice (as text and as checkboxes) in its own card; a table with one role column would scan faster.         | Minor    | layout      | a32, 15    |
| U-02 | "Disable" and "Reset password" are neutral buttons beside "Save roles" (G-11).                                                       | Minor    | consistency | a32        |
| Y-01 | "Logged in" and "Session ends" use the browser locale ("Oct 23, 2026, 8:48 PM") and only the second says "(wall time)" (G-18, #295). | Major    | content     | a33        |
| Y-02 | Permissions are listed as raw `resource:verb` ids in monospace.                                                                      | Minor    | content     | a33        |
| Y-03 | Log out appears in the page and in the header; the password form stretches to 672 px.                                                | Minor    | layout      | a33        |

## Severity count by area

| Area                  | Blocker | Major  | Minor  |
| --------------------- | ------- | ------ | ------ |
| Global                | 0       | 19     | 11     |
| Login                 | 0       | 0      | 3      |
| Overview              | 0       | 1      | 4      |
| Machine detail        | 0       | 2      | 4      |
| OEE                   | 0       | 3      | 5      |
| Downtime coding       | 0       | 1      | 4      |
| Alarms and alarm KPIs | 1       | 4      | 5      |
| Shift reports         | 0       | 3      | 3      |
| Orders                | 0       | 2      | 8      |
| Terminal              | 0       | 2      | 3      |
| Traceability          | 0       | 3      | 3      |
| SPC                   | 1       | 2      | 4      |
| Quality holds         | 0       | 0      | 5      |
| Console               | 0       | 2      | 4      |
| Users and account     | 0       | 1      | 4      |
| **Total**             | **2**   | **45** | **70** |
