import { goldenWeek, reconciliationSuite } from './reconcile.test-support.ts';

// The golden week (apps/simulator/golden/week-01): Monday 06:00 to Monday 06:00, the Friday night
// shift and the weekend included. A few minutes of replay, so it runs in the end-to-end job.
reconciliationSuite(
  'reconciliation with the headless ground truth: the golden week (#96)',
  goldenWeek,
);
