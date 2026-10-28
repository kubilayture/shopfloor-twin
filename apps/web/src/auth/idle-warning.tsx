import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { documentTitle, useTitleLock } from '../components/ui/use-page-title.ts';
import { countdownText } from './idle.ts';

/**
 * The idle warning (#170), restyled in UX-1e (#317, G-31; design system 4.13): a `warn` callout
 * in a card at the bottom (bottom left from `md`, full width below it) instead of a bar over the
 * page's last 100 px, with room reserved under the page so its end can still be scrolled clear;
 * from `xl` it starts right of the side nav (232 px), and below `md` the toasts go to the top.
 * "Stay logged in", the expected answer, is the primary button.
 */
export function IdleWarning({
  absolute,
  left,
  onStay,
  onLogOut,
}: {
  /** The 12-hour limit: no staying, only saving. */
  readonly absolute: boolean;
  readonly left: number;
  readonly onStay: () => void;
  readonly onLogOut: () => void;
}) {
  const countdown = (
    // Not re-announced every second: the alert is read once, the countdown is there to look at.
    <span aria-live="off" className="font-semibold tabular-nums">
      {countdownText(left)}
    </span>
  );
  return (
    <>
      {/* Room under the page for the card, so nothing ends up only under it. */}
      <div aria-hidden="true" className="h-48 md:h-40 print:hidden" />
      <div
        role="alert"
        data-testid="idle-warning"
        data-absolute={absolute}
        className="fixed inset-x-4 bottom-4 z-toast md:right-auto md:w-[28rem] xl:left-62 print:hidden"
      >
        <Callout
          tone="warn"
          className="shadow-elevation-2"
          title={absolute ? 'Your session is about to end' : 'You will be logged out soon'}
        >
          {absolute ? (
            <p>
              Your session reaches its 12-hour limit in {countdown}. Save what you are working on;
              you will need to log in again.
            </p>
          ) : (
            <p>
              Nobody has used this screen for a while: you will be logged out in {countdown}.
              Unsaved input stays on the page; you would log in again to send it.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {absolute ? null : (
              <Button variant="primary" size="sm" data-testid="stay-signed-in" onClick={onStay}>
                Stay logged in
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onLogOut}>
              Log out now
            </Button>
          </div>
        </Callout>
      </div>
    </>
  );
}

/** What the tab reads while the re-login cover is up. */
export const LOCK_TITLE = documentTitle('Log in again');

/**
 * While the re-login cover is up, the tab says what is asked (G-32), and a title the page under
 * it sets meanwhile (a screen that finished loading) waits until the cover goes.
 */
export function useLockTitle(): void {
  useTitleLock(LOCK_TITLE);
}
