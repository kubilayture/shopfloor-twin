import { useEffect } from 'react';

/**
 * The document title (UX-1b, #316; design system 3.2, G-05, WCAG 2.4.2): every route reads
 * "<page> · ShopFloor Twin", so tabs, history and screen readers tell the pages apart.
 *
 * Two sources, the more specific winning: the route's own title (`staticData.title`, set by the
 * shell from the matched route, so every route has one from its first render) and the title a
 * mounted screen gives with `usePageTitle` (through `PageHeader`), which can say more once the
 * data is in ("Order PO-2610-303" from the URL, a machine's name once it is read).
 */

export const PRODUCT_NAME = 'ShopFloor Twin';

/** "<page> · ShopFloor Twin", or the product name alone without a page. */
export function documentTitle(page: string | undefined): string {
  const trimmed = page?.trim();
  return trimmed ? `${trimmed} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/** The titles screens have set, newest last: the newest mounted one wins. */
const screenTitles: { readonly title: string }[] = [];
let routeTitle: string | undefined;

function apply(): void {
  document.title = documentTitle(screenTitles.at(-1)?.title ?? routeTitle);
}

/**
 * A screen's title while it is mounted; the route's title again once it unmounts. Blank or
 * `undefined` leaves the route's title.
 */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined || title.trim() === '') return;
    const entry = { title };
    screenTitles.push(entry);
    apply();
    return () => {
      const at = screenTitles.indexOf(entry);
      if (at >= 0) screenTitles.splice(at, 1);
      apply();
    };
  }, [title]);
}

/** The matched route's title (the shell calls this): the fallback under any screen's own. */
export function useRouteTitle(title: string | undefined): void {
  useEffect(() => {
    routeTitle = title;
    apply();
  }, [title]);
}
