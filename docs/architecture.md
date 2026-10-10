# Architecture

arc42-lite overview. Updated whenever a component, interface or data flow changes. Until the components exist, the target design is plan sections 5 and 7.

## 1. Context

ShopFloor Twin simulates one plant (Orbis Components, Gebze) and runs the software stack above it: edge gateway, MQTT Unified Namespace, MES, mock ERP and web UI.

## 2. Containers

| Container | Status |
| --- | --- |
| `db` (PostgreSQL + TimescaleDB) | Phase 0 (#5) |
| `broker` (Mosquitto) | Phase 0 (#5) |
| `simulator` | Phase 1–2 |
| `edge-gateway` | Phase 3 |
| `mes-server` | Phase 4 |
| `erp-mock` | Phase 7 |
| `web` | Phase 4 |

## 3. Runtime views

Added with the first data path in Phase 3.

## 4. Deployment

One developer machine, Docker Compose. See [runbook.md](runbook.md).
