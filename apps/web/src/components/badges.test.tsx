import type { CommandState, OrderStatus, SpcSignalDto } from '@shopfloor/contracts/mes-api';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COMMAND_STATE_TEXT, ORDER_STATUS_TEXT } from '../domain/orders.ts';
import { STALE_TEXT, stateStyle } from '../domain/states.ts';
import { FinalityBadge } from './finality-badge.tsx';
import { LossBadge } from './loss-badge.tsx';
import { FlagBadges, SectionFinality, StatusFlags, groupFinality, itemFlags } from './oee-ui.tsx';
import { CommandStateBadge, OrderFlags, OrderStatusBadge } from './order-badges.tsx';
import { PriorityBadge } from './priority-badge.tsx';
import { HoldStateBadge, SignalStatusBadge } from './quality-ui.tsx';
import { StaleTag, StateBadge } from './state-badge.tsx';
import { Badge } from './ui/badge.tsx';

const classesOf = (element: Element): string[] => element.className.split(/\s+/);
const iconOf = (element: Element): string | null =>
  element.querySelector('svg')?.getAttribute('data-icon') ?? null;

/** UX-1c (#315): design system 4.2, 2.4, 2.5 and 2.6. */
describe('Badge', () => {
  it('is the word in a tone, with a 1 px border on every variant and a hidden glyph', () => {
    render(
      <Badge tone="alarm" icon="alert" data-testid="b" data-state="open" title="Needs a decision">
        Open
      </Badge>,
    );
    const badge = screen.getByTestId('b');
    expect(badge.textContent).toBe('Open');
    expect(badge.dataset.state).toBe('open');
    expect(badge.getAttribute('title')).toBe('Needs a decision');
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(badge)).toEqual(
      expect.arrayContaining([
        'border',
        'rounded-sm',
        'whitespace-nowrap',
        'font-semibold',
        'bg-alarm-soft',
        'text-alarm-ink',
        'border-alarm-border',
      ]),
    );
  });

  it('has the four variants and the three sizes', () => {
    render(
      <>
        <Badge tone="info" variant="solid" data-testid="solid">
          a
        </Badge>
        <Badge tone="info" variant="outline" data-testid="outline">
          b
        </Badge>
        <Badge tone="info" variant="dashed" size="md" data-testid="dashed">
          c
        </Badge>
        <Badge tone="info" size="lg" data-testid="lg">
          d
        </Badge>
      </>,
    );
    expect(classesOf(screen.getByTestId('solid'))).toEqual(
      expect.arrayContaining(['bg-info-solid', 'text-info-on-solid', 'min-h-4.5', 'text-xs']),
    );
    expect(classesOf(screen.getByTestId('outline'))).toEqual(
      expect.arrayContaining(['bg-surface', 'text-info-ink', 'border-info-border']),
    );
    expect(classesOf(screen.getByTestId('outline'))).not.toContain('border-dashed');
    expect(classesOf(screen.getByTestId('dashed'))).toEqual(
      expect.arrayContaining(['border-dashed', 'min-h-5.5']),
    );
    expect(classesOf(screen.getByTestId('lg'))).toEqual(
      expect.arrayContaining(['min-h-7', 'text-sm', 'bg-info-soft']),
    );
  });

  it('passes id, aria-* and a ref through, and adds a className after its own', () => {
    let node: HTMLSpanElement | null = null;
    render(
      <Badge
        tone="warn"
        id="why"
        aria-label="Short by 3"
        className="ml-2"
        ref={(element) => {
          node = element;
        }}
      >
        Short
      </Badge>,
    );
    const badge = screen.getByText('Short');
    expect(node).toBe(badge);
    expect(badge.id).toBe('why');
    expect(badge.getAttribute('aria-label')).toBe('Short by 3');
    expect(classesOf(badge).at(-1)).toBe('ml-2');
    expect(badge.className).not.toMatch(/undefined|\s{2}/);
  });

  it('has no title attribute unless given one', () => {
    render(<Badge tone="neutral">Closed</Badge>);
    expect(screen.getByText('Closed').hasAttribute('title')).toBe(false);
  });
});

