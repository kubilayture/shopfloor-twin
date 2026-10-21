# ERP mock REST API

`apps/erp-mock` stands in for the business system (ISA-95 level 4): it serves production orders with their routing and BOM and the lot master data, and it receives the MES's confirmations, order status messages and quality notifications, idempotently (#171, #198; decisions in [ADR-0028](../adr/0028-erp-mock-rest-feed-and-idempotent-messages.md) and its amendment). The MES is its only client: it pulls the order feed and the lots every `ERP_POLL_MS` (default 10 s) and posts from its outbox (`orders.erp_message_log`). The server is plain `node:http` (`apps/erp-mock/src/server.ts`); every body is defined once as a zod schema in `@shopfloor/contracts/erp-api` (`packages/contracts/src/erp-api.ts`), which the mock, the MES's `orders` module and the tests share. There is no OpenAPI document for this API: this page is its reference, and `apps/erp-mock/src/api-doc.test.ts` fails when the route table below, the environment variables or the problem types drift from the code.

## Reaching it

- In Compose the service is `erp`, published on `127.0.0.1:${ERP_HTTP_PORT:-4600}` (checklist S8; the container listens on `0.0.0.0:4600` inside the Compose network, where the MES reaches it as `http://erp:4600`). Plain HTTP: it is published on loopback only and every API route needs the token.
- Outside Compose: `ERP_API_TOKEN=<token> pnpm --filter @shopfloor/erp-mock start` (runbook, "ERP mock").
- Answers are JSON (`application/json; charset=utf-8`) with `Cache-Control: no-store`; errors are problem details (below).

## Authentication: the shared token

