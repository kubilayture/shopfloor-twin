export {
  compare,
  equals,
  formatFraction,
  fraction,
  multiply,
  roundHalfUp,
  toDecimal,
} from './fraction.ts';
export type { Fraction } from './fraction.ts';
export { HOUR, hourCuts, intervalsFromFacts, splitAt, totalsByState } from './intervals.ts';
export type { Millis, StateFact, StateInterval } from './intervals.ts';
export {
  CYCLE_RESULTS,
  EXCLUDED_STATES,
  EXTERNAL_LOSS_STATES,
  OEE_STATES,
  OWN_LOSS_STATES,
  availabilityLoss,
  bucketOee,
  bucketTotals,
  oeeFromTotals,
  sumTotals,
  workCenterOee,
} from './oee.ts';
export type {
  AvailabilityLoss,
  BucketInput,
  CycleCount,
  CycleResult,
  OeeConfig,
  OeeLosses,
  OeeResult,
  OeeState,
  OeeTotals,
  StopPiece,
} from './oee.ts';
