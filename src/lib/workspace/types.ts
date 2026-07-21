export interface WorkspaceFileEntry {
  path: string;
  dir: boolean;
  size: number;
  updated_at: string;
}

export interface WorkspaceFilesResponse {
  workspace_id: string;
  files: WorkspaceFileEntry[];
}

export type WorkspaceUploadType = 'file' | 'archive';

export interface TarEntryInput {
  path: string;
  file: Blob;
  mtime?: number;
}

export interface WorkspaceUploadProgress {
  phase: 'queued' | 'packing' | 'uploading' | 'done' | 'error';
  loaded: number;
  total: number;
}

export interface WorkspaceUploadOptions {
  workspaceID: string;
  file: Blob;
  uploadType: WorkspaceUploadType;
  targetPath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceUploadProgress) => void;
}

export interface WorkspaceArchiveUploadOptions {
  workspaceID: string;
  entries: TarEntryInput[];
  totalBytes: number;
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceUploadProgress) => void;
}

export interface WorkspaceUploadResult {
  workspaceID: string;
  files: WorkspaceFileEntry[];
}

export class WorkspaceApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.details = details;
  }
}

export function workspaceErrorMessage(error: unknown): string {
  if (error instanceof WorkspaceApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
