# @shopfloor/web

The MES web app (#98, #122): a plant overview with every machine's live state, a machine detail with its state timeline and telemetry trends, the OEE dashboard and the downtime coding screen. React 19, Vite 8, TanStack Router and Query, Tailwind 4, uPlot, Apache ECharts (plan section 6; decisions in ADR-0020).

## Develop

Start the MES first (runbook, "Run the MES server"); it listens on `127.0.0.1:4700`. Then:

```bash
pnpm --filter @shopfloor/web dev        # http://127.0.0.1:5173
```

The dev server proxies `/api` (REST and the WebSocket at `/api/v1/ws`) to the MES, so the page and the API share one origin, as they are behind nginx in the `web` container (#99):

- `MES_URL` (default `http://127.0.0.1:4700`) points the proxy elsewhere.
- **Host:** the MES answers only `Host` names in `HTTP_ALLOWED_HOSTS` (default `localhost,127.0.0.1,[::1]`). The proxy sends the target's host (`changeOrigin`), so this works with the defaults. Open the app as `localhost` or `127.0.0.1`; other names are refused.
- **Origin:** the MES accepts a WebSocket only from its own origin or `HTTP_ALLOWED_ORIGINS` (ADR-0019). Because `changeOrigin` already satisfies the MES's Host check and Vite's own host check doesn't run on proxied WebSocket upgrades, the proxy has to keep the MES's protection against DNS rebinding itself (`src/dev-proxy.ts`): it refuses (403) an upgrade whose `Host` is not a loopback name (`localhost`, `127.0.0.1`, `[::1]`), and presents the page's origin as the MES's own only when it equals that loopback `Host`. Any other `Origin` is passed on unchanged and the MES refuses it. The same rule applies to HTTP requests (#121): the MES refuses a write without an `Origin` of its own host (ADR-0023), so writes from `pnpm dev` pass only through this rewrite. No `HTTP_ALLOWED_ORIGINS` is needed for development.

No login yet (Phase 9).

## Build

```bash
pnpm --filter @shopfloor/web build      # static files in apps/web/dist
pnpm --filter @shopfloor/web preview    # serves dist on http://127.0.0.1:4173 with the same proxy
```

`dist/` is plain static files (an `index.html` and hashed assets; uPlot and ECharts are separate chunks loaded with the first chart of their kind; the ECharts chunk is about 170 KB gzipped, so Vite warns that it is over 500 KB unzipped). A server must send every unknown path to `index.html` (client-side routes such as `/equipment/cnc-01`) and proxy `/api` to the MES, including the WebSocket upgrade.

## Container

`apps/web/Dockerfile` builds `dist/` with Vite and serves it with nginx (unprivileged, port 8080); Compose publishes it on `127.0.0.1:8080` (`WEB_PORT`) as service `web` (#99, runbook "Full stack"). The nginx configuration is in `nginx/`:

- unknown paths get `index.html` (client-side routes); hashed `/assets/` are cached for a year (`immutable`), `index.html` is always revalidated (`no-cache`); gzip for text;
- `/api/` passes only GET (with HEAD), POST, PUT and DELETE (`limit_except`, others 403) and bodies up to 16 KiB (ADR-0023);
- `/api/` goes to `mes:4700` with the WebSocket upgrade headers, unbuffered, and a 60 s read timeout (the MES pings every 15 s). Docker's DNS is asked again every 10 s, so a recreated MES is found and nginx starts without it;
- it forwards the browser's `Host` **with the port** (`proxy_set_header Host $http_host`): the MES checks the name against `HTTP_ALLOWED_HOSTS` (default `localhost,127.0.0.1,[::1]`, which covers `http://localhost:8080` and `http://127.0.0.1:8080`), and the page's `Origin` (`http://localhost:8080`) then names the MES's own host, so the WebSocket's Origin check passes without `HTTP_ALLOWED_ORIGINS`. `$host` would drop the port and every WebSocket would be refused;
- security headers on every answer: a Content Security Policy without `unsafe-inline` (Vite's output has no inline scripts or styles; React, uPlot and ECharts set styles through the DOM, which CSP allows; ECharts' HTML tooltip would write markup with `style` attributes, which the policy refuses, so its tooltip is drawn on the canvas, checked in a browser in #122), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`;
- `GET /healthz` for the container healthcheck.

To open the app under another name (for example a LAN host name, which also needs a port published beyond loopback), add that name to `MES_ALLOWED_HOSTS` in `.env`.

## How it works

- **API:** `src/api/client.ts` reads `/api/v1` and parses every answer with the zod schemas in `@shopfloor/contracts/mes-api`, the same schemas `mes-server` generates `docs/api/mes.openapi.json` from (ADR-0020). Errors become `ApiError` with the MES's problem details (RFC 9457). Interval reads follow `next` while the MES truncates.
- **Live data:** one `LiveClient` per tab (`src/live/live-client.ts`) holds the WebSocket: reference-counted subscriptions, resubscription (and so fresh snapshots) after every reconnect, exponential backoff with jitter, pacing below the MES's rate limit, retries after `busy`, `rate-limited` and `unavailable`. `connectLiveToCache` writes states, the plant clock and telemetry into the TanStack Query cache (`['live', …]`, without structural sharing; a machine's telemetry is dropped a minute after its detail screen closes); the newer of a REST state and a pushed state wins. After a reconnect the REST queries are refetched; on the detail screen a pushed state change rereads the intervals (at most every 2 s), so the timeline has no hole at its live end.
- **OEE live (#122):** the dashboard subscribes to `oee:<id>` for every work center and machine (8 of the MES's 16 topics) and to `downtime`. `connectLiveToCache` keeps the pushed hour and shift buckets per topic by key (`['live', 'oee', id]`, the last 48 hours and 6 shifts); a pushed bucket replaces the REST one of the same key unless the REST one is final where the push is not, or has a higher revision. Values are the API's: four-decimal strings and exact fractions, never recomputed in floating point; minutes and the waterfall's last step use `@shopfloor/oee-core`'s BigInt fractions. A downtime push rereads the Pareto (at most every 2 s).
- **Downtime live and writes (#122):** `downtime` messages are upserts by record id in `['live', 'downtime']` (a higher `version` wins; at the same version a closed record over an open one, then the longer; `removed` deletes), merged into the REST list and sorted UNCODED first. A coding is `PUT /api/v1/downtime/{id}/coding` with a JSON body (`segments`, `codedBy`, the record's `version`), relative and same-origin, so the browser sends the page's `Origin` through the proxy (ADR-0023); the body is checked with the shared `codingRequestSchema` first. After a save the list is read again (the version belongs to the machine's coding set, so its other records moved on too). On 409 the list is read again and the form reset to what the MES holds; 403, 405, 415, 422 and 429 (with `Retry-After`) are explained from the problem details. `codedBy` is kept in `localStorage` (read and written in `try`/`catch`).
- **Times** are simulation time; they are shown in the plant's zone (Europe/Istanbul). The detail's ranges (last hour, 8 h, 24 h) end at the plant clock, not the wall clock.

## Screens

- `/`: machines by area and work center in line order, each with its state as colour and text, cause, time in state (to the plant clock), and markers: **Stale** when the live connection is down or the state is from an earlier simulator run, **Provisional** when only the device's start-up state is known (no state change seen yet). Machines that never reported show **No data**. The header shows the plant clock and the connection (`Live`, `Connecting…`, `Reconnecting…`).
- `/equipment/$id?range=1h|8h|24h`: current state, a state timeline over the range (bands per state, drawn on to the plant clock with the live state), time per state over the range, the intervals as a table, metrics with units and latest values, and a trend per metric (min/max band and average from the decimated series, live samples appended).

- `/oee?shift=<date/shift>&focus=<id>`: the shift picker (current shift by default, the last week's from `GET /shifts`); a card per work center (Cell M1, Line A1) with OEE (percent and the API's four decimals), A, P, Q, availability loss own and external, status (**Final**, **Provisional** with the time that may still change, **Revision n**, **n incidents**, **Anomaly**) and the bottleneck (ASM-01, by design) on its line; a machine table; for the work center or machine in **Details for**: OEE per hour (bars, final and provisional), the loss waterfall (PBT → own → external → APT → micro-stops → speed → quality → fully productive, from the API's totals and losses, an alert if they don't add up) and the downtime Pareto (own and external by reason, micro-stops by cause). Null OEE reads `n/a`, never 0. Every chart has its values as text beside it.
- `/downtime?shift=…&uncoded=true&record=<id>`: the shift's downtime records, UNCODED first, live; **Only uncoded** and a machine filter; a record's panel with its reasons in effect, the coding form (split at a plant time, a reason per segment over the reason tree or the automatic one, a comment, **Coded by**, **Save coding**, **Undo changes**, **Remove all codings**) and the history from the audit.

Stable hooks for tests (#100, #123): `data-testid="state-<equipmentId>"` on each machine's state badge with the state in `data-state` (`no-data` when it never reported) and as text; `machine-<id>`, `time-in-state-<id>`, `stale-<id>` (shown only after a lost connection or for an earlier run, not while first connecting); `plant-clock`; `connection-status` with `data-status` (`open` when live); on the detail `current-state`, `state-timeline` (bands carry `data-state`) and `latest-<metric>`. OEE: `oee-card-<workCenter>` with the API's four-decimal OEE in `data-oee` (`n/a` when null) and `data-final`, `oee-value-<id>`, `oee-own-<id>`, `oee-external-<id>`, `bottleneck-<workCenter>`, `oee-machine-<id>` (row, `data-oee`), `shift-select`, `focus-select`, `hourly` with rows `hour-<hourStart>`, `waterfall` with rows `waterfall-<step>` (`pbt`, `own`, `external`, `apt`, `micro`, `speed`, `quality`, `productive`; `data-kind`), `pareto` with rows `pareto-<reasonId>`. Downtime: `downtime-row-<recordId>` (`data-uncoded`, `data-reason`), `downtime-summary`, `uncoded-only`, `coding-panel` (`data-record`), `split-at`, `split`, `segment-<n>`, `reason-picker` (one per segment, `data-segment`), `segment-comment`, `coded-by`, `save-coding`, `reset-coding`, `clear-coding`, `coding-errors`, `coding-message` (`data-kind`: `saved`, `conflict`, `refused`, `invalid`, `busy`, `unavailable`), `audit` with `audit-entry`. Navigation: `nav-overview`, `nav-oee`, `nav-downtime`.

## Accessibility

Semantic landmarks and headings, a skip link, focus moved to the new screen's heading after navigating, visible focus outlines, time without data hatched on the timeline (no state colour can pass for it), state never by colour alone (text labels, AA-contrast colours), a text table for the timeline, the connection announced as a status, `prefers-reduced-motion` respected (no animation then, charts included), layouts down to phone width without horizontal page scroll (wide tables scroll inside their box). OEE and downtime: status as text (Final, Provisional, Uncoded, Own/External), every chart with an image label and its values in a table, labelled form controls, errors in `role="alert"` and a saved coding in `role="status"`, focus on the record panel's heading when a record opens.

## Test

```bash
pnpm --filter @shopfloor/web test       # Vitest in jsdom, with coverage (floor 70 / 60)
```

Tests render the whole app with a fake WebSocket the test drives and a stubbed `fetch`; uPlot's canvas is mocked and the chart columns are tested as data, as are the ECharts options (the ECharts view is stubbed in screen tests). Browser tests come with Playwright in #100.
