-- equipment (Phase 5, #113): interval finality. A stored piece is final once nothing that can
-- still arrive may change it: it ends at or before its equipment's "final through" (the latest
-- sourceTime of a device fact whose seq has no open gap below it), or its epoch is closed
-- (ADR-0018). This table remembers, per (equipment, epoch, UTC hour), when the hour became final
-- and how often it changed afterwards: a late fill of a gap already reported as an incident, or a
-- late fact of a closed epoch, raises the revision, so a consumer can tell a revised bucket from
-- an unchanged one.
CREATE TABLE equipment.bucket_finality (
  equipment TEXT NOT NULL,
  -- The device epoch (ADR-0015), as in equipment_state_interval.
  epoch BIGINT NOT NULL,
  -- The UTC hour, as equipment_state_interval.hour: a row exists once every piece in it is final.
  hour TIMESTAMPTZ NOT NULL,
  -- Wall time when the hour became final.
  final_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 0 when unchanged since it became final; raised by each later change.
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- Wall time of the latest revision, if any.
  revised_at TIMESTAMPTZ,
  -- ingest.data_quality_incident ids of the sequence gaps of this equipment's device stream whose
  -- time span overlaps the hour (no foreign key: modules own their schemas, ADR-0016).
  incident_ids BIGINT[] NOT NULL DEFAULT '{}',
  CHECK (hour = date_trunc('hour', hour, 'UTC')),
  PRIMARY KEY (equipment, epoch, hour)
);