describe('StateBadge', () => {
  const cases: [state: string, label: string, icon: string | null, key: string][] = [
    ['Running', 'Running', 'play', 'running'],
    ['Idle', 'Idle', null, 'idle'],
    ['Setup', 'Setup', 'rotate', 'setup'],
    ['PlannedStop', 'Planned stop', 'pause', 'planned-stop'],
    ['Maintenance', 'Maintenance', 'wrench', 'maintenance'],
    ['Off', 'Off', 'circle', 'off'],
    ['Starved', 'Starved', 'triangle-left', 'starved'],
    ['Blocked', 'Blocked', 'play-bar', 'blocked'],
    ['Stopped', 'Stopped', 'stop', 'stopped'],
    ['Down', 'Down', 'close', 'down'],
  ];

  it('shows every state as its word, raw in data-state, on its tokens and with its glyph', () => {
    for (const [state, label, icon, key] of cases) {
      const { unmount } = render(<StateBadge state={state} testId="s" />);
      const badge = screen.getByTestId('s');
      expect(badge.dataset.state, state).toBe(state);
      // The text is the word alone: tests read `textContent` ('Blocked').
      expect(badge.textContent, state).toBe(label);
      expect(iconOf(badge), state).toBe(icon);
      expect(classesOf(badge), state).toEqual(
        expect.arrayContaining([`bg-state-${key}-fill`, `text-state-${key}-ink`]),
      );
      unmount();
    }
  });

  it('draws Setup and No data dashed, the others solid-bordered', () => {
    const { rerender } = render(<StateBadge state="Setup" testId="s" />);
    expect(classesOf(screen.getByTestId('s'))).toContain('border-dashed');
    rerender(<StateBadge state={undefined} testId="s" />);
    const none = screen.getByTestId('s');
    expect(none.dataset.state).toBe('no-data');
    expect(none.textContent).toBe('No data');
    expect(iconOf(none)).toBe('question');
    expect(classesOf(none)).toEqual(
      expect.arrayContaining(['border-dashed', 'bg-state-no-data-fill']),
    );
    rerender(<StateBadge state="Running" testId="s" />);
    expect(classesOf(screen.getByTestId('s'))).not.toContain('border-dashed');
  });

  it('gives every state a timeline band of its own (fill and edges), Setup dashed', () => {
    const bands = cases.map(([state]) => stateStyle(state).band);
    expect(new Set(bands).size).toBe(bands.length);
    for (const [state, , , key] of cases) {
      expect(stateStyle(state).band.split(' '), state).toEqual(
        expect.arrayContaining([
          `bg-state-${key}-fill`,
          'border-y-4',
          `border-state-${key}-border`,
        ]),
      );
    }
    // Running, Off and Planned stop have near-equal fills: their edges differ.
    const edge = (state: string) =>
      stateStyle(state)
        .band.split(' ')
        .find((c) => c.startsWith('border-state-'));
    expect(new Set([edge('Running'), edge('Off'), edge('PlannedStop')]).size).toBe(3);
    expect(stateStyle('Setup').band).toContain('border-dashed');
    expect(stateStyle('Running').band).not.toContain('border-dashed');
  });

  it('shows an unknown state by its raw name in the neutral tone', () => {
    render(<StateBadge state="Warp" testId="s" />);
    const badge = screen.getByTestId('s');
    expect(badge.textContent).toBe('Warp');
    expect(iconOf(badge)).toBeNull();
    expect(classesOf(badge)).toContain('bg-neutral-soft');
  });

  it('has a md and a lg size', () => {
    const { rerender } = render(<StateBadge state="Down" testId="s" />);
    expect(classesOf(screen.getByTestId('s'))).toContain('min-h-5.5');
    rerender(<StateBadge state="Down" testId="s" size="lg" />);
    expect(classesOf(screen.getByTestId('s'))).toContain('min-h-7');
  });

  it('with stale, puts the Stale tag beside it with the full reason visible', () => {
    const { rerender } = render(
      <StateBadge
        state="Running"
        testId="state-cnc-01"
        stale="disconnected"
        staleTestId="stale-cnc-01"
      />,
    );
    const badge = screen.getByTestId('state-cnc-01');
    const tag = screen.getByTestId('stale-cnc-01');
    // The badge keeps its own look and word; the tag follows it.
    expect(badge.textContent).toBe('Running');
    expect(badge.nextElementSibling).toBe(tag);
    expect(tag.textContent).toBe('Stale: live connection lost');
    expect(iconOf(tag)).toBe('clock');
    // A solid warn border, never dashed like Setup and No data.
    expect(classesOf(tag)).toEqual(
      expect.arrayContaining(['bg-warn-soft', 'text-warn-ink', 'border-warn-border']),
    );
    expect(classesOf(tag)).not.toContain('border-dashed');
    rerender(
      <StateBadge
        state="Running"
        testId="state-cnc-01"
        stale="older-run"
        staleTestId="stale-cnc-01"
      />,
    );
    expect(screen.getByTestId('stale-cnc-01').textContent).toBe('Stale: from an earlier run');
    rerender(<StateBadge state="Running" testId="state-cnc-01" staleTestId="stale-cnc-01" />);
    expect(screen.queryByTestId('stale-cnc-01')).toBeNull();
  });
});

