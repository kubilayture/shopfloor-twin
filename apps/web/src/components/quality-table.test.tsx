import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Table, cell } from './quality-ui.tsx';

/** UX-1d1 (#318): the quality screens' `Table` on `DataTable`'s frame and header. */

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => (
    <tr key={i} data-testid={`row-${String(i)}`}>
      <td className={cell}>{i}</td>
      <td className={cell}>Lot {i}</td>
      <td className={cell} />
    </tr>
  ));

describe('the quality Table', () => {
  it('keeps table → tbody → tr → td, the caption, column headers and data-count', () => {
    render(
      <Table testId="hold-list" caption="Open holds" columns={['#', 'Lot', '']} count={2}>
        {rows(2)}
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'Open holds' });
    expect(table.dataset.testid).toBe('hold-list');
    expect(table.dataset.count).toBe('2');
    expect(table.querySelector('caption')?.className).toMatch(/\bsr-only\b/);
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent)).toEqual(['#', 'Lot', '']);
    expect(headers.every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    expect(headers[0]?.className).toMatch(/\bbg-surface-sunken\b/);
    // One vertical alignment: the header's bottom, not `cell`'s top as well.
    expect(headers[0]?.className).toMatch(/\balign-bottom\b/);
    expect(headers[0]?.className).not.toMatch(/\balign-top\b/);
    expect(table.querySelectorAll('tbody > tr > td')).toHaveLength(6);
    expect(table.querySelector('tbody')?.className).toMatch(/\bdivide-y divide-line-subtle\b/);
    // Short: no sticky header, in a frame that fits.
    expect(headers[0]?.className).not.toMatch(/(^| )sticky( |$)/);
    expect(table.parentElement?.dataset.frame).toBe('fit');
  });

  it('sticks its header when more than 15 rows show, counted from the rows without a count', () => {
    const { rerender } = render(
      <Table testId="t" caption="Units" columns={['#', 'Lot', '']}>
        {rows(15)}
      </Table>,
    );
    expect(screen.getAllByRole('columnheader')[0]?.className).not.toMatch(/(^| )sticky( |$)/);
    rerender(
      <Table testId="t" caption="Units" columns={['#', 'Lot', '']}>
        {rows(16)}
      </Table>,
    );
    expect(screen.getAllByRole('columnheader')[0]?.className).toMatch(/\bsticky top-12\b/);
    expect(screen.getByRole('table').hasAttribute('data-count')).toBe(false);
  });

  it('is a bounded scroll box when bounded', () => {
    render(
      <Table testId="hold-units" caption="Units in scope" columns={['#']} count={1} bounded>
        <tr>
          <td className={cell}>1</td>
        </tr>
      </Table>,
    );
    const frame = screen.getByRole('table').parentElement;
    expect(frame?.dataset.frame).toBe('scroll');
    expect(frame?.className).toMatch(/\boverflow-auto scroll-pt-12\b/);
    // One row: nothing scrolls, so no tab stop and no region.
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('columnheader').className).toMatch(
      /\bgroup-data-scroll\/frame:sticky\b/,
    );
  });
});
