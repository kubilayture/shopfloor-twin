-- master-data (Phase 5, #119): the downtime reason tree, seeded from config/plant/reasons.yaml.
-- A reason names a cause; whether a downtime is availability loss (own or external) or a
-- micro-stop follows from its state and length (ADR-0021), so a reason has no loss category.
CREATE TABLE master_data.reason_code (
  -- The path in the tree: BREAKDOWN/SPINDLE-OVERLOAD. UNCODED is the reason no rule gives.
  id TEXT PRIMARY KEY,
  -- The path before the last '/', null at the top of the tree.
  parent_id TEXT REFERENCES master_data.reason_code (id),
  name TEXT NOT NULL,
  -- Order in reasons.yaml: a parent always comes before its children.
  position INTEGER NOT NULL,
  -- False once the configuration no longer lists it: kept, because recorded downtime (and, from
  -- #121, operator coding) may name it.
  active BOOLEAN NOT NULL DEFAULT true,
  CHECK (
    (parent_id IS NULL AND position('/' IN id) = 0)
    OR (parent_id IS NOT NULL AND id = parent_id || '/' || split_part(id, '/', -1))
  )
);
