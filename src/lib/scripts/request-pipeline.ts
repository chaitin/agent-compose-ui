import type { ScriptFile } from './types';
import { expandScriptReferences } from './references';
import { hashBrowserContent } from './project-lifecycle';

export interface ScriptRequestWorkspace {
  getContent(path: string): string | undefined;
  flushDirty(): Promise<void>;
}

export async function prepareScriptRequest(options: {
  mode: 'validate' | 'save' | 'run';
  editorYaml: string;
  workspace: ScriptRequestWorkspace;
  readFile: (path: string) => Promise<Pick<ScriptFile, 'path' | 'content' | 'sha256'>>;
  hashContent?: (content: string) => Promise<string>;
}) {
  if (options.mode !== 'validate') {
    await options.workspace.flushDirty();
  }
  const expanded = await expandScriptReferences(options.editorYaml, async (path) => {
    const inMemory = options.workspace.getContent(path);
    if (options.mode === 'validate' && inMemory !== undefined) {
      return {
        path,
        content: inMemory,
        sha256: await (options.hashContent ?? hashBrowserContent)(inMemory),
      };
    }
    return options.readFile(path);
  });
  return { yamlText: expanded.yamlText, references: expanded.references };
}
