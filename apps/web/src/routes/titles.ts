// Every route's page title (UX-1b, #316; G-05): `staticData.title` on each route, text or made from
// the route's params, so a detail page names what it shows ("Order PO-2610-303"). The shell turns
// the matched route's into the document title (`useRouteTitle`); `titles.test.ts` walks the
// routes so none is left without one.

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    readonly title?: string | ((params: Readonly<Record<string, string | undefined>>) => string);
  }
}

/** What the title needs of a route match (a structural subset of TanStack Router's). */
export interface TitledMatch {
  readonly staticData?: { readonly title?: StaticTitle | undefined } | undefined;
  readonly params?: unknown;
}

type StaticTitle = string | ((params: Readonly<Record<string, string | undefined>>) => string);

export const NOT_FOUND_TITLE = 'Page not found';

/**
 * The deepest matched route's title; "Page not found" when only the root matched (every route has
 * a title, so that is the router's not-found); `undefined` before anything matched (the product
 * name alone).
 */
export function routeTitle(matches: readonly TitledMatch[]): string | undefined {
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const title = match?.staticData?.title;
    if (title === undefined) continue;
    if (typeof title === 'string') return title;
    const params = (match?.params ?? {}) as Readonly<Record<string, string | undefined>>;
    return title(params).trim();
  }
  return matches.length > 0 ? NOT_FOUND_TITLE : undefined;
}
