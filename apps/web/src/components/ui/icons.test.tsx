import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon, type IconName } from './icons.tsx';

function svgIn(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no svg rendered');
  return svg;
}

/** UX-1a (#314): the in-house icon set of design system 4.13 and the glyphs of 2.4 and 2.5. */
describe('Icon', () => {
  it('has every icon design system 4.13 lists, and the state and priority glyphs', () => {
    const listed: IconName[] = [
      'menu',
      'close',
      'chevron-down',
      'chevron-up',
      'chevron-left',
      'chevron-right',
      'check',
      'alert',
      'info',
      'play',
      'pause',
      'stop',
      'wrench',
      'ban',
      'arrow-left',
      'arrow-right',
      'external',
      'download',
      'print',
      'search',
      'user',
      'logout',
      'filter',
      'clock',
      'monitor',
      'sun',
      'moon',
    ];
    const glyphs: IconName[] = [
      'rotate',
      'circle',
      'triangle-left',
      'play-bar',
      'question',
      'triangle-up',
      'triangles-up',
      'dot',
      'spinner',
    ];
    expect([...ICON_NAMES].sort()).toEqual([...listed, ...glyphs].sort());
  });

  it.each(ICON_NAMES)(
    '%s is decorative, in currentColor, with no colour or style of its own',
    (name) => {
      const { container } = render(<Icon name={name} />);
      const svg = svgIn(container);
      expect(container.children).toHaveLength(1);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('role')).toBeNull();
      expect(svg.getAttribute('aria-label')).toBeNull();
      expect(svg.getAttribute('data-icon')).toBe(name);
      expect(svg.getAttribute('viewBox')).toBe('0 0 20 20');
      // The paint is currentColor: a line icon strokes it, a solid one fills it.
      const fill = svg.getAttribute('fill');
      const stroke = svg.getAttribute('stroke');
      expect([fill, stroke]).toContain('currentColor');
      expect([fill, stroke]).toContain('none');
      // Something is drawn, and no shape names a colour: only currentColor or none.
      const shapes = svg.querySelectorAll('path, rect, circle');
      expect(shapes.length).toBeGreaterThan(0);
      for (const element of [svg, ...svg.querySelectorAll('*')]) {
        expect(element.hasAttribute('style'), `${name} style`).toBe(false);
        for (const attribute of ['fill', 'stroke', 'color', 'stop-color']) {
          const value = element.getAttribute(attribute);
          if (value !== null)
            expect(['currentColor', 'none'], `${name} ${attribute}`).toContain(value);
        }
      }
      // No text inside: an icon never carries words (title, desc, text).
      expect(svg.querySelector('title, desc, text')).toBeNull();
      expect(svg.textContent).toBe('');
    },
  );

  it('is 16 px by default and takes the given size', () => {
    const { container, rerender } = render(<Icon name="check" />);
    const svg = () => svgIn(container);
    expect(svg().getAttribute('width')).toBe('16');
    expect(svg().getAttribute('height')).toBe('16');
    rerender(<Icon name="check" size={12} />);
    expect(svg().getAttribute('width')).toBe('12');
    expect(svg().getAttribute('height')).toBe('12');
    rerender(<Icon name="check" size={20} />);
    expect(svg().getAttribute('width')).toBe('20');
  });

  it('never shrinks in a flex row and keeps a given class', () => {
    const { container, rerender } = render(<Icon name="clock" />);
    expect(svgIn(container).getAttribute('class')).toBe('shrink-0');
    rerender(<Icon name="clock" className="text-alarm-ink" />);
    expect(svgIn(container).getAttribute('class')).toBe('shrink-0 text-alarm-ink');
  });

  it('draws line icons as round strokes and solid glyphs as fills', () => {
    const { container, rerender } = render(<Icon name="menu" />);
    const svg = () => svgIn(container);
    expect(svg().getAttribute('fill')).toBe('none');
    expect(svg().getAttribute('stroke')).toBe('currentColor');
    expect(svg().getAttribute('stroke-width')).toBe('1.75');
    expect(svg().getAttribute('stroke-linecap')).toBe('round');
    expect(svg().getAttribute('stroke-linejoin')).toBe('round');
    rerender(<Icon name="play" />);
    expect(svg().getAttribute('fill')).toBe('currentColor');
    expect(svg().getAttribute('stroke')).toBe('none');
    expect(svg().getAttribute('stroke-width')).toBeNull();
  });

  it('leaves the accessible name to the element around it', () => {
    const { getByRole } = render(
      <button type="button">
        <Icon name="close" />
        Close
      </button>,
    );
    expect(getByRole('button').textContent).toBe('Close');
    expect(getByRole('button', { name: 'Close' })).toBeDefined();
  });
});
