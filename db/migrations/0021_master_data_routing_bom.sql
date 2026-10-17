-- master_data (Phase 7, #174): each product's routing and bill of materials, seeded from
-- config/plant (products.yaml: the operations, the blank, components and rework components;
-- plant.yaml: the work center of the equipment that runs each operation). The ERP builds the same
-- from the same files (`routingAndBom` in @shopfloor/contracts/erp-api); the orders module refuses
-- an ERP order whose routing or BOM differs from these.
CREATE TABLE master_data.routing (
  product_id TEXT PRIMARY KEY REFERENCES master_data.product (id),
  -- Minutes of a changeover to this product (products.yaml `changeoverMinutes`), for the dispatch
  -- rule's estimate.
  changeover_minutes INTEGER NOT NULL CHECK (changeover_minutes >= 0)
);

CREATE TABLE master_data.routing_operation (
  product_id TEXT NOT NULL REFERENCES master_data.routing (product_id),
  operation TEXT NOT NULL CHECK (operation ~ '^OP[0-9]{2}$'),
  position INTEGER NOT NULL CHECK (position >= 0),
  work_center_id TEXT NOT NULL REFERENCES master_data.work_center (id),
  -- The ideal cycle of this product at this operation (products.yaml `idealCycleSeconds`), in ms.
  ideal_cycle_ms BIGINT NOT NULL CHECK (ideal_cycle_ms > 0),
  PRIMARY KEY (product_id, operation),
  UNIQUE (product_id, position)
);

CREATE TABLE master_data.bom_item (
  product_id TEXT NOT NULL REFERENCES master_data.routing (product_id),
  material TEXT NOT NULL,
  operation TEXT NOT NULL,
  quantity_per_unit INTEGER NOT NULL CHECK (quantity_per_unit >= 1),
  -- `standard`: every unit, first pass; `rework`: every rework pass of a unit.
  usage TEXT NOT NULL CHECK (usage IN ('standard', 'rework')),
  PRIMARY KEY (product_id, material, operation, usage),
  FOREIGN KEY (product_id, operation) REFERENCES master_data.routing_operation (product_id, operation)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON master_data.routing, master_data.routing_operation,
  master_data.bom_item TO mes_app;
