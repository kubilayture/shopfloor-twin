import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton, buttonClass, type ButtonSize, type ButtonVariant } from './button.tsx';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'dangerSolid'];
const classesOf = (element: HTMLElement): string[] => element.className.split(/\s+/);

/** UX-1c (#315): design system 4.1. */
describe('Button', () => {
  it('is a native button named by its label, type "button" unless told otherwise', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>Save coding</Button>
        <Button type="submit">Sign in</Button>
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save coding' });
    expect(save.getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('type')).toBe('submit');
    fireEvent.click(save);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is reachable by keyboard and takes focus (the ring comes from the base style)', () => {
    render(<Button>Acknowledge</Button>);
    const button = screen.getByRole('button', { name: 'Acknowledge' });
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    // No variant removes the outline: the focus ring of index.css applies to every button.
    for (const variant of VARIANTS) {
      expect(buttonClass({ variant })).not.toMatch(/outline-none|outline-0/);
    }
  });

  it('defaults to secondary md and passes test ids and other attributes through', () => {
    render(
      <Button data-testid="ack-selected" aria-describedby="hint">
        Acknowledge selected (3)
      </Button>,
    );
    const button = screen.getByTestId('ack-selected');
    expect(button.getAttribute('aria-describedby')).toBe('hint');
    expect(button.className).toBe(buttonClass());
    expect(classesOf(button)).toEqual(
      expect.arrayContaining(['border-line-strong', 'bg-surface', 'text-ink', 'min-h-9']),
    );
  });

  it('draws each variant from the tokens', () => {
    const expected: Record<ButtonVariant, string[]> = {
      primary: [
        'bg-accent',
        'text-on-accent',
        'enabled:not-aria-disabled:hover:bg-accent-hover',
        'font-semibold',
      ],
      secondary: [
        'bg-surface',
        'border-line-strong',
        'enabled:not-aria-disabled:hover:bg-surface-hover',
      ],
      ghost: [
        'border-transparent',
        'text-accent',
        'enabled:not-aria-disabled:hover:bg-surface-hover',
      ],
      danger: [
        'bg-surface',
        'border-alarm-border',
        'text-alarm-ink',
        'enabled:not-aria-disabled:hover:bg-alarm-soft',
      ],
      // Its hover is a token pair of the design system: white on alarm-solid-hover, AA both themes.
      dangerSolid: [
        'bg-alarm-solid',
        'text-alarm-on-solid',
        'font-semibold',
        'enabled:not-aria-disabled:hover:bg-alarm-solid-hover',
      ],
    };
    for (const variant of VARIANTS) {
      const classes = buttonClass({ variant }).split(' ');
      expect(classes, variant).toEqual(expect.arrayContaining(expected[variant]));
      // Raw palette classes never: only token utilities.
      expect(buttonClass({ variant }), variant).not.toMatch(
        /-(slate|gray|sky|red|amber|emerald)-\d|(bg|text|border)-(white|black)/,
      );
    }
  });

  it('has the four sizes of the design system', () => {
    const heights: Record<ButtonSize, string> = {
      sm: 'min-h-7',
      md: 'min-h-9',
      lg: 'min-h-11',
      touch: 'min-h-14',
    };
    const padding: Record<ButtonSize, string> = {
      sm: 'px-2.5',
      md: 'px-3.5',
      lg: 'px-4.5',
      touch: 'px-5',
    };
    for (const size of ['sm', 'md', 'lg', 'touch'] as const) {
      const classes = buttonClass({ size }).split(' ');
      expect(classes, size).toContain(heights[size]);
      expect(classes, size).toContain(padding[size]);
    }
    expect(buttonClass({ fullWidth: true }).split(' ')).toContain('w-full');
    expect(buttonClass().split(' ')).not.toContain('w-full');
  });

  it('looks disabled the same way for every variant, never by opacity, and cannot be clicked', () => {
    const onClick = vi.fn();
    render(
      <>
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} disabled onClick={onClick}>
            {variant}
          </Button>
        ))}
      </>,
    );
    for (const variant of VARIANTS) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name: variant });
      expect(button.disabled).toBe(true);
      expect(classesOf(button)).toEqual(
        expect.arrayContaining([
          'disabled:bg-disabled',
          'disabled:border-disabled-line',
          'disabled:text-disabled-ink',
          'disabled:cursor-not-allowed',
        ]),
      );
      expect(button.className).not.toMatch(/opacity/);
      // Hover is only for an enabled button: a disabled primary never lights up.
      expect(classesOf(button).filter((c) => c.startsWith('hover:'))).toEqual([]);
      fireEvent.click(button);
    }
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a leading icon, hidden from assistive technology', () => {
    render(<Button icon="print">Print</Button>);
    const button = screen.getByRole('button', { name: 'Print' });
    const icon = button.querySelector('svg[data-icon="print"]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(button.textContent).toBe('Print');
  });

  it('loading: keeps the label as its name, shows a spinner instead of the icon, busy, inert to clicks', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button icon="check" loading onClick={onClick}>
        Save coding
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save coding' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Not natively disabled: it keeps the keyboard focus (see the next test).
    expect(button.disabled).toBe(false);
    // The disabled look, by aria-disabled: never opacity, no hover.
    expect(classesOf(button)).toEqual(
      expect.arrayContaining([
        'aria-disabled:bg-disabled',
        'aria-disabled:border-disabled-line',
        'aria-disabled:text-disabled-ink',
        'aria-disabled:cursor-not-allowed',
      ]),
    );
    expect(button.querySelector('svg[data-icon="spinner"]')).not.toBeNull();
    expect(button.querySelector('svg[data-icon="check"]')).toBeNull();
    // Reduced motion: a still ellipsis instead of the turning arc, both decorative.
    const [spinning, still] = button.querySelectorAll('[data-spinner]');
    expect(spinning?.className).toContain('motion-safe:inline-flex');
    expect(spinning?.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
    expect(still?.className).toContain('motion-safe:hidden');
    expect(still?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(
      <Button icon="check" onClick={onClick}>
        Save coding
      </Button>,
    );
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.querySelector('[data-spinner]')).toBeNull();
    expect(button.querySelector('svg[data-icon="check"]')).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the focus when it starts loading, and ignores Enter and clicks until it is done', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button onClick={onClick} data-testid="save">
        Save coding
      </Button>,
    );
    const button = screen.getByTestId('save');
    button.focus();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} data-testid="save" loading>
        Save coding
      </Button>,
    );
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} data-testid="save">
        Save coding
      </Button>,
    );
    expect(document.activeElement).toBe(button);
  });

  it('a loading submit button does not submit its form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Release
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit">Release</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a disabled button that is also loading stays natively disabled', () => {
    render(
      <Button loading disabled>
        Release
      </Button>,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Release' }).disabled).toBe(true);
  });
});

