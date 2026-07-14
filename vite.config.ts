import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const base = process.env.AGENT_COMPOSE_BASE || '/';
const backendTarget = process.env.AGENT_COMPOSE_DEV_BACKEND || 'http://127.0.0.1:7410';

export default defineConfig({
  base,
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    // Dev-only: forward Connect/gRPC-web RPC and plain HTTP endpoints to the
    // local backend (`go run ./cmd/agent-compose`, :7410) so hot-reload has real data.
    // Does not affect the production build — RPC baseUrl stays same-origin there.
    proxy: {
      '/agentcompose.v2.': { target: backendTarget, changeOrigin: true },
      '/health.v1.': { target: backendTarget, changeOrigin: true },
      '/api': { target: backendTarget, changeOrigin: true },
      '/jupyter': { target: backendTarget, changeOrigin: true },
    },
  },
});
