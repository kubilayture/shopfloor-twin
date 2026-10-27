import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommentInput } from '../quality-ui.tsx';
import {
  Checkbox,
  ChoiceGroup,
  NumberInput,
  RadioGroup,
  Select,
  Textarea,
  TextInput,
} from './controls.tsx';
import { CharacterCount, controlClass, Field } from './field.tsx';
import { FilterBar } from './filter-bar.tsx';
import { PlantTimeInput } from './plant-time-input.tsx';

const noop = (): void => undefined;

const classesOf = (element: Element): string[] => element.className.split(/\s+/);
const describedText = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id} missing`)
    .join(' | ');

/** UX-1d2 (#319): design system 4.7. */
describe('Field', () => {
  it('ties the label, the hint and the error to the control', () => {
    render(
      <Field label="Order number" hint="As on the traveller." error="No such order." required>
        {({ id, describedBy, invalid }) => (
          <input id={id} name="order" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Order number (required)' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(input)).toBe('As on the traveller. | No such order.');
    // The error has no role: the form's summary announces.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(classesOf(screen.getByText('No such order.').parentElement as Element)).toContain(
      'text-alarm-ink',
    );
  });

  it('says nothing for an optional field and describes nothing without hint or error', () => {
    render(
      <Field label="Note">
        {({ id, describedBy, invalid }) => (
          <input id={id} name="note" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Note' });
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText(/optional/)).toBeNull();
  });

  it('puts the label left of the control when inline (filter bars)', () => {
    render(
      <Field label="Shift" inline>
        {({ id }) => <select id={id} name="shift" />}
      </Field>,
    );
    const select = screen.getByRole('combobox', { name: 'Shift' });
    expect(classesOf(select.parentElement as Element)).toEqual(
      expect.arrayContaining(['flex', 'items-center']),
    );
  });
});

describe('the controls', () => {
  it('give every control an id and a name (G-23)', () => {
    const { container } = render(
      <form>
        <TextInput label="Order" name="order" defaultValue="" />
        <Textarea label="Comment" name="comment" value="" onChange={noop} max={500} />
        <Select label="Reason" name="reason" defaultValue="a">
          <option value="a">A</option>
        </Select>
        <NumberInput label="Repair" name="repair" unit="min" defaultValue="" />
        <Checkbox label="Only open" name="open" />
        <RadioGroup
          legend="Kind"
          name="kind"
          options={[
            { value: 'lot', label: 'Lot' },
            { value: 'serial', label: 'Serial' },
          ]}
          value="lot"
          onChange={noop}
        />
        <PlantTimeInput label="At" name="at" value={null} onChange={noop} />
      </form>,
    );
    const controls = [...container.querySelectorAll('input, select, textarea')];
    expect(controls.length).toBe(10);
    for (const control of controls) {
      expect(control.getAttribute('name'), control.outerHTML).toBeTruthy();
      if (control.getAttribute('type') !== 'hidden') {
        expect(control.id, control.outerHTML).toBeTruthy();
      }
    }
  });

  it('TextInput: the control look, invalid and disabled from the tokens', () => {
    render(
      <>
        <TextInput label="Lot" name="lot" error="Unknown lot." data-testid="lot" />
        <TextInput label="Serial" name="serial" disabled />
      </>,
    );
    const lot = screen.getByRole('textbox', { name: 'Lot' });
    expect(lot.dataset.testid).toBe('lot');
    expect(lot.getAttribute('name')).toBe('lot');
    expect(lot.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(lot)).toBe('Unknown lot.');
    expect(classesOf(lot)).toEqual(
      expect.arrayContaining([
        'min-h-9',
        'rounded-md',
        'border-line-strong',
        'bg-surface',
        'aria-invalid:border-alarm-border',
        'disabled:bg-disabled',
        'disabled:border-disabled-line',
        'disabled:text-disabled-ink',
      ]),
    );
    expect(lot.className).not.toMatch(/opacity/);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Serial' }).disabled).toBe(true);
  });

  it('controlClass: 36 px on the desk, 44 px with 16 px text for login and account, 56 px in the terminal', () => {
    expect(classesOf({ className: controlClass() } as Element)).toEqual(
      expect.arrayContaining(['min-h-9', 'text-sm']),
    );
    const lg = classesOf({ className: controlClass({ size: 'lg' }) } as Element);
    expect(lg).toEqual(expect.arrayContaining(['min-h-11', 'px-3', 'py-2', 'text-base']));
    expect(lg).not.toContain('text-sm');
    expect(classesOf({ className: controlClass({ size: 'touch' }) } as Element)).toEqual(
      expect.arrayContaining(['min-h-14', 'text-lg']),
    );
  });

  it('Textarea: the character count under the box, described by it, over the limit in red', () => {
    const { rerender } = render(
      <Textarea label="Comment" name="comment" value="checked" max={10} onChange={noop} />,
    );
    const box = screen.getByRole('textbox', { name: 'Comment' });
    expect(box.getAttribute('maxlength')).toBe('10');
    expect(describedText(box)).toBe('7 of 10 characters');
    rerender(
      <Textarea
        label="Comment"
        name="comment"
        value="checked the jig"
        max={10}
        hint="Shown in the audit."
        onChange={noop}
      />,
    );
    expect(describedText(box)).toBe('Shown in the audit. | 15 of 10 characters (5 too many)');
    expect(classesOf(screen.getByText(/15 of 10/))).toContain('text-alarm-ink');
  });

  it('Select: the native select with the chevron, changed as specs do with selectOption', () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Reason"
        name="hold-reason"
        data-testid="hold-reason"
        value="SCRATCH"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="SCRATCH">Scratch (SCRATCH)</option>
        <option value="DENT">Dent (DENT)</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Reason' });
    expect(select.tagName).toBe('SELECT');
    expect(select.dataset.testid).toBe('hold-reason');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Scratch (SCRATCH)', 'Dent (DENT)']);
    expect(classesOf(select)).toContain('appearance-none');
    expect(select.parentElement?.querySelector('[data-icon="chevron-down"]')).not.toBeNull();
    fireEvent.change(select, { target: { value: 'DENT' } });
    expect(onChange).toHaveBeenCalledWith('DENT');
  });

  it('NumberInput: a decimal text box with its unit read with it', () => {
    render(
      <NumberInput
        label="Repair time"
        name="repair"
        unit="min"
        defaultValue="x"
        hint="Optional."
        error="Enter a number."
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Repair time' });
    expect(box.getAttribute('inputmode')).toBe('decimal');
    expect(box.getAttribute('type')).toBe('text');
    // The unit is read first, right after the value: "x, min, Optional., Enter a number."
    expect(describedText(box)).toBe('min | Optional. | Enter a number.');
    expect(classesOf(box)).toContain('tabular-nums');
  });

  it('Checkbox: a 16 px box in a 24 px hit area that is its label', () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        label="Only open holds"
        name="open"
        hint="Hides closed ones."
        onChange={onChange}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Only open holds' });
    expect(classesOf(box)).toContain('size-4');
    expect(box.parentElement?.className.split(' ')).toContain('size-6');
    expect(box.closest('label')?.className.split(' ')).toContain('min-h-6');
    expect(describedText(box)).toBe('Hides closed ones.');
    // The whole label toggles it.
    fireEvent.click(screen.getByText('Only open holds'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Checkbox in the terminal: the hint starts under the label, past the 44 px box', () => {
    render(<Checkbox label="Scrap" name="scrap" size="touch" hint="Counts as a reject." />);
    const box = screen.getByRole('checkbox', { name: 'Scrap' });
    expect(box.parentElement?.className.split(' ')).toContain('size-11');
    expect(screen.getByText('Counts as a reject.').parentElement?.className).toBe('pl-12');
  });

  it('ChoiceGroup and RadioGroup: a fieldset named by its legend, one name, invalid choices', () => {
    function Kinds() {
      const [kind, setKind] = useState<'lot' | 'serial'>('lot');
      return (
        <RadioGroup
          legend="Subject"
          name="kind"
          required
          error="Choose one."
          options={[
            { value: 'lot', label: 'Lot', testId: 'kind-lot' },
            { value: 'serial', label: 'Serial', testId: 'kind-serial' },
          ]}
          value={kind}
          onChange={setKind}
        />
      );
    }
    render(
      <>
        <Kinds />
        <ChoiceGroup legend="Show" hint="Any of them." inline>
          <Checkbox label="Open" name="show-open" />
          <Checkbox label="Closed" name="show-closed" />
        </ChoiceGroup>
      </>,
    );
    const group = screen.getByRole('group', { name: 'Subject (required)' });
    expect(group.tagName).toBe('FIELDSET');
    expect(describedText(group)).toBe('Choose one.');
    const serial = within(group).getByRole('radio', { name: 'Serial' });
    expect(serial.getAttribute('name')).toBe('kind');
    expect(serial.getAttribute('aria-invalid')).toBe('true');
    expect(serial.dataset.testid).toBe('kind-serial');
    fireEvent.click(serial);
    expect((serial as HTMLInputElement).checked).toBe(true);
    expect(within(group).getByRole<HTMLInputElement>('radio', { name: 'Lot' }).checked).toBe(false);
    const show = screen.getByRole('group', { name: 'Show' });
    expect(describedText(show)).toBe('Any of them.');
    expect(within(show).getAllByRole('checkbox')).toHaveLength(2);
    expect(show.querySelector('legend')?.className).toBe('mb-1 text-sm font-medium text-ink');
  });

  it('ChoiceGroup with a hidden legend: still the group’s name, visually hidden', () => {
    render(
      <ChoiceGroup legend="Roles of ana" legendHidden inline>
        <Checkbox label="Operator" name="roles-ana" />
      </ChoiceGroup>,
    );
    const group = screen.getByRole('group', { name: 'Roles of ana' });
    expect(group.querySelector('legend')?.className).toBe('sr-only');
  });
});

describe('CharacterCount', () => {
  it('says how many of how many', () => {
    render(<CharacterCount id="c" length={12} max={500} />);
    expect(screen.getByText('12 of 500 characters').id).toBe('c');
  });
});

describe('FilterBar', () => {
  it('is a named group of inline fields with the summary at the end', () => {
    render(
      <FilterBar summary="4 records, 0 uncoded" data-testid="filters">
        <Select label="Shift" name="shift" inline defaultValue="A">
          <option value="A">A</option>
        </Select>
      </FilterBar>,
    );
    const bar = screen.getByRole('group', { name: 'Filters' });
    expect(bar.dataset.testid).toBe('filters');
    expect(within(bar).getByRole('combobox', { name: 'Shift' })).toBeTruthy();
    const summary = within(bar).getByText('4 records, 0 uncoded');
    expect(bar.lastElementChild).toBe(summary);
    expect(classesOf(summary)).toEqual(expect.arrayContaining(['md:ml-auto', 'w-full']));
    expect(classesOf(bar)).toEqual(expect.arrayContaining(['flex-wrap', 'gap-x-3']));
  });
});

describe('CommentInput (quality-ui, re-based on Textarea)', () => {
  it('keeps its id, test id, count and label; marks required, says nothing when optional', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CommentInput
        id="ack"
        label="Comment"
        value="checked"
        testId="ack-comment"
        max={500}
        required
        onChange={onChange}
      />,
    );
    const box = screen.getByTestId('ack-comment');
    expect(box.id).toBe('ack');
    expect(box.getAttribute('name')).toBe('ack-comment');
    expect(box.getAttribute('maxlength')).toBe('500');
    expect(box.getAttribute('aria-describedby')).toBe('ack-count');
    expect(screen.getByRole('textbox', { name: 'Comment (required)' })).toBe(box);
    // Said once, in the name: no aria-required as well (design system 4.7).
    expect(box.hasAttribute('aria-required')).toBe(false);
    expect(screen.getByText('7 of 500 characters').id).toBe('ack-count');
    fireEvent.change(box, { target: { value: 'checked the jig' } });
    expect(onChange).toHaveBeenCalledWith('checked the jig');
    rerender(
      <CommentInput
        id="ack"
        label="Comment"
        value=""
        testId="ack-comment"
        max={500}
        required={false}
        error="A comment is required."
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Comment' })).toBe(box);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(box)).toBe('A comment is required. | 0 of 500 characters');
  });
});
