-- ingest (Phase 7, #174; UNS contract 1.3, ADR-0017 note): the command path's messages.
--
-- Job facts (`events/job`, `uns.events.job/1`) are device facts in the machine's shared sequence,
-- stored with the other device facts so they take part in the device stream's dedup and gap
-- checks, and so the equipment module's finality counts their numbers.
ALTER TABLE ingest.equipment_event DROP CONSTRAINT equipment_event_event_type_check;
ALTER TABLE ingest.equipment_event
  ADD CONSTRAINT equipment_event_event_type_check
  CHECK (event_type IN ('state', 'cycle', 'alarm', 'job'));
-- The orders module reads the job facts of a command id.
CREATE INDEX equipment_event_job_command ON ingest.equipment_event
  ((payload -> 'value' ->> 'commandId'), equipment, epoch)
  WHERE event_type = 'job';

-- The gateway's answers (`cmd-res/load-order`, `uns.cmd-res/1`): topic-scoped streams (the
-- gateway's counter per topic), deduplicated by the stream's cursor like telemetry. Several per
-- command id are normal (redeliveries, resends, `unknown` then the settled answer); the orders
-- module reads them with ADR-0029's precedence. Kept whole in `payload`.
CREATE TABLE ingest.command_result (
  arrival BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic TEXT NOT NULL,
  equipment TEXT NOT NULL,
  -- The gateway's epoch and its sequence number on the topic.
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  command_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  device_epoch BIGINT NOT NULL,
  -- The expiresAt of the delivery the result answers (wall time).
  expires_at TIMESTAMPTZ NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'duplicate', 'rejected', 'expired', 'unknown')),
  responded_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  UNIQUE (topic, epoch, seq)
);
CREATE INDEX command_result_command ON ingest.command_result (command_id, device_epoch);

GRANT SELECT, INSERT, UPDATE, DELETE ON ingest.command_result TO mes_app;
