import type { ScriptFile } from './types';
import { expandScriptReferences } from './references';
import { hashBrowserContent } from './project-lifecycle';
import { interpolateGlobalEnv, type InterpolatableEnvVar } from './env-interpolation';

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
  // Global-env panel values used to expand `${VAR}` references in the YAML
  // before it reaches the backend. The backend's `compose.Normalize` would
  // otherwise expand them from the daemon process env (`.env`), which is not
  // what the user edits in the panel; expanding here makes panel edits take
  // effect on the next apply. Secrets are redacted by the backend and are left
  // intact (see interpolateGlobalEnv).
  globalEnv?: ReadonlyArray<InterpolatableEnvVar>;
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
  const yamlText = options.globalEnv && options.globalEnv.length > 0
    ? interpolateGlobalEnv(expanded.yamlText, options.globalEnv)
    : expanded.yamlText;
  return { yamlText, references: expanded.references };
}
