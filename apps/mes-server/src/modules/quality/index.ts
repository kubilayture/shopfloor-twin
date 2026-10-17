/**
 * The `quality` module, SPC part (#200, Phase 8 plan "SPC", ADR-0032). Everything it stores lives
 * in the `quality` schema; other modules use only what is exported here. Quality holds (#201) join
 * it later.
 *
 * - `Quality.start()` / `stop()` / `tick()`; `onChange(listener)`: signal episodes and
 *   characteristic changes (readings, limits, notice), for the `quality` push topic.
 * - Characteristics from `quality.yaml` (`characteristicsOf(plant)`), seeded at start.
 * - Measurements: one per cycle fact of the characteristic's machine with a measurement, keyed by
 *   the fact, the pass counted per part (1, 2 after a rework), rebuilt per part.
 * - Limit versions (append-only `control_limit` events): version 1 automatic once the baseline's
 *   first-pass readings are final, created at its last reading, never re-derived (a late reading
 *   inside it raises the `baseline-changed` notice); `createLimits` / `endLimits` (`spc:limits`,
 *   audited, 409 `limits-stale`).
 * - Episodes (`quality.spc_signal`): derived by `spc-core` from the readings and the versions,
 *   `provisional` until the tester is final through the triggering point, `final` after,
 *   `withdrawn` when re-derived away (a final one only by a fact from a written-off gap);
 *   `acknowledge` once each (`spc:ack`, audited, 409 `signal-stale`).
 * - Reads: `characteristics()`, `characteristic(id)`, `limits(id)`, `chart(id)` (points and
 *   subgroups derived on read), `measurements(id, query)`, `signals(query)`, `signal(id)`.
 * - Pure (`derive.ts`): `passesOf`, `versionsOf`, `isFinal`, `planSignals`.
 */
export {
  isFinal,
  keyParts,
  passesOf,
  planSignals,
  readingKey,
  signalKey,
  stepsOf,
  versionsOf,
  WITHDRAWN_FINAL,
  WITHDRAWN_PROVISIONAL,
  WITHDRAWN_VERSION,
} from './derive.ts';
export type {
  DerivedSignal,
  LimitEvent,
  PartCycle,
  PointRef,
  Progress,
  SignalPlan,
  StoredSignal,
  VersionRecord,
  WithdrawalCause,
} from './derive.ts';
export {
  LIMIT_AUDIT_ENTITY,
  Quality,
  QualityError,
  SIGNAL_AUDIT_ENTITY,
  SYSTEM_ACTOR,
  characteristicsOf,
} from './quality.ts';
export type {
  CharacteristicConfig,
  CharacteristicRecord,
  ChartView,
  LimitRecord,
  MeasurementRecord,
  QualityChange,
  QualityErrorKind,
  QualityIngest,
  QualityLog,
  QualityOptions,
  QualityWriteContext,
  SignalRecord,
} from './quality.ts';
export { QUALITY_COLUMNS } from './tables.ts';
export type { QualityTables, SignalStatus } from './tables.ts';
