import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './badge.tsx';
import { Callout } from './callout.tsx';
import { Card } from './card.tsx';
import { Code } from './code.tsx';
import { DescriptionList } from './description-list.tsx';
import { Missing } from './format.tsx';
import { KpiTile, Stat } from './stat.tsx';

const classesOf = (element: Element): string[] => element.className.split(/\s+/);

/** UX-1c (#315): design system 4.3, 4.4, 4.13 and 3.4. */
describe('Card', () => {
  it('is a named group by default (no landmark), with status beside the title and actions', () => {
    render(
      <Card
        title="Line OEE"
        status={<Badge tone="neutral">Final</Badge>}
        description="Per shift, at the bottleneck."
        actions={<button type="button">Export</button>}
        testId="line-oee-card"
      >
        <p>body</p>
      </Card>,
    );
    const card = screen.getByRole('group', { name: 'Line OEE' });
    expect(card.tagName).toBe('DIV');
    // A generic div is never named on its own (ARIA 1.2): the name rides on role="group".
    expect(card.getAttribute('role')).toBe('group');
    expect(screen.queryByRole('region')).toBeNull();
    expect(card.dataset.testid).toBe('line-oee-card');
    const heading = within(card).getByRole('heading', { level: 2, name: 'Line OEE' });
    expect(heading.nextElementSibling?.textContent).toBe('Final');
    expect(within(card).getByText('Per shift, at the bottleneck.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Export' })).toBeTruthy();
    expect(classesOf(card)).toEqual(
      expect.arrayContaining(['rounded-lg', 'border', 'border-line', 'bg-surface', 'p-5']),
    );
    expect(card.className).not.toMatch(/shadow|border-l-4/);
  });

  it('takes an h3, another element, compact padding and a tone bar for abnormal items', () => {
    render(
      <Card title="CNC-01" headingLevel={3} as="article" padding="compact" tone="alarm" testId="c">
        x
      </Card>,
    );
    const card = screen.getByRole('article', { name: 'CNC-01' });
    expect(card.dataset.testid).toBe('c');
    expect(card.hasAttribute('role')).toBe(false);
    expect(within(card).getByRole('heading', { level: 3, name: 'CNC-01' })).toBeTruthy();
    expect(classesOf(card)).toEqual(
      expect.arrayContaining(['p-4', 'border-l-4', 'border-l-alarm-border']),
    );
  });

  it('is a region landmark only when asked to be a section', () => {
    render(
      <Card title="Shift A" as="section" testId="c">
        x
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Shift A' });
    expect(card.tagName).toBe('SECTION');
    expect(card.hasAttribute('role')).toBe(false);
  });

  it('without a title has no heading, no role and no name, whatever its element', () => {
    render(
      <>
        <Card testId="c">content</Card>
        <Card testId="s" as="section">
          more
        </Card>
      </>,
    );
    for (const id of ['c', 's']) {
      const element = screen.getByTestId(id);
      expect(element.hasAttribute('aria-labelledby')).toBe(false);
      expect(element.hasAttribute('role')).toBe(false);
    }
    const card = screen.getByTestId('c');
    expect(within(card).queryByRole('heading')).toBeNull();
    expect(card.textContent).toBe('content');
  });
});

describe('Stat', () => {
  it('labels its figure in a description list, keeps test ids and the raw value', () => {
    render(
      <Stat
        label="OEE"
        value="83.04"
        unit="%"
        hint="83/100"
        testId="oee"
        valueTestId="oee-percent"
        dataValue="0.8304"
      />,
    );
    const stat = screen.getByTestId('oee');
    expect(stat.tagName).toBe('DL');
    expect(within(stat).getByRole('term').textContent).toBe('OEE');
    const value = screen.getByTestId('oee-percent');
    expect(value.textContent).toBe('83.04 %');
    expect(value.dataset.value).toBe('0.8304');
    expect(classesOf(value)).toEqual(
      expect.arrayContaining(['tabular-nums', 'text-2xl', 'text-ink']),
    );
    expect(stat.textContent).toContain('83/100');
  });

  it('sizes by emphasis and colours the value only by its tone', () => {
    const { rerender } = render(<Stat label="a" value="1" emphasis="headline" valueTestId="v" />);
    expect(classesOf(screen.getByTestId('v'))).toContain('text-3xl');
    rerender(<Stat label="a" value="1" emphasis="compact" tone="alarm" valueTestId="v" />);
    expect(classesOf(screen.getByTestId('v'))).toEqual(
      expect.arrayContaining(['text-lg', 'text-alarm-ink']),
    );
  });

  it('shows a verdict as a badge', () => {
    render(
      <Stat label="Average per 10 min" value="1.2" verdict={{ tone: 'ok', text: 'Acceptable' }} />,
    );
    const verdict = screen.getByText('Acceptable');
    expect(classesOf(verdict)).toContain('bg-ok-soft');
  });

  it('with no value: an em dash at the same size and the reason, never "n/a"', () => {
    render(
      <Stat
        label="OEE"
        value="n/a"
        emphasis="headline"
        missing="No planned time this shift"
        verdict={{ tone: 'ok', text: 'Acceptable' }}
        hint="hidden"
        valueTestId="v"
      />,
    );
    const value = screen.getByTestId('v');
    expect(value.textContent).toBe('—');
    expect(classesOf(value)).toEqual(expect.arrayContaining(['text-3xl', 'text-ink-secondary']));
    expect(screen.getByText('No planned time this shift')).toBeTruthy();
    expect(screen.queryByText('n/a')).toBeNull();
    expect(screen.queryByText('Acceptable')).toBeNull();
    expect(screen.queryByText('hidden')).toBeNull();
  });
});

