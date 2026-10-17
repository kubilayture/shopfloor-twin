-- master-data (Phase 7, #175; plan "Scrap records", ADR-0031): the scrap reason tree, seeded from
-- config/plant/scrap.yaml. A machine scraps with a coarse reason (DIMENSIONAL, LEAK), a top node of
-- the tree; an operator or quality user codes the record with that node or one below it.
CREATE TABLE master_data.scrap_reason (
  -- The path in the tree: LEAK/POROSITY.
  id TEXT PRIMARY KEY,
  -- The path before the last '/', null at the top of the tree.
  parent_id TEXT REFERENCES master_data.scrap_reason (id),
  name TEXT NOT NULL,
  -- Order in scrap.yaml: a parent always comes before its children.
  position INTEGER NOT NULL,
  -- False once the configuration no longer lists it: kept, because a coded record may name it.
  active BOOLEAN NOT NULL DEFAULT true,
  CHECK (
    (parent_id IS NULL AND position('/' IN id) = 0)
    OR (parent_id IS NOT NULL AND id = parent_id || '/' || split_part(id, '/', -1))
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON master_data.scrap_reason TO mes_app;
