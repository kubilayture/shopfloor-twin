import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Role queries otherwise compute every element's style to skip hidden ones, which makes them
// slow in jsdom, the more so on a busy CI runner; these tests render no hidden content to skip.
// `findBy*` and `waitFor` retry until they pass; a little above their 1 s default, for a loaded
// machine (#212). A call that waits for something slow by design names its own deadline.
configure({ defaultHidden: true, asyncUtilTimeout: 3_000 });

afterEach(() => {
  cleanup();
});

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = () => undefined;
