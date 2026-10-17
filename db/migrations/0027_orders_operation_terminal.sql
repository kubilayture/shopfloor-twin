-- orders (Phase 7, #177; plan "Operator terminal"): what the operator terminal records on an order
-- operation. An operator's start, pause (with a reason) and resume are activity intervals on the
-- operation: they record the operator's time, never the machine's (the CNC runs its queue). A
-- sign-off of the operation, allowed only once the MES has it complete (its final confirmation),
-- is what lets a supervisor close the order. Users are kept by value (identity.user_account ids,
-- no key across module schemas, ADR-0016).

-- Raised by every terminal write on the operation (start, pause, resume, sign-off); a write names
-- the version it read (409 urn:shopfloor:operation-stale otherwise). The sign-off, once given, is
-- kept.
ALTER TABLE orders.order_operation
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN signed_off_user_id BIGINT,
  ADD COLUMN signed_off_by TEXT,
  -- Wall time and plant time of the sign-off.
  ADD COLUMN signed_off_at TIMESTAMPTZ,
  ADD COLUMN signed_off_plant_at TIMESTAMPTZ,
  ADD CONSTRAINT order_operation_signed_off CHECK (
    (signed_off_at IS NULL) = (signed_off_by IS NULL)
    AND (signed_off_at IS NULL) = (signed_off_user_id IS NULL)
    AND (signed_off_at IS NULL) = (signed_off_plant_at IS NULL)
  );

-- One interval of an operator's activity on an order operation: `work` from a start or a resume,
-- `pause` (with its reason) from a pause. A transition closes the open interval and opens the
-- next in one transaction; the operation's sign-off, the end of the operator's crew row at the
-- work center (sign-off at the terminal, the session's end, the shift's end) close it too.
CREATE TABLE orders.operation_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  -- The operation's work center (a master_data.work_center id, by value).
  work_center TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('work', 'pause')),
  reason TEXT CHECK (reason ~ '^[a-z]+(-[a-z]+)*$'),
  comment TEXT CHECK (length(comment) <= 500),
  -- Wall time and plant time of the start and of the end.
  from_at TIMESTAMPTZ NOT NULL,
  from_plant_at TIMESTAMPTZ NOT NULL,
  to_at TIMESTAMPTZ,
  to_plant_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('paused', 'resumed', 'signed-off', 'crew-ended')),
  CHECK ((kind = 'pause') = (reason IS NOT NULL)),
  CHECK (comment IS NULL OR kind = 'pause'),
  CHECK ((to_at IS NULL) = (end_reason IS NULL)),
  CHECK ((to_at IS NULL) = (to_plant_at IS NULL)),
  CHECK (to_at IS NULL OR to_at >= from_at),
  FOREIGN KEY (order_id, operation) REFERENCES orders.order_operation (order_id, operation)
);
-- At most one open interval per operator and order operation.
CREATE UNIQUE INDEX operation_activity_open ON orders.operation_activity (user_id, order_id, operation)
  WHERE to_at IS NULL;
CREATE INDEX operation_activity_operation ON orders.operation_activity (order_id, operation, id);
-- The open intervals of a work center (the terminal) and of an operator (crew ends).
CREATE INDEX operation_activity_open_work_center ON orders.operation_activity (work_center)
  WHERE to_at IS NULL;

-- Intervals are closed, never deleted.
GRANT SELECT, INSERT, UPDATE ON orders.operation_activity TO mes_app;

-- shifts.crew_assignment (#169): a new sign-on of the same user at the same work center from another
-- terminal session ends the open row with `replaced`.
ALTER TABLE shifts.crew_assignment DROP CONSTRAINT crew_assignment_end_reason_check;
ALTER TABLE shifts.crew_assignment ADD CONSTRAINT crew_assignment_end_reason_check
  CHECK (end_reason IN ('sign-off', 'session-ended', 'shift-ended', 'replaced'));
