import type { Theme } from '../components/ui/tokens.ts';

/**
 * The theme switch (UX-12, #336; design system section 8): System, Light or Dark, stored per
 * browser in `localStorage`. `<html data-theme>` always carries the theme in use, `light` or
 * `dark`, so the stylesheet (`index.css`), the charts (`chart/theme.ts`) and `color-scheme` all
 * follow one attribute. Without a stored choice the theme follows `prefers-color-scheme`, and
 * changes with it.
 *
 * Three steps keep the page from showing the wrong theme first:
 * 1. `bootTheme` runs as a classic script in `<head>`, before the body is parsed (an external
 *    file `vite.config.ts` emits, so the CSP needs no inline script);
 * 2. without scripts the stylesheet itself applies the dark values under `prefers-color-scheme:
 *    dark` while `data-theme` is absent;
 * 3. `startTheme`, the first thing `main.tsx` does, takes over: it follows the system setting,
 *    another tab's choice and printing.
 *
 * Print is always light: `beforeprint` sets `data-theme="light"` (the style is recomputed before
 * the page is laid out for paper) and `afterprint` puts the theme in use back.
 *
 * This file imports no React and no stylesheet: `vite.config.ts` reads `bootTheme` from it.
 */

export type ThemePreference = 'system' | Theme;

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** The `localStorage` key; absent means "System". */
export const THEME_STORAGE_KEY = 'shopfloor-twin.theme';

/** The system setting the "System" choice follows. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Sets `data-theme` on `<html>` from the stored choice, else the system setting. It runs alone
 * as a classic script before the body (its source is emitted by `vite.config.ts` as
 * `(bootTheme)(key, query)`), so it uses only its arguments and the platform: no import, no
 * module-level name. A missing or blocked storage follows the system; no `matchMedia`, light.
 */
export function bootTheme(key: string, query: string): void {
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    stored = null;
  }
  let dark = stored === 'dark';
  if (stored !== 'dark' && stored !== 'light') {
    try {
      dark = window.matchMedia(query).matches;
    } catch {
      dark = false;
    }
  }
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/**
 * The boot script exactly as it ships: `bootTheme`'s own source called with the key and the query.
 * `vite.config.ts` emits it (and runs it once in a bare context, so a helper the transpiler adds
 * fails the build), and `theme-preference.test.ts` runs the same string.
 */
export function bootScriptSource(): string {
  return `(${bootTheme.toString()})(${JSON.stringify(THEME_STORAGE_KEY)}, ${JSON.stringify(DARK_QUERY)});\n`;
}

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

/** The stored choice; "System" when none is stored, the value is unknown or storage is blocked. */
export function readPreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Stores the choice ("System" removes the key). A blocked storage keeps it for this page only. */
function storePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') globalThis.localStorage.removeItem(THEME_STORAGE_KEY);
    else globalThis.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode or a storage quota: the choice holds until the page is reloaded.
  }
}

function darkQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined;
}

/** The theme a choice gives with the system setting `systemDark`. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

let preference: ThemePreference = 'system';
let printing = false;
const listeners = new Set<() => void>();

/** The theme in use now, from the choice and the system setting. */
export function currentTheme(): Theme {
  return resolveTheme(preference, darkQuery()?.matches ?? false);
}

/** Puts the theme in use on `<html>`; while printing the page stays light. */
function apply(): void {
  if (printing) return;
  document.documentElement.setAttribute('data-theme', currentTheme());
}

export function getThemePreference(): ThemePreference {
  return preference;
}

/** Chooses, stores and applies a theme; every subscriber (the top bar, the account page) hears it. */
export function setThemePreference(next: ThemePreference): void {
  storePreference(next);
  preference = next;
  apply();
  for (const listener of listeners) listener();
}

export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Applies the stored choice and keeps the theme current: a change of the system setting (under
 * "System"), a choice made in another tab (the `storage` event), and printing (light from
 * `beforeprint` to `afterprint`). Returns the function that stops it.
 */
export function startTheme(): () => void {
  preference = readPreference();
  printing = false;
  apply();
  const query = darkQuery();
  const onSystem = () => {
    apply();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    preference = readPreference();
    apply();
    for (const listener of listeners) listener();
  };
  const onBeforePrint = () => {
    printing = true;
    document.documentElement.setAttribute('data-theme', 'light');
  };
  const onAfterPrint = () => {
    printing = false;
    apply();
  };
  query?.addEventListener('change', onSystem);
  window.addEventListener('storage', onStorage);
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);
  return () => {
    query?.removeEventListener('change', onSystem);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', onAfterPrint);
  };
}
