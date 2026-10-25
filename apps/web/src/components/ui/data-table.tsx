import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { quantityText } from '../../domain/numbers.ts';
import { Button } from './button.tsx';
import { ErrorState, type ErrorStateProps } from './error-state.tsx';
import { Skeleton } from './skeleton.tsx';
import type { Tone } from './tokens.ts';

/**
 * The one data table (UX-1d1, #318; design system 4.5). Real table markup always (`table` →
 * `caption` → `thead` → `tbody` → `tr` → `td`; the specs read cells by position), a visually
 * hidden caption, `th scope="col"`, `data-count`, a test id and `data-*` per row.
 *
 * - Numbers, durations and times of day right-aligned (`numeric` adds tabular figures and no
 *   wrapping); headers aligned over their column.
 * - Rows: 1 px `line-subtle` dividers, no zebra (the dividers carry the rows; zebra fights the tone
 *   bars), hover `surface-sunken`; a tone's 3 px left bar for an abnormal row (`rowTone`); the row
 *   whose detail is open `accent-subtle` with a 3 px `accent` bar and `aria-current`.
 * - The sticky header (G-14) has two modes, chosen by measuring the table against its frame: when
 *   the table fits, the frame clips sideways (`overflow-x: clip`, which is not a scroll box) and
 *   the header sticks to the page under the 48 px top bar; when it is wider, the frame becomes a
 *   bounded scroll box (`max-height: min(70vh, 720px)`) and the header sticks to its top. `bounded`
 *   keeps the box at any width (a long list inside a detail).
 * - Selection: a checkbox column in 24 px hit areas, a select-all whose native `indeterminate`
 *   says "mixed" when some rows are selected.
 * - Row actions: ghost buttons side by side in the last column, under a visually hidden
 *   "Actions" header. When a row the focus was in disappears (acknowledged out of the list), the
 *   focus moves to the same control in the next row, else the previous row, else the heading of
 *   the section around the table; `announceRemoval` says so politely.
 * - "Skip to the details" before a table of row actions with a detail after it (G-33), or a skip
 *   link of its own words past a long table to the next section (`skipLabel`).
 * - Empty, loading and error through `EmptyState`, `Skeleton` and `ErrorState`.
 * - `pageSize` pages long lists ("1–50 of 180", Previous, Next).
 * - Below `md`: `scroll` keeps the table (lower-priority columns drop, a right-edge fade and a
 *   visually hidden note); `stack` renders each row as a card of label and value pairs (G-27).
 */

export type ColumnAlign = 'start' | 'end' | 'center';

export interface Column<Row> {
  readonly key: string;
  /** Always present; a header that only names a column of controls may be visually hidden. */
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  /** `end` for every number, duration and time of day (`numeric` implies it). */
  readonly align?: ColumnAlign;
  /** Right-aligned, tabular figures, no wrapping. */
  readonly numeric?: boolean;
  /** A minimum width (`8rem`), so ids and times keep to one line. */
  readonly width?: string;
  /** No wrapping; the default for `numeric`. */
  readonly nowrap?: boolean;
  /** Which columns survive on narrow screens: 3 drops below `md`, 2 below `sm`, 1 never. */
  readonly priority?: 1 | 2 | 3;
  /** Kept in view on horizontal scroll (the first column). */
  readonly sticky?: boolean;
  /**
   * The cell names its row (`th scope="row"`, role `rowheader`): the first column of a table whose
   * rows are things (a state, a metric), so a screen reader says it with every other cell.
   */
  readonly rowHeader?: boolean;
}

export interface DataTableSelection<Row> {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: Set<string>) => void;
  /** The row's checkbox name: "Select SPINDLE-OVERLOAD on Horizontal machining centre 1". */
  readonly label: (row: Row) => string;
  /** The select-all's name: "Select every alarm that can be acknowledged". */
  readonly allLabel: string;
  /** Rows that cannot be selected get no checkbox (every row by default). */
  readonly selectable?: (row: Row) => boolean;
  /** The select-all's test id. */
  readonly testId?: string;
  /** Each row checkbox's test id. */
  readonly rowTestId?: (row: Row) => string;
}

