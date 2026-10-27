import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.ts';
import { Button } from './button.tsx';
import { DataTable, type Column, type DataTableProps } from './data-table.tsx';
import { EmptyState } from './empty-state.tsx';
import { Section } from './section.tsx';

/** UX-1d1 (#318): design system 4.5. */

interface Alarm {
  readonly id: string;
  readonly code: string;
  readonly minutes: number;
  readonly state: 'unacknowledged' | 'acknowledged';
}

const alarm = (n: number, state: Alarm['state'] = 'unacknowledged'): Alarm => ({
  id: `a${String(n)}`,
  code: `CODE-${String(n)}`,
  minutes: n * 1.5,
  state,
});

const COLUMNS: readonly Column<Alarm>[] = [
  { key: 'code', header: 'Alarm', cell: (row) => row.code },
  { key: 'minutes', header: 'Open (min)', numeric: true, cell: (row) => row.minutes.toFixed(1) },
  { key: 'state', header: 'State', align: 'center', priority: 3, cell: (row) => row.state },
];

function table(props: Partial<DataTableProps<Alarm>> & { readonly rows: readonly Alarm[] }) {
  return (
    <DataTable<Alarm>
      caption="Active alarms, newest first"
      columns={COLUMNS}
      rowKey={(row) => row.id}
      rowTestId={(row) => `alarm-row-${row.id}`}
      rowProps={(row) => ({ 'data-state': row.state, 'data-code': row.code })}
      testId="alarm-table"
      {...props}
    />
  );
}

const rowsOf = (n: number, state?: Alarm['state']) =>
  Array.from({ length: n }, (_, i) => alarm(i + 1, state));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A layout for the frame's measurements: a `ResizeObserver` and the sizes it reads. */
