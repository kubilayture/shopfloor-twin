/**
 * Timelines in headless runs (#235): `plant-config`'s scenario schema parses a golden
 * `scenario.json` and a timeline alike, and a golden written as a timeline gives the same run
 * options, so the same event log (the goldens themselves are checked by `pnpm test:golden`).
 */
import { join } from 'node:path';
import { parseScenario, scenarioPlan, type Scenario } from '@shopfloor/plant-config';
import { describe, expect, it } from 'vitest';
import { readScenario, scenarioNames, scenarioOptions } from './golden.ts';
import { runHeadless } from './run.ts';
import { SCENARIOS, loadTimeline, planOptions, timelineNames, timelinePath } from './timeline.ts';

/** A golden scenario rewritten as a timeline: dispatches, then injections, in list order. */
function asTimeline(scenario: Scenario): unknown {
  const { injections = [], dispatches = [], actions = [], ...head } = scenario;
  // `erp` is not a simulation input; the timeline keeps it as the golden does.
  return {
    ...head,
    timeline: [
      ...dispatches.map((d) => ({ action: 'dispatch', ...d })),
      ...injections.map((injection) =>
        injection.kind === 'leak-drift'
          ? { action: 'leak-drift', ...{ ...injection, kind: undefined } }
          : { action: 'failure', ...injection },
      ),
      ...actions.map(({ kind, ...rest }) => ({ action: kind, ...rest })),
    ].map((entry) => JSON.parse(JSON.stringify(entry)) as unknown),
  };
}

describe('scenario.json and timelines, one schema (#235)', () => {
  it.each(scenarioNames())('maps golden %s as a timeline onto the same options', async (name) => {
    const golden = await scenarioOptions(name);
    const parsed = parseScenario(asTimeline(readScenario(name)));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const fromTimeline = planOptions(golden.config, scenarioPlan(parsed.scenario), name);
    expect(fromTimeline).toEqual(golden);
  });

  it('runs the committed example headless, its actions and injections in the header', async () => {
    const { options, plan } = await loadTimeline(
      join(SCENARIOS, 'monday-breakdown-and-recovery.yaml'),
    );
    expect(plan.infrastructure.map((entry) => entry.kind)).toEqual([
      'opcua-offline',
      'pause',
      'speed',
      'modbus-silent',
      'speed',
      'speed',
      'pause',
    ]);
    const lines: string[] = [];
    const result = runHeadless(options, (line) => lines.push(line));
    expect(result.header.injections?.map((i) => ('kind' in i ? i.kind : 'failure'))).toEqual([
      'failure',
      'leak-drift',
      'failure',
    ]);
    expect(result.header.actions?.map((a) => a.kind)).toEqual([
      'lot-block',
      'lot-release',
      'tool-breakage',
      'operators-absent',
    ]);
    const types = new Set(
      lines.slice(1).map((line) => (JSON.parse(line) as { type: string }).type),
    );
    for (const type of ['lot', 'absence', 'tool-breakage', 'leak-drift', 'repair-start']) {
      expect(types).toContain(type);
    }
  });

  it('finds a committed timeline by name, anything else as a path', () => {
    expect(timelineNames()).toEqual([
      'demo-v1',
      'demo-v1-probe',
      'monday-breakdown-and-recovery',
      'monday-orders-dispatch',
    ]);
    expect(timelinePath('monday-orders-dispatch', '/x')).toBe(
      join(SCENARIOS, 'monday-orders-dispatch.yaml'),
    );
    expect(timelinePath('config/scenarios/a.yaml', '/repo')).toBe('/repo/config/scenarios/a.yaml');
    expect(timelinePath('/abs/a.yaml', '/repo')).toBe('/abs/a.yaml');
  });

  it('refuses a timeline that does not fit, naming the entry', async () => {
    const { options, plan } = await loadTimeline(join(SCENARIOS, 'monday-orders-dispatch.yaml'));
    expect(() =>
      planOptions(options.config, { ...plan, production: 'schedule' }, 'x.yaml'),
    ).toThrow('x.yaml: timeline[0]: dispatches need production mode "orders"');
  });
});
