import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a `Host` header names this machine's loopback interface (any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has((name ?? '').toLowerCase());
}

/**
 * The `Origin` the dev proxy forwards with a WebSocket upgrade or an HTTP request. The MES accepts
 * an upgrade, and a write (ADR-0023), only when its Origin names the MES's own host (ADR-0019);
 * behind the proxy the page's origin is the dev server's, so a page the dev server served under a
 * loopback name is presented as the MES's own origin. Anything else keeps its Origin and is
 * refused by the MES: `changeOrigin` already satisfies the MES's Host allowlist, and Vite's own
 * host check doesn't run on proxied upgrades, so a page on a rebound name (`evil.test` resolving
 * to 127.0.0.1) must not be vouched for here.
 */
export function proxiedOrigin(
  origin: string | undefined,
  host: string | undefined,
  target: string,
): string | undefined {
  if (origin === undefined || !isLoopbackHost(host)) return origin;
  try {
    return new URL(origin).host === host ? new URL(target).origin : origin;
  } catch {
    return origin;
  }
}

/** The outgoing request to the MES, as the proxy hands it to its listeners. */
interface OutgoingRequest {
  setHeader(name: string, value: string): unknown;
  destroy(): unknown;
}

/**
 * Listeners for the dev and preview proxy of `/api` (`proxy.on('proxyReq', …)` and
 * `proxy.on('proxyReqWs', …)`): both apply the loopback-only Origin rule above, so writes from
 * `pnpm dev` pass the MES's Origin check (#121) as WebSocket upgrades do (#98).
 */
export function apiProxyListeners(target: string) {
  return {
    proxyReq: (proxyReq: OutgoingRequest, req: { headers: IncomingHttpHeaders }): void => {
      const origin = proxiedOrigin(req.headers.origin, req.headers.host, target);
      if (origin !== undefined && origin !== req.headers.origin) {
        proxyReq.setHeader('origin', origin);
      }
    },
    proxyReqWs: (
      proxyReq: OutgoingRequest,
      req: { headers: IncomingHttpHeaders },
      socket: { end(data: string): unknown },
    ): void => {
      // Vite's host check skips proxied upgrades: refuse rebound names (DNS rebinding) here.
      if (!isLoopbackHost(req.headers.host)) {
        proxyReq.destroy();
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const origin = proxiedOrigin(req.headers.origin, req.headers.host, target);
      if (origin !== undefined) proxyReq.setHeader('origin', origin);
    },
  };
}
