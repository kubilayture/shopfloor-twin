import { golden, reconciliationSuite } from './reconcile.test-support.ts';

// The golden traceability scenario (apps/simulator/golden/quality-01, #208): the week-01 seed for
// two days in orders mode with small lots (lots change inside orders and cartons), a rework with a
// second seal-kit lot, a leak scrap and a bounded leak drift on LKT-01. Reconciled like orders-01
// (states, OEE, alarms, shift reports, orders and execution), and its genealogy (#199) against
// trace.json: every unit, lot and carton, in order and shuffled, its required features found in
// the MES's answers, and at Monday 14:00 Istanbul (the end of shift A) against `traceAsOf` of the
// truth. The golden hold cases (#201): at that cut a lot, a carton and an order are held, and
// once every fact is in each hold's scope equals the truth's units of its subject.
reconciliationSuite(
  'reconciliation with the headless ground truth: quality-01 traceability (#199)',
  // 6 shift buckets of 8 OEE buckets; no failure injection (the drift is a sensor fault, no alarm);
  // 834 units with records, 7 orders, 6 complete × 5 operations confirmed. Genealogy: 834 units,
  // 23 lots consumed, 50 cartons; 781 backward traces final (the others' latest record is after a
  // machine's last fact); at 14:00 Monday, 204 units, 14 lots, 8 cartons, 184 final.
  () =>
    golden('quality-01', {
      oeeBuckets: 48,
      alarmComparisons: 45,
      shifts: { instances: 6, final: 5, compared: 102 },
      orders: { units: 834, confirmations: 30, orders: 7 },
      genealogy: {
        units: 834,
        lots: 23,
        cartons: 50,
        final: 781,
        cut: '2026-10-12T11:00:00.000Z',
        atCut: { units: 204, lots: 14, cartons: 8, final: 184 },
        features: true,
        // The golden hold cases (#201), opened at the cut (Monday 14:00): the first blank lot in
        // use across it (84 units before, 396 consumed after: one held-material-consumed each),
        // the first seal-kit lot of a rework pass, the first closed carton, the first completed
        // order; its close refused while held, and PO-2610-103's by the blank lot's scope alone.
        // The shuffled replay opens the same holds halfway and reaches the same ends.
        holds: {
          lot: 'BL100-Q01-03',
          lotUnitsAtCut: 84,
          lotUnits: 480,
          consumedAfter: 396,
          reworkLot: 'SK1-Q01-05',
          reworkLotUnits: 11,
          carton: 'PO-2610-101-C01',
          cartonUnits: 20,
          order: 'PO-2610-101',
          orderUnits: 40,
          lotOrder: 'PO-2610-103',
        },
      },
    }),
);