describe('KpiTile', () => {
  it('is a card with one headline figure and at most four compact ones', () => {
    render(
      <KpiTile
        title="Alarm load"
        testId="kpi"
        headline={{ label: 'Average per 10 min', value: '0.8', valueTestId: 'head' }}
        details={['a', 'b', 'c', 'd', 'e'].map((label) => ({ label, value: '1' }))}
      />,
    );
    // A group, not a landmark: a grid of tiles does not flood the landmark list.
    const tile = screen.getByRole('group', { name: 'Alarm load' });
    expect(screen.queryByRole('region')).toBeNull();
    expect(tile.dataset.testid).toBe('kpi');
    expect(classesOf(screen.getByTestId('head'))).toContain('text-3xl');
    const terms = within(tile)
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(terms).toEqual(['Average per 10 min', 'a', 'b', 'c', 'd']);
  });
});

describe('Callout', () => {
  it('shows its title and words on its tone, with a glyph, passing data-* through', () => {
    render(
      <Callout
        tone="alarm"
        title="The write was refused"
        role="alert"
        data-testid="failure"
        data-kind="conflict"
      >
        Someone changed it first.
      </Callout>,
    );
    const callout = screen.getByRole('alert');
    expect(callout.dataset.testid).toBe('failure');
    expect(callout.dataset.kind).toBe('conflict');
    expect(callout.textContent).toBe('The write was refusedSomeone changed it first.');
    expect(callout.querySelector('svg')?.getAttribute('data-icon')).toBe('alert');
    expect(classesOf(callout)).toEqual(
      expect.arrayContaining(['bg-alarm-soft', 'text-alarm-ink', 'border-alarm-border']),
    );
  });

  it('has no role unless asked: a callout present on load is not announced', () => {
    render(<Callout tone="neutral">Your role cannot change orders.</Callout>);
    const callout = screen.getByText('Your role cannot change orders.').parentElement
      ?.parentElement;
    expect(callout?.hasAttribute('role')).toBe(false);
    expect(callout?.querySelector('svg')?.getAttribute('data-icon')).toBe('info');
  });
});

describe('Code', () => {
  it('is an inline code element in monospace at 0.95 em', () => {
    render(<Code testId="id">PO-2610-303</Code>);
    const code = screen.getByTestId('id');
    expect(code.tagName).toBe('CODE');
    expect(classesOf(code)).toEqual(expect.arrayContaining(['font-mono', 'text-[0.95em]']));
  });
});

describe('DescriptionList', () => {
  it('lists the facts that have a value, in source order, flowing by column', () => {
    render(
      <DescriptionList
        testId="facts"
        label="Order facts"
        facts={[
          { term: 'Product', detail: 'VB-100', testId: 'fact-product' },
          { term: 'Due', detail: null },
          { term: 'Quantity', detail: '60 blanks' },
          { term: 'Operator', detail: <Missing reason="Nobody signed on" /> },
        ]}
      />,
    );
    const list = screen.getByTestId('facts');
    expect(list.tagName).toBe('DL');
    expect(list.getAttribute('aria-label')).toBe('Order facts');
    expect(classesOf(list)).toEqual(
      expect.arrayContaining(['columns-1', 'sm:columns-2', 'xl:columns-4']),
    );
    const terms = within(list)
      .getAllByRole('term')
      .map((t) => t.textContent);
    expect(terms).toEqual(['Product', 'Quantity', 'Operator']);
    expect(screen.getByTestId('fact-product').textContent).toBe('ProductVB-100');
  });

  it('takes one or two columns', () => {
    const { rerender } = render(<DescriptionList testId="f" columns={1} facts={[]} />);
    expect(screen.getByTestId('f').className).not.toContain('sm:columns-2');
    rerender(<DescriptionList testId="f" columns={2} facts={[]} />);
    expect(screen.getByTestId('f').className).not.toContain('xl:columns-4');
  });
});
