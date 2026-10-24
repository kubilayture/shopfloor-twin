import { onlineManager } from '@tanstack/react-query';
import { settle } from './render-app.tsx';

/**
 * The browser's network, cut and restored by a test (#312): while cut, `fetch` fails as a
 * browser's does offline (a `TypeError`), and the window hears `offline`; restored, it hears
 * `online`. Stub `fetch` with the returned one.
 */
export function network(reach: typeof fetch) {
  let up = true;
  const calls: { readonly method: string; readonly up: boolean }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ method: init?.method ?? 'GET', up });
    return up ? reach(input, init) : Promise.reject(new TypeError('Failed to fetch'));
  };
  return {
    fetch,
    calls,
    cut: () =>
      settle(() => {
        up = false;
        window.dispatchEvent(new Event('offline'));
      }),
    restore: () =>
      settle(() => {
        up = true;
        window.dispatchEvent(new Event('online'));
      }),
  };
}

/** TanStack Query's online state is global: put it back after a test that cut the network. */
export function resetNetwork(): void {
  onlineManager.setOnline(true);
}