describe('StaleTag', () => {
  it('says the whole STALE_TEXT, never only in a tooltip', () => {
    for (const reason of ['disconnected', 'older-run'] as const) {
      const { unmount } = render(<StaleTag reason={reason} testId="t" />);
      const tag = screen.getByTestId('t');
      expect(tag.textContent).toBe(STALE_TEXT[reason]);
      expect(tag.hasAttribute('title')).toBe(false);
      unmount();
    }
  });
});

describe('PriorityBadge', () => {
  it('keeps data-priority raw, says the priority and adds its glyph on its tokens', () => {
    const cases = [
      ['high', 'High', 'triangles-up'],
      ['medium', 'Medium', 'triangle-up'],
      ['low', 'Low', 'dot'],
    ] as const;
    for (const [priority, label, icon] of cases) {
      const { unmount } = render(<PriorityBadge priority={priority} testId="p" />);
      const badge = screen.getByTestId('p');
      expect(badge.dataset.priority).toBe(priority);
      expect(badge.textContent).toBe(label);
      expect(iconOf(badge)).toBe(icon);
      expect(classesOf(badge)).toEqual(
        expect.arrayContaining([
          `bg-priority-${priority}-fill`,
          `text-priority-${priority}-ink`,
          `border-priority-${priority}-border`,
        ]),
      );
      unmount();
    }
  });
});

