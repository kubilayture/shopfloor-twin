/** Whether a path names `/login`, whatever its case and trailing slashes. */
export const isLogin = (pathname: string): boolean =>
  pathname.toLowerCase().replace(/\/+$/, '') === '/login';

/** Whether a URL path holds a `.` or `..` segment, also percent-encoded (`%2e`). */
function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..';
  });
}

/**
 * Where the app may go after a login (#170): a path of this app, with its search and hash. Never
 * another origin (`//evil.test`, `https://…`, `/\evil.test`), never `/login` itself, and nothing
 * with control characters, so a crafted link can't send a user elsewhere after logging in.
 * Dot segments are refused outright (#170 review M1): the URL parser resolves `/.//evil.test` to
 * `//evil.test`, which the router would treat as another origin. The result is checked again.
 */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? '';
  if (hasDotSegment(path)) return undefined;
  let url: URL;
  try {
    url = new URL(value, 'http://app.invalid');
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://app.invalid') return undefined;
  if (isLogin(url.pathname)) return undefined;
  const result = `${url.pathname}${url.search}${url.hash}`;
  if (!result.startsWith('/') || result.startsWith('//') || result.startsWith('/\\')) {
    return undefined;
  }
  return result;
}