export type DataTableDensity = 'compact' | 'default';
export type DataTableNarrow = 'scroll' | 'stack';
export type RowData = Readonly<Record<`data-${string}`, string | undefined>>;

export interface DataTableProps<Row> {
  /** The visually hidden `<caption>`, which names the table. */
  readonly caption: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Keeps `alarm-row-${id}`, `order-row-${id}` … */
  readonly rowTestId?: (row: Row) => string;
  /** `data-*` per row: `data-state`, `data-blocked` … */
  readonly rowProps?: (row: Row) => RowData;
  /** A left bar for an abnormal row (an unacknowledged alarm). */
  readonly rowTone?: (row: Row) => Tone | undefined;
  readonly selection?: DataTableSelection<Row>;
  /** The row whose detail is open. */
  readonly activeRowKey?: string | undefined;
  /** Controls for the row, side by side in the last column: ghost `sm` buttons. */
  readonly actions?: (row: Row) => ReactNode;
  /** An `EmptyState`, shown instead of the table (header row included) when there is no row. */
  readonly empty?: ReactNode;
  /** The `Skeleton`'s loading text ("Loading holds…"): shown instead of the table while set. */
  readonly loading?: string | undefined;
  /** A failed read: an `ErrorState` instead of the table. */
  readonly error?: ErrorStateProps | undefined;
  /** Default: on when more than 15 rows are shown. */
  readonly stickyHeader?: boolean;
  /** A scroll box at any width, for a long list inside a detail. */
  readonly bounded?: boolean;
  /** 32 or 40 px rows. */
  readonly density?: DataTableDensity;
  /** Below `md`: keep the table and scroll sideways, or one card per row. */
  readonly narrow?: DataTableNarrow;
  /** Client-side paging: rows per page. */
  readonly pageSize?: number;
  /** The id of the detail after the table: a "Skip to the details" link goes before it. */
  readonly skipToDetails?: string | undefined;
  /**
   * The skip link's text when what follows the table is not a detail: "Skip past the units" to
   * the next section of a long page (G-33). "Skip to the details" by default.
   */
  readonly skipLabel?: string | undefined;
  /** The polite status after a row with the focus disappeared: "Alarm acknowledged; 2 left". */
  readonly announceRemoval?: (left: number) => string;
  readonly testId: string;
  /** `data-count`: the rows' count unless given. */
  readonly count?: number;
}

const ALIGN: Readonly<Record<ColumnAlign, string>> = {
  start: 'text-left',
  end: 'text-right',
  center: 'text-center',
};

/** `priority` 3 drops below `md`, 2 below `sm` (written out for Tailwind's scanner). */
const PRIORITY: Readonly<Record<1 | 2 | 3, string>> = {
  1: '',
  2: 'hidden sm:table-cell',
  3: 'hidden md:table-cell',
};

/** The left bar of an abnormal row: the tone's border colour, 3 px, inside the first cell. */
const TONE_BAR: Readonly<Record<Tone, string>> = {
  neutral: 'shadow-[inset_3px_0_0_var(--color-neutral-border)]',
  info: 'shadow-[inset_3px_0_0_var(--color-info-border)]',
  ok: 'shadow-[inset_3px_0_0_var(--color-ok-border)]',
  warn: 'shadow-[inset_3px_0_0_var(--color-warn-border)]',
  caution: 'shadow-[inset_3px_0_0_var(--color-caution-border)]',
  alarm: 'shadow-[inset_3px_0_0_var(--color-alarm-border)]',
};
const ACTIVE_BAR = 'shadow-[inset_3px_0_0_var(--color-accent)]';

const DENSITY: Readonly<Record<DataTableDensity, string>> = {
  compact: 'py-1.5',
  default: 'py-2.5',
};

/** The frame: a rounded `line` border on `surface`. */
const FRAME = 'rounded-lg border border-line bg-surface';
/**
 * The frame when the table fits: clipped (to its rounded corners too) but no scroll box, so the
 * header sticks to the page.
 */
