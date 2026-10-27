import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import type { HttpProxy, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { apiProxyListeners } from './src/dev-proxy.ts';
import { bootScriptSource } from './src/theme/theme-preference.ts';

/** Where the dev server and `vite preview` send `/api` (HTTP and WebSocket). */
const MES_URL = process.env.MES_URL ?? 'http://127.0.0.1:4700';

const api = {
  '/api': {
    target: MES_URL,
    // The MES answers only allowed Host names (HTTP_ALLOWED_HOSTS): send the target's host.
    changeOrigin: true,
    ws: true,
    configure: (proxy: HttpProxy.ProxyServer) => {
      // The Origin rule for HTTP requests (writes, #121) and WebSocket upgrades: dev-proxy.ts.
      const listeners = apiProxyListeners(MES_URL);
      proxy.on('proxyReq', listeners.proxyReq);
      proxy.on('proxyReqWs', listeners.proxyReqWs);
    },
  },
};

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
function themeBoot(): Plugin {
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
      server.middlewares.use(`/${BOOT_NAME}`, (_request, response) => {
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

export default defineConfig({
  plugins: [themeBoot(), react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: api },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: api },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    // CI runs these beside the Testcontainers suites on two cores; tests take milliseconds alone.
    testTimeout: 30_000,
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // main.tsx mounts the app in the page; the charts wrap uPlot's and ECharts' canvas, which jsdom lacks.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/chart/uplot-chart.tsx',
        'src/chart/echarts-view.tsx',
      ],
      thresholds: { lines: 70, branches: 60 },
    },
  },
});
