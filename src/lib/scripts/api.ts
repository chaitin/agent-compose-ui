import type { ScriptFile, ScriptManifest, ScriptTreeNode } from './types';
import { authFetch } from '../auth-fetch';

const BASE = '/script-api/v1';

export const SCRIPT_ERROR_MESSAGES: Record<string, string> = {
  INVALID_PATH: '脚本路径无效',
  NOT_FOUND: '脚本文件不存在',
  ALREADY_EXISTS: '同名文件或文件夹已存在',
  CONTENT_CONFLICT: '磁盘文件已变化，请重新加载或另存',
  PAYLOAD_TOO_LARGE: '脚本超过 2 MiB 限制',
  UNAUTHORIZED: '脚本服务鉴权失败',
  DIRECTORY_NOT_EMPTY: '文件夹不为空',
  SERVICE_UNAVAILABLE: '脚本服务不可用',
};

export function scriptErrorMessage(error: unknown): string {
  if (error instanceof ScriptApiError) {
    return SCRIPT_ERROR_MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ScriptApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ScriptApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await authFetch(`${BASE}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
    });
  } catch (error) {
    throw new ScriptApiError(0, 'SERVICE_UNAVAILABLE', '脚本服务不可用', error);
  }
  if (!response.ok) {
    let body: { error?: { code: string; message: string; details?: unknown } } | null = null;
    try {
      body = (await response.json()) as { error?: { code: string; message: string; details?: unknown } };
    } catch {
      body = null;
    }
    const error = body?.error;
    throw new ScriptApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `请求失败 (${response.status})`,
      error?.details,
    );
  }
  return response;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const scriptApi = {
  async health(): Promise<{ ok: boolean; version: string }> {
    const response = await request('/health');
    return parseJson<{ ok: boolean; version: string }>(response);
  },
  async listTree(): Promise<ScriptTreeNode> {
    const response = await request('/tree');
    return parseJson<ScriptTreeNode>(response);
  },
  async readFile(path: string): Promise<ScriptFile> {
    const response = await request(`/files?path=${encodeURIComponent(path)}`);
    return parseJson<ScriptFile>(response);
  },
  async writeFile(input: { path: string; content: string; expectedSha256: string | null }): Promise<ScriptFile> {
    const response = await request('/files', { method: 'PUT', body: JSON.stringify(input) });
    return parseJson<ScriptFile>(response);
  },
  async deleteFile(path: string, expectedSha256?: string): Promise<void> {
    const suffix = expectedSha256 ? `&expectedSha256=${encodeURIComponent(expectedSha256)}` : '';
    await request(`/files?path=${encodeURIComponent(path)}${suffix}`, { method: 'DELETE' });
  },
  async createFolder(path: string): Promise<void> {
    await request('/folders', { method: 'POST', body: JSON.stringify({ path }) });
  },
  async deleteFolder(path: string, recursive: boolean): Promise<void> {
    await request(`/folders?path=${encodeURIComponent(path)}&recursive=${recursive}`, { method: 'DELETE' });
  },
  async ensureProject(projectId: string, projectName: string): Promise<{ projectId: string; projectName: string; directory: string }> {
    const response = await request(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ projectName }),
    });
    return parseJson<{ projectId: string; projectName: string; directory: string }>(response);
  },
  async deleteProject(projectId: string): Promise<void> {
    await request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  },
  async readManifest(projectId: string): Promise<ScriptManifest | null> {
    const response = await request(`/projects/${encodeURIComponent(projectId)}/manifest`);
    const text = await response.text();
    return text ? (JSON.parse(text) as ScriptManifest) : null;
  },
  async writeManifest(projectId: string, manifest: ScriptManifest): Promise<void> {
    await request(`/projects/${encodeURIComponent(projectId)}/manifest`, {
      method: 'PUT',
      body: JSON.stringify(manifest),
    });
  },
  async deleteManifest(projectId: string): Promise<void> {
    await request(`/projects/${encodeURIComponent(projectId)}/manifest`, { method: 'DELETE' });
  },
};
