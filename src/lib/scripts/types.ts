export type ScriptTreeNode =
  | { kind: 'directory'; name: string; path: string; children: ScriptTreeNode[] }
  | { kind: 'file'; name: string; path: string; size: number; mtimeMs: number; sha256: string };

export interface ScriptFile {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface ScriptReference {
  pointer: string;
  path: string;
  contentSha256: string;
}

export interface ScriptManifest {
  version: 1;
  projectId: string;
  projectName: string;
  updatedAt: string;
  references: ScriptReference[];
}

export interface ScriptApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
