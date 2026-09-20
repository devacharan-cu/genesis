import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The browser folds the ledger with the SAME function the API does.
 *
 * `@genesis/console` is a pure fold over events with no dependency on anything
 * that stores, calls or decides — so it runs unchanged in a browser. Aliasing
 * it to source means the timeline the operator sees and the state the server
 * reports are produced by one implementation, and a replay in the UI cannot
 * disagree with the server about what happened.
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@genesis/console': pkg('console'),
      '@genesis/core-types': pkg('core-types'),
    },
  },
  build: {
    // The map's chunk is large and deliberately separate: three.js is most of
    // it, it is loaded on demand, and the console is usable before it arrives.
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});
