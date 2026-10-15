-- equipment (Phase 4, #96): state intervals built from ingest's state facts (plan "Equipment
-- intervals"). An interval runs from one state fact (or the anchor) to the next fact of the same
-- equipment and device epoch, by seq, on simulation time. It is stored cut into pieces, each inside
-- one UTC hour and one shift bucket, the basis of OEE (Phase 5). The open interval is stored up to
-- the plant watermark, flagged provisional, and replaced when the next fact arrives (ADR-0018).
CREATE TABLE equipment.equipment_state_interval (
  equipment TEXT NOT NULL,
  -- The device epoch (ADR-0015): intervals never cross a restart, and time may go back under a
  -- new epoch, so every key and comparison includes it.
  epoch BIGINT NOT NULL,
  -- The piece: [start_time, end_time), simulation time.
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  cause TEXT,
  -- The UTC hour the piece lies in (Istanbul has no DST, so local hours share its boundaries).
  hour TIMESTAMPTZ NOT NULL,
  -- The shift bucket, as the simulator's ground truth keys it: '<shiftDate>/<shiftId>' or 'no-shift'.
  shift_key TEXT NOT NULL,
  -- Part of the open interval, closed at the plant watermark for now: replaced when the next
  -- fact arrives. A newer epoch closes it for good at the old epoch's last watermark.
  provisional BOOLEAN NOT NULL,
  -- The whole interval the piece was cut from starts here, opened by the fact with this seq
  -- (null: opened by the anchor, a retained message or snapshot).
  interval_start TIMESTAMPTZ NOT NULL,
  start_seq BIGINT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  CHECK (interval_start <= start_time),
  CHECK (hour = date_trunc('hour', start_time, 'UTC')),
  CHECK (end_time <= hour + INTERVAL '1 hour'),
  -- Pieces of one (equipment, epoch) never overlap, so a piece's start identifies it.
  PRIMARY KEY (equipment, epoch, start_time)
);
SELECT create_hypertable(
  'equipment.equipment_state_interval',
  by_range('start_time', INTERVAL '7 days')
);
-- Intervals of one equipment in a time range (#97: timelines), across epochs.
CREATE INDEX equipment_state_interval_range
  ON equipment.equipment_state_interval (equipment, start_time DESC);
-- Totals per shift bucket (#97, Phase 5 OEE).
CREATE INDEX equipment_state_interval_shift
  ON equipment.equipment_state_interval (shift_key, equipment);

-- What the stored intervals of each (equipment, epoch) were computed from: the number of state
-- facts and the last one's seq, the anchor used, and whether a newer epoch has closed it. At
-- start-up the module compares this with ingest's tables and recomputes what differs, so a missed
-- notice (ADR-0017) is caught up from the tables.
CREATE TABLE equipment.interval_source (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  state_facts BIGINT NOT NULL,
  last_seq BIGINT,
  -- ingest.state_anchor.arrival of the (equipment, epoch) anchor known then, if any.
  anchor_arrival BIGINT,
  closed BOOLEAN NOT NULL,
  -- Some fact was earlier than the one before it (by seq) and was moved up to that time: such an
  -- (equipment, epoch) is always recomputed in full.
  clamped BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (equipment, epoch)
);
