export interface Entry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
  sha256?: string;
}

export interface FileEntry extends Entry {
  isDir: false;
  sha256: string;
}

// The read endpoint includes content; the write endpoint returns metadata only.
export interface FileContent extends FileEntry {
  content?: string;
}

export class SkillApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SkillApiError';
  }
}

const BASE = '/api/project-files';

interface ResponsePayload { status: number; body: unknown }

async function request(path: string, init: RequestInit = {}): Promise<ResponsePayload> {
  let response: Response;
  try {
    const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
    response = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: init.body && !multipart ? { 'content-type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (error) {
    throw new SkillApiError(0, 'network_error', '无法连接项目文件服务', error);
  }
  const text = response.status === 204 ? '' : await response.text();
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  if (!response.ok) {
    const envelope = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    throw new SkillApiError(
      response.status,
      typeof envelope?.code === 'string' ? envelope.code : 'unknown',
      typeof envelope?.message === 'string' ? envelope.message : `请求失败 (${response.status})`,
      envelope?.details,
    );
  }
  return { status: response.status, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse(status: number): never {
  throw new SkillApiError(status, 'invalid_response', '项目文件服务返回了无效响应');
}

function validEntry(value: unknown): value is Entry {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string' && value.path.length > 0
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.isDir === 'boolean'
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.modTime === 'string' && value.modTime.length > 0
    && (value.sha256 === undefined || (typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)));
}

function validFileEntry(value: unknown): value is FileEntry {
  return validEntry(value) && value.isDir === false
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
}

function envelopeField(payload: ResponsePayload, field: string): unknown {
  if (!isRecord(payload.body) || !Object.prototype.hasOwnProperty.call(payload.body, field)) invalidResponse(payload.status);
  return payload.body[field];
}

function query(values: Record<string, string | boolean>): string {
  return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
}

export const skillApi = {
  async list(projectKey: string): Promise<Entry[]> {
    const payload = await request(`/skills?${query({ projectKey })}`);
    const entries = envelopeField(payload, 'entries');
    if (!Array.isArray(entries) || !entries.every(validEntry)) invalidResponse(payload.status);
    return entries;
  },
  async create(projectKey: string, name: string): Promise<FileEntry> {
    const payload = await request('/skills/create', { method: 'POST', body: JSON.stringify({ projectKey, name }) });
    const file = envelopeField(payload, 'file');
    if (!validFileEntry(file)) invalidResponse(payload.status);
    return file;
  },
  async read(projectKey: string, path: string): Promise<FileContent> {
    const payload = await request(`/file?${query({ projectKey, path })}`);
    const file = envelopeField(payload, 'file');
    if (!isRecord(file)) invalidResponse(payload.status);
    if (!validFileEntry(file) || typeof file.content !== 'string') invalidResponse(payload.status);
    return file;
  },
  async write(projectKey: string, path: string, content: string, expectedSHA256: string): Promise<FileContent> {
    const payload = await request('/file', { method: 'PUT', body: JSON.stringify({ projectKey, path, content, expectedSHA256 }) });
    const file = envelopeField(payload, 'file');
    if (!isRecord(file)) invalidResponse(payload.status);
    if (!validFileEntry(file) || (file.content !== undefined && typeof file.content !== 'string')) invalidResponse(payload.status);
    return file;
  },
  async remove(projectKey: string, path: string, recursive: boolean): Promise<void> {
    await request(`/folder?${query({ projectKey, path, recursive })}`, { method: 'DELETE' });
  },
  async mkdir(projectKey: string, path: string): Promise<void> {
    const payload = await request('/folder', { method: 'POST', body: JSON.stringify({ projectKey, path }) });
    const createdPath = envelopeField(payload, 'path');
    if (createdPath !== path) invalidResponse(payload.status);
  },
  async upload(projectKey: string, path: string, file: File): Promise<FileEntry> {
    const body = new FormData();
    body.set('projectKey', projectKey);
    body.set('path', path);
    body.set('file', file);
    const payload = await request('/upload', { method: 'POST', body });
    const uploaded = envelopeField(payload, 'file');
    if (!validFileEntry(uploaded)) invalidResponse(payload.status);
    return uploaded;
  },
};