const FRAME_FIT = 'overflow-clip';
/**
 * The frame when the table is wider (or `bounded`): a bounded scroll box the header sticks in. Its
 * scroll padding keeps a focused row control clear of that header (WCAG 2.4.11): the page's own
 * `scroll-padding-top` does not reach inside the box. 48 px (a header row of two lines) until
 * `useOverflow` sets it to the measured header height.
 */
const FRAME_SCROLL = 'overflow-auto scroll-pt-12';
const FRAME_SCROLL_HEIGHT = 'max-h-[min(70vh,720px)]';

/** The header row's cells: sunken, small, secondary ink, a 1 px `line` under them. */
export const HEADER_CELL =
  'bg-surface-sunken text-xs font-semibold text-ink-secondary align-bottom ' +
  'shadow-[inset_0_-1px_0_var(--color-line)]';
/**
 * The sticky header: under the 48 px top bar on the page, at the top of the frame when the frame
 * scrolls (`data-scroll` on the `group/frame`). Its bottom line is a shadow, not a border, so it
 * moves with the sticky cell.
 */
export const STICKY_HEADER_CELL = 'sticky top-12 z-sticky group-data-scroll/frame:top-0';
/**
 * A header that does not stick to the page still sticks inside a scroll box: the box scrolls
 * vertically too, and a short table's header must not scroll out of it.
 */
export const SCROLL_STICKY_HEADER_CELL =
  'group-data-scroll/frame:sticky group-data-scroll/frame:top-0 group-data-scroll/frame:z-sticky';
/** The header cell of a sticky first column, above the header cells that scroll under it. */
const STICKY_CORNER_CELL = 'sticky left-0 top-12 z-sticky-corner group-data-scroll/frame:top-0';
const STICKY_CORNER = 'sticky left-0 z-sticky-corner group-data-scroll/frame:top-0';
const CELL_X = 'px-3';
const HEADER_Y = 'py-2';

/** Narrow screens are below `md` (48rem). */
const NARROW_QUERY = '(max-width: 47.98rem)';

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** Without `matchMedia` (jsdom) the screen counts as wide. */
const isNarrow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

interface Overflow {
  /** The table is wider than its frame. */
  readonly wide: boolean;
  /** The frame's content is taller than the frame (a bounded box that scrolls vertically). */
  readonly tall: boolean;
}

/**
 * Whether the table is wider than its frame, and whether the frame scrolls vertically, measured
 * whenever either is resized. Without `ResizeObserver` (jsdom) neither.
 *
 * It also sets the frame's scroll padding to the header row's height (plus 8 px), so a focused
 * row control clears a header of any number of lines; `scroll-pt-12` is the value until then.
 * Set through the CSSOM (`style.setProperty`), which `style-src 'self'` allows.
 */
function useOverflow(
  frame: RefObject<HTMLDivElement | null>,
  table: RefObject<HTMLTableElement | null>,
): Overflow {
  const [wide, setWide] = useState(false);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const box = frame.current;
    const content = table.current;
    if (!box || !content || typeof ResizeObserver !== 'function') return undefined;
    const head = content.tHead;
    const measure = () => {
      setWide(content.getBoundingClientRect().width > box.clientWidth + 1);
      setTall(box.scrollHeight > box.clientHeight + 1);
      if (head) {
        const height = Math.ceil(head.getBoundingClientRect().height);
        box.style.setProperty('scroll-padding-top', `${String((height + 8) / 16)}rem`);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    if (head) observer.observe(head);
    return () => {
      observer.disconnect();
    };
  }, [frame, table]);
  return { wide, tall };
}

export interface TableFrameProps {
  readonly caption: string;
  readonly testId: string;
  readonly count?: number | undefined;
  /** The `th` cells of the header row. */
  readonly head: ReactNode;
  /** The `tr` rows. */
  readonly children: ReactNode;
  readonly bounded?: boolean | undefined;
  /** Classes on the `tbody` (the legacy quality table draws its dividers there). */
  readonly bodyClassName?: string | undefined;
}

/**
 * The frame, the table, its caption and header row: the part `DataTable` and the quality screens'
 * `Table` (which passes its own rows) share. The frame takes one of the two sticky modes.
 */
