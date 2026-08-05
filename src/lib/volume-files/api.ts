export type VolumeFileEntry = { name: string; path: string; dir: boolean; size: number; mtimeMs: number; sha256?: string };
export type VolumePreview = { path: string; content: string; sha256: string; truncated: boolean };
export class VolumeFileApiError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'VolumeFileApiError'; } }

const BASE = '/api/volume-files';
type Payload = { status: number; body: unknown; contentType: string };
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> { return record(v) && Object.keys(v).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(v, key)); }
function exactOptional(v: unknown, required: readonly string[], optional: readonly string[]): v is Record<string, unknown> { return record(v) && required.every((k) => Object.prototype.hasOwnProperty.call(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k)); }
function relative(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && !v.startsWith('/') && !v.includes('\\') && !v.split('/').some((p) => !p || p === '.' || p === '..') && !/[\x00-\x1f\x7f]/.test(v); }
function validEntry(v: unknown): v is VolumeFileEntry { return exactOptional(v, ['name', 'path', 'dir', 'size', 'mtimeMs'], ['sha256']) && typeof v.name === 'string' && v.name.length > 0 && !v.name.includes('/') && relative(v.path) && typeof v.dir === 'boolean' && Number.isSafeInteger(v.size) && (v.size as number) >= 0 && Number.isSafeInteger(v.mtimeMs) && (v.mtimeMs as number) >= 0 && (v.sha256 === undefined || typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)); }
function query(v: Record<string, string | boolean>) { return Object.entries(v).map(([k, x]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`).join('&'); }
function invalid(status: number): never { throw new VolumeFileApiError(status, 'invalid_response', '卷文件服务返回了无效响应'); }
function aborted(e: unknown) { return e !== null && typeof e === 'object' && 'name' in e && e.name === 'AbortError'; }
function isJSON(contentType: string) { return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json'; }

async function request(path: string, init: RequestInit = {}): Promise<Payload> {
  let response: Response; let text: string;
  try { response = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' }); text = await response.text(); }
  catch (e) { if (aborted(e)) throw e; throw new VolumeFileApiError(0, 'network_error', '无法连接卷文件服务', e); }
  const contentType = response.headers.get('content-type') ?? ''; let body: unknown;
  if (text) { try { body = JSON.parse(text); } catch { body = undefined; } }
  if (!response.ok) {
    if (!isJSON(contentType) || !exact(body, ['error']) || !exactOptional(body.error, ['code', 'message'], ['details']) || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') invalid(response.status);
    throw new VolumeFileApiError(response.status, body.error.code, body.error.message, body.error.details);
  }
  return { status: response.status, body, contentType };
}
function json(p: Payload, status: number): Record<string, unknown> { if (p.status !== status || !isJSON(p.contentType) || !record(p.body)) invalid(p.status); return p.body; }
function empty(p: Payload, status = 204) { if (p.status !== status || p.body !== undefined) invalid(p.status); }

export const volumeFileApi = {
  async list(projectKey: string, volume: string, path = '', signal?: AbortSignal): Promise<VolumeFileEntry[]> { const p = json(await request(`?${query({ projectKey, volume, path })}`, { signal }), 200); if (!exact(p, ['entries']) || !Array.isArray(p.entries) || !p.entries.every(validEntry)) invalid(200); return p.entries; },
  async preview(projectKey: string, volume: string, path: string, signal?: AbortSignal): Promise<VolumePreview> { const p = json(await request(`/preview?${query({ projectKey, volume, path })}`, { signal }), 200); if (!exact(p, ['path', 'content', 'sha256', 'truncated']) || !relative(p.path) || typeof p.content !== 'string' || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256) || typeof p.truncated !== 'boolean') invalid(200); return p as unknown as VolumePreview; },
  downloadURL(projectKey: string, volume: string, path: string) { return `${BASE}/download?${query({ projectKey, volume, path })}`; },
  async upload(projectKey: string, volume: string, path: string, file: File, signal?: AbortSignal) { const body = new FormData(); body.set('projectKey', projectKey); body.set('volume', volume); body.set('path', path); body.set('file', file); const p = json(await request('/upload', { method: 'POST', body, signal }), 201); if (!exact(p, ['file']) || !validEntry(p.file) || p.file.dir) invalid(201); return p.file; },
  async write(projectKey: string, volume: string, path: string, content: string, expectedSHA256: string, signal?: AbortSignal) { const p = json(await request('/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectKey, volume, path, content, expectedSHA256 }), signal }), 200); if (!exact(p, ['file']) || !validEntry(p.file) || p.file.dir) invalid(200); return p.file; },
  async mkdir(projectKey: string, volume: string, path: string, signal?: AbortSignal) { const p = json(await request('/folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectKey, volume, path }), signal }), 201); if (!exact(p, ['path']) || p.path !== path || !relative(p.path)) invalid(201); },
  async removeFile(projectKey: string, volume: string, path: string, signal?: AbortSignal) { empty(await request(`/file?${query({ projectKey, volume, path })}`, { method: 'DELETE', signal })); },
  async removeFolder(projectKey: string, volume: string, path: string, recursive: boolean, signal?: AbortSignal) { empty(await request(`/folder?${query({ projectKey, volume, path, recursive })}`, { method: 'DELETE', signal })); },
};
