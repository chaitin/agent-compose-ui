import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

const base = process.env.AGENT_COMPOSE_BASE || '/';
const uiServerTarget = process.env.AGENT_COMPOSE_DEV_UI_SERVER || 'http://127.0.0.1:8080';

export default defineConfig({
  base,
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ['monaco-editor/editor/editor.api', 'monaco-editor/languages/definitions/javascript/register'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    // Keep the development request path identical to production: the browser
    // talks to the authenticated UI server, which proxies daemon traffic.
    proxy: {
      '/agentcompose.v2.': { target: uiServerTarget, changeOrigin: true },
      '/health.v1.': { target: uiServerTarget, changeOrigin: true },
      '/api': { target: uiServerTarget, changeOrigin: true, ws: true },
      '/ui-api': { target: uiServerTarget, changeOrigin: false },
      '/oauth': { target: uiServerTarget, changeOrigin: true },
      '/jupyter': { target: uiServerTarget, changeOrigin: true, ws: true },
    },
  },
});
