-- identity (Phase 7, #169, ADR-0027): one audit log. Every row of the three module audits is copied
-- into identity.audit_log (`legacy`, the names as typed, never a user id), the counts are checked,
-- and the two audits that identity.audit_log replaces are frozen. alarms.alarm_transition stays the
-- alarm module's transition log (system expiry and epoch ends are not user actions); from now on
-- an operator's transition is written to both.
--
-- How each module audit maps (the modules read their history back from identity.audit_log the same
-- way):
--   equipment.downtime_audit -> entity `downtime-coding-set` `{equipment}~{epoch}`, action
--     `downtime.code|clear|orphan`; before {codings}, after {recordId, from, to, version, codings};
--   alarms.alarm_transition  -> entity `alarm-occurrence` `{equipment}~{epoch}~{seq}` (ack,
--     comment) or `alarm-point` `{equipment}/{code}`, action `alarm.<action>`; before as it was,
--     after with the shelf's `version` for a point action;
--   shifts.handover_audit    -> entity `handover-note` `{note id}`, action `note.create|edit`;
--     before as it was, after with the note's `version`.
-- Times in JSON are ISO 8601 UTC with milliseconds, as the MES writes them.
INSERT INTO identity.audit_log (
  at, plant_at, user_id, username, roles, authenticated, action, entity_type, entity_id, before,
  after, request_id, legacy
)
SELECT
  legacy.at, legacy.plant_at, NULL, legacy.actor, '{}', legacy.authenticated, legacy.action,
  legacy.entity_type, legacy.entity_id, legacy.before, legacy.after, legacy.request_id, true
FROM (
  SELECT
    a.at,
    NULL::timestamptz AS plant_at,
    a.actor,
    a.authenticated,
    CASE a.action
      WHEN 'coded' THEN 'downtime.code'
      WHEN 'cleared' THEN 'downtime.clear'
      ELSE 'downtime.orphan'
    END AS action,
    'downtime-coding-set' AS entity_type,
    a.equipment || '~' || a.epoch::text AS entity_id,
    jsonb_build_object('codings', a.before) AS before,
    jsonb_build_object(
      'recordId', a.record_id,
      'from', to_char(a.from_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'to', to_char(a.to_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'version', a.version,
      'codings', a.after
    ) AS after,
    a.request_id,
    1 AS source,
    a.id AS source_id
  FROM equipment.downtime_audit a
  UNION ALL
  SELECT
    t.at,
    t.plant_at,
    t.actor,
    t.authenticated,
    'alarm.' || t.action,
    CASE WHEN t.seq IS NULL THEN 'alarm-point' ELSE 'alarm-occurrence' END,
    CASE
      WHEN t.seq IS NULL THEN t.equipment || '/' || t.code
      ELSE t.equipment || '~' || t.epoch::text || '~' || t.seq::text
    END,
    t.before,
    CASE
      WHEN t.version IS NULL THEN t.after
      ELSE coalesce(t.after, '{}'::jsonb) || jsonb_build_object('version', t.version)
    END,
    t.request_id,
    2,
    t.id
  FROM alarms.alarm_transition t
  UNION ALL
  SELECT
    h.at,
    h.plant_at,
    h.actor,
    h.authenticated,
    CASE h.action WHEN 'created' THEN 'note.create' ELSE 'note.edit' END,
    'handover-note',
    h.note_id::text,
    h.before,
    h.after || jsonb_build_object('version', h.version),
    h.request_id,
    3,
    h.id
  FROM shifts.handover_audit h
) AS legacy
ORDER BY legacy.at, legacy.source, legacy.source_id;

-- Every row arrived: the counts per module audit must match, or the migration rolls back.
-- (BEGIN shares its line with DECLARE: the runner refuses a line that starts with BEGIN.)
DO $$ DECLARE copied bigint; expected bigint; BEGIN
  SELECT count(*) INTO copied FROM identity.audit_log WHERE legacy AND action LIKE 'downtime.%';
  SELECT count(*) INTO expected FROM equipment.downtime_audit;
  IF copied <> expected THEN
    RAISE EXCEPTION 'downtime audit backfill: % of % rows', copied, expected;
  END IF;
  SELECT count(*) INTO copied FROM identity.audit_log WHERE legacy AND action LIKE 'alarm.%';
  SELECT count(*) INTO expected FROM alarms.alarm_transition;
  IF copied <> expected THEN
    RAISE EXCEPTION 'alarm transition backfill: % of % rows', copied, expected;
  END IF;
  SELECT count(*) INTO copied FROM identity.audit_log WHERE legacy AND action LIKE 'note.%';
  SELECT count(*) INTO expected FROM shifts.handover_audit;
  IF copied <> expected THEN
    RAISE EXCEPTION 'handover audit backfill: % of % rows', copied, expected;
  END IF;
END $$;

-- Frozen: read-only legacy. The MES loses INSERT (its history endpoints read identity.audit_log),
-- and a trigger refuses an insert by any role, the owner included.
REVOKE INSERT ON equipment.downtime_audit, shifts.handover_audit FROM mes_app;

CREATE FUNCTION equipment.downtime_audit_frozen() RETURNS trigger
-- (BEGIN shares its line with AS: the runner refuses a line that starts with BEGIN.)
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'equipment.downtime_audit is frozen: the audit is identity.audit_log (#169)'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER downtime_audit_frozen
  BEFORE INSERT ON equipment.downtime_audit
  FOR EACH STATEMENT EXECUTE FUNCTION equipment.downtime_audit_frozen();

CREATE FUNCTION shifts.handover_audit_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'shifts.handover_audit is frozen: the audit is identity.audit_log (#169)'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER handover_audit_frozen
  BEFORE INSERT ON shifts.handover_audit
  FOR EACH STATEMENT EXECUTE FUNCTION shifts.handover_audit_frozen();
