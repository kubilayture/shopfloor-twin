-- shifts (Phase 6, #163, ADR-0025 "Note: content at final"): the report's `content` counter at
-- the moment it became final, stored with `final_at` under the instance's row lock. A client sees
-- how often the content changed after final as `content_revision - content_at_final`, instead of
-- working it out from the note audit, which compared the MES's clock (`final_at`) with the
-- database's `clock_timestamp()` (the audit's `at`).
ALTER TABLE shifts.shift_instance ADD COLUMN content_at_final BIGINT;

-- Reports already final: the best the stored rows can tell is the note writes the audit dates
-- before `final_at` (the rule the web used until #163), never more than the counter itself.
-- Recodes and acknowledgements count only after final, so they never belong to the baseline.
UPDATE shifts.shift_instance AS instance
SET content_at_final = LEAST(
  instance.content_revision,
  (
    SELECT count(*)
    FROM shifts.handover_audit AS audit
    WHERE audit.epoch = instance.epoch
      AND audit.shift_key = instance.shift_key
      AND audit.at < instance.final_at
  )
)
WHERE instance.status = 'final';

-- Set exactly when final (as `final_at`), and never above the counter, which only rises.
ALTER TABLE shifts.shift_instance
  ADD CONSTRAINT shift_instance_content_at_final_check CHECK (
    (status = 'final') = (content_at_final IS NOT NULL)
    AND (content_at_final IS NULL OR content_at_final BETWEEN 0 AND content_revision)
  );
