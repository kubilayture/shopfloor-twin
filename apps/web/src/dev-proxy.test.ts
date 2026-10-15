import { describe, expect, it } from 'vitest';
import { proxiedOrigin } from './dev-proxy.ts';

describe('proxiedOrigin', () => {
  const target = 'http://127.0.0.1:4700';

  it("presents the dev server's own pages as the MES's origin", () => {
    expect(proxiedOrigin('http://localhost:5173', 'localhost:5173', target)).toBe(
      'http://127.0.0.1:4700',
    );
  });

  it('passes other origins on, so the MES still refuses them', () => {
    expect(proxiedOrigin('https://evil.example', 'localhost:5173', target)).toBe(
      'https://evil.example',
    );
    expect(proxiedOrigin('not a url', 'localhost:5173', target)).toBe('not a url');
    expect(proxiedOrigin(undefined, 'localhost:5173', target)).toBeUndefined();
    expect(proxiedOrigin('http://localhost:5173', undefined, target)).toBe('http://localhost:5173');
  });
});
