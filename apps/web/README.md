# @shopfloor/web

The MES web app (#98): a plant overview with every machine's live state, and a machine detail with its state timeline and telemetry trends. React 19, Vite 8, TanStack Router and Query, Tailwind 4, uPlot (plan section 6; decisions in ADR-0020).

## Develop

Start the MES first (runbook, "Run the MES server"); it listens on `127.0.0.1:4700`. Then:

```bash
pnpm --filter @shopfloor/web dev        # http://127.0.0.1:5173
```

The dev server proxies `/api` (REST and the WebSocket at `/api/v1/ws`) to the MES, so the page and the API share one origin, as they are behind nginx in the `web` container (#99):

- `MES_URL` (default `http://127.0.0.1:4700`) points the proxy elsewhere.
- **Host:** the MES answers only `Host` names in `HTTP_ALLOWED_HOSTS` (default `localhost,127.0.0.1,[::1]`). The proxy sends the target's host (`changeOrigin`), so this works with the defaults. Open the app as `localhost` or `127.0.0.1`; other names are refused.
- **Origin:** the MES accepts a WebSocket only from its own origin or `HTTP_ALLOWED_ORIGINS` (ADR-0019). Because `changeOrigin` already satisfies the MES's Host check and Vite's own host check doesn't run on proxied WebSocket upgrades, the proxy has to keep the MES's protection against DNS rebinding itself (`src/dev-proxy.ts`): it refuses (403) an upgrade whose `Host` is not a loopback name (`localhost`, `127.0.0.1`, `[::1]`), and presents the page's origin as the MES's own only when it equals that loopback `Host`. Any other `Origin` is passed on unchanged and the MES refuses it. No `HTTP_ALLOWED_ORIGINS` is needed for development.

No login yet (Phase 9).

## Build

```bash
pnpm --filter @shopfloor/web build      # static files in apps/web/dist
pnpm --filter @shopfloor/web preview    # serves dist on http://127.0.0.1:4173 with the same proxy
```

`dist/` is plain static files (an `index.html` and hashed assets; uPlot is a separate chunk loaded with the first chart). A server must send every unknown path to `index.html` (client-side routes such as `/equipment/cnc-01`) and proxy `/api` to the MES, including the WebSocket upgrade.

## Container

`apps/web/Dockerfile` builds `dist/` with Vite and serves it with nginx (unprivileged, port 8080); Compose publishes it on `127.0.0.1:8080` (`WEB_PORT`) as service `web` (#99, runbook "Full stack"). The nginx configuration is in `nginx/`:

- unknown paths get `index.html` (client-side routes); hashed `/assets/` are cached for a year (`immutable`), `index.html` is always revalidated (`no-cache`); gzip for text;
- `/api/` goes to `mes:4700` with the WebSocket upgrade headers, unbuffered, and a 60 s read timeout (the MES pings every 15 s). Docker's DNS is asked again every 10 s, so a recreated MES is found and nginx starts without it;
- it forwards the browser's `Host` **with the port** (`proxy_set_header Host $http_host`): the MES checks the name against `HTTP_ALLOWED_HOSTS` (default `localhost,127.0.0.1,[::1]`, which covers `http://localhost:8080` and `http://127.0.0.1:8080`), and the page's `Origin` (`http://localhost:8080`) then names the MES's own host, so the WebSocket's Origin check passes without `HTTP_ALLOWED_ORIGINS`. `$host` would drop the port and every WebSocket would be refused;
- security headers on every answer: a Content Security Policy without `unsafe-inline` (Vite's output has no inline scripts or styles; React and uPlot set styles through the DOM, which CSP allows), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`;
- `GET /healthz` for the container healthcheck.

To open the app under another name (for example a LAN host name, which also needs a port published beyond loopback), add that name to `MES_ALLOWED_HOSTS` in `.env`.

## How it works

- **API:** `src/api/client.ts` reads `/api/v1` and parses every answer with the zod schemas in `@shopfloor/contracts/mes-api`, the same schemas `mes-server` generates `docs/api/mes.openapi.json` from (ADR-0020). Errors become `ApiError` with the MES's problem details (RFC 9457). Interval reads follow `next` while the MES truncates.
- **Live data:** one `LiveClient` per tab (`src/live/live-client.ts`) holds the WebSocket: reference-counted subscriptions, resubscription (and so fresh snapshots) after every reconnect, exponential backoff with jitter, pacing below the MES's rate limit, retries after `busy`, `rate-limited` and `unavailable`. `connectLiveToCache` writes states, the plant clock and telemetry into the TanStack Query cache (`['live', …]`, without structural sharing; a machine's telemetry is dropped a minute after its detail screen closes); the newer of a REST state and a pushed state wins. After a reconnect the REST queries are refetched; on the detail screen a pushed state change rereads the intervals (at most every 2 s), so the timeline has no hole at its live end.
- **Times** are simulation time; they are shown in the plant's zone (Europe/Istanbul). The detail's ranges (last hour, 8 h, 24 h) end at the plant clock, not the wall clock.

## Screens

- `/`: machines by area and work center in line order, each with its state as colour and text, cause, time in state (to the plant clock), and markers: **Stale** when the live connection is down or the state is from an earlier simulator run, **Provisional** when only the device's start-up state is known (no state change seen yet). Machines that never reported show **No data**. The header shows the plant clock and the connection (`Live`, `Connecting…`, `Reconnecting…`).
- `/equipment/$id?range=1h|8h|24h`: current state, a state timeline over the range (bands per state, drawn on to the plant clock with the live state), time per state over the range, the intervals as a table, metrics with units and latest values, and a trend per metric (min/max band and average from the decimated series, live samples appended).

Stable hooks for tests (#100): `data-testid="state-<equipmentId>"` on each machine's state badge with the state in `data-state` (`no-data` when it never reported) and as text; `machine-<id>`, `time-in-state-<id>`, `stale-<id>` (shown only after a lost connection or for an earlier run, not while first connecting); `plant-clock`; `connection-status` with `data-status` (`open` when live); on the detail `current-state`, `state-timeline` (bands carry `data-state`) and `latest-<metric>`.

## Accessibility

Semantic landmarks and headings, a skip link, focus moved to the new screen's heading after navigating, visible focus outlines, time without data hatched on the timeline (no state colour can pass for it), state never by colour alone (text labels, AA-contrast colours), a text table for the timeline, the connection announced as a status, `prefers-reduced-motion` respected (no animation then), layouts down to phone width.

## Test

```bash
pnpm --filter @shopfloor/web test       # Vitest in jsdom, with coverage (floor 70 / 60)
```

Tests render the whole app with a fake WebSocket the test drives and a stubbed `fetch`; uPlot's canvas is mocked and the chart columns are tested as data. Browser tests come with Playwright in #100.
