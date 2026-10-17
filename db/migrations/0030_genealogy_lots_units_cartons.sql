-- genealogy (Phase 8, #199; plan "Genealogy", ADR-0034): lots imported from the ERP's lot list,
-- every unit with its serial, the lots each cycle consumed for it, cartons formed by the packing
-- rule, and the module's incidents. Everything but the lots is derived from the cycle facts and the
-- execution module's units and rebuilt per unit (a reordered or late fact rebuilds, never patches).
-- Ids of other modules (units, orders, equipment) are kept by value (ADR-0016).
CREATE SCHEMA genealogy;
GRANT USAGE ON SCHEMA genealogy TO mes_app;

-- A lot as the ERP lists it (`GET /api/v1/lots`), upserted by id on every import; a lot no longer
-- listed is kept as `retired`, never deleted.
CREATE TABLE genealogy.material_lot (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  material TEXT NOT NULL,
  -- Quantity received, as listed.
  quantity BIGINT NOT NULL CHECK (quantity >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  -- The ERP feed the lot list belonged to when the lot was last imported.
  feed_id TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- The trace search by id prefix: a range in byte order (`id COLLATE "C" >= q AND < q's upper
-- bound`), as on serials, orders and cartons below.
CREATE INDEX material_lot_prefix ON genealogy.material_lot ((id COLLATE "C"));

-- One row per unit (device epoch, partId) as the execution module keys it (ADR-0031), with its
-- serial (not unique: the simulator's counter restarts per run, ADR-0034), product, order and
-- status as execution has them, and its carton. Rebuilt with the unit.
CREATE TABLE genealogy.serial_unit (
  epoch BIGINT NOT NULL,
  part_id BIGINT NOT NULL CHECK (part_id >= 1),
  serial TEXT,
  product TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('wip', 'packed', 'scrapped', 'lost')),
  carton_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (epoch, part_id)
);
CREATE INDEX serial_unit_serial ON genealogy.serial_unit (serial, epoch) WHERE serial IS NOT NULL;
CREATE INDEX serial_unit_order ON genealogy.serial_unit (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX serial_unit_carton ON genealogy.serial_unit (carton_id) WHERE carton_id IS NOT NULL;
CREATE INDEX serial_unit_serial_prefix ON genealogy.serial_unit ((serial COLLATE "C"))
  WHERE serial IS NOT NULL;
CREATE INDEX serial_unit_order_prefix ON genealogy.serial_unit ((order_id COLLATE "C"))
  WHERE order_id IS NOT NULL;

-- One row per operation record of a unit (execution's records, keyed by the cycle fact) with what
-- the fact reported for traceability: whether it carried `lots` at all (false: not reported, as
-- WSH-01 or a gateway before UNS 1.4; [] reported is true with no link), the device operator
-- (`operator_reported` false: no field; true with null: reported none) and the measurement.
CREATE TABLE genealogy.unit_record (
  equipment TEXT NOT NULL,
  epoch BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  operation TEXT NOT NULL,
  pass INTEGER NOT NULL CHECK (pass >= 1),
  completed_at TIMESTAMPTZ NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('good', 'scrap', 'rework')),
  reason TEXT,
  lots_reported BOOLEAN NOT NULL,
  operator TEXT,
  operator_reported BOOLEAN NOT NULL,
  measurement JSONB,
  PRIMARY KEY (equipment, epoch, seq),
  CHECK (operator_reported OR operator IS NULL),
  FOREIGN KEY (epoch, part_id) REFERENCES genealogy.serial_unit (epoch, part_id)
);
CREATE INDEX unit_record_unit ON genealogy.unit_record (epoch, part_id);
-- An order's packing cycles (cartons) by the unit.
CREATE INDEX unit_record_operation ON genealogy.unit_record (operation, result);

-- Typed edges of the genealogy tree: `lot-unit` (a lot reference of a cycle fact: the lot, its
-- material as reported, the unit, operation, pass, machine, the fact's (equipment, epoch, seq), its
-- place in the fact's list and the cycle's time) and `unit-carton` (a unit placed in a carton, its
-- place there and the pack's time).
CREATE TABLE genealogy.genealogy_link (
  kind TEXT NOT NULL CHECK (kind IN ('lot-unit', 'unit-carton')),
  epoch BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  lot TEXT,
  material TEXT,
  operation TEXT,
  pass INTEGER,
  equipment TEXT,
  seq BIGINT,
  carton_id TEXT,
  CHECK (
    (kind = 'lot-unit' AND lot IS NOT NULL AND material IS NOT NULL AND operation IS NOT NULL
      AND pass IS NOT NULL AND equipment IS NOT NULL AND seq IS NOT NULL AND carton_id IS NULL)
    OR (kind = 'unit-carton' AND carton_id IS NOT NULL AND lot IS NULL AND material IS NULL
      AND operation IS NULL AND pass IS NULL AND equipment IS NULL AND seq IS NULL)
  )
);
CREATE UNIQUE INDEX genealogy_link_fact ON genealogy.genealogy_link (equipment, epoch, seq, position)
  WHERE kind = 'lot-unit';
CREATE UNIQUE INDEX genealogy_link_unit_carton ON genealogy.genealogy_link (epoch, part_id)
  WHERE kind = 'unit-carton';
-- One index per edge direction: forward (a lot's units), backward (a unit's lots) and a carton's
-- members.
CREATE INDEX genealogy_link_lot ON genealogy.genealogy_link (lot, epoch, part_id)
  WHERE kind = 'lot-unit';
CREATE INDEX genealogy_link_unit ON genealogy.genealogy_link (epoch, part_id);
CREATE INDEX genealogy_link_carton ON genealogy.genealogy_link (carton_id, position)
  WHERE kind = 'unit-carton';

-- Cartons per order by the packing rule (`trace-core`, `config/plant/packing.yaml`): placed only
-- on final data; a full carton closes at its last member's time, an order's last carton at the
-- order's completion.
CREATE TABLE genealogy.carton (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  product TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 1),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  members INTEGER NOT NULL CHECK (members BETWEEN 0 AND capacity),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id, number),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX carton_open ON genealogy.carton (order_id) WHERE status = 'open';
CREATE INDEX carton_prefix ON genealogy.carton ((id COLLATE "C"));

-- Incidents of the module, at most one open per key: `unknown-lot` (a fact names a lot the MES has
-- not imported; closed when an import lists it), `serial-reused` (one per pair of device epochs
-- sharing a serial) and `material-mismatch` (a lot of a material the BOM doesn't list for that
-- operation and pass); `rebuild-failed` (a unit whose rebuild failed on its own, its rows kept
-- as they were until it is announced again).
CREATE TABLE genealogy.genealogy_incident (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN ('unknown-lot', 'serial-reused', 'material-mismatch', 'rebuild-failed')
  ),
  key TEXT NOT NULL,
  lot TEXT,
  epoch BIGINT,
  part_id BIGINT,
  equipment TEXT,
  message TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  resolution TEXT,
  CHECK ((closed_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX genealogy_incident_open ON genealogy.genealogy_incident (key)
  WHERE closed_at IS NULL;

-- Derived tables are rebuilt (rows replaced); lots and incidents are kept, never deleted (the
-- incidents as execution's are, review L7: the plan's grant list counted them derived).
GRANT SELECT, INSERT, UPDATE, DELETE ON genealogy.serial_unit, genealogy.unit_record,
  genealogy.genealogy_link, genealogy.carton TO mes_app;
GRANT SELECT, INSERT, UPDATE ON genealogy.material_lot, genealogy.genealogy_incident TO mes_app;
