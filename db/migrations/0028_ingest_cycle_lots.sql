-- ingest (Phase 8, #197, ADR-0033): cycle facts carry the lots the machine consumed for the part
-- (UNS contract 1.4, `value.lots`, optional). Genealogy's forward query of a lot during catch-up
-- reads the cycles that consumed it (`Ingest.cycleFacts({ epoch, lot })`) by containment,
-- `payload -> 'value' -> 'lots' @> '[{"lot": …}]'`, which this expression index serves.
-- Payloads without `lots` (older cycles, WSH-01) index nothing.
CREATE INDEX equipment_event_cycle_lots ON ingest.equipment_event
  USING gin ((payload -> 'value' -> 'lots') jsonb_path_ops)
  WHERE event_type = 'cycle';
