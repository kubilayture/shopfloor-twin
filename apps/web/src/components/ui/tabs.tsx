import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, type DataAttributes } from './badge.tsx';

/**
 * Tabs (UX-1d1, #318; design system 4.6): a switch between views of one screen that keeps its
 * place on the page, by the WAI-ARIA tabs pattern. `role="tablist"` named by `label`; each tab a
 * `role="tab"` button with `aria-selected` and `aria-controls` to the panel; a roving tab index
 * (only the selected tab is in the Tab order); Left and Right (wrapping), Home and End move the
 * focus and select at once (automatic activation). The panel is a `TabPanel`, labelled by the
 * selected tab.
 *
 * A switch that changes the URL's path, not a view of one screen, is `SegmentedLinks` instead
 * (4.13). The alarm tabs (`tab-active` …, `data-count`, ids `alarm-tab-…`) keep their test ids,
 * counts and ids through `testId`, `count` and `idPrefix`.
 *
 * Look: underline tabs, 2 px `accent` under the selected one (text `ink` 600), the others
 * `ink-secondary`; a count as a `neutral` badge. The list never wraps: below `sm` it scrolls
 * sideways (A-04). Each tab is 40 px high.
 */
export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  /** A count beside the label, as a `neutral` badge; also in `data-count`. */
  readonly count?: number | undefined;
  readonly testId?: string | undefined;
}

export interface TabsProps {
  /** The tablist's accessible name: "Alarm lists". */
  readonly label: string;
  readonly tabs: readonly TabItem[];
  /** The selected tab's id. */
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** Ids are `${idPrefix}-${tab.id}` (tabs) and `${idPrefix}-panel` (the panel); generated when absent. */
  readonly idPrefix?: string | undefined;
  /** The panel's id, when it is not `${idPrefix}-panel`. */
  readonly panelId?: string | undefined;
  readonly testId?: string | undefined;
}

/** The id of a tab, for a `TabPanel`'s `aria-labelledby`. */
export const tabElementId = (idPrefix: string, id: string): string => `${idPrefix}-${id}`;

/** The default id of the panel the tabs control. */
export const tabPanelId = (idPrefix: string): string => `${idPrefix}-panel`;

const TAB =
  'inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm ' +
  'focus-visible:outline-offset-[-2px] motion-safe:transition-colors motion-safe:duration-fast';
const SELECTED = 'border-accent font-semibold text-ink';
const UNSELECTED =
  'border-transparent font-medium text-ink-secondary hover:border-line hover:text-ink';

/** The index a key moves to from `index` among `count` tabs, or undefined for any other key. */
export function tabTarget(key: string, index: number, count: number): number | undefined {
  const last = count - 1;
  switch (key) {
    case 'ArrowRight':
      return index === last ? 0 : index + 1;
    case 'ArrowLeft':
      return index === 0 ? last : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}

export function Tabs({ label, tabs, value, onChange, idPrefix, panelId, testId }: TabsProps) {
  const generated = useId();
  const prefix = idPrefix ?? generated;
  const panel = panelId ?? tabPanelId(prefix);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // With no tab selected (an unknown value) the first one is the list's Tab stop.
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabTarget(event.key, index, tabs.length);
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    if (target.id !== value) onChange(target.id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-testid={testId}
      className="flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)]"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={tabElementId(prefix, tab.id)}
            aria-selected={selected}
            aria-controls={panel}
            tabIndex={index === selectedIndex ? 0 : -1}
            data-testid={tab.testId}
            data-count={tab.count}
            onClick={() => {
              if (!selected) onChange(tab.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={`${TAB} ${selected ? SELECTED : UNSELECTED}`}
          >
            {tab.label}
            {tab.count === undefined ? null : ' '}
            {tab.count === undefined ? null : (
              <Badge tone="neutral" className="tabular-nums">
                {tab.count}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends DataAttributes {
  /** The panel's id: `tabPanelId(idPrefix)` unless the tabs were given another `panelId`. */
  readonly id: string;
  /** The selected tab's id: `tabElementId(idPrefix, value)`. */
  readonly labelledBy: string;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/**
 * The panel under `Tabs`: focusable (`tabindex="0"`) so the keyboard reaches a panel with no
 * control. `data-*` pass through (the alarm list's `data-view` and `data-count`).
 */
export function TabPanel({ id, labelledBy, testId, className, children, ...data }: TabPanelProps) {
  return (
    <div
      {...data}
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      tabIndex={0}
      data-testid={testId}
      className={className}
    >
      {children}
    </div>
  );
}
