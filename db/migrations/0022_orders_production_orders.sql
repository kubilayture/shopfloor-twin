-- orders (Phase 7, #174; plan "Orders", ADR-0028, ADR-0029): production orders imported from the
-- ERP's change feed, their routing operations, the dispatch commands to the CNCs with every
-- delivery published (a transactional outbox), the ERP message log (feed entries in, status
-- messages and, from #175, confirmations out, also a transactional outbox) and the incidents the
-- module raises for a person to look at. Ids of other modules are kept by value (no keys across
-- module schemas, ADR-0016).
CREATE SCHEMA orders;
GRANT USAGE ON SCHEMA orders TO mes_app;

-- The ERP change feed's cursor and identity (ADR-0028): committed in the transaction of the page
-- it imported, so a crash never skips or half-imports a page. A changed feed id resets it to 0.
CREATE TABLE orders.erp_cursor (
  id TEXT PRIMARY KEY CHECK (id = 'erp'),
  feed_id TEXT CHECK (feed_id ~ '^[0-9a-f]{32}$'),
  cursor BIGINT NOT NULL CHECK (cursor >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- One row per ERP order number, at the revision the MES holds (a later revision replaces an order
-- only imported; after release it is refused and logged).
CREATE TABLE orders.production_order (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  -- The feed entry of that revision.
  feed_seq BIGINT NOT NULL,
  product TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 9),
  -- Plant time.
  planned_start TIMESTAMPTZ NOT NULL,
  due_date TIMESTAMPTZ NOT NULL,
  erp_status TEXT NOT NULL CHECK (erp_status IN ('open', 'cancelled')),
  status TEXT NOT NULL CHECK (
    status IN (
      'imported',
      'rejected',
      'released',
      'dispatched',
      'in-progress',
      'completed',
      'closed',
      'cancelled'
    )
  ),
  short BOOLEAN NOT NULL DEFAULT false,
  dispatch_failed BOOLEAN NOT NULL DEFAULT false,
  dispatch_lost BOOLEAN NOT NULL DEFAULT false,
  -- Why the import refused the revision (status rejected).
  rejection TEXT,
  -- The routing and BOM as the ERP sent them.
  routing JSONB NOT NULL,
  bom JSONB NOT NULL,
  -- Raised by every change; a supervisor write names the version it read (409 otherwise).
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Wall times of the import and the last change; plant times of the lifecycle steps.
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CHECK ((status = 'rejected') = (rejection IS NOT NULL)),
  CHECK (short = false OR status IN ('completed', 'closed'))
);
CREATE INDEX production_order_status ON orders.production_order (status, planned_start);
CREATE INDEX production_order_planned ON orders.production_order (planned_start, id);

-- The routing operations of an order (rebuilt when a new revision replaces an imported order).
-- #175 (execution, confirmations) adds what it tracks per order operation.
CREATE TABLE orders.order_operation (
  order_id TEXT NOT NULL REFERENCES orders.production_order (id),
  operation TEXT NOT NULL CHECK (operation ~ '^OP[0-9]{2}$'),
  position INTEGER NOT NULL CHECK (position >= 0),
  -- A master_data.work_center id, by value.
  work_center TEXT NOT NULL,
  PRIMARY KEY (order_id, operation)
);

-- The command outbox (ADR-0029): a dispatch writes its command in the transaction of the order
-- change; a publisher sends it, one command in flight per CNC, in `queue_position` order. The
-- state columns are read from the gateway's results (ingest.command_result) and the device's job
-- facts, and kept here for the API, push and the per-CNC order.
CREATE TABLE orders.dispatch_command (
  command_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders.production_order (id),
  n INTEGER NOT NULL CHECK (n >= 1),
  -- A CNC (master_data.equipment id, by value).
  equipment TEXT NOT NULL,
  product TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  -- Plant time; the job doesn't start earlier.
  not_before TIMESTAMPTZ NOT NULL,
  -- The simulator run the command is meant for.
  device_epoch BIGINT NOT NULL,
  queue_position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (
    state IN (
      'queued',
      'sent',
      'unknown',
      'failed',
      'accepted',
      'rejected',
      'expired',
      'not-accepted',
      'epoch-ended'
    )
  ),
  settled BOOLEAN NOT NULL DEFAULT false,
  -- Declared failed at least once (an incident was raised).
  failed BOOLEAN NOT NULL DEFAULT false,
  -- The job's acceptance: by its `accepted` fact (confirmed) or, before it, by a result.
  accepted_by TEXT CHECK (accepted_by IN ('fact', 'result')),
  accepted_seq BIGINT,
  accepted_at TIMESTAMPTZ,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  job TEXT CHECK (job IN ('accepted', 'started', 'completed', 'lost')),
  -- Plant times of the job's started and completed facts.
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- Blanks a lost job started (its run ended first): what it counts against the order.
  lost_started INTEGER CHECK (lost_started >= 0),
  rejection TEXT,
  seq_after_expiry BIGINT,
  UNIQUE (order_id, n),
  CHECK (command_id = order_id || '~OP10~' || n::text),
  CHECK ((accepted_by IS NULL) = (job IS NULL)),
  CHECK ((job = 'lost') = (lost_started IS NOT NULL))
);
CREATE INDEX dispatch_command_open ON orders.dispatch_command (equipment, queue_position)
  WHERE settled = false OR job IN ('accepted', 'started');

-- Every delivery of a command published: the first and each resend, with its own expiresAt.
-- Written before the publish, so a crash after the commit is a delivery that never left (resent).
CREATE TABLE orders.command_attempt (
  command_id TEXT NOT NULL REFERENCES orders.dispatch_command (command_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  -- Wall times.
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- The MES process's epoch and its sequence number on the command topic (the command envelope).
  mes_epoch BIGINT NOT NULL,
  mes_seq BIGINT NOT NULL,
  PRIMARY KEY (command_id, attempt)
);

-- The ERP message log: every feed entry imported (in) and every message to the ERP (out), the
-- outbound ones a transactional outbox posted with their Idempotency-Key (statusKey,
-- confirmationKey of @shopfloor/contracts/erp-api) and retried with backoff; a 409 is an
-- `erp-conflict` incident and not retried.
CREATE TABLE orders.erp_message_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind TEXT NOT NULL CHECK (kind IN ('feed-entry', 'status', 'confirmation')),
  order_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  feed_id TEXT,
  feed_seq BIGINT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'imported',
      'rejected',
      'unchanged',
      'cancelled',
      'revision-refused',
      'pending',
      'sent',
      'conflict',
      'refused'
    )
  ),
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  -- The ERP's receipt of an outbound message (201, or 200 on a replay).
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((direction = 'out') = (idempotency_key IS NOT NULL)),
  CHECK ((direction = 'in') = (kind = 'feed-entry'))
);
CREATE INDEX erp_message_log_pending ON orders.erp_message_log (id) WHERE status = 'pending';
CREATE INDEX erp_message_log_order ON orders.erp_message_log (order_id, id);

-- Incidents of the orders module; `key` names what one is about, so the same incident is open at
-- most once.
CREATE TABLE orders.order_incident (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN (
      'erp-feed-changed',
      'erp-conflict',
      'erp-refused',
      'command-failed',
      'command-unconfirmed',
      'unknown-job',
      'duplicate-job',
      'dispatch-lost'
    )
  ),
  key TEXT NOT NULL,
  order_id TEXT,
  command_id TEXT,
  equipment TEXT,
  message TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  resolution TEXT,
  CHECK ((closed_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX order_incident_open ON orders.order_incident (key) WHERE closed_at IS NULL;
CREATE INDEX order_incident_order ON orders.order_incident (order_id, id);

-- Orders and commands are never deleted (their history stays); routing operations are replaced
-- with a new revision of an order only imported; command attempts are append-only.
GRANT SELECT, INSERT, UPDATE ON orders.erp_cursor, orders.production_order,
  orders.dispatch_command, orders.erp_message_log, orders.order_incident TO mes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders.order_operation TO mes_app;
GRANT SELECT, INSERT ON orders.command_attempt TO mes_app;
