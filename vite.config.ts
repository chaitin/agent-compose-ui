import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monacoEditorPluginImport from 'vite-plugin-monaco-editor';

// `vite-plugin-monaco-editor` is CommonJS; under ESM interop the default import
// resolves to the whole `module.exports` object, so the plugin factory lives on
// `.default`. Fall back to the import itself for runtimes that hand us the fn.
const monacoEditorPlugin =
  (monacoEditorPluginImport as any).default ?? monacoEditorPluginImport;

export default defineConfig(({ mode }) => {
  const scriptServiceToken = loadEnv(mode, '.', '').SCRIPT_SERVICE_TOKEN;

  return {
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
          target: 'http://127.0.0.1:7410',
          changeOrigin: true,
          timeout: 300_000,
        },
        '/agentcompose.v2.': {
          target: 'http://127.0.0.1:7410',
          changeOrigin: true,
          timeout: 300_000,
        },
        '/health.v1.': {
          target: 'http://127.0.0.1:7410',
          changeOrigin: true,
        },
        '/api': {
          target: 'http://127.0.0.1:7410',
          changeOrigin: true,
        },
        '/script-api': {
          target: 'http://127.0.0.1:7420',
          changeOrigin: true,
          bypass(req) {
            if (scriptServiceToken) req.headers['x-script-service-token'] = scriptServiceToken;
          },
        },
      },
    },
  };
});
