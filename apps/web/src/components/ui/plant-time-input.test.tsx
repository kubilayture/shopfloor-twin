import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PlantTimeInput, readPlantTime, type PlantTimeInputProps } from './plant-time-input.tsx';

const noop = (): void => undefined;

const describedText = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id} missing`)
    .join(' | ');

/** A night shift: 22:00 on Mon 12 Oct to 06:00 on Tue 13 Oct, plant time (UTC+3). */
const NIGHT = { min: '2026-10-12T19:00:00.000Z', max: '2026-10-13T03:00:00.000Z' };

/** The input with its value held by a parent, as a screen holds it; `sent` records each change. */
function Harness(
  props: Partial<PlantTimeInputProps> & { readonly sent: (iso: string | null) => void },
) {
  const { sent, value: initial = null, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <PlantTimeInput
        label="Split at"
        name="split-at"
        testId="split-at"
        {...rest}
        value={value}
        onChange={(iso) => {
          sent(iso);
          setValue(iso);
        }}
      />
      <button
        type="button"
        onClick={() => {
          setValue(null);
        }}
      >
        Reset
      </button>
      <output data-testid="held">{value ?? 'null'}</output>
    </>
  );
}

const plant = { withSeconds: true, variant: 'plant' } as const;

/** UX-1d2 (#319): design system 4.8. */
describe('readPlantTime', () => {
  it('reads date and time in the plant zone, across plant midnight', () => {
    expect(readPlantTime('12/10/2026', '08:00:00', plant)).toEqual({
      kind: 'ok',
      instant: Date.parse('2026-10-12T05:00:00Z'),
      day: '2026-10-12',
    });
    // 00:30 on the 13th in the plant is 21:30 on the 12th in UTC.
    expect(readPlantTime('13/10/2026', '00:30:00', plant)).toMatchObject({
      instant: Date.parse('2026-10-12T21:30:00Z'),
    });
    expect(readPlantTime('12/10/2026', '23:59:59', plant)).toMatchObject({
      instant: Date.parse('2026-10-12T20:59:59Z'),
    });
  });

  it('is empty with nothing typed, and says which box is wrong otherwise', () => {
    expect(readPlantTime('', '', plant)).toEqual({ kind: 'empty' });
    expect(readPlantTime(' ', ' ', plant)).toEqual({ kind: 'empty' });
    expect(readPlantTime('12/10/2026', '', plant)).toMatchObject({ kind: 'error', field: 'time' });
    expect(readPlantTime('', '08:00', plant)).toMatchObject({
      kind: 'error',
      field: 'date',
      message: 'Enter the date as dd/mm/yyyy, for example 12/10/2026.',
    });
    expect(readPlantTime('12/10/2026', '8 o’clock', plant)).toEqual({
      kind: 'error',
      field: 'time',
      message: 'Enter the time as hh:mm:ss, for example 14:05:09.',
    });
    expect(
      readPlantTime('12/10/2026', 'x', { withSeconds: false, variant: 'plant' }),
    ).toMatchObject({
      message: 'Enter the time as hh:mm, for example 14:05.',
    });
  });

  it('with both bounds takes the day the time falls on inside them', () => {
    const night = { ...plant, ...NIGHT };
    expect(readPlantTime('', '23:00:00', night)).toEqual({
      kind: 'ok',
      instant: Date.parse('2026-10-12T20:00:00Z'),
      day: '2026-10-12',
    });
    expect(readPlantTime('', '00:05:00', night)).toEqual({
      kind: 'ok',
      instant: Date.parse('2026-10-12T21:05:00Z'),
      day: '2026-10-13',
    });
    // The bounds are inclusive.
    expect(readPlantTime('', '22:00:00', night)).toMatchObject({ day: '2026-10-12' });
    expect(readPlantTime('', '06:00:00', night)).toMatchObject({ day: '2026-10-13' });
    expect(readPlantTime('', '12:00:00', night)).toEqual({
      kind: 'error',
      field: 'time',
      message: 'Enter a time between Mon 12 Oct, 22:00:00 and Tue 13 Oct, 06:00:00.',
    });
    // A chosen day is kept: 23:00 on the 13th is after the shift.
    expect(readPlantTime('2026-10-13', '23:00:00', night)).toMatchObject({ kind: 'error' });
    expect(readPlantTime('', '', night)).toEqual({ kind: 'empty' });
  });

  it('checks a single bound', () => {
    expect(readPlantTime('12/10/2026', '07:00:00', { ...plant, min: NIGHT.min })).toMatchObject({
      message: 'Enter a time from Mon 12 Oct, 22:00:00 on.',
    });
    expect(readPlantTime('13/10/2026', '07:00:00', { ...plant, max: NIGHT.max })).toMatchObject({
      message: 'Enter a time up to Tue 13 Oct, 06:00:00.',
    });
  });

  it('takes a whole ISO 8601 instant in the time box in the console variant only', () => {
    const console = { withSeconds: true, variant: 'console' } as const;
    expect(readPlantTime('', '2026-10-12T21:30:00Z', console)).toEqual({
      kind: 'ok',
      instant: Date.parse('2026-10-12T21:30:00Z'),
      day: '2026-10-13',
    });
    expect(readPlantTime('01/01/2020', '2026-10-12T05:37:00.123Z', console)).toMatchObject({
      instant: Date.parse('2026-10-12T05:37:00.123Z'),
    });
    expect(readPlantTime('', '2026-10-12T05:00:00Z', plant)).toMatchObject({ kind: 'error' });
    expect(readPlantTime('', 'x', console)).toMatchObject({
      message:
        'Enter the time as hh:mm:ss, for example 14:05:09, or a whole ISO 8601 instant such as 2026-10-12T05:00:00Z.',
    });
  });
});

describe('PlantTimeInput', () => {
  it('names the zone, labels both boxes and shows the UTC instant live', () => {
    const sent = vi.fn();
    render(<Harness sent={sent} withSeconds required />);
    const group = screen.getByRole('group', {
      name: 'Split at (plant time, Europe/Istanbul) (required)',
    });
    expect(group.tagName).toBe('FIELDSET');
    const date = within(group).getByRole('textbox', { name: 'Date' });
    const time = within(group).getByRole('textbox', { name: 'Time' });
    expect(time.dataset.testid).toBe('split-at');
    expect(date.dataset.testid).toBe('split-at-date');
    expect([date.getAttribute('name'), time.getAttribute('name')]).toEqual([
      'split-at-date',
      'split-at-time',
    ]);
    expect(time.getAttribute('aria-required')).toBe('true');
    // Plain text boxes, never the native pickers.
    expect([date.getAttribute('type'), time.getAttribute('type')]).toEqual(['text', 'text']);
    expect(screen.getByTestId('split-at-utc').textContent).toBe(
      'Date as dd/mm/yyyy, time as hh:mm:ss.',
    );

    fireEvent.change(date, { target: { value: '13/10/2026' } });
    expect(sent).not.toHaveBeenCalled();
    fireEvent.change(time, { target: { value: '00:30:00' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T21:30:00.000Z');
    expect(screen.getByTestId('split-at-utc').textContent).toBe('= 2026-10-12 21:30:00 UTC');
    expect(describedText(time)).toBe('= 2026-10-12 21:30:00 UTC');
    expect(group.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe(
      '2026-10-12T21:30:00.000Z',
    );
    expect(group.getAttribute('name')).toBeNull();
  });

  it('takes a whole hh:mm:ss filled into the time box inside its bounds (the split)', () => {
    const sent = vi.fn();
    render(<Harness sent={sent} withSeconds {...NIGHT} />);
    const day = screen.getByRole('combobox', { name: 'Date' });
    expect(
      within(day)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Mon 12 Oct', 'Tue 13 Oct']);
    fireEvent.change(screen.getByTestId('split-at'), { target: { value: '00:05:30' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T21:05:30.000Z');
    // The day it fell on shows in the picker.
    expect((day as HTMLSelectElement).value).toBe('2026-10-13');
    fireEvent.change(screen.getByTestId('split-at'), { target: { value: '23:15:00' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T20:15:00.000Z');
    expect((day as HTMLSelectElement).value).toBe('2026-10-12');
    // Choosing the other day moves the instant by a day, out of the shift.
    fireEvent.change(day, { target: { value: '2026-10-13' } });
    expect(sent).toHaveBeenLastCalledWith(null);
  });

  it('with bounds and a value, moves the day with a new time, also after leaving', () => {
    const sent = vi.fn();
    render(<Harness sent={sent} withSeconds {...NIGHT} value="2026-10-12T21:05:30.000Z" />);
    const day = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Date' });
    const time = screen.getByTestId<HTMLInputElement>('split-at');
    expect([day.value, time.value]).toEqual(['2026-10-13', '00:05:30']);
    fireEvent.change(time, { target: { value: '23:15:00' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T20:15:00.000Z');
    fireEvent.blur(time);
    fireEvent.change(time, { target: { value: '01:00:00' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T22:00:00.000Z');
    expect(day.value).toBe('2026-10-13');
  });

  it('shows its own error on leaving, on the box that is wrong, and clears it when fixed', () => {
    const sent = vi.fn();
    render(<Harness sent={sent} withSeconds {...NIGHT} />);
    const time = screen.getByTestId('split-at');
    fireEvent.change(time, { target: { value: '12:00:00' } });
    expect(sent).not.toHaveBeenCalled(); // still null
    expect(time.hasAttribute('aria-invalid')).toBe(false);
    fireEvent.blur(time);
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Date' }).hasAttribute('aria-invalid')).toBe(false);
    expect(describedText(time)).toBe(
      'Time as hh:mm:ss. | Enter a time between Mon 12 Oct, 22:00:00 and Tue 13 Oct, 06:00:00.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(time, { target: { value: '02:00:00' } });
    expect(time.hasAttribute('aria-invalid')).toBe(false);
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T23:00:00.000Z');
  });

  it('marks the date box for a bad date and shows the caller’s error when its own is none', () => {
    const { rerender } = render(
      <PlantTimeInput label="Due" name="due" value={null} onChange={noop} testId="due" />,
    );
    const date = screen.getByTestId('due-date');
    const time = screen.getByTestId('due');
    fireEvent.change(date, { target: { value: '31/02/2026' } });
    fireEvent.change(time, { target: { value: '08:00' } });
    fireEvent.blur(time);
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(time.hasAttribute('aria-invalid')).toBe(false);
    expect(describedText(date)).toContain('Enter the date as dd/mm/yyyy');
    fireEvent.change(date, { target: { value: '' } });
    fireEvent.change(time, { target: { value: '' } });
    rerender(
      <PlantTimeInput
        label="Due"
        name="due"
        value={null}
        onChange={noop}
        testId="due"
        error="A due time is required."
      />,
    );
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(time.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(time)).toBe(
      'Date as dd/mm/yyyy, time as hh:mm. | A due time is required.',
    );
  });

  it('shows a value it is given and is reset by its owner', () => {
    const sent = vi.fn();
    render(<Harness sent={sent} value="2026-10-12T21:30:09.000Z" />);
    const date = screen.getByTestId<HTMLInputElement>('split-at-date');
    const time = screen.getByTestId<HTMLInputElement>('split-at');
    // Seconds that are there are shown even without `withSeconds`.
    expect([date.value, time.value]).toEqual(['13/10/2026', '00:30:09']);
    fireEvent.change(time, { target: { value: '01:00' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T22:00:00.000Z');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect([date.value, time.value]).toEqual(['', '']);
    expect(screen.getByTestId('held').textContent).toBe('null');
  });

  it('fills an empty date from defaultDate (the plant clock’s day)', () => {
    render(
      <PlantTimeInput
        label="At"
        name="at"
        value={null}
        onChange={noop}
        testId="at"
        defaultDate="2026-10-12T21:30:00Z"
      />,
    );
    expect(screen.getByTestId<HTMLInputElement>('at-date').value).toBe('13/10/2026');
  });

  it('console variant: simulation time, an ISO 8601 instant filled whole, empty is null', () => {
    const sent = vi.fn();
    render(
      <Harness
        sent={sent}
        label="Until"
        name="drift-until"
        testId="drift-until"
        variant="console"
        withSeconds
      />,
    );
    expect(
      screen.getByRole('group', { name: 'Until (simulation time, Europe/Istanbul)' }),
    ).toBeTruthy();
    const time = screen.getByTestId<HTMLInputElement>('drift-until');
    fireEvent.change(time, { target: { value: '2026-10-12T05:37:00.123Z' } });
    expect(sent).toHaveBeenLastCalledWith('2026-10-12T05:37:00.123Z');
    expect(screen.getByTestId('drift-until-utc').textContent).toBe('= 2026-10-12 05:37:00.123 UTC');
    // Leaving tidies it into the boxes; the value keeps its milliseconds.
    fireEvent.blur(time);
    expect(screen.getByTestId<HTMLInputElement>('drift-until-date').value).toBe('12/10/2026');
    expect(time.value).toBe('08:37:00');
    expect(screen.getByTestId('held').textContent).toBe('2026-10-12T05:37:00.123Z');
    // Emptied (the failure's optional time): null.
    fireEvent.change(screen.getByTestId('drift-until-date'), { target: { value: '' } });
    fireEvent.change(time, { target: { value: '' } });
    expect(sent).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('held').textContent).toBe('null');
  });

  it('gives each box a 36 px (24 px minimum) target and disables both', () => {
    render(
      <PlantTimeInput label="At" name="at" value={null} onChange={noop} testId="at" disabled />,
    );
    for (const box of [screen.getByTestId('at-date'), screen.getByTestId('at')]) {
      expect(box.className.split(' ')).toContain('min-h-9');
      expect(box.matches(':disabled')).toBe(true);
    }
  });
});
