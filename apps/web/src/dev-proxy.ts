const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a `Host` header names this machine's loopback interface (any port). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has((name ?? '').toLowerCase());
}

/**
 * The `Origin` the dev proxy forwards with a WebSocket upgrade. The MES accepts an upgrade whose
 * Origin names its own host (ADR-0019); behind the proxy the page's origin is the dev server's,
 * so a page the dev server served under a loopback name is presented as the MES's own origin.
 * Anything else keeps its Origin and is refused by the MES: `changeOrigin` already satisfies the
 * MES's Host allowlist, and Vite's own host check doesn't run on proxied upgrades, so a page on a
 * rebound name (`evil.test` resolving to 127.0.0.1) must not be vouched for here.
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
