/**
 * Where the app may go after a login (#170): a path of this app, with its search and hash. Never
 * another origin (`//evil.test`, `https://…`, `/\evil.test`), never `/login` itself, and nothing
 * with control characters, so a crafted link can't send a user elsewhere after logging in.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value, 'http://app.invalid');
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://app.invalid') return undefined;
  if (url.pathname === '/login') return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}
