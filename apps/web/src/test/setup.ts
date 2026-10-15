import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Role queries otherwise compute every element's style to skip hidden ones, which makes them
// slow in jsdom, the more so on a busy CI runner; these tests render no hidden content to skip.
configure({ defaultHidden: true });

afterEach(() => {
  cleanup();
});

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = () => undefined;
