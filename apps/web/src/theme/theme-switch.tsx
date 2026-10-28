import { useSyncExternalStore } from 'react';
import { RadioGroup } from '../components/ui/controls.tsx';
import type { IconName } from '../components/ui/icons.tsx';
import { Menu } from '../components/ui/menu.tsx';
import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from './theme-preference.ts';

/**
 * The theme switch (UX-12, #336; design system section 8) in its two places: a menu in the top
 * bar's user area and a radio group on the account page. Both show and set the one stored choice.
 */

const LABELS: Readonly<Record<ThemePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** The top bar's icon names the choice: a screen for System, a sun, a moon. */
const ICONS: Readonly<Record<ThemePreference, IconName>> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
};

/** The stored theme choice, kept current across every switch on the page and other tabs. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeThemePreference, getThemePreference, () => 'system');
}

/** The top bar's switch: an icon button ("Theme: Dark") opening System, Light, Dark. */
export function ThemeMenu() {
  const preference = useThemePreference();
  return (
    <Menu
      label={`Theme: ${LABELS[preference]}`}
      menuLabel="Theme"
      icon={ICONS[preference]}
      surface="dark"
      align="end"
      testId="theme-menu"
      items={THEME_PREFERENCES.map((choice) => ({
        id: choice,
        label: LABELS[choice],
        checked: choice === preference,
        testId: `theme-${choice}`,
        onSelect: () => {
          setThemePreference(choice);
        },
      }))}
    />
  );
}

/** The account page's switch: three radios, the choice applied as it is picked. */
export function ThemeRadioGroup() {
  const preference = useThemePreference();
  return (
    <RadioGroup
      name="theme"
      legend="Theme"
      hint="Stored in this browser. System follows your device's light or dark setting."
      value={preference}
      options={THEME_PREFERENCES.map((choice) => ({
        value: choice,
        label: LABELS[choice],
        testId: `theme-option-${choice}`,
      }))}
      onChange={(choice) => {
        setThemePreference(choice);
      }}
    />
  );
}
