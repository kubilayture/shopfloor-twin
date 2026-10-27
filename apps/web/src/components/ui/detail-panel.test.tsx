import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPanel, WIDE_QUERY } from './detail-panel.tsx';

/** UX-4a (#324): design system 3.4, the detail of a list-and-detail screen. */

function stubWide(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === WIDE_QUERY ? wide : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({ gone = false }: { readonly gone?: boolean }) {
  const [item, setItem] = useState<string | undefined>(undefined);
  return (
    <section aria-labelledby="list-title">
      <h1 id="list-title" tabIndex={-1}>
        Alarms
      </h1>
      {['a', 'b'].map((id) =>
        gone && item === id ? null : (
          <button
            key={id}
            type="button"
            onClick={() => {
              setItem(id);
            }}
          >
            Details {id}
          </button>
        ),
      )}
      {item === undefined ? null : (
        <DetailPanel
          title={`Alarm ${item}`}
          description="Cell M1"
          titleId="panel-title"
          focusKey={item}
          testId="panel"
          closeTestId="close"
          data-item={item}
          returnFocus={() => document.getElementById('list-title')}
          onClose={() => {
            setItem(undefined);
          }}
        >
          <label>
            Comment <input />
          </label>
        </DetailPanel>
      )}
    </section>
  );
}

const open = (name: string) => {
  const button = screen.getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
  return button;
};

describe('DetailPanel', () => {
  it('is a side panel from wide: named by its focused title, closed by Escape, focus back to the opener', () => {
    stubWide(true);
    render(<Harness />);
    const opener = open('Details a');
    const panel = screen.getByTestId('panel');
    expect(panel.tagName).toBe('SECTION');
    expect(panel.dataset.item).toBe('a');
    const title = screen.getByRole('heading', { level: 2, name: 'Alarm a' });
    expect(title.id).toBe('panel-title');
    expect(panel.getAttribute('aria-labelledby')).toBe('panel-title');
    expect(document.activeElement).toBe(title);
    expect(panel.className).toContain('sticky');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment' }), { key: 'Escape' });
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('focuses the title again when another item opens into it, and closes back to that opener', () => {
    stubWide(true);
    render(<Harness />);
    open('Details a');
    const second = open('Details b');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alarm b' }));
    fireEvent.click(screen.getByTestId('close'));
    expect(document.activeElement).toBe(second);
  });

  it('gives the focus to returnFocus when the opener left with its row', () => {
    stubWide(true);
    render(<Harness gone />);
    open('Details a');
    fireEvent.click(screen.getByTestId('close'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('is a side sheet below wide, with the same test ids and the focus on its title', () => {
    stubWide(false);
    render(<Harness />);
    const opener = open('Details a');
    const sheet = screen.getByTestId<HTMLDialogElement>('panel');
    expect(sheet.tagName).toBe('DIALOG');
    expect(sheet.open).toBe(true);
    expect(sheet.dataset.variant).toBe('sheet');
    expect(sheet.dataset.item).toBe('a');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alarm a' }));
    fireEvent.click(screen.getByTestId('close'));
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
