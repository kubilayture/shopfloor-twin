import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Role queries otherwise compute every element's style to skip hidden ones, which makes them
// slow in jsdom, the more so on a busy CI runner; these tests render no hidden content to skip.
// `findBy*` and `waitFor` retry until they pass; their deadline (1 s by default) only decides how
// long a loaded machine may take before a test fails (#212), so it is generous.
configure({ defaultHidden: true, asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = () => undefined;
