-- ingest (Phase 6, #141, ADR-0017 amendment): what the device says about its alarms besides the
-- facts. Neither table takes part in dedup or gap checks; both are keyed by the device epoch.
--
-- Old epochs: a row whose device epoch is older than the newest epoch ingest knows for its
-- equipment (from any fact, state anchor, alarm anchor or alarm snapshot) is stored with
-- stale = true and never used; when a newer epoch arrives later, the older rows become stale then.

-- A retained alarm delivery: the device's own last fact for one code, with its true epoch, seq and
-- sourceTime. The highest seq per (equipment, epoch, code) wins.
CREATE TABLE ingest.alarm_anchor (
  equipment TEXT NOT NULL,
  -- The device epoch (the message's own epoch: alarms are scope device).
  epoch BIGINT NOT NULL,
  code TEXT NOT NULL,
  seq BIGINT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('active', 'cleared')),
  severity INTEGER NOT NULL,
  source_time TIMESTAMPTZ NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
  received_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  PRIMARY KEY (equipment, epoch, code)
);

-- The gateway's alarm snapshot on resync (uns.alarm-snapshot/1): the codes active at as_of_seq.
-- The highest as_of_seq per (equipment, device epoch) wins.
CREATE TABLE ingest.alarm_snapshot (
  equipment TEXT NOT NULL,
  device_epoch BIGINT NOT NULL,
  as_of_seq BIGINT NOT NULL,
  -- Active codes, sorted.
  active TEXT[] NOT NULL,
  -- The gateway's own identity (scope topic): kept for diagnosis, never used for ordering.
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  source_time TIMESTAMPTZ NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
  source_protocol TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  PRIMARY KEY (equipment, device_epoch)
);
