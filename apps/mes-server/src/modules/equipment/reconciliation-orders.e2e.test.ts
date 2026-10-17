import { golden, reconciliationSuite } from './reconcile.test-support.ts';

// The golden scenario in orders mode (apps/simulator/golden/orders-01, #172): the week-01 seed for
// two days, the CNCs running only the jobs dispatched from its ERP dataset, with alarms-01's shift A
// injections. Exit criterion 2 (#175): states, OEE under `scheduledTime: orders` (Idle NO-ORDER
// excluded), alarms and shift reports as the other goldens; and through the orders and execution
// modules the dispatch, every command's device confirmation, every unit's operation records, per
// order and operation the quantities, scrap, rework, backflushed material, completion and WIP, and
// the confirmations computed from the ground truth, in order and shuffled with 10 % duplicates.
reconciliationSuite(
  'reconciliation with the headless ground truth: orders-01 in orders mode (#175)',
  // 6 shift buckets of 8 OEE buckets; the alarm comparisons and shift reports as alarms-01's
  // shift A injections make them; 402 units with records (403 in the ground truth, one blank
  // still in CNC-02), 8 orders, 7 complete × 5 operations confirmed.
  () =>
    golden('orders-01', {
      oeeBuckets: 48,
      alarmComparisons: 60,
      shifts: { instances: 6, final: 5, compared: 102 },
      orders: { units: 402, confirmations: 35, orders: 8 },
    }),
);
