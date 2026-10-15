-- master-data (Phase 4): the ISA-95 equipment hierarchy, products and the shift pattern, seeded
-- from config/plant. Read by every other module through master-data's interface, never directly.
CREATE TABLE master_data.site (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  enterprise_name TEXT NOT NULL
);

CREATE TABLE master_data.area (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES master_data.site (id),
  name TEXT NOT NULL
);

CREATE TABLE master_data.work_center (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES master_data.area (id),
  name TEXT NOT NULL
);

CREATE TABLE master_data.equipment (
  id TEXT PRIMARY KEY,
  work_center_id TEXT NOT NULL REFERENCES master_data.work_center (id),
  name TEXT NOT NULL,
  operation TEXT NOT NULL,
  interface TEXT NOT NULL CHECK (interface IN ('opcua', 'modbus')),
  -- Position in the line (the order of plant.yaml), for screens.
  position INTEGER NOT NULL
);

CREATE TABLE master_data.product (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Per operation, e.g. {"OP10": 240}.
  ideal_cycle_seconds JSONB NOT NULL
);

CREATE TABLE master_data.shift_pattern (
  id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL,
  workdays TEXT[] NOT NULL,
  -- [{id, start, end, break?: {start, minutes}}], as in shifts.yaml.
  shifts JSONB NOT NULL
);
