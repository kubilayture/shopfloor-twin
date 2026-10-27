import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTheme,
  currentTheme,
  DARK_QUERY,
  getThemePreference,
  readPreference,
  resolveTheme,
  setThemePreference,
  startTheme,
  subscribeThemePreference,
  THEME_STORAGE_KEY,
} from './theme-preference.ts';

/** UX-12 (#336): the stored choice, the theme on `<html>`, the system setting and print. */

const root = document.documentElement;

/** A `matchMedia` whose dark query answers `dark`, and that can change. */
function systemSetting(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    media: DARK_QUERY,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const matchMedia = vi.fn((media: string) => ({
    ...query,
    matches: media === DARK_QUERY && query.matches,
  }));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  return {
    matchMedia,
    listeners,
    change(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function removeMatchMedia() {
  Reflect.deleteProperty(window, 'matchMedia');
}

/** An in-memory `Storage` (this jsdom's `localStorage` may be missing). */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

let storage = memoryStorage();
let stop: (() => void) | undefined;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  root.removeAttribute('data-theme');
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  setThemePreference('system');
  vi.unstubAllGlobals();
  root.removeAttribute('data-theme');
  removeMatchMedia();
});

/** Runs `source` as the page runs a classic script: alone, with only the globals in scope. */
function runScript(source: string): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the emitted boot script itself
  const script = new Function(source) as () => void;
  script();
}

describe('bootTheme, the script in <head>', () => {
  /** Runs it as the build emits it: its own source, called with the key and the query. */
  const boot = () => {
    runScript(
      `(${bootTheme.toString()})(${JSON.stringify(THEME_STORAGE_KEY)}, ${JSON.stringify(DARK_QUERY)});`,
    );
  };

  it.each([
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    [null, true, 'dark'],
    [null, false, 'light'],
    ['purple', true, 'dark'],
  ] as const)('stored %s with a dark system %s: %s', (stored, dark, expected) => {
    systemSetting(dark);
    if (stored !== null) storage.setItem(THEME_STORAGE_KEY, stored);
    boot();
    expect(root.getAttribute('data-theme')).toBe(expected);
  });

  it('runs alone from its own source: it reads only its arguments', () => {
    systemSetting(false);
    storage.setItem('another-key', 'dark');
    runScript(`(${bootTheme.toString()})("another-key", "(min-width: 0)");`);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('is light when storage is blocked and there is no matchMedia', () => {
    removeMatchMedia();
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    boot();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('follows the system without localStorage', () => {
    systemSetting(true);
    vi.stubGlobal('localStorage', undefined);
    boot();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('follows the system when storage is blocked', () => {
    systemSetting(true);
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    boot();
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('the stored choice', () => {
  it('resolves System by the system setting, Light and Dark as they are', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('reads System without a stored value, with an unknown one, or with storage blocked', () => {
    expect(readPreference()).toBe('system');
    storage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readPreference()).toBe('system');
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readPreference()).toBe('dark');
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readPreference()).toBe('system');
  });

  it('stores Light and Dark, removes the key for System, and applies the theme at once', () => {
    systemSetting(false);
    setThemePreference('dark');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(getThemePreference()).toBe('dark');
    setThemePreference('light');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    setThemePreference('system');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('keeps the choice for the page when storage refuses it', () => {
    systemSetting(false);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    setThemePreference('dark');
    expect(getThemePreference()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('tells every subscriber, until it unsubscribes', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeThemePreference(heard);
    setThemePreference('dark');
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
    setThemePreference('light');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('is light without matchMedia (jsdom, old browsers) under System', () => {
    removeMatchMedia();
    expect(currentTheme()).toBe('light');
  });
});

describe('startTheme', () => {
  it('applies the stored choice', () => {
    systemSetting(false);
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    stop = startTheme();
    expect(getThemePreference()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('follows a change of the system setting under System, not under a fixed choice', () => {
    const system = systemSetting(false);
    stop = startTheme();
    expect(root.getAttribute('data-theme')).toBe('light');
    system.change(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
    setThemePreference('light');
    system.change(false);
    system.change(true);
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('takes a choice made in another tab', () => {
    systemSetting(false);
    stop = startTheme();
    const heard = vi.fn();
    const unsubscribe = subscribeThemePreference(heard);
    storage.setItem(THEME_STORAGE_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    expect(root.getAttribute('data-theme')).toBe('light');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(getThemePreference()).toBe('dark');
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('prints light from the dark theme and puts the dark theme back afterwards', () => {
    const system = systemSetting(true);
    stop = startTheme();
    expect(root.getAttribute('data-theme')).toBe('dark');
    window.dispatchEvent(new Event('beforeprint'));
    expect(root.getAttribute('data-theme')).toBe('light');
    // Nothing turns it dark while the page is printed.
    system.change(true);
    setThemePreference('dark');
    expect(root.getAttribute('data-theme')).toBe('light');
    window.dispatchEvent(new Event('afterprint'));
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('stops listening when stopped', () => {
    const system = systemSetting(false);
    startTheme()();
    expect(system.listeners.size).toBe(0);
    system.change(true);
    expect(root.getAttribute('data-theme')).toBe('light');
    window.dispatchEvent(new Event('beforeprint'));
    expect(root.getAttribute('data-theme')).toBe('light');
    root.setAttribute('data-theme', 'dark');
    window.dispatchEvent(new Event('afterprint'));
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});