describe('order badges', () => {
  it('OrderStatusBadge: order-status, raw data-status, the word, the tone of 2.6', () => {
    const tones: Record<OrderStatus, string> = {
      imported: 'bg-neutral-soft',
      rejected: 'bg-alarm-soft',
      released: 'bg-neutral-soft',
      dispatched: 'bg-info-soft',
      'in-progress': 'bg-info-soft',
      completed: 'bg-neutral-soft',
      closed: 'bg-neutral-soft',
      cancelled: 'bg-neutral-soft',
    };
    for (const status of Object.keys(tones) as OrderStatus[]) {
      const { unmount } = render(<OrderStatusBadge order={{ status }} />);
      const badge = screen.getByTestId('order-status');
      expect(badge.dataset.status).toBe(status);
      expect(badge.textContent).toBe(ORDER_STATUS_TEXT[status]);
      expect(classesOf(badge), status).toContain(tones[status]);
      expect(iconOf(badge), status).toBe(status === 'completed' ? 'check' : null);
      unmount();
    }
  });

  it('OrderFlags: each flag a warn badge in order-flags; nothing without flags', () => {
    const { rerender, container } = render(
      <OrderFlags order={{ flags: { short: true, dispatchFailed: true, dispatchLost: false } }} />,
    );
    const flags = screen.getByTestId('order-flags');
    expect(flags.textContent).toBe('ShortDispatch failed');
    for (const flag of flags.children) {
      expect(classesOf(flag)).toContain('bg-warn-soft');
    }
    rerender(
      <OrderFlags
        order={{ flags: { short: false, dispatchFailed: false, dispatchLost: false } }}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('CommandStateBadge: command-state, raw data-state, its meaning as the tooltip', () => {
    const tones: Partial<Record<CommandState, string>> = {
      accepted: 'bg-neutral-soft',
      rejected: 'bg-alarm-soft',
      sent: 'bg-info-soft',
      'epoch-ended': 'bg-warn-soft',
      conflict: 'bg-alarm-soft',
    };
    for (const [state, tone] of Object.entries(tones) as [CommandState, string][]) {
      const { unmount } = render(<CommandStateBadge state={state} />);
      const badge = screen.getByTestId('command-state');
      expect(badge.dataset.state).toBe(state);
      expect(badge.textContent).toBe(COMMAND_STATE_TEXT[state].label);
      expect(badge.getAttribute('title')).toBe(COMMAND_STATE_TEXT[state].meaning);
      expect(classesOf(badge), state).toContain(tone);
      unmount();
    }
  });
});

describe('quality badges', () => {
  it('HoldStateBadge: open alarm, released ok, rejected neutral solid; raw data-state', () => {
    const cases = [
      ['open', 'Open', 'bg-alarm-soft'],
      ['released', 'Released', 'bg-ok-soft'],
      ['rejected', 'Rejected', 'bg-neutral-solid'],
    ] as const;
    for (const [state, word, tone] of cases) {
      const { unmount } = render(<HoldStateBadge state={state} />);
      const badge = screen.getByTestId('hold-state');
      expect(badge.dataset.state).toBe(state);
      expect(badge.textContent).toBe(word);
      expect(classesOf(badge)).toContain(tone);
      unmount();
    }
  });

  it('SignalStatusBadge: provisional warn, final alarm, withdrawn struck through; raw data-status', () => {
    const cases = [
      ['provisional', 'Provisional', 'bg-warn-soft'],
      ['final', 'Final', 'bg-alarm-soft'],
      ['withdrawn', 'Withdrawn', 'bg-surface'],
    ] as const;
    for (const [status, word, tone] of cases) {
      const { unmount } = render(<SignalStatusBadge signal={{ status } as SpcSignalDto} />);
      const badge = screen.getByTestId('signal-status');
      expect(badge.dataset.status).toBe(status);
      expect(badge.textContent).toBe(word);
      expect(classesOf(badge)).toContain(tone);
      expect(classesOf(badge).includes('line-through')).toBe(status === 'withdrawn');
      unmount();
    }
  });
});

describe('FinalityBadge', () => {
  it('Final: a neutral outline with a check', () => {
    render(<FinalityBadge final title="Nothing can change it" testId="f" />);
    const badge = screen.getByTestId('f');
    expect(badge.textContent).toBe('Final');
    expect(badge.dataset.finality).toBe('final');
    expect(badge.getAttribute('title')).toBe('Nothing can change it');
    expect(iconOf(badge)).toBe('check');
    expect(classesOf(badge)).toEqual(expect.arrayContaining(['bg-surface', 'text-neutral-ink']));
    expect(classesOf(badge)).not.toContain('border-dashed');
  });

  it('Provisional: a neutral dashed outline without a glyph', () => {
    render(<FinalityBadge final={false} testId="f" />);
    const badge = screen.getByTestId('f');
    expect(badge.textContent).toBe('Provisional');
    expect(badge.dataset.finality).toBe('provisional');
    expect(iconOf(badge)).toBeNull();
    expect(classesOf(badge)).toEqual(expect.arrayContaining(['border-dashed', 'text-neutral-ink']));
  });

  it('revised: an info outline naming the revision and the incidents', () => {
    const { rerender } = render(<FinalityBadge final revision={2} incidents={1} testId="f" />);
    const badge = screen.getByTestId('f');
    expect(badge.textContent).toBe('Final · revision 2 · 1 incident');
    expect(classesOf(badge)).toEqual(
      expect.arrayContaining(['text-info-ink', 'border-info-border']),
    );
    // Provisional and revised: info, still dashed (it may change again).
    rerender(<FinalityBadge final={false} revision={1} testId="f" />);
    expect(screen.getByTestId('f').textContent).toBe('Provisional · revision 1');
    expect(classesOf(screen.getByTestId('f'))).toEqual(
      expect.arrayContaining(['text-info-ink', 'border-dashed']),
    );
    rerender(<FinalityBadge final={false} incidents={3} testId="f" />);
    expect(screen.getByTestId('f').textContent).toBe('Provisional · 3 incidents');
    expect(classesOf(screen.getByTestId('f'))).toContain('text-neutral-ink');
  });
});

describe('LossBadge', () => {
  it('own is warn soft, external a neutral outline; the words stay "Own" and "External"', () => {
    const { rerender } = render(<LossBadge kind="own" testId="l" />);
    expect(screen.getByTestId('l').textContent).toBe('Own');
    expect(screen.getByTestId('l').dataset.kind).toBe('own');
    expect(classesOf(screen.getByTestId('l'))).toContain('bg-warn-soft');
    rerender(<LossBadge kind="external" testId="l" />);
    expect(screen.getByTestId('l').textContent).toBe('External');
    expect(classesOf(screen.getByTestId('l'))).toEqual(
      expect.arrayContaining(['bg-surface', 'border-neutral-border']),
    );
  });
});

describe('StatusFlags', () => {
  it('keeps data-flag, the words and tooltips, on the badge tones of 2.6', () => {
    render(
      <StatusFlags
        flags={[
          { key: 'final', text: 'Final', title: 'settled', tone: 'final' },
          { key: 'revision', text: 'Revision 1', title: 'changed', tone: 'notice' },
          { key: 'incidents', text: '1 incident', title: 'gap', tone: 'notice' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Status' });
    const final = within(list).getByText('Final');
    expect(final.dataset.flag).toBe('final');
    expect(final.getAttribute('title')).toBe('settled');
    expect(iconOf(final)).toBe('check');
    expect(classesOf(final)).toEqual(expect.arrayContaining(['bg-surface', 'text-neutral-ink']));
    expect(classesOf(within(list).getByText('Revision 1'))).toContain('text-info-ink');
    expect(classesOf(within(list).getByText('1 incident'))).toContain('text-warn-ink');
    expect(screen.getByTestId('flag-explanations').textContent).toContain('Final: settled');
  });

  it('draws provisional dashed', () => {
    render(
      <StatusFlags
        flags={[{ key: 'provisional', text: 'Provisional', title: 'open', tone: 'notice' }]}
      />,
    );
    expect(classesOf(screen.getByText('Provisional'))).toContain('border-dashed');
  });
});

describe('OEE finality once per section (UX-3, E-03)', () => {
  const bucket = (final: boolean, provisionalMs = 0) => ({ final, provisionalMs });

  it('groups buckets as final, provisional or mixed, none without a bucket', () => {
    expect(groupFinality([])).toBeUndefined();
    expect(groupFinality([bucket(true), bucket(true)])).toBe('final');
    expect(groupFinality([bucket(false), bucket(false)])).toBe('provisional');
    expect(groupFinality([bucket(true), bucket(false)])).toBe('mixed');
  });

  it('says the section’s finality once, the most open time in the tooltip', () => {
    const { rerender } = render(
      <SectionFinality buckets={[bucket(false, 60_000), bucket(false, 186_000)]} testId="f" />,
    );
    const badge = screen.getByTestId('f');
    expect(badge.textContent).toBe('Provisional');
    expect(badge.dataset.finality).toBe('provisional');
    expect(badge.getAttribute('title')).toContain('up to 3.1 min');
    rerender(<SectionFinality buckets={[bucket(true), bucket(true)]} testId="f" />);
    expect(screen.getByTestId('f').textContent).toBe('Final');
    rerender(<SectionFinality buckets={[bucket(true), bucket(false), bucket(true)]} testId="f" />);
    expect(screen.getByTestId('f').textContent).toBe('2 of 3 final');
    expect(screen.getByTestId('f').dataset.finality).toBe('mixed');
    rerender(<SectionFinality buckets={[]} testId="f" />);
    expect(screen.queryByTestId('f')).toBeNull();
  });

  it('keeps an item’s finality only in a mixed section, its other flags always', () => {
    const flags = [
      { key: 'provisional', text: 'Provisional (2.0 min)', title: 'open' },
      { key: 'revision', text: 'Revision 1', title: 'changed' },
    ] as const;
    expect(itemFlags(flags, 'provisional').map((flag) => flag.key)).toEqual(['revision']);
    expect(itemFlags(flags, 'final').map((flag) => flag.key)).toEqual(['revision']);
    expect(itemFlags(flags, 'mixed').map((flag) => flag.key)).toEqual(['provisional', 'revision']);
    render(<FlagBadges flags={itemFlags(flags, 'provisional')} />);
    const list = screen.getByRole('list', { name: 'Status' });
    expect(list.textContent).toBe('Revision 1');
    expect(list.querySelector('[data-flag="revision"]')?.getAttribute('title')).toBe('changed');
  });
});
