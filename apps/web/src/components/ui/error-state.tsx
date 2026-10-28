import { Button } from './button.tsx';
import { Callout } from './callout.tsx';
import { Icon } from './icons.tsx';

/**
 * A read that failed (UX-1e, #317; design system 4.11): an `alarm` callout, announced
 * (`role="alert"`), with "Could not load …", the MES's detail in `ink-secondary` and "Try again"
 * only when a retry can fix it (`isRetryable`): the network, a 5xx, a 429. A 404 is not this but
 * `NotFound`, which the screens adopt as they migrate.
 *
 * `quiet` is for a network failure while the shell's offline bar already says the connection is
 * gone (#343 review): one line, not announced, no retry (the reads run again by themselves when
 * the connection is back), so an offline screen with five failed reads raises one alert, the
 * bar's, instead of six.
 */
export interface ErrorStateProps {
  readonly what: string;
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
  readonly quiet?: boolean;
  readonly testId?: string | undefined;
}

/** The HTTP status of an API or console error (0: no answer), when the error carries one. */
function statusOf(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('status' in error)) return undefined;
  const { status } = error as { status: unknown };
  return typeof status === 'number' ? status : undefined;
}

/**
 * The MES (or the console) could not be reached: no answer at all, or the proxy's own answer that
 * it could not reach it (502, 504). A 503 may be the MES's own (a database down), so it is not.
 */
export function isNetworkError(error: unknown): boolean {
  const status = statusOf(error);
  return status === 0 || status === 502 || status === 504;
}

/**
 * Whether trying again can help: no answer, a server error or a rate limit. A refused or invalid
 * request (another 4xx) or an answer the app cannot read would fail the same way again. An error
 * without a status (not from the API clients) is given the benefit of the doubt.
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined) return true;
  return status === 0 || status === 429 || status >= 500;
}

/**
 * Words for an answer without a problem body (the proxy's own 502 or 504, a bare 503): the API
 * client names it `HTTP <status>`, and a screen says no HTTP status codes (design system 6.4).
 */
const BARE_STATUS_TEXT: Readonly<Record<number, string>> = {
  429: 'The MES is busy: too many requests at once. Wait a moment.',
  500: 'The MES failed on this request.',
  502: 'The MES cannot be reached.',
  503: 'The MES is not available at the moment.',
  504: 'The MES did not answer in time.',
};

export function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const bare = /^HTTP (\d{3})$/.exec(error.message);
  if (!bare) return error.message;
  const status = Number(bare[1]);
  return (
    BARE_STATUS_TEXT[status] ?? `The MES answered without saying why (status ${String(status)}).`
  );
}

export function ErrorState({ what, error, onRetry, quiet = false, testId }: ErrorStateProps) {
  const detail = errorDetail(error);
  if (quiet) {
    return (
      <p
        data-testid={testId}
        data-error="quiet"
        className="flex items-start gap-2 py-1 text-sm text-ink-secondary"
      >
        <Icon name="alert" size={16} className="mt-0.5 text-warn-ink" />
        <span>
          <span className="font-semibold text-ink">Could not load {what}.</span> {detail}
        </span>
      </p>
    );
  }
  return (
    <Callout
      tone="alarm"
      role="alert"
      data-testid={testId}
      data-error="shown"
      title={`Could not load ${what}.`}
    >
      <p className="text-ink-secondary">{detail}</p>
      {onRetry && isRetryable(error) ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Callout>
  );
}
