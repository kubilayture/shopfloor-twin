/**
 * The `genealogy` module (#199, Phase 8 plan "Genealogy", ADR-0034): lots, serials, cartons and
 * the links between them, and the backward and forward trace queries. Everything it stores lives
 * in the `genealogy` schema; other modules use only what is exported here.
 *
 * - `Genealogy.start()` / `stop()` / `tick()`: follows the execution module's units
 *   (`Execution.onUnits`) and rebuilds each unit's records, lot links and incidents from its
 *   operation records and cycle facts; places cartons on final data with `trace-core`'s packing
 *   rule (`config/plant/packing.yaml`).
 * - `importLots()`: the ERP's lot list (`GET /api/v1/lots`), upserted by id, a lot no longer
 *   listed kept as `retired`; on the ERP poll (`lotPollMs`).
 * - Reads: `serial(serial)` (backward), `lot(id)` (forward), `carton(id)`, `cartons(query)`,
 *   `cartonMembers(query)`, `unitTraces(epoch, partIds)`, `lots()`, `search(q)`, `incidents(query)`;
 *   every trace answer carries `final` and the machines not final through its latest record.
 * - `processedThrough(equipment, epoch)` / `covers(facts)`: the contiguous processed watermark the
 *   quality module's close guard requires (plan review round 2 HIGH C, #201).
 * - Pure (`derive.ts`): `traceUnit`, `mismatches`, `placeCartons`, `finality`, `finalThrough`.
 */
export { finalThrough, finality, mismatches, placeCartons, traceUnit } from './derive.ts';
export type {
  BomLine,
  LotLink,
  LotRef,
  Mismatch,
  PlacedPack,
  Progress,
  TraceFact,
  TracedRecord,
  UnitOperation,
} from './derive.ts';
export { Genealogy, TRACE_UNIT_LIMIT } from './genealogy.ts';
export type {
  CartonRecord,
  CartonTrace,
  Finality,
  GenealogyCrew,
  GenealogyErp,
  GenealogyExecution,
  GenealogyIncident,
  GenealogyIngest,
  GenealogyLog,
  GenealogyOptions,
  LotTrace,
  MaterialLot,
  SearchKind,
  SerialTrace,
  TraceUnitRecord,
  UnitRef,
} from './genealogy.ts';
export { GENEALOGY_COLUMNS } from './tables.ts';
export type { GenealogyTables, GenealogyIncidentType, LotStatus } from './tables.ts';
