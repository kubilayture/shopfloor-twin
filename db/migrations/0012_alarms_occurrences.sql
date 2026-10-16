-- alarms (Phase 6, #142, ADR-0024): alarm occurrences derived from the device's raise and clear
-- facts (ADR-0010), never edited: rebuilt from ingest's facts, anchors and resync snapshots. KPIs
-- are computed on read with alarm-core; nothing here stores a KPI.
CREATE SCHEMA IF NOT EXISTS alarms;

-- One occurrence per device raise, keyed (equipment, device epoch, raise seq): a device sequence
-- number never changes, so the key (the API id `{equipment}~{epoch}~{seq}`) is stable under
-- reordering, duplicates, rebuilds and restarts. Operator state (#143) is stored elsewhere by it.
CREATE TABLE alarms.alarm_occurrence (
  equipment TEXT NOT NULL,
  -- The device epoch (ADR-0015): occurrences never cross a restart.
  epoch BIGINT NOT NULL,
  -- The raise's device sequence number.
  seq BIGINT NOT NULL,
  code TEXT NOT NULL,
  -- The wire severity of the raise, 1-1000.
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 1000),
  -- From the point's definition (master data), or from the severity when it has none.
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  -- False for a code without a definition (another device, new firmware).
  defined BOOLEAN NOT NULL,
  -- 'fact': the raise fact itself; 'anchor': a retained alarm delivery whose fact is not stored
  -- (yet); the fact, if it arrives, has the same key and replaces it.
  source TEXT NOT NULL CHECK (source IN ('fact', 'anchor')),
  -- Simulation time of the raise.
  raised_at TIMESTAMPTZ NOT NULL,
  -- When it stopped being active, and why: the device's clear ('cleared'), a resync snapshot that
  -- showed the code inactive after the clear was lost ('lost'), the next raise of the same point
  -- ('superseded', a lost clear) or a newer epoch ('epoch-ended'). Null while active.
  ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('cleared', 'lost', 'superseded', 'epoch-ended')),
  -- The clear's seq, the snapshot's asOfSeq or the superseding raise's seq; null otherwise.
  end_seq BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= raised_at),
  PRIMARY KEY (equipment, epoch, seq)
);

-- The alarm list (newest first) and the KPI reads (per epoch, by raise time).
CREATE INDEX alarm_occurrence_raised ON alarms.alarm_occurrence (raised_at DESC);
CREATE INDEX alarm_occurrence_epoch_raised ON alarms.alarm_occurrence (epoch, raised_at);
-- Active occurrences.
CREATE INDEX alarm_occurrence_active ON alarms.alarm_occurrence (equipment, epoch)
WHERE ended_at IS NULL;

-- Per (equipment, device epoch): what the stored occurrences were derived from, for catch-up at
-- start-up (ingest's alarm fact count is compared with `facts`), and how far its alarm facts were
-- final when it was last written (`final_through`), so a fact found at start-up that changes an
-- hour final before it raises that hour's revision.
CREATE TABLE alarms.occurrence_source (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  -- Alarm facts of ingest the occurrences reflect.
  facts INTEGER NOT NULL CHECK (facts >= 0),
  -- The retained alarm deliveries used (ADR-0017 amendment): kept when they become stale later,
  -- because an anchor used while its epoch was the newest stays part of that epoch's history.
  anchors JSONB NOT NULL DEFAULT '[]',
  -- The latest resync snapshot of the epoch seen while it was not stale; applied once the device
  -- stream is settled up to its asOfSeq.
  snapshot JSONB,
  -- A newer epoch of the equipment exists: open occurrences ended at closed_at ('epoch-ended').
  closed BOOLEAN NOT NULL DEFAULT false,
  closed_at TIMESTAMPTZ,
  -- The latest sourceTime of a device fact with no open gap below it, when last written.
  final_through TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (equipment, epoch)
);

-- Revisions of final KPI hours (ADR-0024 "Revisions"): an hour of a scope ('plant',
-- 'position:<id>', 'equipment:<id>') is final once every equipment of the scope is final through
-- its end plus fleetingMs (or its epoch is closed); that is computed from final through, not
-- stored. A late fact (a gap filled after it was written off, a resync snapshot closing a lost
-- clear, a real clear replacing it) raises the revision of every final hour it can change, in
-- every scope that contains its equipment (floods are scope-wide). An hour without a row has
-- revision 0.
CREATE TABLE alarms.kpi_revision (
  scope TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  revised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (hour = date_trunc('hour', hour, 'UTC')),
  PRIMARY KEY (scope, epoch, hour)
);
