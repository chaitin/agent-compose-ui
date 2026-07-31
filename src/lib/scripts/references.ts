import type { ScriptFile, ScriptManifest, ScriptReference } from './types';
import { dumpYamlObject, parseYamlObject, type YamlMap } from '../yaml';
import { decodePointer, encodePointer, parseScriptRef, toScriptRef } from './paths';

type ReadFile = (path: string) => Promise<Pick<ScriptFile, 'path' | 'content' | 'sha256'>>;
type HashContent = (content: string) => Promise<string>;

interface ScriptLocation {
  agentName: string;
  pointer: string;
  path: string;
}

function navigate(obj: YamlMap, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAt(obj: YamlMap, parts: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = current[parts[i]];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[parts[parts.length - 1]] = value;
}

function collectScriptLocations(obj: YamlMap): ScriptLocation[] {
  const locations: ScriptLocation[] = [];
  const agents = obj.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return locations;
  for (const [agentName, agentDef] of Object.entries(agents as Record<string, unknown>)) {
    if (!agentDef || typeof agentDef !== 'object' || Array.isArray(agentDef)) continue;
    const scheduler = (agentDef as Record<string, unknown>).scheduler;
    if (!scheduler || typeof scheduler !== 'object' || Array.isArray(scheduler)) continue;
    const scriptValue = (scheduler as Record<string, unknown>).script;
    const refPath = parseScriptRef(scriptValue);
    if (refPath === null) continue;
    locations.push({
      agentName,
      pointer: encodePointer(['agents', agentName, 'scheduler', 'script']),
      path: refPath,
    });
  }
  return locations;
}

export async function expandScriptReferences(
  yamlText: string,
  readFile: ReadFile,
): Promise<{ yamlText: string; references: ScriptReference[] }> {
  const obj = parseYamlObject(yamlText);
  const locations = collectScriptLocations(obj);

  const files = new Map<string, Pick<ScriptFile, 'path' | 'content' | 'sha256'>>();
  for (const location of locations) {
    if (!files.has(location.path)) {
      files.set(location.path, await readFile(location.path));
    }
  }

  const references: ScriptReference[] = [];
  for (const location of locations) {
    const file = files.get(location.path)!;
    setAt(obj, ['agents', location.agentName, 'scheduler', 'script'], file.content);
    references.push({ pointer: location.pointer, path: location.path, contentSha256: file.sha256 });
  }

  return { yamlText: dumpYamlObject(obj), references };
}

export async function restoreScriptReferences(
  daemonYaml: string,
  manifest: ScriptManifest | null,
  deps: { readFile: ReadFile; hashContent: HashContent },
): Promise<{
  yamlText: string;
  references: ScriptReference[];
  warnings: Array<{ pointer: string; path: string; reason: string }>;
}> {
  const obj = parseYamlObject(daemonYaml);
  const references: ScriptReference[] = [];
  const warnings: Array<{ pointer: string; path: string; reason: string }> = [];

  if (!manifest || !Array.isArray(manifest.references)) {
    return { yamlText: dumpYamlObject(obj), references, warnings };
  }

  for (const ref of manifest.references) {
    const parts = decodePointer(ref.pointer);
    const inlineValue = navigate(obj, parts);

    if (typeof inlineValue !== 'string') {
      warnings.push({ pointer: ref.pointer, path: ref.path, reason: 'script 字段缺失或不是字符串' });
      continue;
    }

    const daemonHash = await deps.hashContent(inlineValue);
    if (daemonHash !== ref.contentSha256) {
      warnings.push({ pointer: ref.pointer, path: ref.path, reason: 'daemon 内联内容已变化，保留当前代码' });
      continue;
    }

    let diskFile: Pick<ScriptFile, 'content' | 'sha256'> | null = null;
    try {
      diskFile = await deps.readFile(ref.path);
    } catch {
      diskFile = null;
    }

    if (!diskFile) {
      warnings.push({ pointer: ref.pointer, path: ref.path, reason: '引用文件缺失，已回退为内联代码' });
      continue;
    }

    if (diskFile.sha256 !== ref.contentSha256) {
      warnings.push({ pointer: ref.pointer, path: ref.path, reason: '磁盘脚本已变化，保留当前内联代码' });
      continue;
    }

    setAt(obj, parts, toScriptRef(ref.path));
    references.push(ref);
  }

  return { yamlText: dumpYamlObject(obj), references, warnings };
}

export function replaceInlineWithRef(yamlText: string, pointer: string, path: string): string {
  const obj = parseYamlObject(yamlText);
  setAt(obj, decodePointer(pointer), toScriptRef(path));
  return dumpYamlObject(obj);
}

export function replaceRefWithInline(yamlText: string, pointer: string, content: string): string {
  const obj = parseYamlObject(yamlText);
  setAt(obj, decodePointer(pointer), content);
  return dumpYamlObject(obj);
}