export function TableFrame({
  caption,
  testId,
  count,
  head,
  children,
  bounded = false,
  bodyClassName,
}: TableFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const captionId = useId();
  const { wide: over, tall } = useOverflow(frame, table);
  const scroll = bounded || over;
  // A tab stop and a named region only when the box really scrolls: a bounded box that holds
  // everything is neither (no empty Tab stop, no landmark noise).
  const scrolls = over || (bounded && tall);
  const [atEnd, setAtEnd] = useState(false);
  const onScroll = () => {
    const box = frame.current;
    if (box) setAtEnd(box.scrollLeft + box.clientWidth >= box.scrollWidth - 1);
  };
  return (
    <div className="relative">
      {over ? <p className="sr-only">Scroll for more columns.</p> : null}
      <div
        ref={frame}
        data-scroll={scroll ? '' : undefined}
        data-frame={scroll ? 'scroll' : 'fit'}
        // A box that scrolls takes the focus so the keyboard can scroll it (WCAG 2.1.1).
        {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-labelledby': captionId } : {})}
        onScroll={over ? onScroll : undefined}
        className={`group/frame ${FRAME} ${scroll ? `${FRAME_SCROLL} ${FRAME_SCROLL_HEIGHT}` : FRAME_FIT}`}
      >
        <table
          ref={table}
          className="w-full border-collapse text-left text-sm"
          data-testid={testId}
          {...(count === undefined ? {} : { 'data-count': String(count) })}
        >
          <caption id={captionId} className="sr-only">
            {caption}
          </caption>
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody className={bodyClassName}>{children}</tbody>
        </table>
      </div>
      {over && !atEnd ? (
        <div
          aria-hidden="true"
          data-fade=""
          className="pointer-events-none absolute inset-y-px right-px w-6 rounded-r-lg bg-linear-to-l from-surface"
        />
      ) : null}
    </div>
  );
}

/** A focusable control in a row: what the focus goes back to after a row disappears. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FocusSpot {
  readonly key: string;
  /** The cell the control is in (`data-cell`: `select`, `actions` or `c-<column key>`). */
  readonly cell: string | undefined;
  /** The control's place among the focusable controls of that cell. */
  readonly index: number;
}

function cellOf(row: HTMLElement, cell: string): HTMLElement | undefined {
  return [...row.querySelectorAll<HTMLElement>('[data-cell]')].find(
    (element) => element.dataset.cell === cell,
  );
}

const controlsIn = (element: HTMLElement): HTMLElement[] => [
  ...element.querySelectorAll<HTMLElement>(FOCUSABLE),
];

function rowElement(root: HTMLElement, key: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[data-row-key]')].find(
    (element) => element.dataset.rowKey === key,
  );
}

