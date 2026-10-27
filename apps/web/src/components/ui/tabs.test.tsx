import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TabPanel, Tabs, tabElementId, tabPanelId, tabTarget } from './tabs.tsx';

/** UX-1d1 (#318): design system 4.6, the WAI-ARIA tabs pattern. */

const TABS = [
  { id: 'active', label: 'Active', count: 3, testId: 'tab-active' },
  { id: 'shelved', label: 'Shelved', count: 0, testId: 'tab-shelved' },
  { id: 'history', label: 'History', testId: 'tab-history' },
] as const;

function Harness({ onChange }: { readonly onChange?: (id: string) => void }) {
  const [value, setValue] = useState('active');
  return (
    <>
      <Tabs
        label="Alarm lists"
        tabs={TABS}
        value={value}
        idPrefix="alarm-tab"
        panelId="alarm-tabpanel"
        onChange={(id) => {
          onChange?.(id);
          setValue(id);
        }}
      />
      <TabPanel id="alarm-tabpanel" labelledBy={tabElementId('alarm-tab', value)} testId="panel">
        {value} list
      </TabPanel>
    </>
  );
}

const selected = () =>
  screen.getAllByRole('tab').filter((tab) => tab.getAttribute('aria-selected') === 'true');

describe('Tabs', () => {
  it('is a named tablist of tabs controlling the panel, with ids, counts and test ids', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Alarm lists' });
    expect(list.getAttribute('aria-orientation')).toBe('horizontal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.id)).toEqual([
      'alarm-tab-active',
      'alarm-tab-shelved',
      'alarm-tab-history',
    ]);
    expect(tabs.every((tab) => tab.getAttribute('aria-controls') === 'alarm-tabpanel')).toBe(true);
    expect(screen.getByTestId('tab-active').dataset.count).toBe('3');
    expect(screen.getByTestId('tab-shelved').dataset.count).toBe('0');
    expect(screen.getByTestId('tab-history').hasAttribute('data-count')).toBe(false);
    // The count is a neutral badge after the label; a zero count is still shown.
    expect(screen.getByRole('tab', { name: 'Active 3' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Shelved 0' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
    const panel = screen.getByRole('tabpanel', { name: 'Active 3' });
    expect(panel.id).toBe('alarm-tabpanel');
    expect(panel.tabIndex).toBe(0);
  });

  it('keeps one tab in the Tab order: the selected one (a roving tab index)', () => {
    render(<Harness />);
    expect(selected().map((tab) => tab.id)).toEqual(['alarm-tab-active']);
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(screen.getByTestId('tab-history'));
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
    expect(screen.getByTestId('panel').textContent).toBe('history list');
    expect(screen.getByTestId('panel').getAttribute('aria-labelledby')).toBe('alarm-tab-history');
  });

  it('moves and selects with Left and Right (wrapping), Home and End', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const active = screen.getByTestId('tab-active');
    active.focus();
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('tab-shelved'));
    expect(selected()[0]).toBe(screen.getByTestId('tab-shelved'));
    fireEvent.keyDown(screen.getByTestId('tab-shelved'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('tab-history'));
    fireEvent.keyDown(screen.getByTestId('tab-history'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(active);
    fireEvent.keyDown(active, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('tab-history'));
    fireEvent.keyDown(screen.getByTestId('tab-history'), { key: 'Home' });
    expect(document.activeElement).toBe(active);
    expect(onChange.mock.calls.map((call) => call[0] as string)).toEqual([
      'shelved',
      'history',
      'active',
      'history',
      'active',
    ]);
  });

  it('ignores other keys and a click on the selected tab', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const active = screen.getByTestId('tab-active');
    active.focus();
    const event = fireEvent.keyDown(active, { key: 'ArrowDown' });
    expect(event).toBe(true); // not prevented: the page may scroll
    fireEvent.keyDown(active, { key: 'Enter' });
    fireEvent.click(active);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(active);
  });

  it('draws the selected tab underlined in accent and the others secondary', () => {
    render(<Harness />);
    expect(screen.getByTestId('tab-active').className).toMatch(/\bborder-accent\b/);
    expect(screen.getByTestId('tab-active').className).toMatch(/\bfont-semibold\b/);
    expect(screen.getByTestId('tab-shelved').className).toMatch(/\btext-ink-secondary\b/);
    expect(screen.getByTestId('tab-shelved').className).toMatch(/\bborder-transparent\b/);
    // The list scrolls sideways instead of wrapping (A-04); each tab is 40 px high.
    expect(screen.getByRole('tablist').className).toMatch(/\boverflow-x-auto\b/);
    expect(screen.getByRole('tablist').className).not.toMatch(/\bflex-wrap\b/);
    expect(screen.getByTestId('tab-active').className).toMatch(/\bmin-h-10\b/);
  });

  it('makes the first tab the Tab stop when no tab is selected, and generates ids', () => {
    render(<Tabs label="Views" tabs={TABS} value="none" onChange={() => undefined} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    const prefix = tabs[0]?.id.replace(/-active$/, '') ?? '';
    expect(prefix).not.toBe('');
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(tabPanelId(prefix));
  });
});

describe('TabPanel', () => {
  it('passes data-* through to the panel, which stays a focusable tabpanel', () => {
    render(
      <TabPanel id="p" labelledBy="t" testId="alarm-list" data-view="active" data-count="3">
        rows
      </TabPanel>,
    );
    const panel = screen.getByTestId('alarm-list');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect([panel.dataset.view, panel.dataset.count]).toEqual(['active', '3']);
  });
});

describe('tabTarget', () => {
  it('wraps at both ends and leaves other keys alone', () => {
    expect(tabTarget('ArrowRight', 0, 3)).toBe(1);
    expect(tabTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tabTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tabTarget('ArrowLeft', 2, 3)).toBe(1);
    expect(tabTarget('Home', 2, 3)).toBe(0);
    expect(tabTarget('End', 0, 3)).toBe(2);
    expect(tabTarget('Tab', 0, 3)).toBeUndefined();
  });
});
