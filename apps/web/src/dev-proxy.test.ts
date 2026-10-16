import { describe, expect, it } from 'vitest';
import { apiProxyListeners, isLoopbackHost, proxiedOrigin } from './dev-proxy.ts';

describe('apiProxyListeners', () => {
  const target = 'http://127.0.0.1:4700';
  const listeners = apiProxyListeners(target);
  const outgoing = () => {
    const headers: Record<string, string> = {};
    let destroyed = false;
    return {
      headers,
      destroyed: () => destroyed,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      destroy: () => {
        destroyed = true;
      },
    };
  };

  it("rewrites a loopback page's Origin on HTTP requests, so writes from pnpm dev pass (#121)", () => {
    const proxyReq = outgoing();
    listeners.proxyReq(proxyReq, {
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
    });
    expect(proxyReq.headers).toEqual({ origin: target });
  });

  it('leaves other HTTP requests as they are: the MES refuses them', () => {
    for (const headers of [
      { host: 'localhost:5173', origin: 'https://evil.example' },
      { host: 'evil.test:5173', origin: 'http://evil.test:5173' },
      { host: 'localhost:5173' },
    ]) {
      const proxyReq = outgoing();
      listeners.proxyReq(proxyReq, { headers });
      expect(proxyReq.headers).toEqual({});
    }
  });

  it('applies the same rule to WebSocket upgrades, and refuses rebound names', () => {
    const ok = outgoing();
    listeners.proxyReqWs(
      ok,
      { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' } },
      { end: () => undefined },
    );
    expect(ok.headers).toEqual({ origin: target });
    const rebound = outgoing();
    const answers: string[] = [];
    listeners.proxyReqWs(
      rebound,
      { headers: { host: 'evil.test:4173', origin: 'http://evil.test:4173' } },
      { end: (data: string) => answers.push(data) },
    );
    expect(rebound.destroyed()).toBe(true);
    expect(answers[0]).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });
});

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
