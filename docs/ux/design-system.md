# Design system of the web app

The visual and interaction rules every screen of `apps/web` follows from UX-1 on. It answers the [audit](audit.md) (ids in brackets) and is built issue by issue as [`ux-plan.md`](ux-plan.md) lays out. When a screen and this document disagree after its migration, the screen is wrong; a rule that turns out wrong is changed here first, in the same pull request that changes the code.

## 1. Direction

An industrial control-room style, after ISA-101's high-performance HMI:

1. **Calm by default.** Neutral grey surfaces, dark text, no decorative colour. A plant running normally looks quiet.
2. **Colour means abnormal.** Saturated colour is reserved for states that need a person: down, stopped, starved, blocked, alarms by priority, holds, signals, refused writes. Normal states (running, idle, planned stop, final) are shades of grey. Colour never stands alone: every state also has a word, and the abnormal ones a glyph.
3. **Dense but readable.** Tables and figures carry the work. Body text is 14 px, line height 1.43, numbers right-aligned in tabular figures, labels short, explanations one line with the rest a click away.
4. **One way to do each thing.** One button, one badge, one table, one page header, one chart theme. A screen composes primitives from `src/components/ui/`; it defines no colours, sizes or button classes of its own (G-09).
5. **The plant's clock is the truth.** Times are plant time unless labelled "(wall time)" (#295). Raw values stay in `data-value` and `data-fraction` for the tests and tools; people read the formatted text.

## 2. Tokens

Tokens are CSS custom properties defined once in `src/index.css` with Tailwind 4's `@theme`, so each is both a variable (`var(--color-surface)`) and a utility (`bg-surface`, `text-ink`, `border-line`). Screens use the semantic names only; the raw scale is for the token file. Every colour token has a light and a dark value (section 8); the dark values sit under `:root[data-theme='dark']`.

```css
@import 'tailwindcss';

@theme {
  --color-canvas: #f1f5f9;
  --color-surface: #ffffff;
  --color-surface-sunken: #f8fafc;
  --color-ink: #0f172a;
  --color-ink-secondary: #475569;
  /* … every token below … */
  --font-sans:
    ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}

:root[data-theme='dark'] {
  --color-canvas: #0b1220;
  /* … */
}
```

### 2.1 Neutral scale

Slate, as today, so the change of palette is small and the existing contrast results carry over.

| Token         | Hex       | Use                                                              |
| ------------- | --------- | ---------------------------------------------------------------- |
| `neutral-0`   | `#ffffff` | Surface (cards, tables, inputs)                                  |
| `neutral-50`  | `#f8fafc` | Sunken surface (table header, zebra, read-only field)            |
| `neutral-100` | `#f1f5f9` | Canvas (page background)                                         |
| `neutral-200` | `#e2e8f0` | Hairlines, row dividers, chart grid; Idle fill                   |
| `neutral-300` | `#cbd5e1` | Card and table borders; disabled borders (`disabled-line`)       |
| `neutral-400` | `#94a3b8` | Decorative only; never text                                      |
| `neutral-500` | `#64748b` | Input borders, icons, the non-text 3:1 minimum; never body text  |
| `neutral-600` | `#475569` | Secondary text (labels, captions, hints)                         |
| `neutral-700` | `#334155` | Strong secondary text; Running badge border; chart axis text     |
| `neutral-800` | `#1e293b` | Navigation surface; hover on dark                                |
| `neutral-900` | `#0f172a` | Primary text; top bar                                            |
| `neutral-950` | `#020617` | Not used; defined so Tailwind's own `neutral-950` cannot survive |

Semantic aliases: `canvas` = 100, `surface` = 0, `surface-sunken` = 50, `line` = 300, `line-subtle` = 200, `line-strong` = 500, `ink` = 900, `ink-secondary` = 600, `ink-inverse` = 0.

### 2.2 Accent (actions and links)

| Token            | Hex       | Use                                                                   |
| ---------------- | --------- | --------------------------------------------------------------------- |
| `accent`         | `#075985` | Primary button fill, links, selected tab                              |
| `accent-hover`   | `#0c4a6e` | Primary hover and pressed                                             |
| `accent-subtle`  | `#e0f2fe` | Selected row on a light surface                                       |
| `nav-active`     | `#0c4a6e` | Active nav item background (white text 9.46:1)                        |
| `nav-active-bar` | `#38bdf8` | Active nav item's 3 px left bar (6.83:1 on the nav surface `#1e293b`) |
| `focus`          | `#0369a1` | Focus ring on light surfaces                                          |
| `focus-on-dark`  | `#38bdf8` | Focus ring on the top bar and nav                                     |

The accent is for things you can act on. It is never a state colour, so a link never reads as "info": the `info` tone has its own blue scale (2.3). On the nav surface the active item's background differs little from the surface (1.55:1); the bar (6.83:1) and the white 600-weight text carry the state, as WCAG 1.4.11 asks of the indicator.

### 2.3 Semantic tones

Five tones serve every status in the app. Each has an ink (text on the soft background), a soft background, a border and a solid fill with its on-solid text. Ratios are WCAG 2.x contrast, computed for these exact pairs (AA: 4.5:1 for text, 3:1 for borders and other non-text parts).

| Tone      | Meaning                                                                                 | Ink on soft                 | Border on white | Solid fill / text           |
| --------- | --------------------------------------------------------------------------------------- | --------------------------- | --------------- | --------------------------- |
| `neutral` | Normal, informational, final, closed                                                    | `#334155` on `#f1f5f9` 9.45 | `#64748b` 4.76  | `#334155` / `#ffffff` 10.35 |
| `info`    | Planned intervention, in progress, low priority                                         | `#1e40af` on `#eff6ff` 8.01 | `#2563eb` 5.17  | `#1d4ed8` / `#ffffff` 6.70  |
| `ok`      | Explicit good outcome only (released hold, passed check)                                | `#065f46` on `#ecfdf5` 7.29 | `#047857` 5.48  | `#047857` / `#ffffff` 5.48  |
| `warn`    | Abnormal, needs attention: starved, provisional signal, medium priority, short order    | `#78350f` on `#fffbeb` 8.75 | `#b45309` 5.02  | `#fcd34d` / `#451a03` 10.39 |
| `caution` | Abnormal, held up: blocked                                                              | `#7c2d12` on `#fff7ed` 8.83 | `#c2410c` 5.18  | `#fdba74` / `#431407` 9.28  |
| `alarm`   | Abnormal, act now: down, stopped, high priority, open hold, final signal, refused write | `#991b1b` on `#fef2f2` 7.60 | `#b91c1c` 6.47  | `#b91c1c` / `#ffffff` 6.47  |

Borders are given on white; on the canvas (`#f1f5f9`) the lowest is `info` at 4.72:1, still above 3:1. `info` (royal blue) and the accent (sky, `#075985`) are different hues so a status never looks like a link or a button.

`ok` (green) is used sparingly: "final" and "completed" are normal and stay `neutral`. Green appears where a person made something good happen (a hold released) or a limit check passed ("Acceptable").

### 2.4 Machine states

ISA-101 restraint: grey for the states a plant spends its normal time in, colour for the ones that cost output. The badge always shows the word; abnormal states add a glyph so they survive greyscale and colour blindness. The machine timeline's bands use the same fills with 4 px top and bottom edges in the state's border colour (dashed for Setup): a band has no word and no glyph, and Running, Off and Planned stop have near-equal fills, so the edges (`#334155`, `#cbd5e1`, `#64748b`) keep them apart; the table under the timeline lists every interval by name.

| State        | Tone        | Badge                                                                                                                                     | Glyph               | Contrast |
| ------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------- |
| Running      | neutral     | fill `#f1f5f9`, text `#0f172a`, border `#334155`                                                                                          | ▶                   | 16.30    |
| Idle         | neutral     | fill `#e2e8f0`, text `#0f172a`                                                                                                            | none                | 14.48    |
| Setup        | neutral     | fill `#e2e8f0`, text `#0f172a`, dashed border `#64748b`                                                                                   | ⟳                   | 14.48    |
| Planned stop | neutral     | fill `#f8fafc`, text `#334155`, border `#64748b`                                                                                          | ‖                   | 9.90     |
| Maintenance  | info        | solid `#1d4ed8`, text `#ffffff`                                                                                                           | wrench (SVG)        | 6.70     |
| Off          | neutral     | fill `#f1f5f9`, text `#475569`, border `#cbd5e1`                                                                                          | ○                   | 6.92     |
| Starved      | warn        | solid `#fcd34d`, text `#451a03`, border `#b45309`                                                                                         | ◀ (input missing)   | 10.39    |
| Blocked      | caution     | solid `#fdba74`, text `#431407`, border `#c2410c`                                                                                         | ▶▮ (output blocked) | 9.28     |
| Stopped      | alarm, soft | fill `#fee2e2`, text `#7f1d1d`, border `#b91c1c`                                                                                          | ■                   | 8.20     |
| Down         | alarm       | solid `#b91c1c`, text `#ffffff`                                                                                                           | ✕                   | 6.47     |
| No data      | neutral     | white, dashed border `#64748b`, text `#475569`                                                                                            | ?                   | 7.58     |
| Stale        | warn, soft  | the state's own badge unchanged, beside it a tag: fill `#fffbeb`, text `#78350f`, solid border `#b45309`, the full reason as visible text | clock (SVG)         | 8.75     |

**Stale** is not a machine state but a qualifier: the shown state may be out of date. The state badge keeps its own look and word; beside it a `warn` soft tag (soft fill, solid border, the `StaleTag`) shows the **full reason as visible text**, exactly today's `STALE_TEXT` ("Stale: live connection lost", "Stale: from an earlier run"), with its test id `stale-<equipment id>` (`overview.test.tsx` lines 102 and 113 assert that text). The reason is never only in a tooltip (4.12: a tooltip is never the only place a fact lives, and touch has no hover). The tag's solid `warn` border keeps it apart from the dashed neutral borders of Setup and No data, so a stale Running never reads as a fresh one.

