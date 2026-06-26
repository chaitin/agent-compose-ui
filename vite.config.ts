import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const base = process.env.AGENT_COMPOSE_BASE || '/';

export default defineConfig({
  base,
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    // Dev-only: forward Connect/gRPC-web RPC and plain HTTP endpoints to the
    // local backend (`go run ./cmd/agent-compose`, :7410) so hot-reload has real data.
    // Does not affect the production build — RPC baseUrl stays same-origin there.
    proxy: {
      '/agentcompose.v1.': { target: 'http://127.0.0.1:7410', changeOrigin: true },
      '/health.v1.': { target: 'http://127.0.0.1:7410', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:7410', changeOrigin: true },
    },
  },
});
