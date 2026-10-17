-- orders (Phase 7, #175; plan "Confirmations to the ERP", ADR-0028, ADR-0031): the confirmations
-- the MES sent for an order operation, one final (n = 1) and corrections (n >= 2, signed deltas
-- against the sum of every earlier one). Written in the transaction of their outbound message in
-- orders.erp_message_log (key confirmationKey), never changed: append-only by grants.
CREATE TABLE orders.confirmation (
  order_id TEXT NOT NULL REFERENCES orders.production_order (id),
  operation TEXT NOT NULL CHECK (operation ~ '^OP[0-9]{2}$'),
  n INTEGER NOT NULL CHECK (n >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('final', 'correction')),
  revision INTEGER NOT NULL,
  -- The message's counts: totals in the final one, deltas in a correction.
  yield INTEGER NOT NULL,
  scrap JSONB NOT NULL,
  rework_passes INTEGER NOT NULL,
  material JSONB NOT NULL,
  -- What every confirmation up to this one sums to: the totals the next is judged against.
  totals JSONB NOT NULL,
  -- Plant time: when the operation was complete by its facts.
  confirmed_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (order_id, operation, n),
  CHECK ((kind = 'final') = (n = 1))
);

GRANT SELECT, INSERT ON orders.confirmation TO mes_app;
