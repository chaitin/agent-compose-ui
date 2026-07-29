export type Monaco = typeof import('monaco-editor/editor/editor.api');

let monacoPromise: Promise<Monaco> | undefined;

export function loadMonaco(): Promise<Monaco> {
  if (monacoPromise) return monacoPromise;
  monacoPromise = Promise.all([
    import('monaco-editor/editor/editor.api'),
    import('monaco-editor/languages/definitions/javascript/register'),
    import('monaco-editor/editor/editor.worker?worker'),
  ])
    .then(([monaco, , worker]) => {
      globalThis.MonacoEnvironment = { getWorker: () => new worker.default() };
      return monaco;
    })
    .catch((cause) => {
      monacoPromise = undefined;
      throw cause;
    });
  return monacoPromise;
}

export function preloadMonaco(): void {
  void loadMonaco();
}
