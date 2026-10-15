import { describe, expect, it } from 'vitest';
import { isLoopbackHost, proxiedOrigin } from './dev-proxy.ts';

describe('proxiedOrigin', () => {
  const target = 'http://127.0.0.1:4700';

  it("presents the dev server's own pages on a loopback name as the MES's origin", () => {
    expect(proxiedOrigin('http://localhost:5173', 'localhost:5173', target)).toBe(target);
    expect(proxiedOrigin('http://127.0.0.1:4173', '127.0.0.1:4173', target)).toBe(target);
    expect(proxiedOrigin('http://[::1]:5173', '[::1]:5173', target)).toBe(target);
  });

  it('passes other origins on, so the MES still refuses them', () => {
    expect(proxiedOrigin('https://evil.example', 'localhost:5173', target)).toBe(
      'https://evil.example',
    );
    expect(proxiedOrigin('not a url', 'localhost:5173', target)).toBe('not a url');
    expect(proxiedOrigin(undefined, 'localhost:5173', target)).toBeUndefined();
    expect(proxiedOrigin('http://localhost:5173', undefined, target)).toBe('http://localhost:5173');
  });

  it('does not vouch for a rebound name, even when Origin and Host agree', () => {
    expect(proxiedOrigin('http://evil.test:4173', 'evil.test:4173', target)).toBe(
      'http://evil.test:4173',
    );
    expect(proxiedOrigin('http://localhost.evil.test', 'localhost.evil.test', target)).toBe(
      'http://localhost.evil.test',
    );
  });
});

describe('isLoopbackHost', () => {
  it('knows the loopback names with and without a port', () => {
    expect(isLoopbackHost('LOCALHOST:5173')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.test')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
