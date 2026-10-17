-- ingest (Phase 7, #175, ADR-0031): the execution module reads a unit's cycle facts by device epoch
-- and part id (`Ingest.cycleFacts`), across machines: a unit is keyed (device epoch, partId), and
-- partId is the simulator run's counter shared by every machine (ADR-0030).
CREATE INDEX equipment_event_cycle_part ON ingest.equipment_event
  (epoch, ((payload -> 'value' ->> 'partId')::bigint))
  WHERE event_type = 'cycle';
