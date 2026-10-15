/**
 * The `Origin` the dev proxy forwards with a WebSocket upgrade. The MES accepts an upgrade whose
 * Origin names its own host (ADR-0019); behind the proxy the page's origin is the dev server's,
 * so a page served by the dev server itself is presented as the MES's own origin. Any other
 * origin is passed on unchanged, so the MES still refuses pages from other sites.
 */
export function proxiedOrigin(
  origin: string | undefined,
  host: string | undefined,
  target: string,
): string | undefined {
  if (origin === undefined || host === undefined) return origin;
  try {
    return new URL(origin).host === host ? new URL(target).origin : origin;
  } catch {
    return origin;
  }
}
