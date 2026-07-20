import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monacoEditorPluginImport from 'vite-plugin-monaco-editor';

// `vite-plugin-monaco-editor` is CommonJS; under ESM interop the default import
// resolves to the whole `module.exports` object, so the plugin factory lives on
// `.default`. Fall back to the import itself for runtimes that hand us the fn.
const monacoEditorPlugin =
  (monacoEditorPluginImport as any).default ?? monacoEditorPluginImport;

export default defineConfig({
  plugins: [
    svelte(),
    monacoEditorPlugin({
      languageWorkers: ['editorWorkerService'],
    }),
  ],
  server: {
    port: 5174,
    proxy: {
      '/agentcompose.v1.': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        timeout: 300_000,
      },
      '/agentcompose.v2.': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        timeout: 300_000,
      },
      '/health.v1.': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '^/api/': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '^/oauth/': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '^/agent-compose/session/': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '^/jupyter(?:/|$)': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '^/script-api/': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
