export const DIRECTORY_LIST_BYTES = 256 * 1024;
export const FILE_PREVIEW_BYTES = 512 * 1024;
export const FILE_PREVIEW_BEGIN = '__AC_FILE_BEGIN__';
export const FILE_PREVIEW_END = '__AC_FILE_END__';
export const BASE64_PREVIEW_BYTES = Math.ceil((FILE_PREVIEW_BYTES + 1) / 3) * 4
  + FILE_PREVIEW_BEGIN.length + FILE_PREVIEW_END.length;
export const MAX_DIRECTORY_ENTRIES = 5000;
export const MAX_WRITABLE_FILE_BYTES = 64 * 1024;

export interface FileBrowserEntry {
  name: string;
  isDir: boolean;
  fullPath: string;
}

export interface LimitedOutput {
  value: string;
  bytes: number;
  truncated: boolean;
}

export interface WritableFilePayload {
  base64: string;
  bytes: number;
  remainingBytes: number;
}

export function resolveWorkspaceFileTarget(value: string) {
  if (!value.startsWith('/workspace/') || value.endsWith('/') || value.includes('\0')) return null;
  const segments = value.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  const fileName = segments.at(-1) ?? '';
  if (!fileName) return null;
  const directory = segments.slice(0, -1).join('/') || '/';
  return { directory, fileName, fullPath: value };
}

export function writableFileBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function decodeBase64Preview(encoded: string): { value: string; truncated: boolean } {
  const compact = encoded.replace(/\s/g, '');
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error('文件预览数据损坏');
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const truncated = bytes.length > FILE_PREVIEW_BYTES;
  const preview = truncated ? bytes.slice(0, FILE_PREVIEW_BYTES) : bytes;
  if (preview.includes(0)) throw new Error('该文件是二进制文件，不支持文本预览');
  try {
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(preview), truncated };
  } catch {
    throw new Error('该文件不是有效的 UTF-8 文本，不支持预览');
  }
}

export function extractFramedPreview(output: string): string {
  const begin = output.indexOf(FILE_PREVIEW_BEGIN);
  if (begin < 0) throw new Error('文件预览响应不完整');
  const contentStart = begin + FILE_PREVIEW_BEGIN.length;
  const end = output.indexOf(FILE_PREVIEW_END, contentStart);
  if (end < 0) throw new Error('文件预览响应不完整');
  return output.slice(contentStart, end);
}

export function prepareWritableFile(content: string): WritableFilePayload {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length > MAX_WRITABLE_FILE_BYTES) {
    throw new Error(`文件为 ${encoded.length} UTF-8 bytes，超过写入上限 ${MAX_WRITABLE_FILE_BYTES} bytes`);
  }
  let binary = '';
  for (const byte of encoded) binary += String.fromCharCode(byte);
  return {
    base64: btoa(binary),
    bytes: encoded.length,
    remainingBytes: MAX_WRITABLE_FILE_BYTES - encoded.length,
  };
}

export async function writeBoundedFile<T>(
  content: string,
  path: string,
  write: (base64: string, path: string) => Promise<T>,
): Promise<T> {
  const payload = prepareWritableFile(content);
  return write(payload.base64, path);
}

export function createLimitedOutput(): LimitedOutput {
  return { value: '', bytes: 0, truncated: false };
}

export function appendLimitedOutput(
  current: LimitedOutput,
  chunk: string,
  limit: number,
): LimitedOutput {
  const remaining = Math.max(0, limit - current.bytes);
  const chunkBytes = new TextEncoder().encode(chunk);
  if (chunkBytes.length <= remaining) {
    return {
      value: current.value + chunk,
      bytes: current.bytes + chunkBytes.length,
      truncated: current.truncated,
    };
  }
  const prefix = new TextDecoder('utf-8', { fatal: true });
  let end = Math.min(remaining, chunkBytes.length);
  while (end > 0) {
    try {
      return {
        value: current.value + prefix.decode(chunkBytes.slice(0, end)),
        bytes: current.bytes + end,
        truncated: true,
      };
    } catch {
      end--;
    }
  }
  return { ...current, truncated: true };
}

export function mergeLimitedOutput(
  current: LimitedOutput,
  chunk: string,
  limit: number,
): LimitedOutput {
  if (current.value !== '' && chunk.startsWith(current.value)) {
    return appendLimitedOutput(createLimitedOutput(), chunk, limit);
  }
  return appendLimitedOutput(current, chunk, limit);
}

export function parseDirectoryListing(raw: string, dir: string): FileBrowserEntry[] {
  const records = raw.split('\n');
  records.pop();
  return records.filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    const type = separator >= 0 ? line.slice(0, separator) : '';
    const name = separator >= 0 ? line.slice(separator + 1) : line;
    const fullPath = dir.replace(/\/$/, '') + '/' + name;
    return { name, isDir: type === 'd', fullPath };
  }).sort((left, right) => (
    Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name)
  ));
}

export function formatExecError(stderr: string, fallback: string): string {
  return stderr.trim() || fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
