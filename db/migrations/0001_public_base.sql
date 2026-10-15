-- Base of the MES database (Phase 4, ADR-0016): TimescaleDB, and one schema per module (plan
-- section 7), each owned by exactly one module of mes-server.
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS master_data;
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS equipment;
