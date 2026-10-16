-- master-data (Phase 6, #141): alarm definitions and operator positions, seeded from
-- config/plant/alarms.yaml (ADR-0024). The alarms module reads them through master-data's
-- interface. Rows the configuration no longer lists stay, inactive: occurrences may name them.

-- An operator position: until operators log in (Phase 7), a configured set of work centers. The
-- plant total is reported beside the positions, so `plant` is not a position id.
CREATE TABLE master_data.alarm_position (
  id TEXT PRIMARY KEY CHECK (id <> 'plant'),
  name TEXT NOT NULL,
  -- Order in alarms.yaml, for screens.
  position INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

-- Which position each work center belongs to: at most one (the cross-check in plant-config
-- requires exactly one per work center). Rewritten on every seed.
CREATE TABLE master_data.alarm_position_work_center (
  work_center_id TEXT PRIMARY KEY REFERENCES master_data.work_center (id),
  position_id TEXT NOT NULL REFERENCES master_data.alarm_position (id)
);

-- One alarm point per (equipment, code): its priority (from here, not from the wire severity),
-- operator text and the optional consequence and response.
CREATE TABLE master_data.alarm_definition (
  equipment_id TEXT NOT NULL REFERENCES master_data.equipment (id),
  code TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  text TEXT NOT NULL,
  consequence TEXT,
  response TEXT,
  -- Order in alarms.yaml.
  position INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (equipment_id, code)
);
