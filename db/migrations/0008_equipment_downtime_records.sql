-- equipment (Phase 5, #119): downtime records, derived from the state intervals and rebuilt with
-- them (ADR-0018, ADR-0021 "Automatic classification"). One record per availability-loss interval
-- per scheduled shift bucket: Down, Setup, Idle, Starved, Blocked, and Stopped once the whole
-- interval reaches the micro-stop threshold (config/plant/oee.yaml). Micro-stops, planned states
-- (PlannedStop, Maintenance, Off) and the no-shift bucket make no record. Setup, Down and
-- Maintenance carry on across a shift end, so one interval can make a record in each bucket.
CREATE TABLE equipment.downtime_record (
  equipment TEXT NOT NULL,
  -- The device epoch (ADR-0015), as in equipment_state_interval.
  epoch BIGINT NOT NULL,
  -- The later of the interval's start and its shift bucket's start: keyed by this, the records of
  -- one interval in two buckets never collide.
  start_time TIMESTAMPTZ NOT NULL,
  -- Null while the interval is open and this is its last bucket; otherwise the interval's end or
  -- the bucket's end, whichever is first.
  end_time TIMESTAMPTZ,
  -- The interval the record was cut from, and its shift bucket ('<shiftDate>/<shiftId>').
  interval_start TIMESTAMPTZ NOT NULL,
  shift_key TEXT NOT NULL,
  state TEXT NOT NULL,
  cause TEXT,
  -- master_data.reason_code id from the auto-classification rules; UNCODED when none matched
  -- (no foreign key: modules own their schemas, ADR-0016).
  auto_reason TEXT NOT NULL,
  -- Open, or some of its pieces may still change (#113): it ends after its machine's "final
  -- through" time. Cleared together with the pieces' flags.
  provisional BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time IS NULL OR end_time > start_time),
  CHECK (interval_start <= start_time),
  CHECK (end_time IS NOT NULL OR provisional),
  CHECK (shift_key <> 'no-shift'),
  CHECK (state IN ('Stopped', 'Down', 'Setup', 'Idle', 'Starved', 'Blocked')),
  PRIMARY KEY (equipment, epoch, start_time)
);
-- Records of one equipment in a time range (#120: downtime list and Pareto). A record lies inside
-- one shift bucket, so readers bound start_time from below by the longest bucket.
CREATE INDEX downtime_record_range ON equipment.downtime_record (equipment, start_time);
-- The coding screen lists UNCODED records first (#120, #121).
CREATE INDEX downtime_record_uncoded ON equipment.downtime_record (start_time)
  WHERE auto_reason = 'UNCODED';

-- The micro-stop threshold the stored records were derived with: catch-up rederives an
-- (equipment, epoch) whose threshold differs, including every one stored before #119 (null).
ALTER TABLE equipment.interval_source ADD COLUMN downtime_threshold_ms BIGINT;
