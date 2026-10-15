-- ingest (Phase 4, #95): every UNS message the MES receives, stored idempotently (ADR-0015, plan
-- "Identity, dedup and epochs" and "Ingest"). Facts go into two hypertables on simulation time;
-- duplicates are removed by their unique keys (INSERT ... ON CONFLICT DO NOTHING) and by the cursor.

-- Device facts (scope device): state changes, cycles and alarm transitions, one stream per equipment.
CREATE TABLE ingest.equipment_event (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  -- Simulation time of the fact (the device's sourceTime): all MES accounting uses this.
  source_time TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('state', 'cycle', 'alarm')),
  topic TEXT NOT NULL,
  -- Set for state events only.
  state TEXT,
  cause TEXT,
  quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
  source_protocol TEXT NOT NULL,
  -- Gateway wall time when it read the fact (receivedAt), and MES wall time when it was stored.
  received_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The full validated message.
  payload JSONB NOT NULL,
  CHECK ((event_type = 'state') = (state IS NOT NULL)),
  -- TimescaleDB: a unique key on a hypertable must include its time column.
  UNIQUE (equipment, epoch, seq, source_time)
);
SELECT create_hypertable('ingest.equipment_event', by_range('source_time', INTERVAL '1 day'));

-- Sampled process values (scope topic: a gateway counter per topic).
CREATE TABLE ingest.telemetry_sample (
  topic TEXT NOT NULL,
  equipment TEXT NOT NULL,
  name TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  source_time TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
  source_protocol TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  UNIQUE (topic, epoch, seq, source_time)
);
SELECT create_hypertable('ingest.telemetry_sample', by_range('source_time', INTERVAL '1 day'));
CREATE INDEX telemetry_sample_series ON ingest.telemetry_sample (equipment, name, source_time DESC);

-- Durable dedup and gap state per stream (device:{equipment} or topic:{topic}), like Deduplicator:
-- the current epoch and the sequence ranges seen, as [[from, to], ...]. `reported` holds the gaps
-- already recorded as incidents; a late message may still fill them.
CREATE TABLE ingest.source_cursor (
  stream TEXT PRIMARY KEY,
  epoch BIGINT NOT NULL,
  seen JSONB NOT NULL,
  reported JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retained deliveries and snapshots of state/current: not facts, but the current state, which
-- the equipment module uses when it knows no state for (equipment, device epoch) yet. A snapshot
-- carries the gateway's epoch, so its device epoch is set when the next device fact of that
-- equipment arrives. The first anchor to arrive per (equipment, device_epoch) wins.
CREATE TABLE ingest.state_anchor (
  arrival BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  equipment TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'snapshot')),
  retained BOOLEAN NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('device', 'topic')),
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  source_time TIMESTAMPTZ NOT NULL,
  device_epoch BIGINT,
  state TEXT NOT NULL,
  cause TEXT,
  quality TEXT NOT NULL CHECK (quality IN ('good', 'uncertain', 'bad')),
  received_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  -- The same retained message is delivered again on every subscribe.
  UNIQUE (equipment, scope, epoch, seq)
);
CREATE INDEX state_anchor_epoch ON ingest.state_anchor (equipment, device_epoch, arrival);

-- Data-quality incidents: sequence gaps the MES found (origin mes), still open after the grace
-- period, and the gateway's own _sys/.../incidents messages (origin gateway).
CREATE TABLE ingest.data_quality_incident (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('mes', 'gateway')),
  type TEXT NOT NULL,
  stream TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  -- mes: the missing numbers; gateway: the incident message's own seq (from = to).
  seq_from BIGINT NOT NULL,
  seq_to BIGINT NOT NULL,
  equipment TEXT,
  -- mes: numbers still missing (a late fill lowers it); gateway: as reported (may be null).
  lost INTEGER,
  message TEXT NOT NULL,
  -- gateway: the incident's sourceTime.
  source_time TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL,
  -- mes gaps only: closed when filled late, or when a new epoch ends the stream.
  closed_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('filled', 'epoch-ended')),
  payload JSONB,
  UNIQUE (origin, stream, epoch, seq_from)
);

-- Latest status of each component (_sys/{component}/{instance}/status): the latest delivery wins.
CREATE TABLE ingest.component_status (
  component TEXT NOT NULL,
  instance TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  started_at TIMESTAMPTZ NOT NULL,
  version TEXT NOT NULL,
  source_time TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  PRIMARY KEY (component, instance)
);

-- Messages that failed validation or were refused (stale epoch): never dropped silently.
CREATE TABLE ingest.rejected_message (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic TEXT NOT NULL,
  -- The payload as received, decoded as UTF-8.
  payload TEXT NOT NULL,
  retained BOOLEAN NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('invalid-json', 'invalid-payload', 'topic-mismatch', 'unexpected-topic', 'stale-epoch')
  ),
  detail TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