/** The heading of the section around `element` (focusable by script), if any. */
function sectionHeading(element: HTMLElement): HTMLElement | null {
  const id = element.closest('section[aria-labelledby]')?.getAttribute('aria-labelledby');
  const heading = id ? document.getElementById(id) : null;
  if (heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
  return heading;
}

/**
 * Keeps the focus in the table when the row it was in disappears: the same control in the next
 * row that is still there, else the previous one, else the section's heading. Only when the focus
 * was lost with the row (on `body`), never taken from somewhere the user moved it to.
 */
function useFocusAfterRemoval(
  root: RefObject<HTMLElement | null>,
  keys: readonly string[],
  total: number,
  announce: ((left: number) => string) | undefined,
  setStatus: (text: string) => void,
) {
  const spot = useRef<FocusSpot | null>(null);
  const previous = useRef<readonly string[]>(keys);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = keys;
    const was = spot.current;
    const container = root.current;
    if (!was || !container || keys.includes(was.key)) return;
    spot.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const at = before.indexOf(was.key);
    const remaining = new Set(keys);
    const after = before.slice(at + 1).find((key) => remaining.has(key));
    const prior = before
      .slice(0, Math.max(at, 0))
      .reverse()
      .find((key) => remaining.has(key));
    const target = after ?? prior;
    const row = target === undefined ? undefined : rowElement(container, target);
    // The same control: the same cell, the same place in it (a row without a checkbox does not
    // shift its actions); else the row's first control; else the section heading.
    const cell = row && was.cell !== undefined ? cellOf(row, was.cell) : undefined;
    const inCell = cell ? controlsIn(cell) : [];
    const control =
      inCell[Math.min(was.index, inCell.length - 1)] ?? (row ? controlsIn(row)[0] : undefined);
    (control ?? sectionHeading(container))?.focus();
    if (announce) setStatus(announce(total));
  }, [keys, total, root, announce, setStatus]);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const target = event.target;
    const row = target.closest<HTMLElement>('[data-row-key]');
    const key = row?.dataset.rowKey;
    if (!row || key === undefined) {
      spot.current = null;
      return;
    }
    const cell = target.closest<HTMLElement>('[data-cell]');
    const index = cell ? controlsIn(cell).indexOf(target) : -1;
    spot.current = { key, cell: cell?.dataset.cell, index: Math.max(index, 0) };
  };

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (next !== null) {
      spot.current = null;
      return;
    }
    // Focus lost to nothing: a click on the page (forget the row) or the row's removal (keep it
    // for the layout effect, which runs before this check).
    const left = event.target;
    const remembered = spot.current;
    setTimeout(() => {
      if (spot.current === remembered && left.isConnected) spot.current = null;
    }, 0);
  };

  return { onFocus, onBlur };
}

/** A checkbox in a 24 × 24 px hit area (G-30). */
function Check({
  label,
  checked,
  indeterminate = false,
  disabled = false,
  testId,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string | undefined;
  readonly onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Every render: a click on a mixed box clears `indeterminate` natively, and an owner that keeps
  // the selection re-renders with the same prop.
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  });
  return (
    <label className="inline-flex size-6 cursor-pointer items-center justify-center has-disabled:cursor-not-allowed">
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          // The click cleared it; an owner that keeps the selection does not re-render.
          event.target.indeterminate = indeterminate;
          onChange(event.target.checked);
        }}
        className="size-4 cursor-[inherit] accent-accent"
      />
    </label>
  );
}

function headerAlign<Row>(column: Column<Row>): ColumnAlign {
  return column.align ?? (column.numeric ? 'end' : 'start');
}

function cellClass<Row>(column: Column<Row>): string {
  return [
    ALIGN[headerAlign(column)],
    column.numeric ? 'tabular-nums' : '',
    (column.nowrap ?? column.numeric) ? 'whitespace-nowrap' : '',
    PRIORITY[column.priority ?? 1],
  ]
    .filter(Boolean)
    .join(' ');
}

/** The sticky first column: on top of the cells it scrolls over, in its row's background. */
const STICKY_COLUMN = 'sticky left-0 z-sticky-column';

/** "1–50 of 180": the rows of `page`. */
function rangeText(page: number, size: number, total: number): string {
  const first = page * size + 1;
  const last = Math.min(total, (page + 1) * size);
  return `${quantityText(first)}–${quantityText(last)} of ${quantityText(total)}`;
}

