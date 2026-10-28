import type { ResolvedConfig, ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { themeBoot } from './theme-boot-plugin.ts';
import { bootScriptSource } from './theme-preference.ts';

type Handler = (
  request: unknown,
  response: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
) => void;

/** The dev server's mounted paths, and the page's script tag, for a `base` (#391). */
function serve(base: string) {
  const plugin = themeBoot();
  const mounted = new Map<string, Handler>();
  (plugin.configResolved as unknown as (config: Partial<ResolvedConfig>) => void)({
    base,
    command: 'serve',
  });
  (plugin.configureServer as unknown as (server: Partial<ViteDevServer>) => void)({
    middlewares: {
      use: (path: string, handler: Handler) => {
        mounted.set(path, handler);
      },
    } as unknown as ViteDevServer['middlewares'],
  });
  const transform = plugin.transformIndexHtml as unknown as {
    handler: (html: string, context: object) => { attrs: { src: string } }[];
  };
  const [tag] = transform.handler('', {});
  return { mounted, src: tag?.attrs.src };
}

describe('the theme boot plugin in dev (#391)', () => {
  it('serves the boot script where the page asks for it, under any base', () => {
    for (const base of ['/', '/sft/']) {
      const { mounted, src } = serve(base);
      expect(src).toBe(`${base}theme-boot.js`);
      expect([...mounted.keys()]).toEqual([src]);
      const headers = new Map<string, string>();
      let body = '';
      mounted.get(src ?? '')?.(
        {},
        {
          setHeader: (name, value) => headers.set(name, value),
          end: (text) => {
            body = text;
          },
        },
      );
      expect(headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
      expect(body).toBe(bootScriptSource());
    }
  });
});