- Every `/api/v1/…` request needs `Authorization: Bearer <ERP_API_TOKEN>`: the scheme `Bearer` in any case, one or more spaces, one token without whitespace, nothing after it. Otherwise the answer is **401** with `WWW-Authenticate: Bearer realm="erp-mock"`, and `erp_unauthorized_requests_total` counts it (#242, checklist S7).
- The token is checked **before routing**: an unknown `/api/v1` path or method without the token is 401 too, so nothing about the routes is learned without it.
- The comparison hashes both sides with SHA-256 and compares the 32-byte digests with `timingSafeEqual` (`bearerMatches`, `tokenDigest`), so neither the position of a wrong character nor the token's length shows in the time.
- `ERP_API_TOKEN` is required (an empty or missing value, or one with whitespace, stops the mock with exit status 2, the value never echoed). A token shorter than 16 characters or the `.env.example` placeholder `change-me` is **weak** (`isWeakToken` in `src/env.ts`): the mock starts anyway and logs a warning (`ERP_API_TOKEN is short or the .env.example placeholder; set a random value`). The fresh-clone init and the gate's env file generate a random value.
- One shared token without scopes or rotation is an accepted risk on loopback ([security review](../security-review.md), S7); rotation is in the runbook.
- `/health/live`, `/health/ready` and `/metrics` are open (below).

## Routes

Every route of `/api/v1`, as the server's route table (`apiRoutes`) declares it. `{…}` is one path segment.

| Method | Path                            | Request                                                                                      | Success                                                              |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/v1/orders`                | query `after` (cursor, default 0), `limit` (1–500, default 100)                              | 200 `orderFeedSchema`: `feedId`, `entries`, `cursor`, `more`         |
| POST   | `/api/v1/orders`                | dev only (`ERP_ADMIN=on`): body `erpOrderInputSchema`                                        | 201 the new feed entry (`feedEntrySchema`)                           |
| GET    | `/api/v1/orders/{orderNumber}`  | –                                                                                            | 200 `erpOrderViewSchema`: the ERP's view of the order                |
| GET    | `/api/v1/lots`                  | –                                                                                            | 200 `lotListSchema`: `feedId`, `lots`                                |
| GET    | `/api/v1/lots/{id}`             | –                                                                                            | 200 `erpLotViewSchema`: the lot, its holds, `blocked`                |
| GET    | `/api/v1/confirmations`         | query `orderNumber` (optional)                                                               | 200 `confirmationListSchema`: `confirmations`, in the order received |
| POST   | `/api/v1/confirmations`         | header `Idempotency-Key` = `confirmationKey`; body `confirmationRequestSchema`               | 201 receipt (200 on a replay)                                        |
| GET    | `/api/v1/order-status`          | query `orderNumber` (optional)                                                               | 200 `statusMessageListSchema`: `messages`, in the order received     |
| POST   | `/api/v1/order-status`          | header `Idempotency-Key` = `statusKey`; body `statusMessageRequestSchema`                    | 201 receipt (200 on a replay)                                        |
| GET    | `/api/v1/quality-notifications` | query `holdId` (optional)                                                                    | 200 `qualityNotificationListSchema`: `notifications`, in order       |
| POST   | `/api/v1/quality-notifications` | header `Idempotency-Key` = `qualityNotificationKey`; body `qualityNotificationRequestSchema` | 201 receipt (200 on a replay)                                        |

Open routes, without a token, `GET` only (another method is 405 with `Allow: GET`):

- `/health/live` and `/health/ready`: 200 `{ "status": "ok" }` once the server listens (the image's health check reads `/health/ready`).
- `/metrics`: Prometheus text format: `erp_feed_entries`, `erp_messages_stored{kind}`, `erp_message_posts_total{kind,outcome}` (outcomes `created`, `replayed`, `conflict`, `invalid`, `key-mismatch`, `unknown-order`, `no-final`, `unknown-subject`, `hold-sequence`, `hold-decided`), `erp_unauthorized_requests_total`.

Any other path outside `/api/v1/` is 404.

### The order feed: `GET /api/v1/orders`

- The feed is the list of **order versions** in feed order: each entry has `feedSeq` (its position, dense from 1) and `order` (`orderNumber`, `revision` 1–999, `product`, `quantity` 1–100,000, `priority` 1–9 with 1 the most urgent, `status` `open` or `cancelled`, `plannedStart` and `dueDate` in UTC with milliseconds, `routing` of `{ operation, workCenter }`, `bom` of `{ material, operation, quantityPerUnit, usage }` with `usage` `standard` or `rework`). A new revision of an order is a new entry; `cancelled` withdraws an order by a new revision.
- `after` is the client's cursor (an integer 0 to 2^53 − 1), `limit` 1–500 (default 100; 0 and anything above 500 are 400). The page holds the entries with `feedSeq` above `after`; `cursor` is the last entry's `feedSeq` (or `after` when the page is empty), passed as the next `after`; `more` says whether entries follow.
- **Feed identity:** `feedId` (32 hex digits) hashes the expanded dataset (orders and lots) and the store's own id, created once with the store. Orders added through the dev-only post append and keep it; a replaced dataset or a deleted store changes it. A client keeps `feedId` beside its cursor: another `feedId`, or **409** `urn:shopfloor:erp-cursor-ahead` (an `after` beyond the feed's last entry), means the cursor belongs to another feed, and the MES raises an incident and starts again at 0 (its import is idempotent by order number and revision, #174).

### The dev-only order post: `POST /api/v1/orders`

With `ERP_ADMIN=off` (the default) it is **405** with `Allow: GET`. With `ERP_ADMIN=on` (dev only; the mock logs a warning at start) the body is an order version as in a dataset (`erpOrderInputSchema`: `status` defaults to `open`, `priority` to 5, routing and BOM to those built from the plant's master data unless given); it is appended to the feed (201, the entry) and kept in the store. A revision not above the order's latest is **409** `urn:shopfloor:erp-revision-conflict`.

### The ERP's views: `GET /api/v1/orders/{orderNumber}` and `GET /api/v1/lots/{id}`

- **Order view** (`erpOrderViewSchema`), derived from what the MES sent: the latest revision (`order`), every `revisions` number, `status` (the status of the last status message received by `receivedSeq`, whatever its place in the lifecycle; `null` before any), `short` (from the last `completed`), the `statusHistory`, and per routing operation of the latest revision the totals of the confirmations received, corrections included (`confirmations`, `yield`, `scrap` by reason, `scrapTotal`, `reworkPasses`, `material`). An order number the feed doesn't hold, or one that isn't an order number, is **404**.
- **Lot view** (`erpLotViewSchema`): the feed's `feedId`, the lot (`id`, `material`, `quantity`), the holds whose subject is that lot as folded from the quality notifications received (`state` `open`, `released` or `rejected`, opened and decided by and at, the latest reason and scope counts with `scopeAsOf` and `scopeFinal`, the notifications' `receivedSeq`), and `blocked` while one of them is open or rejected (a released lot is used as is). A hold on a serial, carton or order of the lot is not a hold on the lot: the ERP has no genealogy. A lot not in the lot list is **404**.
- `GET /api/v1/lots` lists the lot master data in dataset order, with the feed's `feedId`: a changed lot list is a changed feed.

### Messages from the MES: confirmations, status messages, quality notifications

The three `POST` routes share one idempotency scheme.

- **`Idempotency-Key`** (1–200 visible ASCII characters without spaces; missing or malformed is **400**) must be the key built from the body, otherwise **422** `urn:shopfloor:erp-key-mismatch`. So one message has exactly one key and a second message for the same thing can't hide under another key:
  - confirmation: `confirmationKey` = `{orderNumber}~{operation}~conf~{n}`, e.g. `ORD-1001~OP10~conf~1`;
  - status message: `statusKey` = `{orderNumber}~r{revision}~status~{status}`, e.g. `ORD-1001~r1~status~accepted`;
  - quality notification: `qualityNotificationKey` = `{holdId}~{transition}~{n}`, e.g. `17~opened~1`.
- **Answers:** the first post of a key is **201** with a receipt (`idempotencyKey`, `kind`, `receivedSeq` (the order in which the ERP received its messages, across every kind), `receivedAt` (wall time), and `orderNumber`, or `holdId` for a notification; `messageReceiptSchema` is the union). The same key with the same body is **200** with that same receipt, also after a restart (the store keeps it). The same key with another body, or on another of the three routes, is **409** `urn:shopfloor:erp-idempotency-conflict`. Bodies are compared after validation as canonical JSON (keys sorted, times normalised to UTC), so key order or the offset of one instant is no difference.
- **Confirmations** (`confirmationRequestSchema`): `orderNumber`, `revision`, `operation` (`OP10`…), `kind` (`final` is number 1 with no negative counts; `correction` is number 2 and above, with signed deltas), `confirmation` (n), `yield`, `scrap` (`{ reason, quantity }`, at most 64 lines), `reworkPasses`, `material` (backflushed, at most 64 lines), `confirmedAt`. A correction for an order operation without a final confirmation received is **422** `urn:shopfloor:erp-correction-without-final`. The store also refuses a second confirmation of the same (order, operation, number) under another key with **409** `urn:shopfloor:erp-duplicate-confirmation` (unreachable through the key check; a backstop).
- **Status messages** (`statusMessageRequestSchema`): `orderNumber`, `revision`, `status` (`accepted`, `rejected`, `rejected-revision`, `released`, `in-progress`, `completed`, `closed`, `cancelled`), `short` (only with `completed`: packed good below the quantity), an optional `reason` (at most 500 characters), `sentAt`.
- A confirmation or status message naming an order, a revision or (for a confirmation) an operation the ERP doesn't hold is **422** `urn:shopfloor:erp-unknown-order`; its key stays unused.
- **Quality notifications** (`qualityNotificationRequestSchema`, the ADR-0028 amendment): `holdId` (the MES's hold id, no `~`), `transition` (`opened` is transition 1; `released` or `rejected`, 2 and above), `transitionNo`, `subject` (`lot`, `serial`, `carton` or `order` with its `id`), `reason` (a code of `quality.yaml`), an optional `comment` (at most 500 characters), `user` (the MES user name), `occurredAt`, and the scope counts `scope` (`units`, `cartons`, `orders`), which are provisional: `scopeAsOf` (the plant time they stand at) and `scopeFinal`. A comment on a hold is not notified. Refused, with the key left unused: an `opened` on a `lot` not in the lot list or an `order` not in the feed, **422** `urn:shopfloor:erp-unknown-subject` (serials and cartons are the MES's own and not checked); a release or rejection whose hold's `opened` wasn't received, or named another subject, **422** `urn:shopfloor:erp-hold-sequence`; a second decision on a hold, **409** `urn:shopfloor:erp-hold-decided`.
- `GET` on the same three paths lists what was received, in the order received, each with its receipt and body; `orderNumber` (confirmations, status messages) or `holdId` (notifications) filters, and a malformed one is **400**.
- How the MES treats the answers: a 409 is an `erp-conflict` incident and is not retried; other 4xx are refused and never retried; a 5xx or a connection error is retried from the outbox (ADR-0028 notes on #174, #175, #201).

## Errors

Every error is RFC 9457 problem details (`application/problem+json; charset=utf-8`): `type`, `title` (the HTTP reason phrase), `status`, `detail`, `instance` (the path). The `type` is `about:blank` except for the stable URIs a client tells apart (`ERP_PROBLEM_TYPES` in contracts):

| Status | `type`                                       | When                                                                            |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------- |
| 409    | `urn:shopfloor:erp-idempotency-conflict`     | The `Idempotency-Key` was used before with another body or on another route     |
| 422    | `urn:shopfloor:erp-unknown-order`            | A message names an order, revision or operation the ERP doesn't hold            |
| 409    | `urn:shopfloor:erp-revision-conflict`        | The dev-only order post with a revision not above the order's latest            |
| 422    | `urn:shopfloor:erp-key-mismatch`             | The `Idempotency-Key` is not the key built from the body                        |
| 409    | `urn:shopfloor:erp-duplicate-confirmation`   | A stored confirmation's (order, operation, number) under another key (backstop) |
| 422    | `urn:shopfloor:erp-correction-without-final` | A correction before the operation's final confirmation                          |
| 409    | `urn:shopfloor:erp-cursor-ahead`             | `after` beyond the feed's last entry: the cursor belongs to another feed        |
| 422    | `urn:shopfloor:erp-unknown-subject`          | A hold opened on a lot or order the ERP doesn't hold                            |
| 422    | `urn:shopfloor:erp-hold-sequence`            | A release or rejection without the hold's opening, or on another subject        |
| 409    | `urn:shopfloor:erp-hold-decided`             | A second decision on a decided hold                                             |

With `about:blank`: **400** (a malformed query parameter, `Idempotency-Key` or JSON body), **401** (no or wrong token, with `WWW-Authenticate`), **404** (an unknown path, order or lot), **405** (a method the path doesn't take, with `Allow`), **413** (a body above 64 KiB; the connection closes after the answer), **415** (a body that isn't `application/json`), **422** (a body that fails its schema; `detail` lists `path: message` per issue), **500** (`internal error`; the cause is logged, never sent).

## Datasets: `ERP_DATASET`

The orders and lots are loaded once at start from a dataset file (`erpDatasetSchema`: `orders`, an optional `lots`), YAML or JSON, expanded by the pure `expandErpDataset` of contracts: an entry is an order version whose feed number is its position, an order's revisions must rise in feed order, routing and BOM come from `PLANT_CONFIG_DIR` (`products.yaml`, `plant.yaml`) unless the entry gives its own, and the lots default to the plant's `stock.yaml`, the simulator's stock, unless the file lists `lots` (a lot id listed twice is refused). An invalid dataset stops the mock with exit status 1, the entry named. If the store holds orders added through the dev-only post and the dataset changed under them, the mock refuses to start: delete the store.

| Dataset                                        | Used by                                                                                                      | What it holds                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `config/erp/orders.yaml`                       | The default (`src/env.ts`; the image sets `ERP_DATASET=/app/config/erp/orders.yaml`): the dev stack          | Six order versions (one of them a revision); lots from `stock.yaml`                                                |
| `config/erp/demo-v1.yaml`                      | The demo (#281): `compose.demo.yml` sets `ERP_DATASET=/app/config/erp/demo-v1.yaml`; `pnpm demo` uses it too | Four VB-100 orders planned for Monday 06:15 with the timeline `config/scenarios/demo-v1.yaml` ([demo](../demo.md)) |
| `apps/simulator/golden/orders-01/orders.json`  | The reconcile pass `orders` (`e2e/compose.reconcile-orders.yml`, mounted read-only)                          | The golden scenario's orders; lots from `stock.yaml`                                                               |
| `apps/simulator/golden/quality-01/orders.json` | The reconcile pass `quality` (`e2e/compose.reconcile-quality.yml`, mounted read-only)                        | The golden scenario's orders and its own small `lots`                                                              |

Both `config/erp` files are in the ERP mock's image; the golden ones are mounted by the harnesses' overrides. The golden harness serves a scenario's dataset through `expandErpDataset` without the app.

## Environment

| Variable           | Default                        | Meaning                                                                                                                       |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ERP_API_TOKEN`    | – (required)                   | The shared bearer token; no whitespace; weak (short or `change-me`) only warns                                                |
| `ERP_DATASET`      | `config/erp/orders.yaml`       | The dataset file (above)                                                                                                      |
| `PLANT_CONFIG_DIR` | `config/plant`                 | Master data for routings, BOMs and the default lots                                                                           |
| `ERP_STORE_PATH`   | `.store/erp.db`                | The SQLite store (`node:sqlite`, WAL, `synchronous=FULL`): messages received and orders added; Compose: the `erp-data` volume |
| `ERP_ADMIN`        | `off`                          | `on` enables the dev-only `POST /api/v1/orders`                                                                               |
| `HTTP_HOST`        | `127.0.0.1` (image: `0.0.0.0`) | Listen address                                                                                                                |
| `HTTP_PORT`        | `4600`                         | Listen port                                                                                                                   |
| `LOG_LEVEL`        | `info`                         | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` (Compose: `ERP_LOG_LEVEL`)                                       |

An invalid environment stops the mock with exit status 2, naming each variable (a token's value is shown as `(hidden)`). In Compose, `.env` sets `ERP_API_TOKEN` (required, `:?`), `ERP_HTTP_PORT`, `ERP_LOG_LEVEL` and `ERP_ADMIN`; the MES gets `ERP_URL=http://erp:4600`, the same token and `ERP_POLL_MS`.