The light solid fills (Starved, Blocked, and the medium alarm priority) carry a 1 px border in their tone's border colour (5.02 and 5.18:1 on white), so their edge shows on white and on the canvas, where the fills alone are under 1.6:1. Glyphs are inline SVG icons from `src/components/ui/icons.tsx`, `aria-hidden`, 12 px in a badge. A machine card in an abnormal state also gets a 4 px left border in the state's border colour, so the overview shows the problem from across the room (G-13, O-01).

### 2.5 Alarm priority

| Priority | Badge                                             | Glyph | Contrast |
| -------- | ------------------------------------------------- | ----- | -------- |
| High     | solid `#b91c1c`, text `#ffffff`                   | ▲▲    | 6.47     |
| Medium   | solid `#fbbf24`, text `#451a03`, border `#b45309` | ▲     | 8.97     |
| Low      | white, border `#2563eb`, text `#1e40af`           | ●     | 8.72     |

The glyphs are today's (`PriorityBadge`). An unacknowledged alarm's row has a 4 px left bar in its priority's border colour and bold text; acknowledged rows are plain (A-03).

### 2.6 Finality and other statuses

Every status the app shows maps to one tone, so the same word always looks the same (G-12).

| Domain                                           | Value → tone                                                                                                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finality (OEE, alarm KPIs, shift reports, trace) | Final → `neutral` outline with a check glyph; Provisional → `neutral` dashed outline; revised → `info`, keeping its outline (dashed while provisional)                                                                                                   |
| Order status                                     | Imported, Released, Closed → `neutral`; Dispatched, In progress → `info`; Completed → `neutral` with check; Cancelled → `neutral` (a decision, not a fault); Rejected (at import) → `alarm` soft; flags (Short, Dispatch failed, Dispatch lost) → `warn` |
| Command state                                    | as today's `COMMAND_STATE_TEXT` tones, mapped good → `neutral`, bad → `alarm`, warn → `warn`, info → `info`                                                                                                                                              |
| Quality hold                                     | Open → `alarm` soft; Released → `ok` soft; Rejected → `neutral` solid                                                                                                                                                                                    |
| SPC signal episode                               | Provisional → `warn` soft; Final → `alarm` soft, text "Final" as today (the tone, not the word, says it is a signal); Withdrawn → `neutral` outline, struck through                                                                                      |
| Serial status                                    | Packed, In WIP → `neutral`; Rework → `warn`; Scrapped → `alarm` soft                                                                                                                                                                                     |
| Live connection                                  | Live → `neutral` dot; Connecting, Reconnecting → `warn` dot pulsing (still under reduced motion: no pulse); Offline → `alarm` dot                                                                                                                        |

Finality is shown once per scope: in the section header or card header, not on every row; a row shows its own badge only when it differs from its section (E-03). Where a test reads the badge text (`order-status`, `hold-state`, `signal-status`), the text stays and only the tone changes; a text change is made in its screen's issue with the spec updated in the same pull request.

### 2.7 Typography

System fonts only: the CSP allows `font-src 'self'` and nothing is fetched from a CDN. `--font-sans` and `--font-mono` as above.

| Token       | Size / line height         | Weight  | Use                                                       |
| ----------- | -------------------------- | ------- | --------------------------------------------------------- |
| `text-2xs`  | 11 px / 16 px (0.6875 rem) | 500     | Chart axis ticks, badge counts                            |
| `text-xs`   | 12 px / 16 px (0.75 rem)   | 400–600 | Badges, captions, hints, table footnotes                  |
| `text-sm`   | 14 px / 20 px (0.875 rem)  | 400     | **Body and tables (the default)**                         |
| `text-base` | 16 px / 24 px (1 rem)      | 400     | Forms on the login and account pages; terminal small text |
| `text-lg`   | 18 px / 28 px (1.125 rem)  | 600     | Section title (`h2`), card title                          |
| `text-xl`   | 20 px / 28 px (1.25 rem)   | 600     | Page title (`h1`) on detail and list pages; terminal body |
| `text-2xl`  | 24 px / 32 px (1.5 rem)    | 600     | Page title on dashboards; KPI value (small tile)          |
| `text-3xl`  | 30 px / 36 px (1.875 rem)  | 600     | KPI value (headline tile); terminal headings              |
| `text-4xl`  | 36 px / 40 px (2.25 rem)   | 700     | One headline figure per page at most                      |

- **Numbers** use `font-variant-numeric: tabular-nums` (the `tabular-nums` utility, applied by `DataTable` numeric cells, `Stat` and `KpiTile`), in the sans font, never monospace (G-15).
- **Monospace** is for identifiers only: equipment ids, lots, serials, cartons, order ids, alarm codes, request ids. At 0.95 em so it sits on the sans baseline.
- **Weights:** 400 body, 500 labels and table headers, 600 titles and emphasised values, 700 the one headline figure. No 800/900.
- **Line length:** prose at most `72ch` (`max-w-prose`); a page's description is one line at most 90 characters (G-08).

### 2.8 Spacing

A 4 px base. Tailwind's default spacing already is this scale (`1` = 4 px); screens use only these steps.

| Step | px  | Use                                                             |
| ---- | --- | --------------------------------------------------------------- |
| 0.5  | 2   | Badge vertical padding, icon to text in a badge                 |
| 1    | 4   | Inline gaps inside a control                                    |
| 2    | 8   | Table cell vertical padding (compact), gap between badges       |
| 3    | 12  | Table cell horizontal padding; gap between form fields in a row |
| 4    | 16  | Card padding (compact); phone page gutter; gap between cards    |
| 5    | 20  | Card padding (default)                                          |
| 6    | 24  | Gap between sections; tablet page gutter                        |
| 8    | 32  | Desktop page gutter; gap under the page header                  |
| 10   | 40  | –                                                               |
| 12   | 48  | Top bar height                                                  |
| 16   | 64  | Empty-state vertical padding                                    |

Vertical rhythm on a page: page header, 24 px, filter bar, 16 px, first section; sections 32 px apart; within a section, title to content 12 px.

### 2.9 Radius, elevation, z-index, motion

| Radius token  | px   | Use                           |
| ------------- | ---- | ----------------------------- |
| `radius-sm`   | 4    | Badges, checkboxes, table     |
| `radius-md`   | 6    | Buttons, inputs, selects      |
| `radius-lg`   | 8    | Cards, dialogs, menus         |
| `radius-full` | 9999 | Status dots, pills in the nav |

| Elevation | Look                                                                | Use                                 |
| --------- | ------------------------------------------------------------------- | ----------------------------------- |
| 0         | border `line`, no shadow                                            | Cards, tables, panels (the default) |
| 1         | border `line` + `0 1px 2px rgb(15 23 42 / 0.06)`                    | Sticky table header, sticky panel   |
| 2         | border `line` + `0 4px 12px rgb(15 23 42 / 0.12)`                   | Menus, tooltips, popovers           |
| 3         | `0 12px 32px rgb(15 23 42 / 0.24)` + backdrop `rgb(15 23 42 / 0.5)` | Dialogs, the nav drawer             |

| z-index token | Value | Layer                                                                    |
| ------------- | ----- | ------------------------------------------------------------------------ |
| `z-sticky`    | 10    | Sticky table headers, sticky detail panels                               |
| `z-topbar`    | 20    | The top bar                                                              |
| `z-nav`       | 30    | The nav drawer and its backdrop                                          |
| `z-popover`   | 40    | Menus, tooltips                                                          |
| `z-toast`     | 50    | Toasts; the idle warning (today `z-40`)                                  |
| `z-dialog`    | 60    | Dialogs (native `<dialog>` uses the top layer; this is for the fallback) |
| `z-lock`      | 70    | The re-login cover (today `z-50`): above everything                      |

Motion: `--duration-fast: 120ms` (hover, press), `--duration-base: 200ms` (drawer, dialog, panel), easing `cubic-bezier(0.2, 0, 0, 1)`. Nothing animates a value the plant reports (no tweened numbers, no chart animation; ECharts `animation: false`). The existing `prefers-reduced-motion` rule stays and also stops the connection dot's pulse.

### 2.10 Token names

