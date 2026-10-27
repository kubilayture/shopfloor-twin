-- orders (#366): the crew row an activity interval was started under. A crew row's end closes the
-- intervals started under it (`crew-ended`), named by this id instead of by time: the crew row's
-- end in wall time, read back in milliseconds, could precede an interval's start (in microseconds,
-- or after the database's clock stepped back), and a late notice of an ended row must still never
-- close work begun under a newer sign-on. A shifts.crew_assignment id, by value (no key across
-- module schemas, ADR-0016); null for intervals written before this migration or without the
-- crew check (module tests that write without the API), which a crew end still judges by time.
ALTER TABLE orders.operation_activity ADD COLUMN crew_id BIGINT;