/** The pager under a paged table: "1–50 of 180", Previous, Next. */
function Pager({
  caption,
  page,
  pages,
  size,
  total,
  onPage,
}: {
  readonly caption: string;
  readonly page: number;
  readonly pages: number;
  readonly size: number;
  readonly total: number;
  readonly onPage: (page: number) => void;
}) {
  return (
    <nav
      aria-label={`${caption}: pages`}
      className="mt-2 flex flex-wrap items-center justify-end gap-2 text-sm text-ink-secondary"
    >
      {/* Not a live region: a live list would announce every count change; a page change by the
          user is announced through the table's status. */}
      <p className="tabular-nums">{rangeText(page, size, total)}</p>
      <Button
        size="sm"
        icon="chevron-left"
        disabled={page === 0}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        Previous
      </Button>
      <Button
        size="sm"
        disabled={page >= pages - 1}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        Next
      </Button>
    </nav>
  );
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowTestId,
  rowProps,
  rowTone,
  selection,
  activeRowKey,
  actions,
  empty,
  loading,
  error,
  stickyHeader,
  bounded = false,
  density = 'default',
  narrow = 'scroll',
  pageSize,
  skipToDetails,
  skipLabel = 'Skip to the details',
  announceRemoval,
  testId,
  count,
}: DataTableProps<Row>) {
  const root = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const narrowScreen = useNarrow();

  const pages = pageSize === undefined ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  const shown =
    pageSize === undefined ? rows : rows.slice(current * pageSize, (current + 1) * pageSize);
  const keys = shown.map(rowKey);
  const focus = useFocusAfterRemoval(root, keys, rows.length, announceRemoval, setStatus);

  const statusRegion =
    announceRemoval === undefined && pageSize === undefined ? null : (
      <p role="status" className="sr-only">
        {status}
      </p>
    );

  if (error !== undefined) return <ErrorState {...error} />;
  if (loading !== undefined) return <Skeleton shape="table" label={loading} />;

  const total = count ?? rows.length;
  if (rows.length === 0 && empty !== undefined) {
    return (
      <div ref={root} data-testid={testId} data-count={String(total)} data-empty-table="">
        <div className={FRAME}>{empty}</div>
        {statusRegion}
      </div>
    );
  }

  // The select-all covers the rows shown (the current page), never rows the user cannot see.
  const selectable = selection
    ? shown.filter((row) => selection.selectable?.(row) ?? true).map(rowKey)
    : [];
  const chosen = selection ? selectable.filter((key) => selection.selected.has(key)) : [];
  const all = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (key: string, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (on) next.add(key);
    else next.delete(key);
    selection.onChange(next);
  };
  const rowCheck = (row: Row) => {
    if (!selection) return null;
    if (!(selection.selectable?.(row) ?? true)) return null;
    const key = rowKey(row);
    return (
      <Check
        label={selection.label(row)}
        checked={selection.selected.has(key)}
        testId={selection.rowTestId?.(row)}
        onChange={(on) => {
          toggle(key, on);
        }}
      />
    );
  };
  const allCheck = selection ? (
    <Check
      label={selection.allLabel}
      checked={all}
      indeterminate={chosen.length > 0 && !all}
      disabled={selectable.length === 0}
      testId={selection.testId}
      onChange={(on) => {
        // This page's rows only: a selection made on other pages stays.
        const next = new Set(selection.selected);
        for (const key of selectable) {
          if (on) next.add(key);
          else next.delete(key);
        }
        selection.onChange(next);
      }}
    />
  ) : null;

  const skip =
    skipToDetails === undefined ? null : (
      <a
        href={`#${skipToDetails}`}
        onClick={(event) => {
          const target = document.getElementById(skipToDetails);
          if (!target) return;
          event.preventDefault();
          if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
          target.focus();
        }}
        className="sr-only focus:not-sr-only focus:mb-2 focus:inline-block focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-link focus:underline"
      >
        {skipLabel}
      </a>
    );

  const pager =
    pageSize === undefined || pages <= 1 ? null : (
      <Pager
        caption={caption}
        page={current}
        pages={pages}
        size={pageSize}
        total={rows.length}
        onPage={(next) => {
          setPage(next);
          setStatus(`Rows ${rangeText(next, pageSize, rows.length)}`);
        }}
      />
    );

  if (narrow === 'stack' && narrowScreen) {
    return (
      <div ref={root} onFocus={focus.onFocus} onBlur={focus.onBlur}>
        {skip}
        {selection ? (
          <div className="mb-2 flex items-center gap-1 text-sm">
            {allCheck}
            <span aria-hidden="true">Select all</span>
          </div>
        ) : null}
        <ul
          aria-label={caption}
          data-testid={testId}
          data-count={String(total)}
          className={`${FRAME} divide-y divide-line-subtle`}
        >
          {shown.map((row) => {
            const key = rowKey(row);
            const active = key === activeRowKey;
            const tone = rowTone?.(row);
            return (
              <li
                key={key}
                {...rowProps?.(row)}
                data-row-key={key}
                data-testid={rowTestId?.(row)}
                aria-current={active ? 'true' : undefined}
                className={`flex gap-2 p-3 ${active ? `bg-accent-subtle ${ACTIVE_BAR}` : tone ? TONE_BAR[tone] : ''}`}
              >
                {selection ? (
                  <div data-cell="select" className="-ml-1 shrink-0">
                    {rowCheck(row)}
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
                    {columns.map((column) => (
                      <div key={column.key} className="contents">
                        <dt className="text-xs font-semibold text-ink-secondary">
                          {column.header}
                        </dt>
                        <dd
                          data-cell={`c-${column.key}`}
                          className={`min-w-0 ${column.numeric ? 'tabular-nums' : ''} ${(column.nowrap ?? column.numeric) ? 'whitespace-nowrap' : ''}`}
                        >
                          {column.cell(row)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {actions ? (
                    <div data-cell="actions" className="mt-2 flex flex-wrap items-center gap-2">
                      {actions(row)}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {pager}
        {statusRegion}
      </div>
    );
  }

  const sticky = stickyHeader ?? shown.length > 15;
  const headerCell = `${HEADER_CELL} ${CELL_X} ${sticky ? STICKY_HEADER_CELL : SCROLL_STICKY_HEADER_CELL}`;
  const cornerCell = `${HEADER_CELL} ${CELL_X} ${sticky ? STICKY_CORNER_CELL : STICKY_CORNER}`;
  const bodyCell = `${CELL_X} align-middle`;
  const head = (
    <>
      {selection ? (
        <th scope="col" className={`${headerCell} w-10 py-1`} data-select="">
          {allCheck}
        </th>
      ) : null}
      {columns.map((column) => (
        <th
          key={column.key}
          scope="col"
          className={`${column.sticky ? cornerCell : headerCell} ${HEADER_Y} ${cellClass(column)}`}
          {...(column.width === undefined ? {} : { style: { minWidth: column.width } })}
        >
          {column.header}
        </th>
      ))}
      {actions ? (
        <th scope="col" className={`${headerCell} ${HEADER_Y}`}>
          <span className="sr-only">Actions</span>
        </th>
      ) : null}
    </>
  );

  return (
    <div ref={root} onFocus={focus.onFocus} onBlur={focus.onBlur}>
      {skip}
      <TableFrame caption={caption} testId={testId} count={total} head={head} bounded={bounded}>
        {shown.map((row) => {
          const key = rowKey(row);
          const active = key === activeRowKey;
          const tone = rowTone?.(row);
          const bar = active ? ACTIVE_BAR : tone ? TONE_BAR[tone] : '';
          return (
            <tr
              key={key}
              {...rowProps?.(row)}
              data-row-key={key}
              data-testid={rowTestId?.(row)}
              aria-current={active ? 'true' : undefined}
              className={`border-t border-line-subtle first:border-t-0 ${active ? 'bg-accent-subtle' : 'bg-surface hover:bg-surface-sunken'}`}
            >
              {selection ? (
                <td data-cell="select" className={`${bodyCell} w-10 py-0 ${bar}`}>
                  {rowCheck(row)}
                </td>
              ) : null}
              {columns.map((column, index) => {
                const Cell = column.rowHeader ? 'th' : 'td';
                return (
                  <Cell
                    key={column.key}
                    {...(column.rowHeader ? { scope: 'row' } : {})}
                    data-cell={`c-${column.key}`}
                    className={`${bodyCell} ${DENSITY[density]} ${cellClass(column)} ${column.rowHeader ? 'font-normal' : ''} ${column.sticky ? `${STICKY_COLUMN} bg-inherit` : ''} ${!selection && index === 0 ? bar : ''}`}
                  >
                    {column.cell(row)}
                  </Cell>
                );
              })}
              {actions ? (
                <td data-cell="actions" className={`${bodyCell} whitespace-nowrap py-1`}>
                  <div className="flex flex-nowrap items-center justify-end gap-1">
                    {actions(row)}
                  </div>
                </td>
              ) : null}
            </tr>
          );
        })}
      </TableFrame>
      {pager}
      {statusRegion}
    </div>
  );
}
