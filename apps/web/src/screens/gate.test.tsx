import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { problem } from '../test/fixtures.ts';
import { renderApp } from '../test/render-app.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reads nothing but the session before it knows there is one (#170)', async () => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    );
    paths.push(url.pathname);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return problem(401, 'Unauthorized', 'no session', url.pathname);
  });
  await renderApp('/alarms', { session: 'fetch' });
  await screen.findByRole('heading', { name: 'Log in' });
  expect(paths).toEqual(['/api/v1/session']);
});
