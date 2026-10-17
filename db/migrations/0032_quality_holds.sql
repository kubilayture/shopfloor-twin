-- quality, holds (Phase 8, #201; plan "Quality holds", ADR-0035): a hold on a lot, a serial, a
-- carton or an order, its append-only transitions and comments, its scope as last derived from the
-- genealogy, and `held-material-consumed` incidents. The scope is derived from the subject through
-- the genealogy and grows with facts; `hold_unit` is a derived copy for reads, never what the
-- close guard reads (plan review round 1, HIGH 1). Ids of other modules (units, lots, cartons,
-- orders, equipment) are kept by value (ADR-0016). Also: the orders module's ERP outbox takes the
-- kind `quality-notification` (plan review round 1, MEDIUM 5; ADR-0028 amendment).

-- A hold's current state. `id` is a UUID, unique forever: the ERP's store outlives the MES's
-- database (ADR-0028 amendment). `opened_plant_at` is the plant clock (the newest epoch's
-- watermark) when it opened (round 1, MEDIUM 9); null when the MES had no plant clock yet, then
-- every consumption of a held lot counts as after the opening. Never deleted.
CREATE TABLE quality.hold (
  id UUID PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('lot', 'serial', 'carton', 'order')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('open', 'released', 'rejected')),
  reason TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  opened_plant_at TIMESTAMPTZ,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decided_plant_at TIMESTAMPTZ,
  decision_reason TEXT,
  -- Transitions and comments so far (`hold_transition.n` of the latest).
  transitions INTEGER NOT NULL DEFAULT 1 CHECK (transitions >= 1),
  -- Rises with every transition and comment (409 hold-stale).
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'open') = (decided_by IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CHECK ((decided_by IS NULL) = (decision_reason IS NULL))
);
CREATE INDEX hold_subject ON quality.hold (subject_kind, subject_id);
CREATE INDEX hold_state ON quality.hold (state, opened_at);

-- Every transition and comment of a hold, numbered from 1 (`opened`): append-only, a trigger
-- refuses UPDATE, DELETE and TRUNCATE to every role. `scope` holds the counts a notification
-- carried (units, cartons, orders, asOf, final); null for a comment, which is not notified.
CREATE TABLE quality.hold_transition (
  hold_id UUID NOT NULL REFERENCES quality.hold (id),
  n INTEGER NOT NULL CHECK (n >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('opened', 'commented', 'released', 'rejected')),
  reason TEXT,
  comment TEXT,
  actor TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  plant_at TIMESTAMPTZ,
  scope JSONB,
  PRIMARY KEY (hold_id, n),
  CHECK ((kind = 'opened') = (n = 1)),
  CHECK ((kind = 'commented') = (reason IS NULL)),
  CHECK ((kind = 'commented') = (scope IS NULL)),
  CHECK (kind <> 'commented' OR comment IS NOT NULL)
);

CREATE FUNCTION quality.hold_transition_append_only() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'quality.hold_transition is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER hold_transition_no_update_delete
  BEFORE UPDATE OR DELETE ON quality.hold_transition
  FOR EACH ROW EXECUTE FUNCTION quality.hold_transition_append_only();
CREATE TRIGGER hold_transition_no_truncate
  BEFORE TRUNCATE ON quality.hold_transition
  FOR EACH STATEMENT EXECUTE FUNCTION quality.hold_transition_append_only();

-- A hold's scope as last derived (units with their order and carton then), for reads: rebuilt
-- while the hold is open or rejected, kept as it stood once released. `joined_at` (wall time) is
-- when the unit first joined: after the opening for a unit whose fact arrived late or that consumed
-- a held lot later.
CREATE TABLE quality.hold_unit (
  hold_id UUID NOT NULL REFERENCES quality.hold (id),
  epoch BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  serial TEXT,
  order_id TEXT,
  carton_id TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (hold_id, epoch, part_id)
);
CREATE INDEX hold_unit_unit ON quality.hold_unit (epoch, part_id);

-- `held-material-consumed`: a lot under a hold consumed after the hold opened (and before a
-- release), by the fact (equipment, epoch, seq) and the lot. The MES sees it but can't stop it: a
-- hold never commands a machine. Kept, never deleted; one per fact, lot and hold.
CREATE TABLE quality.hold_incident (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('held-material-consumed')),
  hold_id UUID NOT NULL REFERENCES quality.hold (id),
  lot TEXT NOT NULL,
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  operation TEXT,
  pass INTEGER,
  -- Plant time of the consumption (the cycle's completion).
  consumed_at TIMESTAMPTZ NOT NULL,
  message TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (hold_id, equipment, epoch, seq, lot)
);
CREATE INDEX hold_incident_hold ON quality.hold_incident (hold_id, id);

-- Holds are kept (state changes in place); transitions are append-only; the scope copy is derived
-- and rebuilt; incidents are kept.
GRANT SELECT, INSERT, UPDATE ON quality.hold TO mes_app;
GRANT SELECT, INSERT ON quality.hold_transition TO mes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON quality.hold_unit TO mes_app;
GRANT SELECT, INSERT ON quality.hold_incident TO mes_app;

-- orders' ERP outbox (ADR-0028): quality notifications (#201) are messages about a hold, not an
-- order: `order_id` and `revision` are null only for them, and `subject_kind`/`subject_id` name
-- the hold. One outbox, one publisher and one backoff for every ERP message.
ALTER TABLE orders.erp_message_log DROP CONSTRAINT erp_message_log_kind_check;
ALTER TABLE orders.erp_message_log
  ADD CONSTRAINT erp_message_log_kind_check
  CHECK (kind IN ('feed-entry', 'status', 'confirmation', 'quality-notification'));
ALTER TABLE orders.erp_message_log ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE orders.erp_message_log ALTER COLUMN revision DROP NOT NULL;
ALTER TABLE orders.erp_message_log ADD COLUMN subject_kind TEXT CHECK (subject_kind IN ('hold'));
ALTER TABLE orders.erp_message_log ADD COLUMN subject_id TEXT;
ALTER TABLE orders.erp_message_log
  ADD CONSTRAINT erp_message_log_order_kinds
  CHECK (
    kind = 'quality-notification'
    OR (order_id IS NOT NULL AND revision IS NOT NULL AND subject_kind IS NULL)
  );
ALTER TABLE orders.erp_message_log
  ADD CONSTRAINT erp_message_log_quality_notification
  CHECK (
    kind <> 'quality-notification'
    OR (
      direction = 'out' AND order_id IS NULL AND revision IS NULL
      AND subject_kind = 'hold' AND subject_id IS NOT NULL
    )
  );
CREATE INDEX erp_message_log_subject ON orders.erp_message_log (subject_kind, subject_id, id)
  WHERE subject_kind IS NOT NULL;
