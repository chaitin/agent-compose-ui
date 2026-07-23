import {
  localWorkspaceApi,
  LocalWorkspaceApiError,
  type WorkspaceFileEntry,
} from './local-api';

export interface WorkspaceRefreshResult {
  files: WorkspaceFileEntry[];
  error: LocalWorkspaceApiError | null;
}

export class WorkspaceFileStore {
  projectKey = $state('');
  workspacePath = $state('');
  files = $state<WorkspaceFileEntry[]>([]);
  activePath = $state('');
  loading = $state(false);
  lastError = $state<LocalWorkspaceApiError | null>(null);
  lastRefreshedAt = $state('');

  #refreshGeneration = 0;
  setWorkspace(projectKey: string, workspacePath: string): void {
    if (this.projectKey === projectKey && this.workspacePath === workspacePath) return;

    this.projectKey = projectKey;
    this.workspacePath = workspacePath;
    this.files = [];
    this.activePath = '';
    this.lastError = null;
    this.lastRefreshedAt = '';
    this.#refreshGeneration += 1;

    if (projectKey && workspacePath) {
      void this.#ensureDirAndRefresh();
    }
  }

  async #ensureDirAndRefresh(): Promise<void> {
    const sp = this.projectKey;
    const wp = this.workspacePath;
    if (!sp || !wp) return;
    try {
      await localWorkspaceApi.ensureDir(sp, wp);
      await this.refresh();
    } catch (error) {
      // Directory creation failed — refresh will show the error
      void this.refresh();
    }
  }

  get workspaceID(): string {
    const sp = this.projectKey;
    return sp && this.workspacePath ? `${sp}::${this.workspacePath}` : '';
  }

  async #ensureReady(): Promise<void> {
    if (!this.workspacePath) throw new LocalWorkspaceApiError(0, '未绑定 workspace');
    if (!this.projectKey) throw new LocalWorkspaceApiError(0, '项目 Workspace 尚未创建');
  }

  async refresh(): Promise<WorkspaceRefreshResult> {
    const sp = this.projectKey;
    if (!sp || !this.workspacePath) {
      return { files: this.files, error: null };
    }
    const generation = ++this.#refreshGeneration;
    const source = sp;
    const ws = this.workspacePath;
    this.loading = true;
    try {
      const response = await localWorkspaceApi.listFiles(source, ws);
      if (generation !== this.#refreshGeneration || this.projectKey !== source || this.workspacePath !== ws) {
        return { files: this.files, error: null };
      }
      this.files = response.files;
      this.lastError = null;
      this.lastRefreshedAt = new Date().toISOString();
      return { files: response.files, error: null };
    } catch (error) {
      if (generation !== this.#refreshGeneration || this.projectKey !== source || this.workspacePath !== ws) {
        return { files: this.files, error: null };
      }
      const wrapped = error instanceof LocalWorkspaceApiError
        ? error
        : new LocalWorkspaceApiError(0, error instanceof Error ? error.message : String(error));
      this.lastError = wrapped;
      return { files: this.files, error: null };
    } finally {
      if (generation === this.#refreshGeneration && this.projectKey === source && this.workspacePath === ws) {
        this.loading = false;
      }
    }
  }

  async upload(
    file: File,
    targetPath?: string,
    onProgress?: (progress: { loaded: number; total: number }) => void,
  ): Promise<WorkspaceFileEntry[]> {
    await this.#ensureReady();
    const result = await localWorkspaceApi.uploadFile(
      this.projectKey,
      this.workspacePath,
      file,
      targetPath,
      onProgress,
    );
    this.files = result.files;
    this.lastRefreshedAt = new Date().toISOString();
    this.lastError = null;
    return result.files;
  }

  async download(path: string): Promise<Blob> {
    await this.#ensureReady();
    return await localWorkspaceApi.downloadFile(this.projectKey, this.workspacePath, path);
  }

  hasFile(path: string): boolean {
    return this.files.some((f) => f.path === path && !f.dir);
  }

  removeFile(path: string): void {
    if (this.activePath === path) this.activePath = '';
    this.files = this.files.filter((f) => f.path !== path);
  }

  async deleteFile(path: string): Promise<void> {
    await this.#ensureReady();
    await localWorkspaceApi.deleteFile(this.projectKey, this.workspacePath, path);
    this.removeFile(path);
  }

  async createFolder(path: string): Promise<void> {
    await this.#ensureReady();
    await localWorkspaceApi.createFolder(this.projectKey, this.workspacePath, path);
    await this.refresh();
  }

  async deleteFolder(path: string, recursive: boolean): Promise<void> {
    await this.#ensureReady();
    await localWorkspaceApi.deleteFolder(this.projectKey, this.workspacePath, path, recursive);
    await this.refresh();
  }
}

export const workspaceFiles = new WorkspaceFileStore();
