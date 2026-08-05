export interface SharedDirectory { id: string; name: string; path: string; writable: boolean }

export class SharedDirectoryApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'SharedDirectoryApiError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path) || path.includes('\\')) return false;
  if (path !== '/' && path.endsWith('/')) return false;
  if (!path.split('/').every((segment, index) => index === 0 || (segment !== '' && segment !== '.' && segment !== '..'))) return false;
  // Keep this list and basename comparison in parity with internal/sharedirs/catalog.go.
  const forbiddenRoots = ['/', '/data', '/proc', '/sys', '/dev'];
  if (forbiddenRoots.some((root) => path === root || (root !== '/' && path.startsWith(`${root}/`)))) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === 'docker.sock' || base === 'containerd.sock' || base === 'podman.sock') return false;
  return true;
}

function validEntry(value: unknown): value is SharedDirectory {
  return record(value)
    && typeof value.id === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value.id)
    && typeof value.name === 'string' && value.name === value.name.trim() && value.name.length > 0 && value.name.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value.name)
    && typeof value.path === 'string' && canonicalAbsolutePath(value.path)
    && typeof value.writable === 'boolean';
}

function invalid(status: number): never {
  throw new SharedDirectoryApiError(status, 'invalid_response', '共享目录服务返回了无效响应');
}

export const sharedDirectoryApi = {
  async list(): Promise<SharedDirectory[]> {
    let response: Response;
    try {
      response = await fetch('/api/shared-directories', { credentials: 'same-origin' });
    } catch (error) {
      throw new SharedDirectoryApiError(0, 'network_error', '无法连接共享目录服务', error);
    }
    const text = response.status === 204 ? '' : await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!response.ok) {
      const envelope = record(body) && record(body.error) ? body.error : undefined;
      throw new SharedDirectoryApiError(
        response.status,
        typeof envelope?.code === 'string' ? envelope.code : 'unknown',
        typeof envelope?.message === 'string' ? envelope.message : `请求失败 (${response.status})`,
        envelope?.details,
      );
    }
    if (!record(body) || !Array.isArray(body.entries) || !body.entries.every(validEntry)) invalid(response.status);
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const entry of body.entries) {
      if (ids.has(entry.id) || paths.has(entry.path)) invalid(response.status);
      ids.add(entry.id); paths.add(entry.path);
    }
    return body.entries;
  },
};
