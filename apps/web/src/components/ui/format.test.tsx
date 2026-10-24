import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Duration, Missing, Percent, PlantTime, Quantity, Ratio, WallTime } from './format.tsx';

/** UX-1c (#315): design system 4.13 and section 6. */
describe('Missing', () => {
  it('shows an em dash, the reason visually hidden and in the tooltip', () => {
    render(<Missing reason="Not applicable: no planned busy time" testId="m" />);
    const missing = screen.getByTestId('m');
    const [dash, reason] = missing.children;
    expect(dash?.textContent).toBe('—');
    expect(dash?.getAttribute('aria-hidden')).toBe('true');
    expect(reason?.textContent).toBe('Not applicable: no planned busy time');
    expect(reason?.className).toBe('sr-only');
    expect(missing.getAttribute('title')).toBe('Not applicable: no planned busy time');
    expect(missing.className).toContain('text-ink-secondary');
    expect(missing.textContent).not.toMatch(/n\/a|none|–/);
  });
});

describe('Duration', () => {
  it('follows design system 6.1, the raw value in data-value and dateTime', () => {
    const cases: [ms: number, seconds: boolean, text: string, iso: string][] = [
      [45_000, false, '45 s', 'PT45S'],
      [12 * 60_000 + 5_000, false, '12 min', 'PT12M5S'],
      [12 * 60_000 + 5_000, true, '12 min 05 s', 'PT12M5S'],
      [(4 * 60 + 54) * 60_000, false, '4 h 54 min', 'PT4H54M'],
      [(2 * 24 + 12) * 3_600_000, false, '2 d 12 h', 'PT60H'],
    ];
    for (const [ms, seconds, text, iso] of cases) {
      const { unmount } = render(<Duration ms={ms} seconds={seconds} testId="d" />);
      const element = screen.getByTestId('d');
      expect(element.tagName).toBe('TIME');
      expect(element.textContent).toBe(text);
      expect(element.getAttribute('datetime')).toBe(iso);
      expect(element.dataset.value).toBe(String(ms));
      unmount();
    }
  });
});

describe('no finite number (design system 6.3)', () => {
  it('Duration and Quantity show Missing with the reason, never "0 s" or a dash with a unit', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { unmount } = render(
        <>
          <Duration ms={value} testId="d" missing="Not reported" />
          <Quantity value={value} unit="min" testId="q" />
        </>,
      );
      const duration = screen.getByTestId('d');
      expect(duration.dataset.missing).toBe('');
      expect(duration.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
      expect(duration.getAttribute('title')).toBe('Not reported');
      const quantity = screen.getByTestId('q');
      expect(quantity.textContent).toBe('—No value');
      expect(quantity.textContent).not.toMatch(/min|–|0 s/);
      unmount();
    }
  });

  it('a negative duration (clock skew) reads 0 s, as the live time in state always has', () => {
    render(<Duration ms={-500} testId="d" />);
    expect(screen.getByTestId('d').textContent).toBe('0 s');
  });
});

describe('PlantTime', () => {
  const at = '2026-10-12T04:15:00.000Z'; // Mon 12 Oct, 07:15:00 in Istanbul

  it('dates the time, keeps the instant in dateTime and the full time in the tooltip', () => {
    render(<PlantTime at={at} testId="t" />);
    const time = screen.getByTestId('t');
    expect(time.textContent).toBe('Mon 12 Oct, 07:15:00');
    expect(time.getAttribute('datetime')).toBe(at);
    expect(time.getAttribute('title')).toBe('Mon 12 Oct, 07:15:00');
  });

  it('shows the time alone on the plant clock’s day, dated on another', () => {
    const { rerender } = render(<PlantTime at={at} clock="2026-10-12T15:00:00.000Z" testId="t" />);
    expect(screen.getByTestId('t').textContent).toBe('07:15:00');
    expect(screen.getByTestId('t').getAttribute('title')).toBe('Mon 12 Oct, 07:15:00');
    rerender(<PlantTime at={at} clock="2026-10-13T15:00:00.000Z" testId="t" />);
    expect(screen.getByTestId('t').textContent).toBe('Mon 12 Oct, 07:15:00');
  });

  it('a planning time has no seconds; a number instant becomes ISO in dateTime', () => {
    render(<PlantTime at={Date.parse('2026-10-12T19:00:00.000Z')} seconds={false} testId="t" />);
    const time = screen.getByTestId('t');
    expect(time.textContent).toBe('Mon 12 Oct, 22:00');
    expect(time.getAttribute('datetime')).toBe('2026-10-12T19:00:00.000Z');
  });
});

describe('WallTime', () => {
  it('is labelled wall time', () => {
    render(<WallTime at="2026-10-22T06:12:03.000Z" testId="w" />);
    const time = screen.getByTestId('w');
    expect(time.textContent).toBe('Thu 22 Oct, 09:12:03 (wall time)');
    expect(time.getAttribute('datetime')).toBe('2026-10-22T06:12:03.000Z');
  });
});

describe('Percent and Ratio', () => {
  const ratio = { fraction: '83/100', decimal: '0.8304' } as const;

  it('Percent: two decimals with a space before the sign; raw decimal, fraction and tooltip', () => {
    render(<Percent ratio={ratio} na="n/a reason" testId="p" />);
    const percent = screen.getByTestId('p');
    expect(percent.textContent).toBe('83.04 %');
    expect(percent.dataset.decimal).toBe('0.8304');
    expect(percent.dataset.fraction).toBe('83/100');
    expect(percent.getAttribute('title')).toBe('83/100 exactly');
  });

  it('Ratio: the four-decimal string with the same markers', () => {
    render(<Ratio ratio={ratio} na="reason" testId="r" />);
    const value = screen.getByTestId('r');
    expect(value.textContent).toBe('0.8304');
    expect(value.dataset.decimal).toBe('0.8304');
    expect(value.dataset.fraction).toBe('83/100');
  });

  it('not applicable: Missing with the reason, the raw markers n/a', () => {
    for (const Component of [Percent, Ratio]) {
      const { unmount } = render(
        <Component ratio={null} na="Not applicable: no planned busy time" testId="x" />,
      );
      const element = screen.getByTestId('x');
      expect(element.dataset.decimal).toBe('n/a');
      expect(element.dataset.fraction).toBe('n/a');
      expect(element.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
      expect(element.querySelector('.sr-only')?.textContent).toBe(
        'Not applicable: no planned busy time',
      );
      unmount();
    }
  });
});

describe('Quantity', () => {
  it('writes counts and values by 6.1 with the unit after a space and the raw value', () => {
    const cases: [value: number, places: number, unit: string | undefined, text: string][] = [
      [60, 0, 'blanks', '60 blanks'],
      [1800, 1, 'min', '1800.0 min'],
      [12_345, 0, 'pieces', '12,345 pieces'],
      [1_234_567.25, 2, undefined, '1,234,567.25'],
      [-93.14, 1, 'min', '−93.1 min'],
      [-0.01, 1, undefined, '0.0'],
    ];
    for (const [value, places, unit, text] of cases) {
      const { unmount } = render(
        <Quantity value={value} places={places} testId="q" {...(unit ? { unit } : {})} />,
      );
      const element = screen.getByTestId('q');
      expect(element.textContent).toBe(text);
      expect(element.dataset.value).toBe(String(value));
      expect(element.className).toContain('tabular-nums');
      unmount();
    }
  });
});
