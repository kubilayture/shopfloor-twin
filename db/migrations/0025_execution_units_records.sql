-- execution (Phase 7, #175; plan "Routing execution per part", ADR-0031): every part tracked through
-- the routing from the device's cycle facts. Derived and rebuilt from facts like alarm occurrences
-- (a reordered or late fact rebuilds its unit); only the scrap coding is a user's write. Ids of other
-- modules (orders, equipment) are kept by value (ADR-0016).
CREATE SCHEMA execution;
GRANT USAGE ON SCHEMA execution TO mes_app;

-- A unit: one part of one simulator run, keyed (device epoch, partId). partId restarts with the
-- simulator, so a serial is unique only within an epoch (Phase 8's genealogy owns serial identity).
CREATE TABLE execution.unit (
  epoch BIGINT NOT NULL,
  part_id BIGINT NOT NULL CHECK (part_id >= 1),
  -- Set by the end of OP10 (also for a part scrapped there); WSH-01 reads none.
  serial TEXT,
  product TEXT NOT NULL,
  -- The job its OP10 cycle belongs to (the latest `started` fact below the cycle on its CNC), and
  -- that job's order; null while the OP10 cycle or the job's `started` fact is missing.
  order_id TEXT,
  command_id TEXT,
  -- `lost`: in WIP when its device run ended (ADR-0029 "Simulator restart").
  status TEXT NOT NULL CHECK (status IN ('wip', 'packed', 'scrapped', 'lost')),
  -- Where a unit in WIP is by its records: `after:OPxx` (in the buffer, on a Blocked machine or in
  -- the next machine's cycle: no fact tells them apart), `rework:OP30` (sent back by the leak test),
  -- `done` once terminal.
  position TEXT NOT NULL,
  -- Its last record's plant time, and when it reached `packed` or `scrapped`.
  last_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  -- A routing break not proven yet: a record where another operation was expected (later in the
  -- routing: `missing-predecessor`; earlier: `repeated`), the expected operation and that record's
  -- time. A violation once every machine of that operation is final through that time (a fact
  -- still on its way could explain it).
  suspect TEXT CHECK (suspect IN ('missing-predecessor', 'repeated')),
  suspect_operation TEXT,
  suspect_before TIMESTAMPTZ,
  -- A routing violation found (also an incident): `missing-predecessor`, `repeated`, or
  -- `after-terminal` (a record after the unit was packed or scrapped, proven at once).
  violation TEXT CHECK (violation IN ('missing-predecessor', 'repeated', 'after-terminal')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (epoch, part_id),
  CHECK ((status IN ('packed', 'scrapped')) = (terminal_at IS NOT NULL)),
  CHECK ((suspect IS NULL) = (suspect_operation IS NULL)),
  CHECK ((suspect IS NULL) = (suspect_before IS NULL))
);
CREATE INDEX unit_order ON execution.unit (order_id, status);
CREATE INDEX unit_suspect ON execution.unit (epoch) WHERE suspect IS NOT NULL;

-- One record per cycle fact of a unit: (unit, operation, pass) with the machine, the cycle's
-- completion time (its `sourceTime`; cycle facts carry no start, so none is invented), result and
-- reason. Keyed by the fact, so a reordered fact that renumbers a pass updates its record.
CREATE TABLE execution.operation_record (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  operation TEXT NOT NULL CHECK (operation ~ '^OP[0-9]{2}$'),
  -- 1, or 2 at OP30 and OP40 after a leak-test failure sent the unit back.
  pass INTEGER NOT NULL CHECK (pass >= 1),
  completed_at TIMESTAMPTZ NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('good', 'scrap', 'rework')),
  reason TEXT,
  -- The unit's order (null while unattributed), kept here for the per-order quantities.
  order_id TEXT,
  PRIMARY KEY (equipment, epoch, seq),
  FOREIGN KEY (epoch, part_id) REFERENCES execution.unit (epoch, part_id)
);
CREATE INDEX operation_record_unit ON execution.operation_record (epoch, part_id);
CREATE INDEX operation_record_order ON execution.operation_record (order_id, operation);

-- A machine scrap (OP10 DIMENSIONAL, OP40 second LEAK) as a record a person codes with a detailed
-- reason (master_data.scrap_reason, by value). Kept, never deleted; the derived columns follow the
-- unit's rebuild, the coding columns are only written by a coding (version per record, audited in
-- identity.audit_log). Coding never changes a quantity.
CREATE TABLE execution.scrap_record (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  serial TEXT,
  order_id TEXT,
  operation TEXT NOT NULL,
  pass INTEGER NOT NULL CHECK (pass >= 1),
  scrapped_at TIMESTAMPTZ NOT NULL,
  -- The cycle fact's reason.
  machine_reason TEXT NOT NULL,
  coded_reason TEXT,
  comment TEXT,
  coded_by TEXT,
  coded_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (equipment, epoch, seq),
  CHECK ((coded_reason IS NULL) = (coded_at IS NULL))
);
CREATE INDEX scrap_record_order ON execution.scrap_record (order_id, id);
CREATE INDEX scrap_record_uncoded ON execution.scrap_record (id) WHERE coded_reason IS NULL;

-- Incidents of the execution module (routing violations), at most one open per key.
CREATE TABLE execution.execution_incident (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('routing-violation')),
  key TEXT NOT NULL,
  epoch BIGINT,
  part_id BIGINT,
  order_id TEXT,
  equipment TEXT,
  message TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  resolution TEXT,
  CHECK ((closed_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX execution_incident_open ON execution.execution_incident (key)
  WHERE closed_at IS NULL;

-- Units and records are derived and rebuilt (a unit's records are replaced); scrap records and
-- incidents are kept.
GRANT SELECT, INSERT, UPDATE, DELETE ON execution.unit, execution.operation_record TO mes_app;
GRANT SELECT, INSERT, UPDATE ON execution.scrap_record, execution.execution_incident TO mes_app;
