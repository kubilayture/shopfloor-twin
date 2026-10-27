import { afterEach, describe, expect, it, vi } from 'vitest';

// The trend's time axis as uPlot itself places the ticks (#360 review): a real uPlot in jsdom
// over a stand-in 2D context (jsdom has no canvas), so the splits are uPlot's own round steps in
// the plant zone, not hand-written ones. uPlot reads `matchMedia` when it loads.
const layout = vi.hoisted(() => {
  const state = { width: 1000 };
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const noop = () => undefined;
  class FakePath {
    moveTo = noop;
    lineTo = noop;
    rect = noop;
    arc = noop;
    closePath = noop;
    bezierCurveTo = noop;
    addPath = noop;
  }
  Object.assign(globalThis, { Path2D: FakePath });
  const context = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'measureText'
          ? (text: string) => ({ width: text.length * 6 })
          : key === 'canvas'
            ? undefined
            : noop,
      set: () => true,
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => context) as never;
  // The plot's CSS width, which jsdom does not lay out.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => state.width,
  });
  return state;
});

const { default: uPlot } = await import('uplot');
const { options } = await import('./uplot-chart.tsx');
const { readFont, readTokens, uplotTheme } = await import('./theme.ts');

let plot: InstanceType<typeof uPlot> | undefined;
afterEach(() => {
  plot?.destroy();
  plot = undefined;
});

const s = (iso: string) => Date.parse(iso) / 1000;

/** The time axis' labels as uPlot draws them over [from, to] on a plot `width` px wide. */
async function labels(from: number, to: number, width: number): Promise<string[]> {
  layout.width = width;
  const element = document.createElement('div');
  document.body.append(element);
  plot = new uPlot(
    options(width, '°C', uplotTheme(readTokens(), readFont())),
    [
      [from, to],
      [1, 2],
      [1, 2],
      [1, 2],
    ],
    element,
  );
  plot.setScale('x', { min: from, max: to });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const axis = plot.axes[0] as unknown as { _values: string[] };
  return axis._values.filter((label) => label !== '');
}

describe("the trend's time axis as uPlot places it (#360)", () => {
  it('gives a tick every 3 h over 24 h, dated at the start and at midnight, at most 8', async () => {
    // 14:30 to 14:30 plant time, as `now - 24 h` usually is.
    expect(await labels(s('2026-10-13T11:30:00Z'), s('2026-10-14T11:30:00Z'), 1000)).toEqual([
      '15:00\nTue 13 Oct',
      '18:00',
      '21:00',
      '00:00\nWed 14 Oct',
      '03:00',
      '06:00',
      '09:00',
      '12:00',
    ]);
  });

  it('keeps at most 8 when the window starts and ends on a whole step: its start goes', async () => {
    const shown = await labels(s('2026-10-13T12:00:00Z'), s('2026-10-14T12:00:00Z'), 1000);
    expect(shown).toHaveLength(8);
    expect(shown[0]).toBe('18:00\nTue 13 Oct');
    expect(shown.at(-1)).toBe('15:00');
  });

  it('gives 4 ticks on a phone, 6 h apart, the dates kept apart', async () => {
    expect(await labels(s('2026-10-13T11:30:00Z'), s('2026-10-14T11:30:00Z'), 255)).toEqual([
      '18:00',
      '00:00\nWed 14 Oct',
      '06:00',
      '12:00',
    ]);
  });

  it('gives round times without dates over an hour and over 8 h', async () => {
    expect(await labels(s('2026-10-13T10:05:00Z'), s('2026-10-13T11:05:00Z'), 1000)).toEqual([
      '13:10',
      '13:20',
      '13:30',
      '13:40',
      '13:50',
      '14:00',
    ]);
    expect(await labels(s('2026-10-13T03:30:00Z'), s('2026-10-13T11:30:00Z'), 1000)).toEqual([
      '07:00',
      '08:00',
      '09:00',
      '10:00',
      '11:00',
      '12:00',
      '13:00',
      '14:00',
    ]);
  });
});