The tables above give the values; these are the names `src/index.css` defines (UX-1a, #314). The same names, values and the contrast ratios this document states are kept as data in `src/components/ui/tokens.ts`, and `tokens.test.ts` checks the stylesheet, the Tailwind utilities and the recomputed ratios against them. Colours are `--color-<name>` (utilities `bg-<name>`, `text-<name>`, `border-<name>`, …).

| Group                 | Names                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Neutral scale (2.1)   | `neutral-0` … `neutral-950` (950 = `#020617`, so no Tailwind neutral survives): the same in both themes, for the token file only; screens use the semantic names                                                         |
| Surfaces, lines, text | `canvas`, `surface`, `surface-sunken`, `surface-hover` (= `neutral-100`: a button's hover), `line`, `line-subtle`, `line-strong`, `ink`, `ink-secondary`, `ink-inverse`                                                  |
| Disabled (4.1)        | `disabled` (fill), `disabled-line`, `disabled-ink`                                                                                                                                                                       |
| Accent (2.2)          | `accent` (primary fill, selected tab), `accent-hover`, `on-accent` (text on the fill), `accent-subtle`, `link`, `nav-active`, `nav-active-ink`, `nav-active-bar`, `focus`, `focus-on-dark`, `alarm-solid-hover` (4.1)    |
| Shell (3.2)           | `topbar`, `topbar-ink`, `nav`, `nav-ink`, `nav-heading`, `nav-hover` (`#334155`, nav text 8.40): the same in both themes                                                                                                 |
| Tones (2.3)           | `<tone>-ink`, `<tone>-soft`, `<tone>-border`, `<tone>-solid`, `<tone>-on-solid` for `neutral`, `info`, `ok`, `warn`, `caution`, `alarm`                                                                                  |
| Machine states (2.4)  | `state-<state>-fill`, `-ink`, `-border` for `running`, `idle`, `setup`, `planned-stop`, `maintenance`, `off`, `starved`, `blocked`, `stopped`, `down`, `no-data`; a state without a border in 2.4 has its fill as border |
| Alarm priority (2.5)  | `priority-<high\|medium\|low>-fill`, `-ink`, `-border`                                                                                                                                                                   |
| Charts (5)            | `chart-1` … `chart-5` (the categorical palette in order), `chart-other` (`neutral-700`), `chart-limit` (`#b91c1c`)                                                                                                       |
| Overlay               | `backdrop` (`rgb(15 23 42 / 0.5)`, elevation 3)                                                                                                                                                                          |
| Type (2.7)            | `text-2xs` … `text-4xl` (size and line height; the weight is set where used), `font-sans`, `font-mono`                                                                                                                   |
| Spacing (2.8)         | `--spacing: 0.25rem`, Tailwind's scale                                                                                                                                                                                   |
| Radius, shadow (2.9)  | `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-full`; `shadow-elevation-1` … `shadow-elevation-3` (the same in both themes)                                                                                          |
| Layers, motion (2.9)  | `z-sticky` … `z-lock`, `duration-fast`, `duration-base`, `ease-standard` (`--z-*` and `--duration-*` are variables with utilities written by name: Tailwind has no theme namespace for them)                             |
| Breakpoint (3.1)      | `wide:` (`--breakpoint-wide: 90rem`)                                                                                                                                                                                     |

## 3. Layout and navigation

### 3.1 Breakpoints

Tailwind's defaults plus one, `wide` (1440 px, `--breakpoint-wide: 90rem`). What changes at each:

| Name   | Min width | Shell                                        | Content                                                                      |
| ------ | --------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| base   | 0         | Top bar 48 px; nav in a drawer; gutter 16 px | One column; tables become stacked rows or scroll with a fade                 |
| `sm`   | 640       | as base                                      | Two-column KPI tiles                                                         |
| `md`   | 768       | as base; gutter 24 px                        | Filter bars on one row; two-column cards                                     |
| `lg`   | 1024      | as base                                      | Three-column cards; list-and-detail as list, detail below or in a side sheet |
| `xl`   | 1280      | Side nav 232 px, always open; gutter 32 px   | Four-column KPI tiles; list-and-detail still opens the detail as a sheet     |
| `wide` | 1440      | as `xl`                                      | List-and-detail side by side (400 px panel)                                  |
| `2xl`  | 1536      | as `xl`                                      | Content capped at 1440 px                                                    |

`xl` is where the side nav is open because the Playwright suites and the demo recording run at 1280 × 720 (Desktop Chrome): every `nav-*` link stays visible and clickable there, as the specs expect.

### 3.2 App shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☰  ShopFloor Twin   Gebze plant time Thu 22 Oct, 03:25:03 ● Live  user  Log out │  top bar 48 px, neutral-900
├────────────┬─────────────────────────────────────────────────────────┤
│ MONITOR    │  ‹ All orders                                            │
│  Overview  │  Order PO-2610-303  [Completed] [Short]   [Close order]  │  page header
│  Alarms    │  VB-100 · 60 blanks · due Mon 12 Oct, 22:00              │
│  Alarm KPIs│ ──────────────────────────────────────────────────────── │
│  OEE       │  filters                                                 │
│ PRODUCTION │                                                          │
│  Orders  ● │  sections …                                              │
│  …         │                                                          │
└────────────┴─────────────────────────────────────────────────────────┘
```

- **Top bar** (`<header>`, 48 px, `neutral-900`, sticky): the menu button (below `xl`), the product name (link to `/`), the plant clock (`plant-clock`, unchanged text "Gebze plant time: …", and its `<time dateTime>` child, which the demo walkthrough reads), the connection status (`connection-status`), the user name (`nav-account` → `/account`, `signed-in-user`; the roles move to its `title` and the account page, G-04) and a visible "Log out" ghost button (`logout`; the demo and the login helper click it directly). Below `lg` the clock drops the "Gebze plant time:" prefix visually (kept as visually hidden text; from `md`, as first planned, it squeezed the status and the user name at 768) and the user name truncates; below `sm` the product name (the drawer carries it) and the clock's date also go visually (the whole plant time stays the `<time>`'s text and its tooltip), so the row holds at 320 px with "Log out" still in words. The connection status shortens with an ellipsis before anything wraps.
- **Side nav** (`<nav aria-label="Screens">`, 232 px, `neutral-800`): groups by job, each under a visible heading that is the group's real heading (an `h2`, `text-xs` 600, letter-spaced, `#94a3b8` on `#1e293b`, 5.71:1), and each group's list is labelled by it (`aria-labelledby`). Link text `#e2e8f0` (11.87:1). A group with no visible link for the role is not rendered.

  | Group      | Links (permission)                                                    |
  | ---------- | --------------------------------------------------------------------- |
  | Monitor    | Overview, Alarms, Alarm KPIs, OEE                                     |
  | Production | Orders, Downtime coding, Shift reports, Terminal (`terminal:operate`) |
  | Quality    | SPC, Holds, Traceability                                              |
  | Admin      | Users (`user:admin`), Console (`sim:control`)                         |

  Every link keeps its `data-testid` (`nav-overview` … `nav-console`) and its text. A link is **active** for its route and every route under it (G-03): `aria-current="page"` on the exact route, `aria-current="true"` on a sub-route, the same look for both (`nav-active` `#0c4a6e` background, white 600-weight text 9.46:1, a 3 px `nav-active-bar` `#38bdf8` on the left, 6.83:1 against the nav surface). Alarms is active on `/alarms` only, Alarm KPIs on `/alarms/kpi`.

- **Below `xl`** the same `<nav>` element becomes a drawer: off-canvas, opened by the top bar's menu button ("Menu", `aria-expanded`, `aria-controls`), `inert` while closed, closed by Escape, by the backdrop, by its own close button ("Close the navigation", in a 48 px row with the product name) and by following a link; focus moves into it (to the close button) on open and back to the menu button on close, except after a link to another page, whose heading takes it. While it is open the skip link, the top bar and `main` are `inert`, so the focus stays in the drawer (the offline bar is not: its alert is still announced), and the page behind does not scroll (`overscroll-contain` on the nav, the page's overflow hidden until it closes). When the window narrows to the drawer layout while a nav link has the focus, the focus goes to the menu button. The links are rendered at every width (only CSS hides them), so the jsdom tests that click `nav-*` keep working.
- **Main** (`<main id="main" tabIndex={-1}>`): `canvas` background, gutter per breakpoint, content `max-width: 1440px` centred on `2xl`. The skip link, the heading focus on navigation (`useFocusOnNavigation`, `useHeadingFocus`) and the print rules stay. The programmatically focused heading and `main` show no ring (G-22). `:focus:not(:focus-visible)` would not do it: after a keyboard-triggered navigation the browser treats the script's `focus()` as focus-visible. The rule is scoped to the elements that are only ever focused by script:

  ```css
  h1[tabindex='-1']:focus-visible,
  main[tabindex='-1']:focus {
    outline: none;
  }
  ```

- **Print:** the side nav, the drawer, the top bar, the offline bar, toasts and the idle warning carry `print:hidden`; when printing, `main` drops the side nav's offset and its gutters (`print:ml-0 print:p-0`), so the shift report's A4 rules apply as today.
- **Document title:** every screen sets `"<page title> · ShopFloor Twin"` (G-05); detail pages include the id ("Order PO-2610-303 · ShopFloor Twin"). Every route carries its title as `staticData.title` (text, or made from its params), which the shell applies from the first render, standalone routes and the not-found page ("Page not found") included; a mounted `PageHeader` puts its own title over it through `usePageTitle(title)` (its `documentTitle` when the title is not plain text), so a screen can name what it read ("CNC 01" for `/equipment/cnc-01`).
- **The terminal** (`/terminal/:workCenter`) keeps its own standalone shell, restyled with the same tokens: a 56 px top bar with the work center's **name** and id (X-02), the plant clock, the connection status only once the operator is signed on (X-03), and a "Change work center" link to `/terminal` (X-04). The picker `/terminal` is a desk page in the shell.
- **Login** keeps its centred card on the canvas, with the product name as the card's header.

### 3.3 Page header

One component for every page (G-06):

```
‹ Back label                                                   (optional)
Title  [status badges]                              [secondary] [Primary]
One-line description, max 90 characters.            (optional)
[meta: key facts as "label value · label value"]   (optional)
──────────────────────────────────────────────────────────────────────────
[filter bar: label + control pairs inline, wraps; right-aligned summary]   (optional)
```

- Title: `h1`, `text-xl` (lists and details) or `text-2xl` (dashboards: overview, OEE, alarm KPIs), with `useHeadingFocus`. Ids in the title are monospace (`Order <code>PO-2610-303</code>`).
- Back link: always "‹ " plus the parent's name: "All orders", "Plant overview", "Traceability", "All holds", "SPC charts", "Shift reports", "Operator terminal" (one rule, G-06). The hold detail gets one (H-04).
- Actions: at most one primary; destructive actions are `danger` (G-11); more than three go into an overflow menu. Below `md` the actions wrap under the title, full width.
- Filter bar: labels inline to the left of their control (`Shift [select]`), 12 px between pairs, wraps; the result summary ("4 records, 0 uncoded") sits right-aligned on the same row from `md`.
- Long explanations: a "What this page shows" `Disclosure` under the description, closed by default (G-08).

### 3.4 Content patterns

- **Sections:** `Section` = `h2` (`text-lg`) + optional description + optional actions + content; 32 px apart. Nested sections take `level={3}` (`h3`, `text-base`, 24 px apart) or `level={4}` (`h4`, `text-sm`, 16 px). A section with a finality has its badge beside the title.
- **Cards** for groups of facts and charts; **tables** (in a `DataTable`, which brings its own card frame) for lists. A page never mixes a bare table with carded ones (G-07, M-03).
- **List and detail** (downtime coding, alarms): at `wide` (≥ 1440 px) the detail is a sticky side panel of 400 px (`top: 64px`, max height the viewport, scrolls itself), rendered only while an item is selected, which leaves the table about 740 px; with nothing selected the table takes the full width (G-26). Below `wide`, including 1280 (the Playwright and demo width, where a panel would leave the table about 520 px), the detail opens as a full-height side sheet (a `Dialog` with `variant="sheet"`, 440 px, full width below `md`) over the list. Decision: the sheet below 1440, not a narrower panel with an icon-rail nav, because an icon rail would hide the nav's words at the width the demo is recorded at. The URL parameter (`?record=`, `?alarm=`) and the panel's test ids (`coding-panel`, `alarm-panel`) are unchanged.
- **Long detail pages** (order, shift report, serial, lot, SPC chart): an in-page section index (`SectionNav`) under the header, sticky at `xl` as a row of anchor links; each section keeps its id and test id (Q-01, R-01).
- **Key facts** (order, serial, carton, hold headers): a `DescriptionList` in a fixed number of columns per breakpoint (1 / 2 / 4) that flows by column, so the reading order never changes with the width; fields with no value are left out unless their absence is the information (Q-02).

## 4. Components

All live in `src/components/ui/`, are written in-house on Tailwind and the tokens, and each has a unit test for its accessible name, role, keyboard behaviour and states. Every component passes through `data-testid` and any other `data-*` props, so a screen's test ids stay where they are. Signatures are sketches; the issue that builds a component settles details.

### 4.1 Button and IconButton

```ts
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid'; // dangerSolid: the confirm dialog's solid danger
type ButtonSize = 'sm' | 'md' | 'lg' | 'touch';
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; // default 'secondary'
  size?: ButtonSize; // default 'md'
  loading?: boolean; // shows a spinner, sets aria-busy, keeps the label for the accessible name
  icon?: IconName; // leading icon, aria-hidden
  fullWidth?: boolean;
}
interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  icon: IconName;
  label: string; // required: the accessible name and the tooltip
}
```

| Variant       | Rest                                                                                            | Hover                                                           | Use                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `primary`     | fill `accent`, text white (7.56)                                                                | `accent-hover` (9.46)                                           | The one main action of a page, form or dialog                                                                                    |
| `secondary`   | white, border `neutral-500`, text `ink`                                                         | fill `neutral-100`                                              | Every other action                                                                                                               |
| `ghost`       | no border, text `accent`                                                                        | fill `neutral-100`                                              | Low-weight actions in tables and toolbars                                                                                        |
| `danger`      | white, border `#b91c1c`, text `#991b1b`; in a confirm dialog solid `#b91c1c`, text white (6.47) | fill `#fef2f2`                                                  | Irreversible or destructive: Disable, Reset password, Close, Cancel order, Block, Take offline, Break tool, Retract, End version |
| `dangerSolid` | fill `alarm-solid` `#b91c1c`, text `alarm-on-solid` white (6.47; dark `#dc2626`, 4.83)          | fill `alarm-solid-hover` `#991b1b` (8.31; dark `#b91c1c`, 6.47) | The confirm button of a destructive `ConfirmDialog` (4.9)                                                                        |

| Size    | Height | Padding x | Text  |
| ------- | ------ | --------- | ----- |
| `sm`    | 28 px  | 10 px     | 13 px |
| `md`    | 36 px  | 14 px     | 14 px |
| `lg`    | 44 px  | 18 px     | 16 px |
| `touch` | 56 px  | 20 px     | 18 px |

- **Disabled** (G-10): fill `neutral-100`, border `neutral-300`, text `neutral-600` (6.92 on `neutral-100`; the tokens `disabled`, `disabled-line`, `disabled-ink`, also for disabled form controls, 4.7), `cursor: not-allowed`, no hover; never opacity. The same look for every variant, so a disabled primary never reads as enabled. When the reason is not obvious, a hint beside it says why ("Select alarms to acknowledge them").
- **Loading:** the label stays, a 14 px spinner replaces the icon, the button looks disabled and is `aria-busy="true"` and `aria-disabled="true"`: clicks, Enter and form submits are ignored, but it is not natively `disabled`, so the keyboard focus stays on it (a natively disabled button drops focus to the page, which would also escape a dialog's focus trap); `prefers-reduced-motion` shows a static ellipsis instead of the spin.
- **Focus:** 2 px `focus` ring, 2 px offset (section 7).
- Buttons in a row: primary last (right), 8 px apart. Row actions in tables are `ghost` `sm`, side by side, never stacked (A-02).

### 4.2 Badge and StatusPill

One component for every status (G-12):

```ts
type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'caution' | 'alarm';
interface BadgeProps {
  tone: Tone;
  variant?: 'soft' | 'solid' | 'outline' | 'dashed'; // default 'soft'
  icon?: IconName; // aria-hidden glyph
  size?: 'sm' | 'md' | 'lg'; // 18 / 22 / 28 px high
  title?: string; // tooltip text (also an accessible description)
  children: React.ReactNode; // the word: always present
}
```

Domain wrappers keep today's names and test attributes, and map values to tones by the tables in section 2:

- `StateBadge({ state, size, stale, testId })` → `data-state`, the machine-state table (2.4); `stale` (`'disconnected' | 'older-run'`) adds the Stale tag beside it, `StaleTag({ reason, testId })`, whose visible text is the full `STALE_TEXT` and whose test id stays `stale-<equipment id>`.
- `PriorityBadge({ priority, testId })` → `data-priority`, 2.5.
- `OrderStatusBadge`, `OrderFlags`, `CommandStateBadge` → `data-testid="order-status"` / `order-flags` / `command-state`, `data-status`, `data-state` (2.6).
- `HoldStateBadge`, `SignalStatusBadge` → `hold-state`, `signal-status` (2.6).
- `FinalityBadge({ final, revision, incidents, title })` → replaces the per-row `StatusFlags` list for the section-level finality; `StatusFlags` stays for the detail disclosure with `data-flag`.
- `LossBadge({ kind: 'own' | 'external' })`: `own` → `warn` soft, `external` → `neutral` outline (D-02).

Shape: `radius-sm`, `text-xs` 600 (`md`: 13 px), 2 px × 6 px padding, a 1 px border on every variant (so soft and outline badges line up), `white-space: nowrap`.

### 4.3 Card

```ts
interface CardProps {
  title?: React.ReactNode; // h2 or h3 by `headingLevel`
  headingLevel?: 2 | 3;
  description?: string;
  actions?: React.ReactNode; // top-right
  status?: React.ReactNode; // a badge beside the title (finality)
  tone?: Tone; // a 4 px left bar in the tone's border colour, for abnormal items only
  padding?: 'compact' | 'default'; // 16 / 20 px
  as?: 'section' | 'article' | 'div'; // default 'div': a named group; 'section' is a landmark
  children: React.ReactNode;
}
```

White surface, 1 px `line` border, `radius-lg`, elevation 0. Role by `as`: a `div` (the default) with a title is a named `role="group"` (a generic `div` may not carry a name), so a grid of KPI tiles does not flood the landmark list; `section` is a region landmark and `article` an article, both named by the heading; untitled cards are not named. Card grids: 16 px gap, equal heights per row only where the cards are peers (machine cards), otherwise natural height (E-05).

### 4.4 KpiTile and Stat

```ts
interface StatProps {
  label: string; // above the value, text-xs 500 ink-secondary
  value: React.ReactNode; // tabular-nums; size by `emphasis`
  unit?: string; // after the value, text-sm ink-secondary, a space before it
  emphasis?: 'headline' | 'default' | 'compact'; // text-3xl / text-2xl / text-lg
  hint?: React.ReactNode; // below: the raw fraction, a comparison, "of 18"
  tone?: Tone; // colours the value only when abnormal (above a limit)
  verdict?: { tone: Tone; text: string }; // e.g. Acceptable / Overloaded, as a Badge
  testId?: string;
  valueTestId?: string; // keeps today's ids on the figure itself (e.g. `${id}-percent`)
  dataValue?: string; // raw value for tests (#295)
}
```

`KpiTile` is a `Card` holding one headline `Stat` and up to four compact ones underneath. A KPI with no value renders "—" in `ink-secondary` at the same size plus a one-line reason ("No planned time this shift"), never "n/a" at headline size (E-01). The OEE cards, the alarm KPI cards (K-01: the average per 10 min is the headline with its EEMUA verdict; the other nine rows move into a compact `DescriptionList`), the order OEE, FPY and line OEE cards and a new overview summary strip (O-04) use it.

### 4.5 DataTable

```ts
interface Column<Row> {
  key: string;
  header: React.ReactNode; // always present; may be visually hidden ("Actions")
  cell: (row: Row) => React.ReactNode;
  align?: 'start' | 'end' | 'center'; // 'end' for every number, duration and time-of-day column
  numeric?: boolean; // implies align 'end' and tabular-nums
  width?: string; // e.g. '8rem'; ids and times get a fixed min width so they don't wrap
  nowrap?: boolean; // default true for numeric, ids, dates, badges
  priority?: 1 | 2 | 3; // which columns survive on narrow screens (1 always)
  sticky?: boolean; // first column sticky on horizontal scroll
}
interface DataTableProps<Row> {
  caption: string; // visually hidden <caption>, as today
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  rowTestId?: (row: Row) => string; // keeps `alarm-row-${id}`, `order-row-${id}` …
  rowProps?: (row: Row) => Record<`data-${string}`, string>; // data-blocked, data-state …
  rowTone?: (row: Row) => Tone | undefined; // left bar for abnormal rows (unacknowledged alarm)
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: Set<string>) => void;
    label: (row: Row) => string;
    allLabel: string;
    testId?: string;
  };
  activeRowKey?: string; // the row whose detail is open: aria-selected / aria-current
  actions?: (row: Row) => React.ReactNode; // ghost sm buttons in the last column, in a row
  empty?: React.ReactNode; // an EmptyState; the header row is not shown when empty
  stickyHeader?: boolean; // default true when rows > 15
  density?: 'compact' | 'default'; // 32 / 40 px rows
  narrow?: 'scroll' | 'stack'; // below md: scroll with an edge fade, or one card per row
  pageSize?: number; // client-side paging for long lists (lot units: 50)
  testId: string;
  count?: number; // data-count, as today's quality Table
}
```

- Header row: `surface-sunken`, `text-xs` 600 uppercase-free (sentence case), `ink-secondary`, a 1 px `line` bottom border; `th scope="col"`; right-aligned headers over right-aligned columns.
- Rows: 1 px `line-subtle` dividers, no zebra (the dividers carry the rows; zebra fights the tone bars), hover `neutral-50`, the active row `accent-subtle` with a 3 px `accent` left bar (D-03).
- Numbers right-aligned in tabular figures. Units: durations keep their unit in every cell ("30.0 min", as the demo walkthrough asserts on the Pareto table, and because durations mix scales); a column of measured values or counts with one unit puts it in the header ("Leak rate (Pa/min)") and the cells hold numbers only.
- **Sticky header** (G-14): `position: sticky` works only when no ancestor between the header and the scrolling viewport clips overflow. So the frame has two modes, chosen by measuring (a `ResizeObserver` on the table against its frame):
  - the table fits its frame: the frame uses `overflow-x: clip` (not `auto`), the header sticks to the page under the top bar (`top: 48px`);
  - the table is wider than its frame: the frame becomes a bounded scroll box (`overflow: auto`, `max-height: min(70vh, 720px)`), and the header sticks to the top of that box.
- Row removal: when a row the focus was in disappears (an alarm acknowledged out of the Active view, a record coded out of "Only uncoded"), focus moves to the same action in the next row, else the previous row, else the table's section heading (`tabindex="-1"`); a polite status says what happened ("Alarm acknowledged; 2 left").
- Narrow screens: `scroll` keeps the table and adds a right-edge fade and a visually hidden "Scroll for more columns" note; columns with `priority: 3` drop below `md`, `priority: 2` below `sm`; `stack` renders each row as a definition list (used for the alarm list and downtime records on phones, G-27).
- Long lists: `pageSize` with a pager under the table ("1–50 of 180", previous and next) (T-04).
- Selection: a checkbox column with a 24 × 24 px hit area (G-30), a select-all in the header that sets the native `indeterminate` property when some rows are selected (screen readers announce "mixed" from it; no `aria-checked` on a native checkbox). The bulk button keeps today's label with the count in brackets, "Acknowledge selected (3)", which `final/alarm-actions.spec.ts` reads.
- Keyboard (G-33): a table whose rows each carry an action (downtime "Code", alarm "Acknowledge") is preceded by a "Skip to the details" link when a detail panel follows it, so a keyboard user does not tab through 90 buttons.

### 4.6 Tabs

```ts
interface TabsProps {
  label: string; // aria-label of the tablist
  tabs: { id: string; label: React.ReactNode; count?: number; testId?: string }[];
  value: string;
  onChange: (id: string) => void;
  panelId?: string; // the tabpanel's id
}
```

WAI-ARIA tabs: `role="tablist"`, roving `tabindex`, Left/Right/Home/End move and select (automatic activation), `aria-controls` to the panel, the panel `role="tabpanel"` with `aria-labelledby`. Look: underline tabs (2 px `accent` under the selected one, text `ink` 600; others `ink-secondary`), counts as a `neutral` badge. Below `sm` the tab list scrolls sideways instead of wrapping (A-04). Today's alarm tabs (`tab-active`, `tab-acknowledged`, `tab-shelved`, `tab-history`) keep their ids.

### 4.7 Form fields

```ts
interface FieldProps {
  label: string; // visible <label>
  hint?: React.ReactNode; // below the control, aria-describedby
  error?: string; // below the hint, red ink, aria-invalid + aria-describedby, role none (the form's summary announces)
  required?: boolean; // " (required)" in the label; optional fields say nothing
  inline?: boolean; // label left of the control (filter bars)
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
}
```

- Controls (`TextInput`, `Textarea`, `Select`, `Checkbox`, `Radio`, `NumberInput`): 36 px high (`md`), 56 px in the terminal (`touch`), white, 1 px `neutral-500` border (4.76:1), `radius-md`, focus ring; invalid: border `#b91c1c` plus the error text; disabled: as a disabled button, `disabled` fill (`neutral-100`), `disabled-line` border (`neutral-300`), `disabled-ink` text (`neutral-600`, 6.92:1). Every control gets an `id` and a `name` (G-23).
- `Select` is the native `<select>` styled with tokens (an arrow from `icons.tsx`), never a custom listbox: it is accessible on every platform, the e2e specs drive it with `selectOption`, and long option texts can be read (H-05: the select is as wide as its longest option up to the field's width, and the option text is shortened at the source, not cut).
- `Checkbox`: 16 px box in a 24 px hit area, label to the right.
- `CharacterCount` as today's comment box ("12 of 500 characters", `aria-describedby`).
- Form errors: a refused write keeps today's `FailureMessage` (role alert, problem type) restyled as an `alarm` soft `Callout` at the top of the form; field errors under their fields.

### 4.8 Plant-time input

The one way to enter a time (N-02, D-05, C-07):

```ts
interface PlantTimeInputProps {
  label: string;
  value: string | null; // ISO 8601 UTC, as the API takes it
  onChange: (iso: string | null) => void;
  withSeconds?: boolean; // downtime split: true
  min?: string;
  max?: string; // ISO bounds (the shift)
  required?: boolean;
  testId?: string;
}
```

Two plain text inputs, date (`dd/mm/yyyy`, or a `Select` of the shift's days when bounded) and time (`hh:mm` or `hh:mm:ss`), not the native pickers (they follow the OS locale). The label says "(plant time, Europe/Istanbul)"; the hint shows the UTC instant as it will be sent, live ("= 2026-10-12 05:00:00 UTC"). Parsing and formatting go through `domain/time.ts` in the plant zone. Where the console needs simulation time, the same input is labelled "(simulation time)".

### 4.9 Dialog and ConfirmDialog

```ts
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string; // h2, aria-labelledby
  description?: string; // aria-describedby
  variant?: 'modal' | 'sheet'; // centred 480 px, or a full-height side sheet 440 px (list-and-detail below 1440 px)
  initialFocus?: React.RefObject<HTMLElement>;
  children: React.ReactNode;
  footer?: React.ReactNode; // buttons, primary last
}
interface ConfirmDialogProps {
  open: boolean;
  title: string; // "Close order PO-2610-303?"
  body: React.ReactNode; // what happens and what cannot be undone
  confirmLabel: string; // the verb again: "Close order"
  tone?: 'danger' | 'default';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  pending?: boolean;
}
```

Native `<dialog>` with `showModal()`: the browser gives the top layer, the inert background, Escape and the `::backdrop`. The component adds focus to `initialFocus` or the first control, focus back to the opener on close, closes on a backdrop click (outside the dialog's box, so a sheet's empty lower part is not one) only when nothing was typed, and holds the page still behind it (`html:has(dialog:modal) { overflow: hidden }`: `showModal()` alone lets a wheel or touch over the backdrop scroll the page). The owner holds `open`: Escape asks it, and a close the browser makes by itself (Chrome's close watcher on a repeated Escape) is told to the owner and undone while the owner still holds it open, so a dialog whose write is busy never vanishes; the `close` event of the owner's own close, which the browser fires a task later, is not taken for one (UX-1e, #352 review). Confirmations are for irreversible writes only (close, cancel or abandon an order, disable a user, reset a password, retract a note, end a limit version, the console's destructive levers); an action that today confirms inline in its form (order actions' `action-form-*`, the terminal's `terminal-pause-confirm-*`) keeps its inline confirm and its ids, restyled. The re-login cover (`relogin`) keeps its own markup and moves to the tokens, over the translucent `backdrop` (G-32, decided in #352): the page under it stays visible and `inert`, so the person sees the unsaved input they log in again to send, and the tab reads "Log in again · ShopFloor Twin"; "Log in as someone else" discards that input first, so another user never sends it.

### 4.10 Toast

```ts
toast({ tone: 'neutral' | 'ok' | 'alarm', title: string, body?: string, action?: { label: string; onClick: () => void } });
```

Bottom-right (top, full width below `md`, off the idle warning's bottom strip), at most three (the oldest timed toast leaves first, an alarm only when only alarms are left), 6 s for neutral and ok (paused on hover and focus), alarm toasts stay until dismissed. Two live regions, in the page from the start so an added toast is announced: `aria-live="polite"` for neutral and ok, `aria-live="assertive"` for `alarm` (the live behaviour of `role="status"` and `role="alert"`, without the roles, so the empty regions add no status or alert to every page; UX-1e). They hold a visually hidden copy of each toast's title and body, so the "Dismiss" and action labels are not read out; the visible toasts sit outside them. A dismissed toast that had the focus does not leave the others paused. Toasts confirm a completed write that leaves the screen ("Coding saved"); a write's result that the screen shows anyway (a row changes) needs none. Today's inline result messages with test ids (`coding-message`, `action-message`, `action-done`, `new-note-message`) stay inline: a toast never replaces an element a test reads.

### 4.11 EmptyState, Skeleton, ErrorState, NotFound

```ts
interface EmptyStateProps {
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: IconName;
  size?: 'inline' | 'section' | 'page';
  testId?: string;
}
interface SkeletonProps {
  shape: 'text' | 'stat' | 'table' | 'chart' | 'card';
  rows?: number;
  label: string; /* "Loading OEE" */
}
interface ErrorStateProps {
  what: string;
  error: unknown;
  onRetry?: () => void;
} // QueryError, restyled
interface NotFoundProps {
  kind: string /* "order" */;
  id: string;
  back: { to: string; label: string };
}
```

- **Empty** (H-03, K-04, N-05, E-01): a centred block in the section's frame with a title ("No holds match these filters"), one line of why or what to do, and an action when there is one ("Clear filters", "Open a hold"). A table with no rows shows the EmptyState instead of its header row. Test ids that mark today's empty texts (`alarm-list-empty` …) move onto the EmptyState.
- **Loading** (G-19): skeletons of the content's own shape at its final size (a table skeleton with its header and five grey rows, a stat skeleton the height of the figure), so nothing jumps. The skeleton has `role="status"` and a visually hidden label ("Loading OEE…", today's text, so tests and screen readers hear the same); shimmer only without reduced motion. Below 300 ms nothing is shown (a delayed skeleton), to avoid flashes on fast loads.
- **Error** (`QueryError`, kept by name and props): an `alarm` soft callout with "Could not load …", the MES's detail in `ink-secondary`, and "Try again" (secondary) only for errors a retry can fix: network, 5xx, 429 (an error without a status is given the benefit of the doubt). While the offline bar is up, a failure to reach the MES (no answer, or the proxy's 502 or 504; not a 503, which may be the MES's own) is one quiet line instead: not announced, no "Try again"; when the connection is back the bar has every active failed read run again at once, and a line stays quiet until its read has run again, so they do not turn into alerts together; so an offline screen with five failed reads raises one alert, the bar's (UX-1e, after #343). A 404 is not an error but **NotFound**: the page header with the id as asked ("Order PO-NOPE"), an EmptyState "No order PO-NOPE" with "The MES has no order with this id." and the back link (G-21, M-06, T-06). The router's own "Page not found" uses the same component.
- **Forbidden** (N-07): a page the role may not open by URL (the console, the users) keeps its own heading and shows the same pattern under it: an `EmptyState` "Not available for your role" with the screen's sentence and the permission id ("Only an admin drives the simulation (permission `sim:control`).", still `role="alert"` under its test id) and "Back to the plant overview".
- **Offline** (G-20): the shell (not the terminal's own screen, whose errors stay loud) shows a `warn` bar under the top bar while the browser is offline or the live connection is lost ("Offline: the figures below stopped updating at 03:25:03"; "Connection lost: …" with the browser online). The connection counts as lost once a reconnect has failed too (attempt 2 on, as the header counts them) or has been connecting or reconnecting for 5 s (behind nginx a handshake to a stopped MES hangs for its 60 s timeout): one reconnect after a blip, or right after the network returns, usually succeeds within its first delay and shows no bar (UX-1e); and queries run with `networkMode: 'always'` so a request fails with the network error instead of waiting silently; the header status then reads "Offline". This is a behaviour fix and goes in its own issue (UX-B4).

### 4.12 Tooltip, InfoTip and Disclosure

```ts
interface TooltipProps {
  content: string;
  children: React.ReactElement;
  side?: 'top' | 'bottom';
}
interface InfoTipProps {
  label: string /* "About line OEE" */;
  children: React.ReactNode;
}
interface DisclosureProps {
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId?: string;
}
```

- `Tooltip` is a supplement only, never the only place a fact lives (touch has no hover): it shows on hover and focus after 400 ms, stays while hovered, hides on Escape (that Escape does nothing else: inside a dialog it does not close the dialog), and its trigger gets `aria-describedby`. Built on the Popover API (`popover="manual"`), placed by script beside its trigger (flipped and kept inside the viewport; no CSS anchor positioning, which Firefox lacks). Without the Popover API no tooltip is rendered: an unknown `popover` attribute would show it inline for good. Today's `title` attributes that carry exact fractions stay (`RatioValue`'s `title`).
- `InfoTip` is a small (28 px) ghost `IconButton` ("i", `popovertarget`, `aria-expanded`) that toggles a `popover="auto"` panel with the explanation (placed by script, hidden until placed; a `<details>` in place without the Popover API); used for the long explanations taken out of the body text (G-08), reachable by keyboard and touch.
- `Disclosure` is a styled `<details>`/`<summary>` (as today's "What the status means", "Bill of materials", "Payload"), with a chevron and a 24 px hit area.

### 4.13 Others

- `PageHeader`, `Section`, `SectionNav`, `DescriptionList`, `FilterBar` (3.3, 3.4).
- `Callout({ tone, title, children })`: page-level messages (a refused write, the idle warning restyled, "Your role cannot change orders" as a one-line neutral callout instead of an empty "Actions" section, G-29, Q-08).
- `Code`: an inline identifier in monospace; `Kbd` for the terminal's keyboard hints.
- `Icon` (`icons.tsx`): about 20 inline SVG icons drawn in-house at 16 and 20 px with `currentColor` (menu, close, chevrons, check, alert, info, play, pause, stop, wrench, ban, arrow-left/right, external, download, print, search, user, logout, filter, clock); no icon package.
- `Duration`, `PlantTime`, `WallTime`, `Ratio`, `Percent`, `Quantity`: formatting components over `domain/time.ts` and `domain/numbers.ts` that render the text by the content rules (section 6) and keep the raw value in `data-value` / `data-fraction` / `data-decimal` and `<time dateTime>`.

#### Menu (overflow actions)

```ts
interface MenuProps {
  label: string; // the trigger's accessible name and visible text, e.g. "More actions"
  icon?: IconName; // an IconButton trigger when there is no visible text
  items: {
    id: string;
    label: string;
    onSelect: () => void;
    tone?: 'default' | 'danger';
    disabled?: boolean;
    testId?: string; // keeps an action's id when it moves into the menu
  }[];
  align?: 'start' | 'end';
}
```

A button with `aria-haspopup="menu"` and `aria-expanded`, opening a `role="menu"` list in a popover (`popover="auto"`: light dismiss and Escape from the platform). Arrow keys move between `role="menuitem"` buttons, Home and End jump, typing a letter moves to the next item starting with it, Enter and Space select, focus returns to the trigger on close. Used when a page header or row has more than three actions. An action a spec clicks by test id stays a visible button unless the spec is updated in the same pull request.

#### SegmentedLinks (range and view switches)

```ts
interface SegmentedLinksProps {
  label: string; // aria-label of the group
  items: { key: string; label: string; to: string; search?: Record<string, string> }[];
  current: string; // the active key
}
```

A row of real links (`<a>`) in a `role="group"` frame, the active one with `aria-current="page"` and the selected look (`accent` fill, white text 7.56:1); the others secondary. For the machine detail's range ("Last hour", "Last 8 h", "Last 24 h"): they change the URL, so they stay links with `aria-current`, as `machine-detail.test.tsx` reads them by role link (M-04). A switch that does not change the URL is a `Tabs` or a toggle-button group with `aria-pressed` instead.

### 4.14 No headless UI dependency

Decision: build every primitive in-house; add no Radix, Headless UI, React Aria or similar. Reasons:

1. The hard parts now come from the platform: `<dialog>` with `showModal()` (focus containment, inert background, Escape, top layer), the Popover API (light dismiss, top layer) for menus and tooltips, `inert` (React 19 types it), `<details>` for disclosures and native `<select>`. The remaining behaviour (roving tab index for tabs, focus return, a menu's arrow keys) is a few dozen lines each, unit-tested.
2. The component set is small and fixed (section 4); no comboboxes, date pickers or virtualised grids are needed (the plant-time input deliberately avoids a picker).
3. The CSP (`style-src 'self'`, no inline styles in markup) is easier to keep with code we write; the pnpm `minimumReleaseAge` policy and the dependency review (`docs/dependencies.md`) stay untouched.
4. Every test contract (test ids, accessible names, `selectOption` on native selects) survives without adapting to a library's DOM.

#### Supported browsers, and what jsdom cannot test

| Platform feature                  | Chrome / Edge | Firefox | Safari / iPadOS |
| --------------------------------- | ------------- | ------- | --------------- |
| `<dialog>` `showModal()`          | 37            | 98      | 15.4            |
| `inert`                           | 102           | 112     | 15.5            |
| Popover API                       | 114           | 125     | **17.0**        |
| CSS anchor positioning (not used) | 125           | –       | 26              |

**Supported:** the last two major versions of Chrome and Edge, Firefox 125 and later, Safari 17 and later on macOS and iPadOS 17 and later. Popover is the binding feature: plant tablets on iPadOS 16 must be updated to 17 (the operator terminal uses no popover, so it still works there: tooltips are not rendered without the Popover API, the trigger's own text stands, and an InfoTip is a `<details>` in place). Menus, tooltips and InfoTips are positioned by script in every browser; CSS anchor positioning is not used.

**jsdom** (the web unit tests) implements none of `showModal`, the Popover API or `inert` behaviour. `src/test/setup.ts` gets stubs: `HTMLDialogElement.prototype.showModal`/`show`/`close` set and clear `open` and fire `close`; `HTMLElement.prototype.showPopover`/`hidePopover`/`togglePopover` toggle a `:popover-open` stand-in attribute (`data-popover-open`) and fire `toggle` with `oldState`/`newState`, and `close` fires after `close()`, each in a later task as browsers deliver them (`flushOverlayEvents` in `src/test/overlay.ts` waits for them); a click on a `popovertarget` button toggles its popover; Escape hides the last `popover="auto"` shown, or else fires a cancelable `cancel` at the top modal dialog and closes it unless refused; `inert` is only an attribute there, reflected by the property. A closed popover is hidden, so its accessible name is empty in jsdom: tests find it by role and read its `aria-label`. Unit tests therefore check roles, names, attributes, `aria-*` state and focus calls, not containment. **Focus containment, `inert` and light dismiss are verified in a real browser**: the visual and accessibility harness (UX-1g) opens each dialog, sheet, menu, tooltip and the nav drawer in Chromium and checks that Tab stays inside, the background is inert, Escape and an outside click close it and focus returns; WebKit is checked by hand on an iPad for the terminal and the drawer once per release.

If an issue later needs a primitive the platform cannot give (a searchable combobox, for example), it writes an ADR first, as the brief requires. No ADR is needed for this decision because nothing is added.

## 5. Chart theme

One module, `src/chart/theme.ts`, read by ECharts (registered as theme `shopfloor` and passed to `init`) and by uPlot (an options helper), with its colours taken from the CSS tokens at run time (`getComputedStyle(document.documentElement)`) so the dark theme repaints the canvases (G-25).

| Element         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Font            | `--font-sans`, 12 px axis labels and legend, 11 px tick labels, `ink-secondary`; values in tooltips in tabular figures                                                                                                                                                                                                                                                                                                                                                                            |
| Axes            | Axis line `neutral-500`, ticks outside 4 px, split lines `neutral-200` dashed on the value axis only; the value axis starts at 0 for bars                                                                                                                                                                                                                                                                                                                                                         |
| Axis titles     | The unit only, at the end of the axis ("min", "Pa/min", "%"), never a sentence                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Legend          | Top-left, above the plot, square 10 px markers for bars and 16 px line samples for lines; hidden when there is one series                                                                                                                                                                                                                                                                                                                                                                         |
| Tooltip         | White, `line` border, elevation 2, plant time with date, one row per series with its marker, the unit                                                                                                                                                                                                                                                                                                                                                                                             |
| Series palette  | Categorical, in this order: `#0369a1` (5.93), `#b45309` (5.02), `#6d28d9` (7.10), `#047857` (5.48), `#be185d` (6.04); `neutral-700` for "total" or "other"                                                                                                                                                                                                                                                                                                                                        |
| State colours   | Machine states, alarm priorities, own and external loss use the tokens of section 2, never the categorical palette                                                                                                                                                                                                                                                                                                                                                                                |
| SPC             | Points `neutral-700` circles (provisional: hollow), signalling points `alarm` diamonds, UCL/LCL `#b91c1c` dashed 1.5 px, centre `neutral-600` solid, ±1σ/2σ zones `neutral-200` dotted, retests `info` triangles; every point's symbol drawn after the first render and after every live update (C-03, cause under investigation in UX-B1); rule labels in a lane above the plot, staggered and collision-avoided (`labelLayout: { hideOverlap: true }` plus the rule list under the chart, C-02) |
| Category labels | Wrap to two lines at 180 px instead of truncating; still too long, the label ends in "…" and the full text is in the tooltip and the table (E-07)                                                                                                                                                                                                                                                                                                                                                 |
| Value labels    | Only when there are ≤ 12 bars and the value is not zero; zero or no data draws no label (E-05)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Empty data      | No chart: the figure shows an `EmptyState` ("No planned time in this shift") at the chart's height                                                                                                                                                                                                                                                                                                                                                                                                |
| Tooltip render  | `tooltip.renderMode: 'richText'`: drawn on the canvas, so ECharts adds no HTML tooltip node with inline styles (the CSP's `style-src 'self'` stays clean); uPlot's legend is its own stylesheet. Rows formatted by the theme's formatter                                                                                                                                                                                                                                                          |
| Animation       | Off (`animation: false`); uPlot has none                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sizes           | Height 240 px (compact), 320 px (default); grid padding 8 px left (axis labels contained), 16 px right                                                                                                                                                                                                                                                                                                                                                                                            |
| Narrow screens  | Below `md`: fewer x ticks (every other), legend under the title, horizontal bar charts get their own label column so axis labels never overlap                                                                                                                                                                                                                                                                                                                                                    |
| Accessibility   | As today: the canvas `role="img"` with a one-sentence `aria-label` that states the main reading ("OEE per hour: 0 % in all 2 hours"), and the table beside it with every value                                                                                                                                                                                                                                                                                                                    |

Waterfall (E-06): every step is drawn as a positive bar from its base, losses labelled with a true minus sign (U+2212, no space: "−93.1"), the table writes the same.

## 6. Content rules

### 6.1 Numbers and units

- **Ratios** (OEE, A, P, Q, yield) show as a percentage with the precision `percentText` gives today (two decimals): "83.04 %". The four-decimal value (`0.8304`) leaves the visible text and moves to a new raw attribute, `data-decimal`, beside the exact `data-fraction` (`83/100`) and the `title`; it also stays in the shift report's JSON (E-02, R-02). Today the tests read the **text** as well as `data-fraction`: `e2e/browser/orders/oee/1-order-line-oee.spec.ts` (`ratio()`, lines 27–31, its decimal compared by `orders-pass.ts`'s `checkOeeScreen`) and `demo/walkthrough.spec.ts` (lines 483–485, `/^0\.\d{4}$/` and `'1.0000'`). So `data-decimal` is added to every ratio element (`RatioValue`, `RatioHeadline`, the order OEE and FPY values, the line OEE values) first, and the issue that changes the text moves those specs to `data-decimal` in the same pull request (UX-3 the walkthrough, UX-6b `ratio()`).
- **Percent sign** with a space before it ("83.04 %"), as today.
- **Units** after the value with a space ("93.1 min", "3.245 Pa/min", "60 blanks"). In tables, durations keep the unit in each cell ("30.0 min"; the demo asserts that text in the Pareto table); a column of measured values or counts with one unit names it in the header and its cells hold numbers only (4.5).
- **Precision:** a measured value with its characteristic's precision (`domain/numbers.ts`, #295); loss minutes with one decimal, rounded half up as the MES does; counts as integers. Thousands with a comma ("12,345 pieces", "18,000.0 min") from 10,000 up only, so "1800.0 min" stays as it is, so figures under it keep their reconciled spelling.
- **Signs:** a true minus (U+2212) directly before the number ("−93.1"); "+" only for deltas.
- **Durations** (one function, G-17): under a minute "45 s"; under an hour "12 min" (with seconds, "12 min 05 s", only where it ticks live: time in state, a running pause); under a day "4 h 54 min"; from a day "2 d 12 h". Loss totals that reconcile stay in minutes with one decimal.

### 6.2 Time

- **Plant time** is the default and needs no label inside the app; the shell's clock names the zone ("Gebze plant time"). Format `Mon 12 Oct, 07:15:00` (en-GB, plant zone).
- **The date goes with every time** unless the time falls on the plant clock's current day in the plant zone: then the time alone (`07:15:00`). One rule for every row, with no "(today)" heading variant; before the plant clock is known, every time is dated. Every such element carries the full plant date-time in its `title` and the raw instant in `<time dateTime>` (`formatPlantTimeRelative` in `domain/time.ts`; A-01, #309). Seconds are shown for event times (facts, alarms, cycles), not for planning times (due, planned start: `Mon 12 Oct, 22:00`).
- **Wall time** (when the MES or a person did something) always ends with "(wall time)" and never uses the browser's locale or zone settings (Y-01); the formatting functions live in `domain/time.ts` only, and no screen calls `toLocaleString`.
- **Ranges:** "Mon 12 Oct, 06:15 – 12:17" on one day, "Wed 21 Oct, 22:00 – Thu 22 Oct, 06:00" across midnight.
- **Inputs** are plant time with the UTC instant shown (4.8).

### 6.3 Empty, absent and not applicable

| Case                                                      | Show                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A real zero                                               | `0` (or `0.0 min`)                                                                                                               |
| No value: not applicable, not yet known, nothing recorded | `—` (em dash, `ink-secondary`) with the reason in a tooltip and as visually hidden text ("not applicable: no planned busy time") |
| A device did not report the field                         | `Not reported` in `ink-secondary`                                                                                                |
| Nobody (no operator signed on, no comment)                | `—` in tables; a sentence in prose ("Nobody signed on")                                                                          |
| An empty list or section                                  | An `EmptyState` with a sentence, never a lone "none"                                                                             |

"n/a", "none", "None" and "–" (en dash) leave the visible text (G-16). Raw markers that tests read stay raw (`data-fraction="n/a"`, `data-value`).

### 6.4 Words

- **Sentence case** everywhere: titles, buttons, tabs, table headers, badges ("Planned stop", "Line OEE per hour"). Codes and names keep their case ("OP30", "VB-100", "SPINDLE-OVERLOAD").
- **Names before codes:** "Leak tester (lkt-01)", "Spindle overload · SPINDLE-OVERLOAD"; in tables the name in `ink`, the code in `ink-secondary` monospace below or beside it. Telemetry metrics get display names from the plant model ("Coolant temperature", M-02).
- **No protocol talk in the UI:** no HTTP status codes, problem-type URIs or fact sequence numbers in body text (Q-06, A-06); the problem type stays in `FailureMessage`'s small print where it helps support, and sequence numbers move into a "Technical details" disclosure.
- **Action labels** are a verb and, where it is not obvious, its object: "Acknowledge", "Acknowledge selected (3)" (the count in brackets, as today and as `final/alarm-actions.spec.ts` reads it), "Save coding", "Open hold", "Close order", "Disable user". No "OK", "Submit" or "Yes". A confirm dialog repeats the verb on its button. Accessible names may say more than the visible label (today's "Code Manual assembly station at 22:00:00" stays).
- **Read-only roles** see "View" instead of an action verb that opens a read-only panel (D-04), or a one-line callout instead of an empty actions section.
- **Explanations:** one line under the page title; anything longer in an `InfoTip` or a closed `Disclosure`.

## 7. Accessibility (WCAG 2.2 AA)

The bar for every issue. The harness of UX-1g reports it with axe on every route from early on; UX-F1 makes it a failing check.

| Criterion                                        | Rule here                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text content                           | Every chart: `role="img"`, an `aria-label` with the main reading, and its data table. Decorative glyphs `aria-hidden`.                                                                                                                                                                                                                          |
| 1.3.1 Info and relationships                     | Real headings in order (one `h1`), `table` with `caption` and `th scope`, `dl` for facts, `fieldset`/`legend` for groups of checkboxes, labels tied to controls.                                                                                                                                                                                |
| 1.3.2 / 1.3.4 Sequence, orientation              | Fact grids flow by column (3.4); no layout depends on orientation (the terminal works in both).                                                                                                                                                                                                                                                 |
| 1.4.1 Use of colour                              | Every state and tone carries a word; abnormal states a glyph; links are underlined in body text.                                                                                                                                                                                                                                                |
| 1.4.3 Contrast (text)                            | ≥ 4.5:1 for every text pair in section 2 (computed): the lowest light-theme text pair is 5.48 (white on `#047857`), the lowest dark-theme one 4.83 (white on the dark Down fill). `neutral-500` is 4.76 on white but **4.34 on the canvas**, so it is never used for text; secondary text is `neutral-600` (7.58 on white, 6.92 on the canvas). |
| 1.4.11 Non-text contrast                         | Input borders `neutral-500` (4.76 on white, 4.34 on canvas), focus rings ≥ 3:1 (5.93 on white, 8.33 on the top bar), state badge fills against their surface or a 1 px border that is ≥ 3:1.                                                                                                                                                    |
| 1.4.10 / 1.4.4 Reflow, resize                    | Usable at 320 px wide and 200 % zoom without two-way scrolling except data tables and charts (allowed), which scroll inside their own frame.                                                                                                                                                                                                    |
| 1.4.12 / 1.4.13                                  | Text spacing overrides don't clip (no fixed heights on text); tooltips are dismissible (Escape), hoverable and persistent.                                                                                                                                                                                                                      |
| 2.1.1 Keyboard                                   | Everything by keyboard: tabs with arrows, dialogs trap and return focus, the nav drawer, table row actions as buttons (rows are not clickable divs), the SPC chart's points through its table.                                                                                                                                                  |
| 2.4.1 / 2.4.2 / 2.4.3                            | Skip link kept, plus "Skip to the details" before long action tables (G-33); page titles per route (G-05); focus order follows the visual order; focus moves to the new page's `h1` on navigation (kept).                                                                                                                                       |
| 2.4.7 / 2.4.11 / 2.4.13 Focus                    | A 2 px solid ring in `focus` (`focus-on-dark` on the top bar and nav) with a 2 px offset on every interactive element, `:focus-visible` only; sticky headers and panels never cover the focused element (`scroll-padding-top: 64px`).                                                                                                           |
| 2.5.3 Label in name                              | The visible label starts the accessible name ("Acknowledge" → "Acknowledge SPINDLE-OVERLOAD on Horizontal machining centre 1", as today).                                                                                                                                                                                                       |
| 2.5.8 Target size                                | ≥ 24 × 24 px for every target on desktop (checkboxes in a 24 px hit area), ≥ 44 px on touch layouts, 56 px in the terminal.                                                                                                                                                                                                                     |
| 3.2.2 / 3.3.1 / 3.3.3 Forms                      | No change of context on input (filters update the list, not the page); errors identified in text, tied to their field (`aria-invalid`, `aria-describedby`), with a suggestion where possible (L-01).                                                                                                                                            |
| 3.3.7 Redundant entry                            | Forms keep what was typed after a refused write (they do today: keep it).                                                                                                                                                                                                                                                                       |
| 4.1.2 / 4.1.3 Name, role, value; status messages | Native elements first; toggles expose `aria-pressed` or `aria-current`; live regions: the connection status (polite, kept), toasts, the skeleton's `role="status"`, the offline bar.                                                                                                                                                            |
| Motion                                           | `prefers-reduced-motion` stops pulses, shimmer, drawer slides and spinners (a static indicator instead); nothing flashes.                                                                                                                                                                                                                       |

## 8. Dark mode

**Decision: in scope, token-ready from UX-1a, shipped as its own issue after the screen migrations.**

- UX-1a defines every colour token with a light and a dark value and a `data-theme` attribute on `<html>` (`light`, `dark`, or absent = follow `prefers-color-scheme`). From UX-1a on, a migrated screen that uses a raw colour (a Tailwind palette class like `bg-slate-50`, a hex in a chart option) fails review; a check script (UX-1a) lists the files still using raw colours, and UX-F3 turns it into a failing check.
- The switch (System, Light, Dark) ships in UX-12, after every screen is on tokens, in the top bar's user area and on the account page, stored in `localStorage` per browser. Until then the app is light only, as now.
- **Print is always light.** The existing `@media print` rules force white; charts print from the still image `EChartsView` takes on `beforeprint` (`getDataURL`), so in dark mode the chart is first re-themed light on `beforeprint`, the image taken, and the dark theme restored on `afterprint` (UX-12). **The terminal** follows the same switch; tablets in a bright hall will mostly stay light.
- Dark values (computed pairs, AA):

  | Token                    | Dark                                                      | Pair and ratio                              |
  | ------------------------ | --------------------------------------------------------- | ------------------------------------------- |
  | `canvas`                 | `#0b1220`                                                 | `ink` `#e2e8f0` on it 15.19                 |
  | `surface`                | `#111a2b`                                                 | `ink` 14.12; `ink-secondary` `#94a3b8` 6.79 |
  | `surface-sunken`         | `#0e1626`                                                 | –                                           |
  | `line` / `line-strong`   | `#334155` / `#64748b`                                     | `line-strong` on surface 3.66 (non-text)    |
  | `link`                   | `#7dd3fc`                                                 | on surface 10.44                            |
  | `accent` (primary fill)  | `#38bdf8`, text `on-accent` `#0b1220`                     | 8.74                                        |
  | `focus`                  | `#38bdf8`                                                 | on surface 8.13                             |
  | Running badge            | fill `#1e293b`, text `#e2e8f0`, border `#cbd5e1`          | 11.87                                       |
  | Active nav item          | `#0c4a6e`, text `#ffffff`, bar `#38bdf8`                  | 9.46 (as light)                             |
  | Idle badge               | fill `#334155`, text `#e2e8f0`                            | 8.40                                        |
  | Starved badge            | fill `#fcd34d`, text `#451a03` (unchanged)                | 10.39                                       |
  | Down badge               | fill `#dc2626`, text `#ffffff`                            | 4.83; fill on surface 3.6                   |
  | `alarm` soft             | text `#fca5a5` on `#2a1215`                               | 9.25                                        |
  | `warn` soft              | text `#fcd34d` on `#2a2110`                               | 11.00                                       |
  | `ok` soft                | text `#6ee7b7` on `#0f2a22`                               | 10.02                                       |
  | `info` soft              | text `#93c5fd` on `#0f1d3a`, border `#60a5fa`             | 9.26; border on surface 6.85                |
  | Chart series 1, 2; limit | `#38bdf8` 8.13, `#f59e0b` 8.10; `#f87171` 6.29 on surface | –                                           |

  The other dark values (UX-1a), each pair recomputed by `tokens.test.ts`. The shell (top bar and nav), the light solid fills (Starved, Blocked, medium priority, the `warn` and `caution` solids) and the shadows keep their light values.

  | Token                                      | Dark                                                                           | Pair and ratio                                   |
  | ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------ |
  | `surface-hover`, `disabled`, `line-subtle` | `#1e293b`                                                                      | `ink` on it 11.87; `disabled-ink` `#94a3b8` 5.71 |
  | `disabled-line`                            | `#334155`                                                                      | –                                                |
  | `ink-inverse`                              | `#0b1220`                                                                      | –                                                |
  | `ink-secondary` on `canvas`                | –                                                                              | 7.30                                             |
  | `accent-hover`                             | `#7dd3fc`                                                                      | `on-accent` on it 11.23                          |
  | `alarm-solid-hover`                        | `#b91c1c`                                                                      | white on it 6.47                                 |
  | `accent-subtle`                            | `#0c2d48`                                                                      | `ink` on it 11.47                                |
  | `neutral` tone                             | ink `#cbd5e1` on soft `#1e293b`; border `#64748b`; solid `#475569`             | 9.85; border 3.66; white on solid 7.58           |
  | `info` tone                                | solid `#2563eb`                                                                | white 5.17                                       |
  | `ok` tone                                  | border `#10b981`; solid `#047857` (unchanged)                                  | border 6.86; white 5.48                          |
  | `warn` tone                                | border `#f59e0b`                                                               | 8.10                                             |
  | `caution` tone                             | ink `#fdba74` on soft `#2b1a10`; border `#f97316`                              | 9.90; border 6.21                                |
  | `alarm` tone                               | border `#f87171`; solid `#dc2626`                                              | border 6.29; white 4.83                          |
  | Setup badge                                | as Idle, dashed border `#94a3b8`                                               | 8.40                                             |
  | Planned stop badge                         | fill `#0e1626`, text `#cbd5e1`, border `#64748b`                               | 12.18                                            |
  | Maintenance badge                          | `info` solid `#2563eb`, text `#ffffff`                                         | 5.17                                             |
  | Off badge                                  | fill `#111a2b`, text `#94a3b8`, border `#334155`                               | 6.79                                             |
  | Stopped badge                              | `alarm` soft: text `#fca5a5` on `#2a1215`, border `#f87171`                    | 9.25                                             |
  | No data badge                              | fill `#111a2b`, text `#94a3b8`, dashed border `#64748b`                        | 6.79                                             |
  | Priority high / low                        | high as Down (`#dc2626`); low fill `#111a2b`, text `#93c5fd`, border `#60a5fa` | 4.83; 9.65                                       |
  | Chart series 3, 4, 5; other                | `#a78bfa`, `#34d399`, `#f472b6`; `#cbd5e1`                                     | 6.40, 9.05, 6.57; 11.72 on surface               |
  | `backdrop`                                 | `rgb(2 6 23 / 0.7)`                                                            | –                                                |

## 9. Rules for every migration

1. Keep every `data-testid`, `data-*` value a test reads (raw, #295), accessible name and role. A rename updates the specs in the same pull request and says so in its description.
2. No behaviour, API or contract change; a defect found on the way is fixed in its own issue or reported.
3. No raw colours, no per-screen button or input classes, no `toLocaleString`, no monospace numbers.
4. Every state of the screen designed: loading (skeleton), empty, error, not found where an id is in the URL, data, read-only role.
5. Checked at 1440, 1280, 1024, 768 and 390, keyboard only once, and with the visual and accessibility harness (UX-1g, report-only until UX-F1) on the touched routes.
6. Structural selectors and asserted texts survive too, not only test ids: element types and id prefixes a spec counts (`article[data-testid^="machine-"]`), element ids (`#line-title`), cell positions (`td.nth(1)`), child elements (`plant-clock`'s `<time>`), literal texts a spec asserts, and test ids that must stay **absent** (`operator-name`, `coded-by`, `note-author`). Each issue in [`ux-plan.md`](ux-plan.md) lists the ones it touches.
