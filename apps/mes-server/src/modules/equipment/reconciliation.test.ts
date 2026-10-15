import { reconciliationSuite } from './reconcile.test-support.ts';

// The golden seed from Friday 06:00 to Saturday 08:00 (Istanbul): shifts A, B and the Friday
// night shift C, which ends on Saturday, then the weekend's no-shift bucket. The whole golden week
// runs in the end-to-end job (reconciliation-week.e2e.test.ts).
reconciliationSuite('reconciliation with the headless ground truth: Friday (#96)', () =>
  Promise.resolve({ seed: 20261012, start: '2026-10-16T06:00:00+03:00', days: 26 / 24 }),
);
