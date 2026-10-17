# ADR-0028: ERP mock: a REST change feed pulled by the MES, idempotent messages in SQLite

- Status: accepted
- Date: 2026-10-16
- Deciders: Claude (Phase 7 plan, #171), recorded for the owner under the standing instruction of 2026-10-15

## Context and problem statement

Phase 7 runs the plant from orders (master plan section 5, data paths 3 and 4): orders come down from an ERP, confirmations and status messages go back up. The ERP is a mock (section 1: it only exchanges orders and confirmations). How does the MES get orders, how do messages reach the ERP without duplicates after a crash, and what does the mock hold and keep?

## Considered options

1. **REST, pulled by the MES:** a change feed of order versions with a cursor, lots, and message posts with an `Idempotency-Key`; a shared bearer token.
2. **File drop:** the ERP writes order files into a shared volume, the MES polls it and writes confirmation files back.
3. **MQTT:** orders and confirmations as UNS messages under an `erp` class.

Storage of what the mock received: (a) `node:sqlite`, as the gateway's outbox (ADR-0014); (b) PostgreSQL, the MES's database; (c) memory only.

## Decision outcome

Chosen option: 1 with (a), because a feed with a cursor gives exactly-once import without a second channel: the MES commits its cursor in the same transaction as the orders it imported (#174), so a crash neither skips nor half-imports a page. A file drop adds a shared volume and a poller for nothing a feed doesn't give; MQTT would put a business system on the plant's namespace, which section 5 keeps for the shop floor. The mock's own database must not be the MES's (two systems, two stores), and memory loses what the MES sent at every restart, which the "MES restarted, ERP totals unchanged" check of exit criterion 4 needs.

**Interface** (`@shopfloor/contracts/erp-api`, served by `apps/erp-mock` on `node:http`, port 4600):

- `GET /api/v1/orders?after={cursor}&limit={n}` (default 100, at most 500): order versions after the cursor in feed order, each with its feed number `feedSeq`, the order (number, revision, product, quantity, planned start and due date in UTC, priority 1–9, ERP status `open` or `cancelled`), its routing (operation and work center) and BOM (material, operation, quantity per unit, `standard` or `rework`). The answer carries `feedId`, `cursor` (the last entry's `feedSeq`, or `after` when empty) and `more`. Feed numbers are dense from 1. An `after` beyond the last entry is 409 `urn:shopfloor:erp-cursor-ahead`.
- **Feed identity:** a cursor is a position in one feed. `feedId` is the first 32 hex digits of SHA-256 over the expanded dataset's hash (canonical JSON of the feed and lots) and the store id, a UUID created once with the store. Orders added through `POST /orders` only append, so they keep it; a replaced dataset or a deleted store changes it. The MES stores `feedId` beside its cursor; when a page brings another one, or the ERP answers `erp-cursor-ahead`, it raises an incident and resets its cursor to 0, which re-imports idempotently by (order number, revision) (#174).
- `GET /api/v1/orders/{orderNumber}`: the ERP's view of an order, derived from what the MES sent: latest revision, revisions, the latest status (`null` before any), `short`, the status history, and per routing operation the sum of the confirmations received (yield, scrap by reason, rework passes, material), corrections included.
- `GET /api/v1/lots`; `GET /api/v1/confirmations` and `GET /api/v1/order-status` (optional `orderNumber`): what was received, in the order received.
- `POST /api/v1/confirmations` and `POST /api/v1/order-status`, each with an `Idempotency-Key` header that must be the key built from the body (`confirmationKey`: `{order}~{operation}~conf~{n}`; `statusKey`: `{order}~r{revision}~status~{status}`; otherwise 422 `urn:shopfloor:erp-key-mismatch`). So a confirmation (order, operation, number) or a status message (order, revision, status) has exactly one key, and a second message for it can't hide under another key; the store also holds confirmations unique on (order, operation, number) and refuses a duplicate under another key with 409 `urn:shopfloor:erp-duplicate-confirmation` (unreachable through the key check). The first post of a key answers 201 with a receipt (`receivedSeq`, `receivedAt`); the same key with the same body answers 200 with that receipt; the same key with another body, or on the other endpoint, answers 409 `urn:shopfloor:erp-idempotency-conflict`. Bodies are compared after validation as canonical JSON (keys sorted, `confirmedAt` and `sentAt` normalised to UTC), so key order or the offset of one instant is not a difference. A message for an order, revision or (for a confirmation) operation the ERP doesn't hold is 422 `urn:shopfloor:erp-unknown-order`, and its key stays unused. A final confirmation is number 1 with counts ≥ 0, a correction number 2 and above with signed deltas, and a correction for an order operation with no final received is 422 `urn:shopfloor:erp-correction-without-final`; `short` only on `completed`. The order view's status is that of the last status message received (highest `receivedSeq`), whatever its place in the lifecycle.
- `POST /api/v1/orders` (dev only, `ERP_ADMIN=on`; otherwise 405): appends an order version to the feed; a revision not above the order's latest is 409 `urn:shopfloor:erp-revision-conflict`.
- Every `/api/v1` route needs `Authorization: Bearer {ERP_API_TOKEN}` (compared in constant time on SHA-256 digests), otherwise 401 with `WWW-Authenticate: Bearer`. `/health/live`, `/health/ready` and `/metrics` (plain-text Prometheus format: feed entries, messages stored, posts by kind and outcome, refused requests) are open, on loopback as every service. Errors are problem details (RFC 9457).

**Dataset:** orders and lots are loaded at start from `ERP_DATASET` (default `config/erp/orders.yaml`; JSON works too, for a golden scenario's `orders.json`). An entry is an order version; its feed number is its position, and an order's revisions must rise in feed order. Routing and BOM are built from `config/plant` unless the entry gives its own (so a scenario can carry an order the MES must reject): the operations of `products.yaml`, each with the work center of the equipment that runs it in `plant.yaml`; the blank at the first operation, the components and the rework components at `componentsOperation`, one each per unit. An unknown product gets an empty routing and BOM. Lots default to `stock.yaml`, the file the simulator stocks from, so ERP and plant hold the same lots without the simulator ever calling the ERP. The expansion is a pure function in contracts (`expandErpDataset`), so the golden harness can serve a scenario's dataset without the app. Nothing depends on wall time except `receivedAt`.

**Store:** one SQLite file (`ERP_STORE_PATH`, a Compose volume), WAL with `synchronous=FULL` as ADR-0014: the messages received (key unique, kind, order, canonical body, `receivedSeq`, `receivedAt`) and the orders added through `POST /orders` (with their feed numbers, which follow the dataset's). Each post is one durable commit. `node:sqlite` is synchronous, so the key lookup and the insert of one request can't interleave with another's. If the dataset changes under added orders (their feed numbers no longer follow it), the mock refuses to start rather than renumber a feed a client holds a cursor into.

### Consequences

- Good: no dependency (`node:http`, `node:sqlite`, `node:crypto`); the MES's import and its outbox can be tested against the same schemas and a scenario dataset without the app.
- Good: a replay after an MES crash between the ERP's answer and the MES's commit is answered with the stored receipt, so the ERP's totals don't move (plan risk "duplicate confirmations").
- Bad: the token is one shared secret without rotation or scopes; enough for a mock on loopback (Phase 9 hardens transport).
- Good: a client can tell a cursor of another feed (`feedId`, 409 `erp-cursor-ahead`) instead of silently skipping or re-reading orders.
- Bad: a changed dataset with added orders needs the store deleted; the mock says so at start.

Note (#174, the MES's import): a new revision replaces only an order the MES holds as `imported` or `rejected`. After release it is refused (logged `revision-refused`, `rejected-revision` posted), and that includes a revision with ERP status `cancelled`: an ERP cancellation of a released order does not stop it; a supervisor cancels it in the MES before dispatch, and a dispatched order runs on (no cancel on the machine in Phase 7; runbook). A feed entry the MES's database refuses is undone to a savepoint of its own and recorded as rejected (an `erp-invalid-entry` incident), so the page and its cursor still commit and one entry can't block every later import; a routing that repeats an operation is refused at validation.
