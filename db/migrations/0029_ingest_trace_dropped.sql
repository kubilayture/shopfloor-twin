-- ingest (Phase 8, #197 review): a cycle whose trace fields (`lots`, `operator`, UNS contract 1.4)
-- the contract refuses is stored without them, never refused as a whole (the device sequence must
-- not get a gap); what was dropped is recorded here with the delivery as received, reason
-- `trace-dropped`, in the fact's own transaction.
ALTER TABLE ingest.rejected_message DROP CONSTRAINT rejected_message_reason_check;
ALTER TABLE ingest.rejected_message ADD CONSTRAINT rejected_message_reason_check CHECK (
  reason IN (
    'invalid-json',
    'invalid-payload',
    'topic-mismatch',
    'unexpected-topic',
    'stale-epoch',
    'unstorable',
    'trace-dropped'
  )
);
