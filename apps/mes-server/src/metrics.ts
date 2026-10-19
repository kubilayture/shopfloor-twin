/**
 * Bucket edges shared by the derived-work histograms (#238, Phase 9 plan "Derived-work costs"):
 * `mes_quality_spc_derive_seconds`, `mes_quality_chart_read_seconds`,
 * `mes_quality_hold_scope_seconds` and `mes_genealogy_round_seconds`. 1, 2.5, 5, 10, 20, 25, 50,
 * 100, 250 ms, 0.5 s and 1 s, so every budget (10, 20, 50 ms) is an edge on a dashboard. The
 * budgets themselves are judged from raw timings (each module's `onTiming`), not from buckets.
 */
export const DERIVED_WORK_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
];
