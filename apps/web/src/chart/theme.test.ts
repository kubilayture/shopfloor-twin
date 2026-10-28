import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { init, use as registerModules, type EChartsType } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLOR_TOKENS, NEUTRAL_SCALE } from '../components/ui/tokens.ts';
import { waterfall } from '../domain/oee.ts';
import { hourKpi } from '../test/alarm-fixtures.ts';
import { emptyResult, hourBucket, PARETO, result } from '../test/oee-fixtures.ts';
import { limitVersion, point, signal } from '../test/quality-fixtures.ts';
import { alarmHourlyOption, alarmHourlyReading } from './alarm-options.ts';
import { ECHARTS_MODULES } from './echarts-modules.ts';
import { themedOption } from './echarts-view.tsx';
import {
  EXTERNAL_STYLE,
  hourlyOption,
  hourlyReading,
  NARROW_LABEL_WIDTH,
  paretoOption,
  paretoReading,
  waterfallOption,
  waterfallReading,
} from './oee-options.ts';
import { CENTRE_DASH, SPC_COLORS, spcChartOption } from './spc-options.ts';
import {
  axisValueText,
  CHART_TOKEN_NAMES,
  CHART_TOKENS,
  echartsTheme,
  readTokens,
  resolveTokens,
  tokenRef,
  uplotTheme,
  useThemeVersion,
  withAlpha,
} from './theme.ts';
import { options as uplotOptions } from './uplot-chart.tsx';

// uPlot reads the pixel ratio through `matchMedia` when it loads, which jsdom lacks.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

registerModules([...ECHARTS_MODULES, SVGRenderer]);

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--color-chart-1');
});

/** Light values from the token data (jsdom has no stylesheet). */
const read = readTokens();
const FONT = 'system-ui';

const steps = waterfall(result());
if (!steps) throw new Error('fixture has losses');

/** Every chart the app draws, as its builder makes it. */
const OPTIONS = {
  hourly: hourlyOption([
    hourBucket('cell-m1', '2026-10-15T03:00:00.000Z', { final: true }),
    hourBucket('cell-m1', '2026-10-15T04:00:00.000Z', { result: emptyResult() }),
  ]),
  waterfall: waterfallOption(steps),
  pareto: paretoOption(PARETO).option,
  alarm: alarmHourlyOption(
    [hourKpi('2026-10-15T03:00:00.000Z', { raises: 3, peak10: 2, final: true })],
    10,
  ),
  spc: spcChartOption({
    chart: 'I',
    points: [point(0, 2, { rules: [1] }), point(3, 2.1, { final: false })],
    limits: [limitVersion(1)],
    signals: [signal(1, { chart: 'I', status: 'provisional' })],
    unit: 'Pa/min',
    resolution: 0.001,
  }),
};