describe('IconButton', () => {
  it('is named and titled by its label, square, with its icon hidden', () => {
    render(<IconButton icon="close" label="Close the panel" data-testid="panel-close" />);
    const button = screen.getByRole('button', { name: 'Close the panel' });
    expect(button.getAttribute('title')).toBe('Close the panel');
    expect(button.getAttribute('data-testid')).toBe('panel-close');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(button)).toContain('min-w-9');
    expect(classesOf(button)).not.toContain('px-3.5');
  });

  it('sizes the square with the button (24 px minimum target at sm and above)', () => {
    render(<IconButton icon="info" label="About line OEE" size="sm" variant="ghost" />);
    const button = screen.getByRole('button', { name: 'About line OEE' });
    expect(classesOf(button)).toEqual(expect.arrayContaining(['min-w-7', 'min-h-7']));
  });

  it('keeps its name while loading', () => {
    render(<IconButton icon="download" label="Download CSV" loading />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Download CSV' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('refuses an empty or blank label', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // @ts-expect-error -- a literal empty label is a type error: an unnamed button
    expect(() => render(<IconButton icon="close" label="" />)).toThrow(/needs a label/);
    const blank = ['  '].join('');
    expect(() => render(<IconButton icon="close" label={blank} />)).toThrow(/needs a label/);
    vi.restoreAllMocks();
  });
});
