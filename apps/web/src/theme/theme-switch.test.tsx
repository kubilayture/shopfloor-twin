import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushOverlayEvents } from '../test/overlay.ts';
import { setThemePreference, THEME_STORAGE_KEY } from './theme-preference.ts';
import { ThemeMenu, ThemeRadioGroup } from './theme-switch.tsx';

/** UX-12 (#336): the switch in the top bar and on the account page, one stored choice. */

const root = document.documentElement;
let items = new Map<string, string>();

beforeEach(() => {
  items = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
});

afterEach(() => {
  act(() => {
    setThemePreference('system');
  });
  vi.unstubAllGlobals();
  root.removeAttribute('data-theme');
});

describe('ThemeMenu (top bar)', () => {
  it('names the choice in use, and offers System, Light and Dark as radio items', async () => {
    render(<ThemeMenu />);
    const trigger = screen.getByRole('button', { name: 'Theme: System' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('title')).toBe('Theme: System');
    expect(trigger.querySelector('[data-icon="monitor"]')).not.toBeNull();
    // The list has a stable name; the choice is in its checked item and the button's name.
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('Theme');
    fireEvent.click(trigger);
    await flushOverlayEvents();
    const choices = screen.getAllByRole('menuitemradio');
    expect(choices.map((choice) => choice.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    // Keyboard focus starts on the first choice.
    expect(document.activeElement).toBe(choices[0]);
  });

  it('applies, stores and shows a choice', async () => {
    render(<ThemeMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme: System' }));
    await flushOverlayEvents();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    await flushOverlayEvents();
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(items.get(THEME_STORAGE_KEY)).toBe('dark');
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' });
    expect(trigger.querySelector('[data-icon="moon"]')).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    await flushOverlayEvents();
    expect(screen.getByTestId('theme-dark').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('theme-light'));
    await flushOverlayEvents();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(
      screen.getByRole('button', { name: 'Theme: Light' }).querySelector('[data-icon="sun"]'),
    ).not.toBeNull();
  });
});

describe('ThemeRadioGroup (account page)', () => {
  it('is a group "Theme" of three radios with the choice checked', () => {
    act(() => {
      setThemePreference('light');
    });
    render(<ThemeRadioGroup />);
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(group.tagName).toBe('FIELDSET');
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((radio) => radio.value)).toEqual(['system', 'light', 'dark']);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).checked).toBe(true);
    expect(group.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('applies a choice at once, and the top bar follows', async () => {
    render(
      <>
        <ThemeMenu />
        <ThemeRadioGroup />
      </>,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(items.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Theme: Dark' })).toBeTruthy();
    // And the other way round.
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }));
    await flushOverlayEvents();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'System' }));
    await flushOverlayEvents();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'System' }).checked).toBe(true);
    expect(items.has(THEME_STORAGE_KEY)).toBe(false);
  });
});