function stubResize(size: {
  readonly tableWidth: number;
  readonly frameWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    },
  );
  vi.spyOn(HTMLTableElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: size.tableWidth,
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(size.frameWidth);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(size.scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(size.clientHeight);
}

describe('DataTable markup', () => {
  it('is a real table with a hidden caption, column headers, row test ids, data-* and data-count', () => {
    render(table({ rows: rowsOf(3) }));
    const el = screen.getByRole('table', { name: 'Active alarms, newest first' });
    expect(el.dataset.testid).toBe('alarm-table');
    expect(el.dataset.count).toBe('3');
    expect(el.querySelector('caption')?.className).toMatch(/\bsr-only\b/);
    const headers = within(el).getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent)).toEqual(['Alarm', 'Open (min)', 'State']);
    expect(headers.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    // table → tbody → tr → td: the positional reads of the specs.
    const rows = el.querySelectorAll('tbody > tr');
    expect(rows).toHaveLength(3);
    const first = screen.getByTestId('alarm-row-a1');
    expect(first.dataset.state).toBe('unacknowledged');
    expect(first.dataset.code).toBe('CODE-1');
    expect([...first.querySelectorAll('td')].map((td) => td.textContent)).toEqual([
      'CODE-1',
      '1.5',
      'unacknowledged',
    ]);
  });

  it('makes a rowHeader column the row headers (th scope="row"), the other cells td', () => {
    const columns: readonly Column<Alarm>[] = [
      { ...COLUMNS[0], rowHeader: true } as Column<Alarm>,
      ...COLUMNS.slice(1),
    ];
    render(table({ rows: rowsOf(2), columns }));
    const el = screen.getByRole('table', { name: 'Active alarms, newest first' });
    const heads = within(el).getAllByRole('rowheader');
    expect(heads.map((th) => [th.tagName, th.getAttribute('scope'), th.textContent])).toEqual([
      ['TH', 'row', 'CODE-1'],
      ['TH', 'row', 'CODE-2'],
    ]);
    // Body weight, not a header's bold; the row's other cells stay td (positional reads).
    expect(heads[0]?.className).toContain('font-normal');
    const first = screen.getByTestId('alarm-row-a1');
    expect(first.querySelectorAll('td')).toHaveLength(2);
    expect(first.firstElementChild?.getAttribute('data-cell')).toBe('c-code');
  });

  it('right-aligns numbers in tabular figures, without wrapping, under a right-aligned header', () => {
    render(table({ rows: rowsOf(1) }));
    const [codeTh, minutesTh, stateTh] = screen.getAllByRole('columnheader');
    const [codeTd, minutesTd, stateTd] = screen.getByTestId('alarm-row-a1').querySelectorAll('td');
    expect(minutesTh?.className).toMatch(/\btext-right\b/);
    expect(minutesTd?.className).toMatch(/\btext-right\b/);
    expect(minutesTd?.className).toMatch(/\btabular-nums\b/);
    expect(minutesTd?.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(codeTh?.className).toMatch(/\btext-left\b/);
    expect(codeTd?.className).not.toMatch(/\btabular-nums|whitespace-nowrap\b/);
    expect(stateTd?.className).toMatch(/\btext-center\b/);
    // Priority 3 drops below md, in the header and the cells alike.
    expect(stateTh?.className).toMatch(/(^| )hidden md:table-cell\b/);
    expect(stateTd?.className).toMatch(/(^| )hidden md:table-cell\b/);
    expect(codeTd?.className).not.toMatch(/\bhidden\b/);
  });

  it('gives a column a minimum width and keeps a non-numeric column on one line on request', () => {
    const columns: Column<Alarm>[] = [
      { key: 'code', header: 'Alarm', width: '8rem', nowrap: true, cell: (row) => row.code },
    ];
    render(table({ rows: rowsOf(1), columns }));
    expect(screen.getByRole('columnheader').style.minWidth).toBe('8rem');
    expect(screen.getByRole('cell').className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('draws rows with dividers and hover, no zebra; 40 px rows or 32 px compact', () => {
    const { rerender } = render(table({ rows: rowsOf(2) }));
    const row = screen.getByTestId('alarm-row-a2');
    expect(row.className).toMatch(/\bborder-t\b/);
    expect(row.className).toMatch(/\bborder-line-subtle\b/);
    expect(row.className).toMatch(/\bfirst:border-t-0\b/);
    expect(row.className).toMatch(/\bhover:bg-surface-sunken\b/);
    expect(row.className).not.toMatch(/\beven:|odd:/);
    expect(row.querySelector('td')?.className).toMatch(/\bpy-2\.5\b/);
    rerender(table({ rows: rowsOf(2), density: 'compact' }));
    expect(screen.getByTestId('alarm-row-a2').querySelector('td')?.className).toMatch(
      /\bpy-1\.5\b/,
    );
  });

  it('marks an abnormal row with its tone bar and the active row with aria-current and accent', () => {
    const { rerender } = render(
      table({
        rows: [alarm(1), alarm(2, 'acknowledged'), alarm(3)],
        rowTone: (row) => (row.state === 'unacknowledged' ? 'alarm' : undefined),
        activeRowKey: 'a3',
      }),
    );
    const first = screen.getByTestId('alarm-row-a1');
    expect(first.querySelector('td')?.className).toContain('var(--color-alarm-border)');
    expect(first.hasAttribute('aria-current')).toBe(false);
    expect(screen.getByTestId('alarm-row-a2').querySelector('td')?.className).not.toContain(
      'inset_3px',
    );
    const active = screen.getByTestId('alarm-row-a3');
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(active.className).toMatch(/\bbg-accent-subtle\b/);
    // An open abnormal row keeps its tone bar; the accent fill marks it open.
    expect(active.querySelector('td')?.className).toContain('alarm-border');
    expect(active.querySelector('td')?.className).not.toContain('var(--color-accent)');
    // An open normal row takes the accent bar.
    rerender(
      table({
        rows: [alarm(1), alarm(2, 'acknowledged'), alarm(3)],
        rowTone: (row) => (row.state === 'unacknowledged' ? 'alarm' : undefined),
        activeRowKey: 'a2',
      }),
    );
    const open = screen.getByTestId('alarm-row-a2');
    expect(open.className).toMatch(/\bbg-accent-subtle\b/);
    expect(open.querySelector('td')?.className).toContain('var(--color-accent)');
  });

  it('makes an emphasised row bold in every cell, its row header included (rowEmphasis)', () => {
    render(
      table({
        rows: [alarm(1), alarm(2, 'acknowledged')],
        columns: [
          { key: 'code', header: 'Alarm', rowHeader: true, cell: (row) => row.code },
          ...COLUMNS.slice(1),
        ],
        rowEmphasis: (row) => row.state === 'unacknowledged',
      }),
    );
    const cells = (id: string) => [
      ...screen.getByTestId(`alarm-row-${id}`).querySelectorAll<HTMLElement>('th, td'),
    ];
    expect(cells('a1').map((cell) => /\bfont-semibold\b/.test(cell.className))).toEqual([
      true,
      true,
      true,
    ]);
    expect(cells('a1')[0]?.className).not.toMatch(/\bfont-normal\b/);
    // A plain row: the row header normal weight, the other cells inherit.
    expect(cells('a2').map((cell) => /\bfont-semibold\b/.test(cell.className))).toEqual([
      false,
      false,
      false,
    ]);
    expect(cells('a2')[0]?.className).toMatch(/\bfont-normal\b/);
  });

  it('keeps a sticky first column above the cells it scrolls over', () => {
    const columns: Column<Alarm>[] = [
      { key: 'code', header: 'Alarm', sticky: true, cell: (row) => row.code },
      { key: 'state', header: 'State', cell: (row) => row.state },
    ];
    render(table({ rows: rowsOf(1), columns }));
    const [stickyTh, otherTh] = screen.getAllByRole('columnheader');
    expect(stickyTh?.className).toMatch(/\bsticky left-0 z-sticky-corner\b/);
    expect(otherTh?.className).not.toMatch(/\bleft-0\b/);
    const [stickyTd, otherTd] = screen.getAllByRole('cell');
    expect(stickyTd?.className).toMatch(/\bsticky left-0 z-sticky-column bg-inherit\b/);
    expect(otherTd?.className).not.toMatch(/(^| )sticky( |$)/);
  });
});

describe('DataTable sticky header', () => {
  const headerOf = () => screen.getAllByRole('columnheader')[0];

  it('sticks under the top bar on the page when more than 15 rows show, in a clipped frame', () => {
    const { rerender } = render(table({ rows: rowsOf(15) }));
    expect(headerOf()?.className).not.toMatch(/(^| )sticky( |$)/);
    rerender(table({ rows: rowsOf(16) }));
    expect(headerOf()?.className).toMatch(/\bsticky top-12 z-sticky\b/);
    expect(headerOf()?.className).toMatch(/\bgroup-data-scroll\/frame:top-0\b/);
    const frame = screen.getByTestId('alarm-table').parentElement;
    expect(frame?.dataset.frame).toBe('fit');
    expect(frame?.className).toMatch(/\boverflow-clip\b/);
    expect(frame?.className).not.toMatch(/\boverflow-auto\b/);
    expect(frame?.hasAttribute('data-scroll')).toBe(false);
    expect(frame?.hasAttribute('tabindex')).toBe(false);
    // The header's bottom line is a shadow, so it moves with the sticky cells.
    expect(headerOf()?.className).toContain('shadow-[inset_0_-1px_0_var(--color-line)]');
  });

  it('follows stickyHeader when given', () => {
    const { rerender } = render(table({ rows: rowsOf(2), stickyHeader: true }));
    expect(headerOf()?.className).toMatch(/(^| )sticky( |$)/);
    rerender(table({ rows: rowsOf(20), stickyHeader: false }));
    expect(headerOf()?.className).not.toMatch(/(^| )sticky( |$)/);
  });

  it('becomes a bounded scroll box, but no tab stop or region while nothing overflows', () => {
    render(table({ rows: rowsOf(3), bounded: true }));
    const frame = screen.getByTestId('alarm-table').parentElement;
    expect(frame?.dataset.frame).toBe('scroll');
    expect(frame?.hasAttribute('data-scroll')).toBe(true);
    expect(frame?.className).toMatch(/\boverflow-auto\b/);
    expect(frame?.className).toContain('max-h-[min(70vh,720px)]');
    // Its scroll padding keeps a focused row clear of the sticky header inside it.
    expect(frame?.className).toMatch(/\bscroll-pt-12\b/);
    // The containing block of absolutely positioned cell content (sr-only text): kept inside.
    expect(frame?.className).toMatch(/(^| )relative( |$)/);
    expect(frame?.hasAttribute('tabindex')).toBe(false);
    expect(frame?.hasAttribute('role')).toBe(false);
    expect(screen.queryByRole('region')).toBeNull();
    // Not wider than the frame: no note and no fade.
    expect(screen.queryByText('Scroll for more columns.')).toBeNull();
    // Three rows: no sticky header on the page, but it sticks inside the box, which also
    // scrolls vertically, so it never scrolls out of it.
    expect(headerOf()?.className).not.toMatch(/(^| )sticky( |$)/);
    expect(headerOf()?.className).toMatch(
      /\bgroup-data-scroll\/frame:sticky group-data-scroll\/frame:top-0\b/,
    );
  });

  it('pads the scroll box by the measured header height, through the CSSOM', () => {
    stubResize({ tableWidth: 600, frameWidth: 600, scrollHeight: 1200, clientHeight: 500 });
    vi.spyOn(HTMLTableSectionElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 63.5,
    } as DOMRect);
    render(table({ rows: rowsOf(40), bounded: true }));
    const frame = screen.getByRole('region', { name: 'Active alarms, newest first' });
    expect(frame.style.getPropertyValue('scroll-padding-top')).toBe('4.5rem'); // 64 + 8 px
  });

  it('is a focusable region named by its caption once the bounded box overflows', () => {
    stubResize({ tableWidth: 600, frameWidth: 600, scrollHeight: 1200, clientHeight: 500 });
    render(table({ rows: rowsOf(40), bounded: true }));
    const frame = screen.getByRole('region', { name: 'Active alarms, newest first' });
    expect(frame.dataset.frame).toBe('scroll');
    expect(frame.tabIndex).toBe(0);
    const caption = screen.getByRole('table').querySelector('caption');
    expect(frame.getAttribute('aria-labelledby')).toBe(caption?.id);
    expect(frame.hasAttribute('aria-label')).toBe(false);
    // Taller, not wider: no sideways note or fade.
    expect(screen.queryByText('Scroll for more columns.')).toBeNull();
  });

  it('becomes a scroll box with an edge fade and a note when the table is wider than its frame', () => {
    let callback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb;
        }
        observe = observe;
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );
    let tableWidth = 900;
    vi.spyOn(HTMLTableElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: tableWidth }) as DOMRect,
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    render(table({ rows: rowsOf(20) }));
    expect(observe).toHaveBeenCalledTimes(3); // the frame, the table, its header row
    const frame = screen.getByRole('region', { name: 'Active alarms, newest first' });
    expect(frame.dataset.frame).toBe('scroll');
    expect(screen.getByText('Scroll for more columns.').className).toMatch(/\bsr-only\b/);
    const fade = frame.parentElement?.querySelector('[data-fade]');
    expect(fade?.getAttribute('aria-hidden')).toBe('true');
    expect(fade?.className).toMatch(/\bfrom-surface\b/);
    // Still sticky, now to the top of the box (the frame carries data-scroll).
    expect(headerOf()?.className).toMatch(/(^| )sticky( |$)/);

    // Scrolled to the end: the fade goes.
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    frame.scrollLeft = 300;
    fireEvent.scroll(frame);
    expect(frame.parentElement?.querySelector('[data-fade]')).toBeNull();

    // Wider frame: back to the page mode.
    tableWidth = 600;
    act(() => {
      callback?.([], {} as ResizeObserver);
    });
    expect(screen.getByTestId('alarm-table').parentElement?.dataset.frame).toBe('fit');
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('DataTable selection', () => {
  function Selectable({ initial = [] }: { readonly initial?: readonly string[] }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
    return table({
      rows: [alarm(1), alarm(2), alarm(3, 'acknowledged')],
      selection: {
        selected,
        onChange: setSelected,
        label: (row) => `Select ${row.code}`,
        allLabel: 'Select every alarm that can be acknowledged',
        selectable: (row) => row.state === 'unacknowledged',
        testId: 'select-all',
        rowTestId: (row) => `select-${row.id}`,
      },
    });
  }
  const all = () => screen.getByTestId<HTMLInputElement>('select-all');

  it('has a select-all in the header and a named checkbox per selectable row, in 24 px hit areas', () => {
    render(<Selectable />);
    expect(
      screen.getByRole('checkbox', { name: 'Select every alarm that can be acknowledged' }),
    ).toBe(all());
    expect(all().closest('th')?.getAttribute('scope')).toBe('col');
    expect(screen.getByRole('checkbox', { name: 'Select CODE-1' }).dataset.testid).toBe(
      'select-a1',
    );
    expect(screen.queryByTestId('select-a3')).toBeNull();
    expect(all().parentElement?.tagName).toBe('LABEL');
    expect(all().parentElement?.className).toMatch(/\bsize-6\b/);
    expect(screen.getByTestId('select-a1').parentElement?.className).toMatch(/\bsize-6\b/);
    // The checkbox column comes first; the cells after it keep their places.
    const cells = screen.getByTestId('alarm-row-a1').querySelectorAll('td');
    expect(cells[1]?.textContent).toBe('CODE-1');
  });

  it('sets the native indeterminate when some selectable rows are selected, checked when all', () => {
    render(<Selectable />);
    expect(all().checked).toBe(false);
    expect(all().indeterminate).toBe(false);
    fireEvent.click(screen.getByTestId('select-a1'));
    expect(all().checked).toBe(false);
    expect(all().indeterminate).toBe(true);
    expect(all().hasAttribute('aria-checked')).toBe(false);
    fireEvent.click(screen.getByTestId('select-a2'));
    expect(all().checked).toBe(true);
    expect(all().indeterminate).toBe(false);
    fireEvent.click(screen.getByTestId('select-a1'));
    expect(all().indeterminate).toBe(true);
  });

  it('selects every selectable row and clears them from the select-all', () => {
    render(<Selectable initial={['a1']} />);
    fireEvent.click(all());
    expect(screen.getByTestId<HTMLInputElement>('select-a1').checked).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>('select-a2').checked).toBe(true);
    expect(all().checked).toBe(true);
    fireEvent.click(all());
    expect(screen.getByTestId<HTMLInputElement>('select-a1').checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>('select-a2').checked).toBe(false);
    expect(all().indeterminate).toBe(false);
  });

  it('selects only the rows of the page shown', () => {
    const onChange = vi.fn();
    render(
      table({
        rows: rowsOf(5),
        pageSize: 2,
        selection: {
          selected: new Set(),
          onChange,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select all',
          testId: 'select-all',
        },
      }),
    );
    fireEvent.click(all());
    expect([...(onChange.mock.calls[0]?.[0] as Set<string>)]).toEqual(['a1', 'a2']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(all());
    expect([...(onChange.mock.calls[1]?.[0] as Set<string>)]).toEqual(['a3', 'a4']);
  });

  it('keeps the other pages\u2019 selection when the select-all selects or clears a page', () => {
    function Paged() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <>
          {table({
            rows: rowsOf(5),
            pageSize: 2,
            selection: {
              selected,
              onChange: setSelected,
              label: (row) => `Select ${row.code}`,
              allLabel: 'Select all',
              testId: 'select-all',
            },
          })}
          <output data-testid="chosen">{[...selected].sort().join(',')}</output>
        </>
      );
    }
    render(<Paged />);
    const chosen = () => screen.getByTestId('chosen').textContent;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CODE-1' }));
    expect(chosen()).toBe('a1');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Page 2: none of its rows selected, so the select-all is clear, not mixed.
    expect(all().checked).toBe(false);
    expect(all().indeterminate).toBe(false);
    fireEvent.click(all());
    expect(chosen()).toBe('a1,a3,a4');
    expect(all().checked).toBe(true);
    fireEvent.click(all());
    expect(chosen()).toBe('a1');
    expect(all().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    // Page 1: one of two selected.
    expect(all().indeterminate).toBe(true);
  });

  it('keeps the select-all mixed when the owner keeps the selection after a click', () => {
    render(
      table({
        rows: rowsOf(3),
        selection: {
          selected: new Set(['a1']),
          onChange: () => undefined,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select all',
          testId: 'select-all',
        },
      }),
    );
    expect(all().indeterminate).toBe(true);
    fireEvent.click(all());
    expect(all().checked).toBe(false);
    expect(all().indeterminate).toBe(true);
  });

  it('disables the select-all when no row can be selected', () => {
    render(
      table({
        rows: [alarm(1, 'acknowledged')],
        selection: {
          selected: new Set(),
          onChange: () => undefined,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select all',
          selectable: () => false,
          testId: 'select-all',
        },
      }),
    );
    expect(all().disabled).toBe(true);
    expect(all().checked).toBe(false);
  });
});

describe('DataTable row actions and focus', () => {
  function Acknowledging({
    initial = 4,
    announce = true,
  }: {
    readonly initial?: number;
    readonly announce?: boolean;
  }) {
    const [rows, setRows] = useState(() => rowsOf(initial));
    const remove = (id: string) => {
      setRows((all) => all.filter((row) => row.id !== id));
    };
    return (
      <Section title="Active alarms" id="alarms-title">
        {table({
          rows,
          actions: (row) => (
            <>
              <Button variant="ghost" size="sm" onClick={() => undefined}>
                Details {row.code}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`ack-${row.id}`}
                onClick={() => {
                  remove(row.id);
                }}
              >
                Acknowledge {row.code}
              </Button>
            </>
          ),
          ...(announce
            ? { announceRemoval: (left: number) => `Alarm acknowledged; ${String(left)} left` }
            : {}),
        })}
        <button type="button">Elsewhere</button>
      </Section>
    );
  }

  it('puts the actions side by side in the last column, under a hidden "Actions" header', () => {
    render(<Acknowledging initial={1} />);
    const headers = screen.getAllByRole('columnheader');
    const last = headers[headers.length - 1];
    expect(last?.textContent).toBe('Actions');
    expect(last?.querySelector('.sr-only')?.textContent).toBe('Actions');
    const cell = screen.getByTestId('ack-a1').closest('td');
    expect(cell?.firstElementChild?.className).toMatch(/\bflex flex-nowrap\b/);
    expect(cell?.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(screen.getByTestId('ack-a1').className).toMatch(/\bmin-h-7\b/);
  });

  it('moves the focus to the same action in the next row when the row disappears', () => {
    render(<Acknowledging />);
    const ack = screen.getByTestId('ack-a2');
    ack.focus();
    fireEvent.click(ack);
    expect(screen.queryByTestId('alarm-row-a2')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('ack-a3'));
    expect(screen.getByRole('status').textContent).toBe('Alarm acknowledged; 3 left');
  });

  it('falls back to the previous row, then to the section heading', () => {
    render(<Acknowledging initial={2} />);
    screen.getByTestId('ack-a2').focus();
    fireEvent.click(screen.getByTestId('ack-a2'));
    expect(document.activeElement).toBe(screen.getByTestId('ack-a1'));
    fireEvent.click(screen.getByTestId('ack-a1'));
    const heading = screen.getByRole('heading', { name: 'Active alarms' });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('status').textContent).toBe('Alarm acknowledged; 0 left');
  });

  it('keeps the same control among several in the row', () => {
    render(<Acknowledging announce={false} />);
    const details = screen.getByRole('button', { name: 'Details CODE-1' });
    details.focus();
    fireEvent.focus(details);
    act(() => {
      // The row goes for another reason (a live update) while its first action has the focus.
      fireEvent.click(screen.getByTestId('ack-a1'));
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details CODE-2' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('finds the same action in a next row whatever its checkbox', () => {
    function Mixed() {
      const [rows, setRows] = useState(() => [alarm(1, 'acknowledged'), alarm(2)]);
      return table({
        rows,
        selection: {
          selected: new Set(),
          onChange: () => undefined,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select all',
          selectable: (row) => row.state === 'unacknowledged',
        },
        actions: (row) => (
          <>
            <Button size="sm">Details {row.code}</Button>
            <Button
              size="sm"
              onClick={() => {
                setRows((all) => all.filter((r) => r.id !== row.id));
              }}
            >
              Remove {row.code}
            </Button>
          </>
        ),
      });
    }
    render(<Mixed />);
    // The first row has no checkbox: "Details" is its first control. The next row's first
    // control is its checkbox; the same control is still "Details".
    const details = screen.getByRole('button', { name: 'Details CODE-1' });
    details.focus();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove CODE-1' }));
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details CODE-2' }));
  });

  it('takes the first control of the next row when it lacks the same one', () => {
    function NoCheck() {
      const [rows, setRows] = useState(() => [alarm(1), alarm(2, 'acknowledged')]);
      return table({
        rows,
        selection: {
          selected: new Set(),
          onChange: () => undefined,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select all',
          selectable: (row) => row.state === 'unacknowledged',
        },
        actions: (row) => (
          <Button
            size="sm"
            onClick={() => {
              setRows((all) => all.filter((r) => r.id !== row.id));
            }}
          >
            Remove {row.code}
          </Button>
        ),
      });
    }
    render(<NoCheck />);
    // The focus is on the first row's checkbox; the next row has none.
    screen.getByRole('checkbox', { name: 'Select CODE-1' }).focus();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove CODE-1' }));
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove CODE-2' }));
  });

  it('counts every row, not the page, in the removal status', () => {
    function Paged() {
      const [rows, setRows] = useState(() => rowsOf(4));
      return table({
        rows,
        pageSize: 2,
        announceRemoval: (left) => `Alarm acknowledged; ${String(left)} left`,
        actions: (row) => (
          <Button
            size="sm"
            data-testid={`ack-${row.id}`}
            onClick={() => {
              setRows((all) => all.filter((r) => r.id !== row.id));
            }}
          >
            Acknowledge {row.code}
          </Button>
        ),
      });
    }
    render(<Paged />);
    screen.getByTestId('ack-a1').focus();
    fireEvent.click(screen.getByTestId('ack-a1'));
    expect(document.activeElement).toBe(screen.getByTestId('ack-a2'));
    expect(screen.getByRole('status').textContent).toBe('Alarm acknowledged; 3 left');
  });

  it('does not take the focus back from where the user moved it', () => {
    render(<Acknowledging />);
    screen.getByTestId('ack-a1').focus();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.click(screen.getByTestId('ack-a1'));
    expect(document.activeElement).toBe(elsewhere);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('leaves the focus where it went even while the row is still remembered', () => {
    render(<Acknowledging />);
    const ack = screen.getByTestId('ack-a1');
    ack.focus();
    // Focus lost to nothing (no related target), then taken by a control outside, before the
    // check that would forget the row has run; then the row goes.
    ack.blur();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    fireEvent.click(ack);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('forgets the row after the focus left it for nothing (a click on the page)', async () => {
    render(<Acknowledging />);
    const ack = screen.getByTestId('ack-a1');
    ack.focus();
    ack.blur();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(ack);
    expect(document.activeElement).toBe(document.body);
  });

  it('puts a "Skip to the details" link before the table that focuses the detail', () => {
    render(
      <>
        {table({
          rows: rowsOf(2),
          skipToDetails: 'alarm-detail',
          actions: (row) => <Button size="sm">Acknowledge {row.code}</Button>,
        })}
        <aside id="alarm-detail">Detail</aside>
      </>,
    );
    const skip = screen.getByRole('link', { name: 'Skip to the details' });
    expect(skip.getAttribute('href')).toBe('#alarm-detail');
    expect(skip.className).toMatch(/\bsr-only focus:not-sr-only\b/);
    expect(
      skip.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(skip);
    const detail = screen.getByText('Detail');
    expect(document.activeElement).toBe(detail);
    expect(detail.getAttribute('tabindex')).toBe('-1');
  });

  it('words the skip link by skipLabel, past a long table to the next section (G-33)', () => {
    render(
      <>
        {table({ rows: rowsOf(2), skipToDetails: 'next-title', skipLabel: 'Skip past the units' })}
        <h2 id="next-title">Orders</h2>
      </>,
    );
    expect(screen.queryByRole('link', { name: 'Skip to the details' })).toBeNull();
    const skip = screen.getByRole('link', { name: 'Skip past the units' });
    expect(skip.getAttribute('href')).toBe('#next-title');
    fireEvent.click(skip);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Orders' }));
  });
});

describe('DataTable states', () => {
  it('shows its EmptyState instead of the table, header row included, under the test id', () => {
    render(table({ rows: [], empty: <EmptyState title="No active alarms" /> }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('columnheader')).toBeNull();
    const empty = screen.getByTestId('alarm-table');
    expect(empty.dataset.count).toBe('0');
    expect(within(empty).getByText('No active alarms')).toBeTruthy();
  });

  it('keeps the header row of an empty table without an EmptyState', () => {
    render(table({ rows: [] }));
    expect(screen.getByRole('table').dataset.count).toBe('0');
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });

  it('shows a table skeleton while loading, and the error state for a failed read', () => {
    const { rerender } = render(table({ rows: [], loading: 'Loading alarms…' }));
    const status = screen.getByRole('status');
    expect(status.dataset.shape).toBe('table');
    expect(status.textContent).toContain('Loading alarms…');
    expect(screen.queryByRole('table')).toBeNull();
    const onRetry = vi.fn();
    rerender(
      table({
        rows: [],
        loading: 'Loading alarms…',
        error: { what: 'the alarms', error: new ApiError('Unavailable', 503), onRetry },
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Could not load the alarms.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('uses the given count for data-count', () => {
    render(table({ rows: rowsOf(2), count: 7 }));
    expect(screen.getByRole('table').dataset.count).toBe('7');
  });
});

describe('DataTable paging', () => {
  it('shows one page with "1–50 of 120", Previous and Next', () => {
    render(table({ rows: rowsOf(120), pageSize: 50 }));
    expect(screen.getByRole('table').querySelectorAll('tbody > tr')).toHaveLength(50);
    expect(screen.getByRole('table').dataset.count).toBe('120');
    const pager = screen.getByRole('navigation', { name: 'Active alarms, newest first: pages' });
    expect(within(pager).getByText('1–50 of 120')).toBeTruthy();
    const previous = within(pager).getByRole('button', { name: 'Previous' });
    const next = within(pager).getByRole('button', { name: 'Next' });
    expect(previous).toHaveProperty('disabled', true);
    fireEvent.click(next);
    expect(within(pager).getByText('51–100 of 120')).toBeTruthy();
    expect(screen.getByTestId('alarm-row-a51')).toBeTruthy();
    expect(screen.queryByTestId('alarm-row-a1')).toBeNull();
    fireEvent.click(next);
    expect(within(pager).getByText('101–120 of 120')).toBeTruthy();
    expect(next).toHaveProperty('disabled', true);
    fireEvent.click(previous);
    expect(within(pager).getByText('51–100 of 120')).toBeTruthy();
  });

  it('announces a page change by the user, and never a count change by itself', () => {
    const { rerender } = render(table({ rows: rowsOf(120), pageSize: 50 }));
    const range = screen.getByText('1–50 of 120');
    expect(range.hasAttribute('aria-live')).toBe(false);
    expect(range.closest('[aria-live]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    rerender(table({ rows: rowsOf(121), pageSize: 50 }));
    expect(screen.getByText('1–50 of 121')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('status').textContent).toBe('Rows 51–100 of 121');
  });

  it('has no pager for one page, and stays on the last page when rows go', () => {
    const { rerender } = render(table({ rows: rowsOf(50), pageSize: 50 }));
    expect(screen.queryByRole('navigation')).toBeNull();
    rerender(table({ rows: rowsOf(120), pageSize: 50 }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    rerender(table({ rows: rowsOf(80), pageSize: 50 }));
    expect(screen.getByText('51–80 of 80')).toBeTruthy();
  });
});

describe('DataTable on narrow screens', () => {
  function narrowScreen(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  it('stacks each row as a card of label and value pairs below md with `stack`', () => {
    narrowScreen(true);
    render(
      table({
        rows: rowsOf(2),
        narrow: 'stack',
        activeRowKey: 'a2',
        actions: (row) => <Button size="sm">Acknowledge {row.code}</Button>,
      }),
    );
    expect(screen.queryByRole('table')).toBeNull();
    const list = screen.getByRole('list', { name: 'Active alarms, newest first' });
    expect(list.dataset.testid).toBe('alarm-table');
    expect(list.dataset.count).toBe('2');
    const card = screen.getByTestId('alarm-row-a1');
    expect(card.tagName).toBe('LI');
    expect(card.dataset.state).toBe('unacknowledged');
    expect([...card.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      'Alarm',
      'Open (min)',
      'State',
    ]);
    expect([...card.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual([
      'CODE-1',
      '1.5',
      'unacknowledged',
    ]);
    expect(within(card).getByRole('button', { name: 'Acknowledge CODE-1' })).toBeTruthy();
    expect(screen.getByTestId('alarm-row-a2').getAttribute('aria-current')).toBe('true');
  });

  it('keeps the table below md with `scroll`, and above md with `stack`', () => {
    narrowScreen(true);
    const { unmount } = render(table({ rows: rowsOf(2) }));
    expect(screen.getByRole('table')).toBeTruthy();
    unmount();
    narrowScreen(false);
    render(table({ rows: rowsOf(2), narrow: 'stack' }));
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('makes an emphasised stacked card bold', () => {
    narrowScreen(true);
    render(
      table({
        rows: [alarm(1), alarm(2, 'acknowledged')],
        narrow: 'stack',
        rowEmphasis: (row) => row.state === 'unacknowledged',
      }),
    );
    expect(screen.getByTestId('alarm-row-a1').className).toMatch(/\bfont-semibold\b/);
    expect(screen.getByTestId('alarm-row-a2').className).not.toMatch(/\bfont-semibold\b/);
  });

  it('keeps selection in the stacked cards', () => {
    narrowScreen(true);
    const onChange = vi.fn();
    render(
      table({
        rows: rowsOf(2),
        narrow: 'stack',
        selection: {
          selected: new Set(['a1']),
          onChange,
          label: (row) => `Select ${row.code}`,
          allLabel: 'Select every alarm',
        },
      }),
    );
    const all = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select every alarm' });
    expect(all.indeterminate).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CODE-2' }));
    expect([...(onChange.mock.calls[0]?.[0] as Set<string>)]).toEqual(['a1', 'a2']);
  });
});
