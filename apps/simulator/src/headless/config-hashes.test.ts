/**
 * The bottleneck is derived, not configured (#229, ADR-0036): `oee-core` reads it from the routing
 * (`products.yaml`) and the equipment (`plant.yaml`), so neither `oee.yaml` (in
 * `analysisConfigSha256`) nor the plant configuration (in `configSha256` and every event log) gains
 * a key. Asserted here for the four goldens: both hashes of the current configuration equal those
 * of their committed summaries and the values they had before Phase 9 (main at 3e3ef33).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deriveBottlenecks, formatFraction } from '@shopfloor/oee-core';
import { idealCycleMs } from '@shopfloor/plant-config';
import { describe, expect, it } from 'vitest';
import { scenarioOptions } from './golden.ts';
import { analysisConfigHash, configHash } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');

const PLANT = '35123ec56e3be6b7bc7b2362aca7c86f9d3bc31052a5ee673d1ed41a570b1221';
const ANALYSIS = '5756271448987031c8b24ff5a3e2dc58b79cf4e7408a25bb4cf0e40350b43764';

/** `configSha256` before Phase 9; `quality-01` hashes its scenario-local stock (#196). */
const BEFORE: Readonly<Record<string, { config: string; analysis: string }>> = {
  'week-01': { config: PLANT, analysis: ANALYSIS },
  'alarms-01': { config: PLANT, analysis: ANALYSIS },
  'orders-01': { config: PLANT, analysis: ANALYSIS },
  'quality-01': {
    config: '26830f9ae575c6cde32c47c480c5b50f8684e89d1d6079dd9e977c086b53c0ce',
    analysis: ANALYSIS,
  },
};

interface SummaryHashes {
  readonly analysisConfigSha256: string;
  readonly run: { readonly configSha256: string };
}

describe.each(Object.entries(BEFORE))('golden %s', (name, before) => {
  it('keeps configSha256 and analysisConfigSha256 unchanged', async () => {
    const options = await scenarioOptions(name);
    const summary = JSON.parse(
      await readFile(resolve(GOLDEN, name, 'summary.json'), 'utf8'),
    ) as SummaryHashes;
    expect({
      config: configHash(options.config),
      analysis: analysisConfigHash(options.config),
    }).toEqual(before);
    expect({ config: summary.run.configSha256, analysis: summary.analysisConfigSha256 }).toEqual(
      before,
    );
  });

  it('derives ASM-01 (OP30) as the bottleneck of both products from its configuration', async () => {
    const { config } = await scenarioOptions(name);
    const bottlenecks = deriveBottlenecks({
      operations: config.products.operations,
      equipment: config.plant.areas.flatMap((area) =>
        area.workCenters.flatMap((center) => center.equipment),
      ),
      idealCycleMs: idealCycleMs(config),
    });
    expect(
      Object.fromEntries(
        Object.entries(bottlenecks).map(([product, b]) => [
          product,
          `${b.operation} ${b.equipment.join(',')} ${formatFraction(b.effectiveCycleMs)}`,
        ]),
      ),
    ).toEqual({ 'VB-100': 'OP30 asm-01 150000/1', 'VB-200': 'OP30 asm-01 210000/1' });
  });
});
