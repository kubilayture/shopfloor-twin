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
 *
 * `failures` is for one error that stands for several failed reads (#394, `ScreenError`): `what`
 * names them all, each read's detail is said once (one line when they all say the same, else one
 * line per read), and "Try again" is offered when a retry can fix any of them.
 */
export interface ErrorStateProps {
  readonly what: string;
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
  readonly quiet?: boolean;
  readonly testId?: string | undefined;
  readonly failures?: readonly Failure[] | undefined;
  /**
   * A read it names is on its way again (#394 review): "Try again" shows as busy (`Button`
   * `loading`: `aria-busy`, `aria-disabled`, the label kept), since the error stays up meanwhile.
   */
  readonly busy?: boolean;
}

/** One failed read of several: what it is ("the equipment") and how it failed. */
export interface Failure {
  readonly what: string;
  readonly error: unknown;
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

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * What the reads' errors say, each once: one entry when every read says the same (`what` left
 * out), else one per read and distinct detail, named by its read.
 */
export function failureDetails(
  failures: readonly Failure[],
): readonly { readonly what?: string; readonly detail: string }[] {
  const details = failures.map((failure) => ({
    what: failure.what,
    detail: errorDetail(failure.error),
  }));
  if (new Set(details.map((entry) => entry.detail)).size <= 1) {
    return details.slice(0, 1).map(({ detail }) => ({ detail }));
  }
  const seen = new Set<string>();
  return details.filter(({ what, detail }) => {
    const key = `${what}\u0000${detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function ErrorState({
  what,
  error,
  onRetry,
  quiet = false,
  testId,
  failures,
  busy = false,
}: ErrorStateProps) {
  const all = failures !== undefined && failures.length > 0 ? failures : [{ what, error }];
  const details = failureDetails(all);
  const detail = details
    .map((entry) =>
      entry.what === undefined ? entry.detail : `${capitalised(entry.what)}: ${entry.detail}`,
    )
    .join('; ');
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
      {details.length === 1 ? (
        <p className="text-ink-secondary">{detail}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 text-ink-secondary">
          {details.map((entry) => (
            <li key={`${entry.what ?? ''}|${entry.detail}`}>
              <span className="text-ink">{capitalised(entry.what ?? '')}:</span> {entry.detail}
            </li>
          ))}
        </ul>
      )}
      {onRetry && all.some((failure) => isRetryable(failure.error)) ? (
        <Button variant="secondary" size="sm" className="mt-2" loading={busy} onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Callout>
  );
}
