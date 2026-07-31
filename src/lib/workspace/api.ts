import { authFetch } from '../auth-fetch';
import {
  WorkspaceApiError,
  type WorkspaceFilesResponse,
  type WorkspaceUploadOptions,
  type WorkspaceUploadResult,
  type WorkspaceArchiveUploadOptions,
  type WorkspaceFileEntry,
} from './types';
import { packTarBlob } from './tar';

const BASE = '/api/agent-compose/workspaces';

async function parseError(response: Response): Promise<WorkspaceApiError> {
  let message = `请求失败 (${response.status})`;
  let details: unknown;
  try {
    const text = await response.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { message?: string; error?: string } | string;
        if (typeof body === 'string') {
          message = body;
        } else if (body?.message) {
          message = body.message;
          details = body;
        } else if (body?.error) {
          message = body.error;
          details = body;
        }
      } catch {
        message = text;
      }
    }
  } catch {
    // ignore body parse errors
  }
  return new WorkspaceApiError(response.status, message, details);
}

export const workspaceApi = {
  async listFiles(workspaceID: string, signal?: AbortSignal): Promise<WorkspaceFilesResponse> {
    let response: Response;
    try {
      response = await authFetch(`${BASE}/${encodeURIComponent(workspaceID)}/files`, { signal });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WorkspaceApiError(0, 'workspace 服务不可用', error);
    }
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as WorkspaceFilesResponse;
  },

  async downloadFile(
    workspaceID: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    let response: Response;
    try {
      response = await authFetch(
        `${BASE}/${encodeURIComponent(workspaceID)}/download?path=${encodeURIComponent(path)}`,
        { signal },
      );
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new WorkspaceApiError(0, 'workspace 服务不可用', error);
    }
    if (!response.ok) throw await parseError(response);
    return await response.blob();
  },

  async uploadFile(opts: WorkspaceUploadOptions): Promise<WorkspaceUploadResult> {
    const { workspaceID, file, uploadType, targetPath, signal, onProgress } = opts;
    const form = new FormData();
    form.append('file', file);
    form.append('upload_type', uploadType);
    if (uploadType === 'file' && targetPath) {
      form.append('path', targetPath);
    }

    return await new Promise<WorkspaceUploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/${encodeURIComponent(workspaceID)}/upload`);
      xhr.responseType = 'json';
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (onProgress) {
          onProgress({
            phase: 'uploading',
            loaded: event.loaded,
            total: event.total || file.size || 0,
          });
        }
      };
      xhr.upload.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      xhr.upload.onerror = () => reject(new WorkspaceApiError(0, '网络错误，上传失败'));

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress({ phase: 'done', loaded: file.size, total: file.size });
          const body = (xhr.response ?? null) as WorkspaceFilesResponse | null;
          if (!body || !Array.isArray(body.files)) {
            reject(new WorkspaceApiError(xhr.status, '上传响应格式错误'));
            return;
          }
          resolve({
            workspaceID: body.workspace_id ?? workspaceID,
            files: body.files as WorkspaceFileEntry[],
          });
        } else {
          if (onProgress) onProgress({ phase: 'error', loaded: 0, total: file.size });
          const status = xhr.status || 0;
          let message = `上传失败 (${status})`;
          let details: unknown;
          if (xhr.response && typeof xhr.response === 'object') {
            const body = xhr.response as { message?: string; error?: string };
            if (body.message) message = body.message;
            else if (body.error) message = body.error;
            details = body;
          } else if (typeof xhr.responseText === 'string' && xhr.responseText) {
            message = xhr.responseText;
          }
          reject(new WorkspaceApiError(status, message, details));
        }
      };

      if (signal) {
        if (signal.aborted) xhr.abort();
        else signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      try {
        xhr.send(form);
      } catch (error) {
        reject(new WorkspaceApiError(0, '上传请求无法发出', error));
      }
    });
  },

  // Pack entries into a tar Blob (browser assembles file parts without reading
  // them all into JS memory) and send via the same XHR + FormData path as
  // single-file uploads. This replaces the previous fetch + duplex:'half'
  // streaming approach, which failed silently before reaching the daemon.
  async uploadArchive(opts: WorkspaceArchiveUploadOptions): Promise<WorkspaceUploadResult> {
    const { workspaceID, entries, totalBytes, signal, onProgress } = opts;
    if (entries.length === 0) {
      throw new WorkspaceApiError(0, '没有可上传的文件');
    }
    let tarBlob: Blob;
    try {
      tarBlob = packTarBlob(entries);
    } catch (error) {
      throw new WorkspaceApiError(
        0,
        '打包 tar 失败：' + (error instanceof Error ? error.message : String(error)),
      );
    }
    const tarFile = new File([tarBlob], 'upload.tar', { type: 'application/x-tar' });
    return await this.uploadFile({
      workspaceID,
      file: tarFile,
      uploadType: 'archive',
      signal,
      onProgress: onProgress
        ? (p) => {
            // totalBytes is the sum of file sizes (no tar overhead); clamp progress to 100%.
            const clampedTotal = Math.max(totalBytes, p.total);
            onProgress({ ...p, total: clampedTotal });
          }
        : undefined,
    });
  },
};
