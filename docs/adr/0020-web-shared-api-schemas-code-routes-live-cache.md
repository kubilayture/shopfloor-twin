# ADR-0020: Web app: shared zod API schemas, code-based routes, pushed states in the query cache

- Status: accepted
- Date: 2026-10-15
- Deciders: Claude (#98), within the Phase 4 plan; recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

The Phase 4 plan fixes the web stack (React 19, Vite 8, TanStack Router and Query, Tailwind 4, uPlot) and its two screens: a plant overview with every machine's live state, and a machine detail with a state timeline and telemetry trends. Building them left these questions open:

- **API types:** how does `web` know the shapes of `/api/v1` and of the WebSocket messages, and how is that kept in step with `mes-server`? Apps never import each other (plan section 8), and boundaries parse `unknown` with zod.
- **Routes:** TanStack Router supports file-based routes (a Vite plugin generates `routeTree.gen.ts`) and code-based routes.
- **Live data:** how do pushed states reach the screens so the overview shows each machine's latest state within 2 s (exit criterion 3), with reconnects, resubscription and the MES's rate limits?
- **Tests:** plan section 9 lists Vitest browser mode for components; which DOM do the component tests use now?

## Considered options

API types: (a) generate TypeScript types from `docs/api/mes.openapi.json` and `mes-realtime.schema.json` (`openapi-typescript`) and check the generated file for drift; (b) hand-written zod schemas in `web`, compared against the committed JSON Schema by a test; (c) move the response and message zod schemas from `mes-server`'s `realtime` module to `@shopfloor/contracts` (plan section 8 already puts "REST DTOs" there); `mes-server` generates the OpenAPI document from them as before, and `web` parses with the same schemas.

Routes: (a) file-based with the router plugin; (b) code-based.

Live data: (a) a store beside TanStack Query (context or an external store) for pushed states; (b) push into the query cache under `['live', …]` keys, read with `useQuery` and merged with the REST answers by "newest wins"; (c) write pushed states into the cached REST answers (`['equipment']`) directly.

DOM for tests: (a) Vitest browser mode with Playwright; (b) jsdom; (c) happy-dom.

## Decision outcome

- **API types: (c).** `packages/contracts/src/mes-api.ts` holds the response schemas, the WebSocket message schemas and the API limits; `@shopfloor/contracts/mes-api` exports them without the rest of the package. `mes-server`'s `schemas.ts` keeps only the request schemas (their transforms to `Date` and numbers are the server's business) and re-exports the rest. The OpenAPI drift test passed unchanged after the move, so the committed documents still describe exactly these schemas, and `web` validates every REST answer and pushed message at runtime with them, as plan section 8 asks. (a) gives types without runtime validation and adds a generator and a generated file; (b) duplicates every schema and needs a comparison that ignores descriptions.
- **Routes: (b).** Two routes (`/` and `/equipment/$id` with a validated `range` search parameter) fit in one short file, fully typed through `Register`; nothing is generated, so there is no generated file to commit or keep out of lint and Prettier, and no extra Vite plugin. Revisit when the app grows past a dozen routes (operator terminal, OEE screens in later phases).
- **Live data: (b).** One `LiveClient` per tab owns the WebSocket: subscriptions are reference-counted by the components that hold them, sent again after every reconnect (which brings fresh snapshots), and paced at 5 messages per second in bursts of 8, below the MES's 10 per second in bursts of 20. A lost connection is retried with exponential backoff (0.5 s doubling to 15 s, ±25 % jitter); `busy`, `rate-limited` and `unavailable` errors resend the subscriptions not yet confirmed (1 s doubling); other errors are kept for display, not retried. `connectLiveToCache` writes snapshots and deltas into the query cache under `['live', 'states']` (states and plant clock) and `['live', 'telemetry', id]` (recent samples, bounded), and after a reconnect refetches the REST queries, which may have missed changes. Screens show the newer of the REST state and the pushed state (newer device epoch, then later `seq`, then later start), so a REST answer that arrives after a delta never takes the screen back. (a) would duplicate what the cache already does (subscriptions, structural sharing, devtools); (c) loses pushes that arrive before the REST answer.
- **Tests: (b), jsdom,** for now. The screens' tests render the whole app (router, query client, a fake socket driven by the test) and check what a user sees; charts are tested through the pure shaping function, and uPlot's canvas is mocked. jsdom is the most complete DOM emulation and the one Testing Library targets; browser mode needs Playwright's browsers in every `pnpm verify`. Playwright arrives with #100 for the end-to-end check, and browser mode can be adopted for chart components then.

### Consequences

- Good: one schema per message from `mes-server` to the screen; a change that breaks `web` fails its typecheck in the same pull request, and malformed data is refused at the boundary instead of rendering wrongly.
- Good: pushed states reach the overview within one event-loop turn plus TanStack Query's batched notification (a 0 ms timeout); at 60× intermediate states may be skipped, the latest always wins.
- Good: no generated sources in the web app.
- Bad: the browser bundle carries zod (the main chunk is about 140 KB gzipped with React, the router and the query client); acceptable for a plant-floor dashboard, revisit if load time matters on terminals.
- Bad: `contracts` now holds HTTP DTOs beside UNS payloads; the subpath export keeps them apart for consumers.
- Bad: jsdom has no layout or canvas, so chart rendering and real browser behaviour are only covered by #100's Playwright test.

## Notes (#122): OEE and downtime screens

- **Routes:** `/oee` and `/downtime` join as code-based routes with validated search parameters (`shift`, `focus`; `shift`, `record`, `uncoded`). Four routes still fit one file; the revisit threshold stands.
- **Live data:** the same pattern for the new topics. `['live', 'oee', id]` holds only the hour and shift buckets of `oee:<id>` the plant clock is in; when either key moves on, the old one is dropped and the REST reads are fetched again, so a bucket the clock has left shows the REST answer. A pushed bucket replaces the REST one of the same key unless the REST one is further along (final where the push is not, or a higher revision). `['live', 'downtime']` holds `downtime` messages as upserts by record id (higher coding-set `version` wins; at equal versions closed over open, then longer; `removed` deletes), merged into the REST list on screen. No OEE value is recomputed in floating point: screens show the API's strings, and derived values (minutes, the waterfall's last step) use `@shopfloor/oee-core`'s fractions.
- **Writes:** the first write from the app goes through `sendJson`: a relative URL (same origin, through the proxy, so the browser sends the page's `Origin`, ADR-0023), `Content-Type: application/json`, the body checked with the shared request schema before sending. Problem details, including `Retry-After`, reach the screen through `ApiError`. A coding draft keeps the version and codings it started from: a newer record with the same codings moves the version (the MES pushes the machine's other records as `updated` after a write); one with other codings makes the draft stale, and it is never sent with the newer version, which would replace that coding unseen.
- **Charts:** Apache ECharts for bars (tree-shaken from `echarts/core`, a lazily loaded chunk of about 170 KB gzipped), uPlot stays for the telemetry trends. Under the strict CSP the canvas tooltip is used (`renderMode: 'richText'`); the HTML tooltip writes `style` attributes through `innerHTML`, which `style-src 'self'` refuses. Checked in a browser against the Compose stack: no CSP violation. In jsdom the ECharts view is stubbed and the options are tested as data.
