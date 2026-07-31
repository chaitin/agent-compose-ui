import { authFetch } from '../auth-fetch';

export interface WorkspaceFileEntry {
  path: string;
  dir: boolean;
  size: number;
  updated_at: string;
}

interface GoFileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

function mapEntry(e: GoFileEntry): WorkspaceFileEntry {
  return {
    path: e.path,
    dir: e.dir,
    size: e.size,
    updated_at: e.mtimeMs > 0 ? new Date(e.mtimeMs).toISOString() : '',
  };
}

export class LocalWorkspaceApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LocalWorkspaceApiError';
    this.status = status;
  }
}

async function request(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await authFetch(input, init);
  } catch (error) {
    throw new LocalWorkspaceApiError(0, '网络错误');
  }
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore
    }
    throw new LocalWorkspaceApiError(response.status, message);
  }
  return response;
}

export const localWorkspaceApi = {
  async ensureDir(projectKey: string, workspacePath: string): Promise<{ ok: boolean; path: string }> {
    const response = await request('/api/local-workspace/ensure-dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectKey, workspacePath }),
    });
    return response.json();
  },

  async listFiles(
    projectKey: string,
    workspacePath: string,
  ): Promise<{ files: WorkspaceFileEntry[] }> {
    const params = new URLSearchParams({ projectKey, workspacePath });
    const response = await request(`/api/local-workspace/files?${params}`);
    const data = await response.json() as { files: GoFileEntry[] };
    return { files: data.files.map(mapEntry) };
  },

  async uploadFile(
    projectKey: string,
    workspacePath: string,
    file: File,
    targetPath?: string,
    onProgress?: (progress: { loaded: number; total: number }) => void,
  ): Promise<{ files: WorkspaceFileEntry[] }> {
    return await new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      form.append('projectKey', projectKey);
      form.append('workspacePath', workspacePath);
      if (targetPath) form.append('path', targetPath);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/local-workspace/upload');
      xhr.responseType = 'json';
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (onProgress) {
          onProgress({ loaded: event.loaded, total: event.total || file.size || 0 });
        }
      };
      xhr.upload.onerror = () => reject(new LocalWorkspaceApiError(0, '网络错误，上传失败'));

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          const resp = (xhr.response ?? { files: [] }) as { files: GoFileEntry[] };
          resolve({ files: resp.files.map(mapEntry) });
        } else {
          let message = `上传失败 (${xhr.status})`;
          if (xhr.response && typeof xhr.response === 'object') {
            const body = xhr.response as { error?: string };
            if (body.error) message = body.error;
          }
          reject(new LocalWorkspaceApiError(xhr.status || 0, message));
        }
      };
      xhr.send(form);
    });
  },

  async downloadFile(
    projectKey: string,
    workspacePath: string,
    path: string,
  ): Promise<Blob> {
    const params = new URLSearchParams({ projectKey, workspacePath, path });
    const response = await request(`/api/local-workspace/download?${params}`);
    return response.blob();
  },

  async deleteFile(
    projectKey: string,
    workspacePath: string,
    path: string,
  ): Promise<void> {
    const params = new URLSearchParams({ projectKey, workspacePath, path });
    await request(`/api/local-workspace/file?${params}`, { method: 'DELETE' });
  },

  async createFolder(
    projectKey: string,
    workspacePath: string,
    path: string,
  ): Promise<void> {
    await request('/api/local-workspace/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectKey, workspacePath, path }),
    });
  },

  async deleteFolder(
    projectKey: string,
    workspacePath: string,
    path: string,
    recursive: boolean,
  ): Promise<void> {
    const params = new URLSearchParams({ projectKey, workspacePath, path, recursive: String(recursive) });
    await request(`/api/local-workspace/folder?${params}`, { method: 'DELETE' });
  },
};
