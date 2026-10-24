import { describe, expect, it } from 'vitest';
import { focusableIn, placeBeside, positionPopover } from './overlay.ts';

/** UX-1e (#317): where menus and tooltips go, and what takes focus in a dialog. */
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 100 };

describe('placeBeside', () => {
  it('puts it on the side asked, lined up as asked', () => {
    expect(
      placeBeside(rect(300, 400, 100, 30), size, viewport, { side: 'bottom', align: 'start' }),
    ).toEqual({
      top: 436,
      left: 300,
      side: 'bottom',
    });
    expect(
      placeBeside(rect(300, 400, 100, 30), size, viewport, { side: 'top', align: 'end' }),
    ).toEqual({
      top: 294,
      left: 200,
      side: 'top',
    });
    expect(
      placeBeside(rect(300, 400, 100, 30), size, viewport, { side: 'top', align: 'center' }).left,
    ).toBe(250);
  });

  it('flips to the side with more room when the asked one has too little', () => {
    expect(
      placeBeside(rect(300, 750, 100, 30), size, viewport, { side: 'bottom', align: 'start' }).side,
    ).toBe('top');
    expect(
      placeBeside(rect(300, 20, 100, 30), size, viewport, { side: 'top', align: 'start' }).side,
    ).toBe('bottom');
    // Neither fits: the larger side, kept inside the viewport.
    const cramped = placeBeside(rect(300, 40, 100, 30), { width: 200, height: 900 }, viewport, {
      side: 'top',
      align: 'start',
    });
    expect(cramped).toEqual({ top: 76, left: 300, side: 'bottom' });
  });

  it('stays 8 px inside the left and right edges', () => {
    expect(
      placeBeside(rect(0, 400, 20, 20), size, viewport, { side: 'bottom', align: 'center' }).left,
    ).toBe(8);
    expect(
      placeBeside(rect(980, 400, 20, 20), size, viewport, { side: 'bottom', align: 'start' }).left,
    ).toBe(792);
    expect(
      placeBeside(
        rect(300, 50, 10, 2),
        size,
        { width: 1000, height: 60 },
        { side: 'top', align: 'start' },
      ).top,
    ).toBe(8);
  });

  it('writes the place through the CSSOM', () => {
    const trigger = document.createElement('button');
    const popover = document.createElement('div');
    expect(positionPopover(trigger, popover, { side: 'bottom', align: 'start' })).toBe('bottom');
    expect(popover.style.top).toBe('8px');
    expect(popover.style.left).toBe('8px');
  });
});

describe('focusableIn', () => {
  it('lists what Tab reaches, in order, without disabled, hidden-by-tabindex or inert parts', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a href="#x">link</a><a>no href</a>
      <button>b</button><button disabled>off</button>
      <input type="hidden" /><input aria-label="field" />
      <div tabindex="-1">skip</div><div tabindex="0">reach</div>
      <div inert><button>inert</button></div>
      <select aria-label="s"></select><textarea aria-label="t"></textarea>
      <details><summary>more</summary></details>`;
    expect(focusableIn(root).map((e) => e.textContent || e.getAttribute('aria-label'))).toEqual([
      'link',
      'b',
      'field',
      'reach',
      's',
      't',
      'more',
    ]);
  });
});
