import { dumpYamlObject, parseYamlObject, type YamlMap } from '../yaml';
import { decodePointer, encodePointer, parseScriptRef, toScriptRef } from './paths';

export type ScriptLocation =
  | { pointer: string; kind: 'reference'; path: string }
  | { pointer: string; kind: 'inline'; content: string };

const SENTINEL = '__SCRIPT_BLOCK_SENTINEL_7c3f9a__';

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

function stripScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export type ScriptRange =
  | {
      pointer: string;
      agentName: string;
      kind: 'reference';
      path: string;
      startLine: number;
      endLine: number;
    }
  | {
      pointer: string;
      agentName: string;
      kind: 'inline';
      content: string;
      startLine: number;
      endLine: number;
    };

function scanScriptRanges(lines: string[]): ScriptRange[] {
  const ranges: ScriptRange[] = [];
  const pathStack: Array<{ indent: number; key: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^(\s*)([^\s#:].*?)\s*:(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    const value = match[3].trim();

    while (pathStack.length > 0 && pathStack[pathStack.length - 1].indent >= indent) {
      pathStack.pop();
    }
    pathStack.push({ indent, key });
    const path = pathStack.map((entry) => entry.key);

    if (path.length === 4 && path[0] === 'agents' && path[2] === 'scheduler' && path[3] === 'script') {
      const agentName = path[1];
      const pointer = encodePointer(['agents', agentName, 'scheduler', 'script']);
      const refPath = parseScriptRef(value);

      if (refPath !== null) {
        ranges.push({ pointer, agentName, kind: 'reference', path: refPath, startLine: i + 1, endLine: i + 1 });
      } else if (value === '|' || value === '|-' || value === '|+' || value === '>' || value === '>-' || value === '>+') {
        let blockIndent = -1;
        const blockLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const blockLine = lines[j];
          if (blockLine.trim() === '') {
            blockLines.push('');
            j += 1;
            continue;
          }
          const leading = blockLine.match(/^(\s*)/)?.[1].length ?? 0;
          if (leading <= indent) break;
          if (blockIndent < 0) blockIndent = leading;
          blockLines.push(blockLine.slice(blockIndent));
          j += 1;
        }
        const endLine = j - 1;
        let content: string;
        if (value === '|+' || value === '>+') {
          content = blockLines.join('\n');
        } else {
          const trimmed = [...blockLines];
          while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
            trimmed.pop();
          }
          content = trimmed.join('\n');
          if (value === '|' || value === '>') content += '\n';
        }
        ranges.push({ pointer, agentName, kind: 'inline', content, startLine: i + 1, endLine: endLine + 1 });
      } else {
        ranges.push({ pointer, agentName, kind: 'inline', content: stripScalarQuotes(value), startLine: i + 1, endLine: i + 1 });
      }
    }
  }
  return ranges;
}

export function listScriptRanges(yamlText: string): ScriptRange[] {
  return scanScriptRanges(yamlText.split('\n'));
}

export function defaultScriptPath(pointer: string, projectName?: string): string {
  const parts = decodePointer(pointer);
  const rawName = parts[0] === 'agents' && parts[1] ? parts[1] : 'script';
  const safeName = rawName
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'script';
  const dir = (projectName?.trim() || 'scripts').toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'scripts';
  return `${dir}/${safeName}.js`;
}

export function findScriptAtLine(yamlText: string, lineNumber: number): ScriptLocation | null {
  const ranges = listScriptRanges(yamlText);
  for (const range of ranges) {
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      if (range.kind === 'reference') {
        return { pointer: range.pointer, kind: 'reference', path: range.path };
      }
      return { pointer: range.pointer, kind: 'inline', content: range.content };
    }
  }
  return null;
}

export function extractInlineScript(yamlText: string, pointer: string, path: string): { yamlText: string; content: string } {
  const obj = parseYamlObject(yamlText);
  const parts = decodePointer(pointer);
  const current = navigate(obj, parts);
  const content = typeof current === 'string' ? current : '';
  setAt(obj, parts, toScriptRef(path));
  return { yamlText: dumpYamlObject(obj), content };
}

export function referenceExistingScript(yamlText: string, pointer: string, path: string): string {
  const obj = parseYamlObject(yamlText);
  setAt(obj, decodePointer(pointer), toScriptRef(path));
  return dumpYamlObject(obj);
}

function emitBlockScalar(indent: string, content: string): string {
  const prefix = `${indent}  `;
  const lines = content.split('\n').map((line) => (line === '' ? '' : prefix + line));
  return `${indent}script: |-\n${lines.join('\n')}`;
}

export function initializeInlineScript(yamlText: string, pointer: string): string {
  return inlineScriptReference(yamlText, pointer, '');
}

export function inlineScriptReference(yamlText: string, pointer: string, content: string): string {
  const obj = parseYamlObject(yamlText);
  setAt(obj, decodePointer(pointer), SENTINEL);
  const dumped = dumpYamlObject(obj);
  const lines = dumped.split('\n');
  const pattern = new RegExp(`^(\\s*)script: ${SENTINEL}\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(pattern);
    if (match) {
      lines[i] = emitBlockScalar(match[1], content);
      break;
    }
  }
  return lines.join('\n');
}