describe('chart theme (UX-1f, design system section 5)', () => {
  it('leaves no colour value in chart/: every colour is a token (G-25)', () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(sources).toContain('theme.ts');
    for (const file of sources) {
      const code = readFileSync(join(dir, file), 'utf8');
      // A colour literal ('#0369a1'); issue references in comments (#295) are not strings.
      expect(code, file).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
      expect(code, file).not.toMatch(/['"`](?:white|black|red|gray|grey)['"`]/i);
      expect(code, file).not.toMatch(/\brgba?\(\s*\d/);
    }
  });

  it('reads a token from the stylesheet, else from the token data, in the theme on <html>', () => {
    expect(readTokens()('chart-1')).toBe('#0369a1');
    document.documentElement.dataset.theme = 'dark';
    expect(readTokens()('chart-1')).toBe('#38bdf8');
    document.documentElement.style.setProperty('--color-chart-1', '#123456');
    expect(readTokens()('chart-1')).toBe('#123456');
    expect(readTokens()('neutral-900')).toBe('#0f172a');
  });

  it('resolves token references deeply, keeps functions and leaves the option as it was', () => {
    const formatter = () => 'x';
    const option = {
      color: [tokenRef('chart-1')],
      series: [{ itemStyle: { color: CHART_TOKENS.limit }, label: { formatter }, data: [1, null] }],
      other: 'var(--font-sans)',
    };
    const resolved = resolveTokens(option, read);
    expect(resolved).toEqual({
      color: ['#0369a1'],
      series: [{ itemStyle: { color: '#b91c1c' }, label: { formatter }, data: [1, null] }],
      other: 'var(--font-sans)',
    });
    expect(option.color[0]).toBe('var(--color-chart-1)');
    expect(withAlpha('#0369a1', 0.15)).toBe('rgba(3, 105, 161, 0.15)');
    expect(withAlpha('transparent', 0.5)).toBe('transparent');
  });

  it('defines the theme: font, axes, legend, a canvas tooltip and no animation', () => {
    const theme = echartsTheme(read, FONT);
    expect(theme.animation).toBe(false);
    expect(theme.color).toEqual(['#0369a1', '#b45309', '#6d28d9', '#047857', '#be185d']);
    expect(theme.textStyle).toEqual({ fontFamily: FONT, color: '#475569', fontSize: 12 });
    expect(theme.tooltip).toMatchObject({
      renderMode: 'richText',
      backgroundColor: '#ffffff',
      borderColor: '#cbd5e1',
      shadowColor: 'rgba(15, 23, 42, 0.12)',
    });
    expect(theme.legend).toMatchObject({ left: 0, top: 0, itemWidth: 10, itemHeight: 10 });
    for (const axis of [theme.categoryAxis, theme.valueAxis, theme.timeAxis]) {
      expect(axis.axisLine.lineStyle.color).toBe('#64748b');
      expect(axis.axisTick).toMatchObject({ show: true, inside: false, length: 4 });
      expect(axis.axisLabel).toMatchObject({ color: '#475569', fontSize: 11 });
      expect(axis.nameTextStyle.fontSize).toBe(12);
    }
    expect(theme.valueAxis.splitLine).toEqual({
      show: true,
      lineStyle: { color: '#e2e8f0', type: 'dashed' },
    });
    expect(theme.categoryAxis.splitLine.show).toBe(false);
    expect(theme.timeAxis.splitLine.show).toBe(false);
  });

  it.each(Object.entries(OPTIONS))(
    'draws %s with a rich-text tooltip, no animation and only resolved colours',
    (_name, option) => {
      const drawn = themedOption({ ...option, animation: true }, read);
      expect(drawn.animation).toBe(false);
      expect(drawn.tooltip).toMatchObject({ renderMode: 'richText', trigger: 'item' });
      expect(typeof (drawn.tooltip as { formatter?: unknown }).formatter).toBe('function');
      expect(JSON.stringify(drawn)).not.toContain('var(');
      expect(JSON.stringify(option)).not.toContain("'html'");
    },
  );

  it('formats each tooltip as plain text rows with the plant time and the unit', () => {
    const tip = (option: Record<string, unknown>, params: Record<string, unknown>) =>
      (option.tooltip as { formatter: (p: unknown) => string }).formatter(params);
    expect(tip(OPTIONS.hourly, { dataIndex: 0 })).toBe('Thu 15 Oct, 06:00\nOEE: 63.00 % (final)');
    expect(tip(OPTIONS.hourly, { dataIndex: 1 })).toBe('Thu 15 Oct, 07:00\nOEE: n/a (provisional)');
    expect(tip(OPTIONS.waterfall, { dataIndex: 1 })).toMatch(/: −2\.5 min$/);
    expect(tip(OPTIONS.pareto, { dataIndex: 1 })).toBe(
      'Starved by the upstream station\nExternal: 0.8 min',
    );
    expect(tip(OPTIONS.alarm, { dataIndex: 0, seriesName: 'Raises' })).toBe(
      'Thu 15 Oct, 06:00 (final)\nRaises: 3',
    );
    expect(tip(OPTIONS.alarm, { dataIndex: 0, seriesName: 'Peak per window' })).toBe(
      'Thu 15 Oct, 06:00 (final)\nPeak per window: 2',
    );
    expect(tip(OPTIONS.hourly, { dataIndex: 5 })).toBe('');
  });

  it('labels no zero or n/a bar, and no bar at all past twelve (E-05)', () => {
    interface Labelled {
      label: { show: boolean; formatter: (p: { dataIndex: number }) => string };
    }
    const zero = result({ oee: { fraction: '0/1', decimal: '0.0000' } });
    const hours = hourlyOption([
      hourBucket('m', '2026-10-15T03:00:00.000Z', { result: zero }),
      hourBucket('m', '2026-10-15T04:00:00.000Z'),
    ]);
    const [bars] = hours.series as Labelled[];
    expect(bars?.label.show).toBe(true);
    expect(bars?.label.formatter({ dataIndex: 0 })).toBe('');
    expect(bars?.label.formatter({ dataIndex: 1 })).toBe('63.00 %');
    const many = Array.from({ length: 13 }, (_, i) =>
      hourBucket(
        'm',
        new Date(Date.parse('2026-10-15T03:00:00.000Z') + i * 3_600_000).toISOString(),
      ),
    );
    expect((hourlyOption(many).series as Labelled[])[0]?.label.show).toBe(false);
    expect((hourlyOption(many.slice(0, 12)).series as Labelled[])[0]?.label.show).toBe(true);

    // The waterfall's step of exactly zero (the fixture's setup) draws no "0.0".
    const losses = result().losses;
    if (!losses) throw new Error('fixture has losses');
    const flat = waterfall(
      result({
        losses: {
          ...losses,
          availability: {
            own: { stopped: 0, down: 0, setup: 0, idle: 0, total: 0 },
            external: { starved: 50_000, blocked: 0, total: 50_000 },
          },
        },
      }),
    );
    if (!flat) throw new Error('fixture has losses');
    const [, visible] = waterfallOption(flat).series as Labelled[];
    expect(visible?.label.formatter({ dataIndex: 1 })).toBe('');
    expect(visible?.label.formatter({ dataIndex: 2 })).toBe('−0.8');
  });

  it('wraps the Pareto reasons on two lines at 180 px before ending them in "…" (E-07)', () => {
    const axis = OPTIONS.pareto.yAxis as { axisLabel: Record<string, unknown> };
    expect(axis.axisLabel).toMatchObject({
      width: 180,
      overflow: 'break',
      lineOverflow: 'truncate',
      ellipsis: '…',
    });
    expect(axis.axisLabel.height).toBe(2 * (axis.axisLabel.lineHeight as number));
  });

  it('names the flood threshold in the legend, never as a label over the plot (K-03, #339)', () => {
    const [, peak, threshold] = OPTIONS.alarm.series as {
      name?: string;
      markLine?: { label: { show: boolean } };
    }[];
    expect(peak?.markLine?.label.show).toBe(false);
    expect(threshold?.name).toMatch(/^Flood threshold \(\d+\)$/);
  });

  it('colours SPC by role: neutral points, alarm diamonds, dashed limits, dotted zones', () => {
    const series = OPTIONS.spc.series as {
      name: string;
      lineStyle?: { color: string; type?: string; width: number };
    }[];
    const byName = (name: string) => series.find((s) => s.name === name)?.lineStyle;
    expect(byName('UCL')).toEqual({ color: CHART_TOKENS.limit, type: 'dashed', width: 1.5 });
    expect(byName('LCL')).toEqual({ color: CHART_TOKENS.limit, type: 'dashed', width: 1.5 });
    // The centre long-dashed and the join light: the two never read as one line.
    expect(byName('Centre')).toEqual({ color: CHART_TOKENS.text, type: [12, 4], width: 1.5 });
    expect(CENTRE_DASH).toEqual([12, 4]);
    expect(byName('Points')).toEqual({ color: tokenRef('line'), width: 1 });
    // Episode shades by state, never the categorical palette.
    expect([
      SPC_COLORS.episodeFinal,
      SPC_COLORS.episodeProvisional,
      SPC_COLORS.episodeGrowing,
    ]).toEqual([tokenRef('alarm-border'), tokenRef('warn-border'), tokenRef('info-border')]);
    expect(byName('+1σ')).toMatchObject({ color: CHART_TOKENS.grid, type: 'dotted' });
    expect(OPTIONS.spc.legend).toMatchObject({ left: 0, itemWidth: 16 });
  });

  it('names only real tokens (a typo is a type error, and this catches a removed token)', () => {
    const known = new Set([...COLOR_TOKENS.map((t) => t.name), ...Object.keys(NEUTRAL_SCALE)]);
    for (const name of CHART_TOKEN_NAMES) expect(known.has(name), name).toBe(true);
  });

  it('draws external loss as the neutral outline, apart from the totals', () => {
    interface Styled {
      data: ({ itemStyle: unknown } | number | null)[];
      itemStyle?: unknown;
    }
    const [, visible] = OPTIONS.waterfall.series as Styled[];
    const external = steps.steps.findIndex((step) => step.key === 'external');
    const pbt = steps.steps.findIndex((step) => step.key === 'pbt');
    const style = (i: number) => (visible?.data[i] as { itemStyle: unknown }).itemStyle;
    expect(style(external)).toEqual({
      color: tokenRef('line'),
      borderColor: tokenRef('neutral-border'),
      borderWidth: 1,
    });
    expect(style(pbt)).toEqual({ color: tokenRef('chart-other') });
    const [, paretoExternal] = OPTIONS.pareto.series as Styled[];
    expect(paretoExternal?.itemStyle).toBe(EXTERNAL_STYLE);
  });

  it('lays out narrow charts (section 5): the Pareto label column and ticks, no crowded labels', () => {
    expect(OPTIONS.pareto.media).toEqual([
      {
        query: { maxWidth: 480 },
        option: { yAxis: { axisLabel: { width: NARROW_LABEL_WIDTH } }, xAxis: { splitNumber: 3 } },
      },
    ]);
    const [, visible] = OPTIONS.waterfall.series as { labelLayout?: unknown }[];
    expect(visible?.labelLayout).toEqual({ hideOverlap: true });
    const [bars] = OPTIONS.hourly.series as { labelLayout?: unknown }[];
    expect(bars?.labelLayout).toEqual({ hideOverlap: true });
  });

  it('redraws on a new data-theme only, not on other changes to <html>', async () => {
    const { result: version } = renderHook(() => useThemeVersion());
    const root = document.documentElement;
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    root.dataset.theme = 'dark';
    await flush();
    expect(version.current).toBe(1);
    // The same value again, or a class an extension adds: no redraw.
    root.dataset.theme = 'dark';
    root.classList.add('some-extension');
    await flush();
    expect(version.current).toBe(1);
    root.dataset.theme = 'light';
    await flush();
    expect(version.current).toBe(2);
    root.classList.remove('some-extension');
  });

  it('states the main reading of each chart for its text alternative', () => {
    expect(
      hourlyReading([
        hourBucket('m', '2026-10-15T03:00:00.000Z', {
          result: result({ oee: { fraction: '0/1', decimal: '0.0000' } }),
        }),
        hourBucket('m', '2026-10-15T04:00:00.000Z', {
          result: result({ oee: { fraction: '0/1', decimal: '0.0000' } }),
        }),
      ]),
    ).toBe('OEE per hour: 0.00 % in all 2 hours');
    expect(
      hourlyReading([
        hourBucket('m', '2026-10-15T03:00:00.000Z'),
        hourBucket('m', '2026-10-15T04:00:00.000Z', {
          result: result({ oee: { fraction: '1/2', decimal: '0.5000' } }),
        }),
        hourBucket('m', '2026-10-15T05:00:00.000Z', { result: emptyResult() }),
      ]),
    ).toBe(
      'OEE per hour over 3 hours: lowest 50.00 % at 07:00, highest 63.00 % at 06:00; 1 without planned time',
    );
    expect(
      hourlyReading([hourBucket('m', '2026-10-15T03:00:00.000Z', { result: emptyResult() })]),
    ).toBe('OEE per hour: no hour with planned time in 1 hour');
    expect(waterfallReading(steps)).toBe(
      'Loss waterfall: 16.7 min planned busy time to 10.5 min fully productive; largest loss availability loss, own, 2.5 min',
    );
    expect(paretoReading(PARETO)).toBe(
      'Availability loss by reason: largest Spindle overload (own), 1.7 min, of 3 reasons',
    );
    expect(paretoReading({ reasons: [] })).toBe('Availability loss by reason: none');
    const hours = [
      hourKpi('2026-10-15T03:00:00.000Z', { raises: 3, peak10: 2 }),
      hourKpi('2026-10-15T04:00:00.000Z', { raises: 14, peak10: 12 }),
    ];
    expect(alarmHourlyReading(hours, 10, 600_000)).toBe(
      'Alarm raises: 17 in 2 hours, most at 07:00 (14); peak per 10 min 12, above the flood threshold of 10',
    );
    expect(alarmHourlyReading(hours.slice(0, 1), 10)).toBe(
      'Alarm raises: 3 in 1 hour, most at 06:00 (3); peak per window 2, within the flood threshold of 10',
    );
    expect(alarmHourlyReading([], undefined)).toBe('Alarm raises: 0 in 0 hours');
  });

  it('styles the uPlot trend from the same tokens', () => {
    const theme = uplotTheme(read, FONT);
    const opts = uplotOptions(800, '°C', theme);
    expect(opts.height).toBe(240);
    expect(opts.series.slice(1).map((s) => s.stroke)).toEqual(['#64748b', '#64748b', '#0369a1']);
    expect(opts.bands?.[0]?.fill).toBe('rgba(3, 105, 161, 0.15)');
    const [x, y] = opts.axes ?? [];
    expect(x?.grid).toEqual({ show: false });
    expect(y?.grid).toEqual({ stroke: '#e2e8f0', width: 1, dash: [4, 4] });
    expect(x?.stroke).toBe('#475569');
    expect(x?.font).toBe('11px system-ui');
    expect(y?.labelFont).toBe('12px system-ui');
    expect(y?.ticks).toMatchObject({ stroke: '#64748b', size: 4 });
  });

  describe('as ECharts draws it', () => {
    let chart: EChartsType | undefined;
    afterEach(() => {
      chart?.dispose();
      chart = undefined;
    });

    it('paints the token values on the chart, never a token reference', () => {
      chart = init(document.createElement('div'), echartsTheme(read, FONT), {
        renderer: 'svg',
        width: 600,
        height: 320,
      });
      chart.setOption(themedOption(OPTIONS.hourly, read), { notMerge: true });
      const svg = chart.renderToSVGString();
      expect(svg).toContain('#0369a1');
      expect(svg).toContain('#475569');
      expect(svg).not.toContain('var(');
      // No zero label, and the n/a hour has no bar: one bar label only.
      expect(svg.match(/63\.00 %/g)).toHaveLength(1);
    });

    it.each([
      [390, NARROW_LABEL_WIDTH, 3],
      [900, 180, 5],
    ])('draws the Pareto at %i px with a %i px label column, from 0', (width, labels, ticks) => {
      chart = init(document.createElement('div'), echartsTheme(read, FONT), {
        renderer: 'svg',
        width,
        height: 200,
      });
      const pareto = paretoOption({
        reasons: [
          {
            reason: 'A',
            name: 'Blocked by the downstream station',
            loss: 'external',
            ms: 13_400_000,
            records: 62,
          },
          { reason: 'B', name: 'Chip jam', loss: 'own', ms: 390_000, records: 2 },
        ],
      });
      chart.setOption(themedOption(pareto.option, read), { notMerge: true });
      interface Axis {
        get(path: string[]): unknown;
      }
      const model = (
        chart as unknown as { getModel(): { getComponent(t: string): Axis } }
      ).getModel();
      expect(model.getComponent('yAxis').get(['axisLabel', 'width'])).toBe(labels);
      expect(model.getComponent('xAxis').get(['splitNumber'])).toBe(ticks);
      expect(chart.renderToSVGString()).toMatch(/>0<\/text>/);
    });

    it('writes value ticks as the tables write numbers: grouped from 10,000 only (#339)', () => {
      const draw = (minutes: number) => {
        chart?.dispose();
        chart = init(document.createElement('div'), echartsTheme(read, FONT), {
          renderer: 'svg',
          width: 900,
          height: 200,
        });
        const pareto = paretoOption({
          reasons: [
            { reason: 'A', name: 'Starved', loss: 'external', ms: minutes * 60_000, records: 8 },
          ],
        });
        chart.setOption(themedOption(pareto.option, read), { notMerge: true });
        return chart.renderToSVGString();
      };
      const shift = draw(1800);
      expect(shift).toMatch(/>1500<\/text>/);
      expect(shift).not.toMatch(/\d,\d{3}</);
      expect(draw(30_000)).toMatch(/>20,000<\/text>/);
    });
  });

  it('writes an axis value with its own decimals, grouped from 10,000, with a true minus', () => {
    expect(axisValueText(0)).toBe('0');
    expect(axisValueText(1800)).toBe('1800');
    expect(axisValueText(12_000)).toBe('12,000');
    expect(axisValueText(2.5)).toBe('2.5');
    expect(axisValueText(-120)).toBe('\u2212120');
  });
});
