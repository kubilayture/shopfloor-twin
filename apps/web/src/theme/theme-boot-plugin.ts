import { runInNewContext } from 'node:vm';
import type { Plugin } from 'vite';
import { bootScriptSource } from './theme-preference.ts';

/**
 * The theme boot script's Vite plugin (UX-12, #336), apart from `vite.config.ts` so a unit test
 * can drive its hooks (#391).
 */

/** The boot script's file: `<base>theme-boot.js` from the dev server, hashed under `assets/` in a build. */
const BOOT_NAME = 'theme-boot.js';

/**
 * Runs the boot script as the browser would, in a bare context with only the globals it may use,
 * and checks that it set `data-theme`: a helper the config bundler might add to the transpiled
 * function (`__name`, a polyfill) would throw here and fail the build or the dev server, rather
 * than in `<head>` in the browser.
 */
function checkBootScript(source: string): void {
  let theme: string | undefined;
  runInNewContext(source, {
    localStorage: { getItem: () => 'dark' },
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          if (name === 'data-theme') theme = value;
        },
      },
    },
  });
  if (theme !== 'dark') throw new Error(`the theme boot script set data-theme to ${String(theme)}`);
}

/**
 * The theme before the first paint (UX-12, #336): `bootScriptSource()` as a classic script at the
 * end of `<head>` (after the stylesheet link, still before the body is parsed), so `data-theme`
 * is set before the first paint. An external file, not inline: the CSP allows `script-src 'self'`
 * only. A module script would run only after the document is parsed, too late to keep a stored
 * "Dark" from showing a light page first. Served by the dev server, emitted as an asset in every
 * build (`--watch` too); its path follows Vite's `base`.
 */
export function themeBoot(): Plugin {
  const source = bootScriptSource();
  let base = '/';
  let building = false;
  let asset: string | undefined;
  return {
    name: 'shopfloor-theme-boot',
    configResolved(config) {
      base = config.base;
      building = config.command === 'build';
      checkBootScript(source);
    },
    configureServer(server) {
      // Under `base`, where `transformIndexHtml` points the page (#391: `--base /sft/` was served
      // index.html for it).
      server.middlewares.use(`${base}${BOOT_NAME}`, (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(source);
      });
    },
    buildStart() {
      if (building) asset = this.emitFile({ type: 'asset', name: BOOT_NAME, source });
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const file = asset && context.bundle ? fileNameOf(context.bundle, BOOT_NAME) : BOOT_NAME;
        return [{ tag: 'script', attrs: { src: `${base}${file}` }, injectTo: 'head' }];
      },
    },
  };
}

/** The emitted file name of the asset first named `name` in the bundle. */
function fileNameOf(bundle: Record<string, { type: string; fileName: string }>, name: string) {
  const found = Object.values(bundle).find(
    (file) =>
      file.type === 'asset' && ((file as { names?: readonly string[] }).names ?? []).includes(name),
  );
  if (!found) throw new Error(`the build emitted no ${name}`);
  return found.fileName;
}
