import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import process from 'node:process';
import type { HttpProxy } from 'vite';
import { defineConfig } from 'vitest/config';
import { apiProxyListeners } from './src/dev-proxy.ts';

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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: api },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: api },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    // CI runs these beside the Testcontainers suites on two cores; tests take milliseconds alone.
    testTimeout: 15_000,
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // main.tsx mounts the app in the page; the chart wraps uPlot's canvas, which jsdom lacks.
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/chart/uplot-chart.tsx',
      ],
      thresholds: { lines: 70, branches: 60 },
    },
  },
});
