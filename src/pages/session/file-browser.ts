export const DIRECTORY_LIST_BYTES = 256 * 1024;
export const FILE_PREVIEW_BYTES = 512 * 1024;
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
