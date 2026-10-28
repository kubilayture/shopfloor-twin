import { describe, expect, it } from 'vitest';
import { countOf } from './words.ts';

describe('countOf (#393 review F6)', () => {
  it('writes the singular for one and the plural otherwise', () => {
    expect(countOf(1, 'point')).toBe('1 point');
    expect(countOf(0, 'point')).toBe('0 points');
    expect(countOf(2, 'value')).toBe('2 values');
    expect(countOf(1, 'line')).toBe('1 line');
    expect(countOf(3, 'child', 'children')).toBe('3 children');
    expect(countOf(1, 'child', 'children')).toBe('1 child');
  });
});
