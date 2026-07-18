import { scriptApi } from './api';
import { restoreScriptReferences } from './references';
import { sha256 } from '../sha256';

export function canonicalProjectId(projectId: string): string {
  const value = String(projectId ?? '');
  return value.startsWith('sha256:') ? value.slice(7) : value;
}

export async function hashBrowserContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await sha256(data);
  const hex = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export async function restoreProjectScripts(options: {
  projectId: string;
  daemonYaml: string;
  api: Pick<typeof scriptApi, 'readManifest' | 'readFile'>;
  hashContent?: (content: string) => Promise<string>;
}) {
  const manifest = await options.api.readManifest(options.projectId);
  return restoreScriptReferences(options.daemonYaml, manifest, {
    readFile: options.api.readFile,
    hashContent: options.hashContent ?? hashBrowserContent,
  });
}
