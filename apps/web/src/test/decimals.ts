import { expect } from 'vitest';
import { percentText } from '../domain/oee.ts';

/**
 * UX-1c (#315): every ratio element in `root` carries `data-decimal`, the raw four-decimal string
 * (`n/a` when not applicable), equal to what it shows: the four decimals themselves, or the
 * percentage they make (`0.8304` → `83.04 %`). Returns the elements checked.
 */
export function expectDecimals(root: ParentNode): HTMLElement[] {
  const elements = [...root.querySelectorAll<HTMLElement>('[data-decimal]')];
  for (const element of elements) {
    const decimal = element.getAttribute('data-decimal') ?? '';
    expect(decimal, element.outerHTML).toMatch(/^(-?\d+\.\d{4}|n\/a)$/);
    const shown = element.textContent.trim();
    const ratio = decimal === 'n/a' ? null : { fraction: '', decimal };
    expect([decimal, percentText(ratio)], element.outerHTML).toContain(shown);
  }
  return elements;
}
