import { golden, reconciliationSuite } from './reconcile.test-support.ts';

// The golden scenario with injected faults (apps/simulator/golden/alarms-01, #140): the week-01
// seed for two days with a flood and a chattering point on Cell M1, a fleeting and a standing
// alarm. Its alarms, OEE, intervals and downtime are reconciled like the golden week's (#142).
reconciliationSuite(
  'reconciliation with the headless ground truth: alarms-01 with injected faults (#142)',
  // 6 shift buckets of 8 OEE buckets; 15 occurrences, and per scope (plant, cell-m1, line-a1) its
  // hours, 6 shift buckets, floods, run and shift bad actors. 6 shift reports (#144), all but the
  // last final (the run ends with machines running, so nothing proves its end).
  () =>
    golden('alarms-01', {
      oeeBuckets: 48,
      alarmComparisons: 129,
      shifts: { instances: 6, final: 5, compared: 102 },
    }),
);
