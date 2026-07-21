import {
  localWorkspaceApi,
  LocalWorkspaceApiError,
  type WorkspaceFileEntry,
} from './local-api';

export interface WorkspaceRefreshResult {
  files: WorkspaceFileEntry[];
  error: LocalWorkspaceApiError | null;
}

let tempSeq = 0;

export class WorkspaceFileStore {
  sourcePath = $state('');
  workspacePath = $state('');
  files = $state<WorkspaceFileEntry[]>([]);
  activePath = $state('');
  loading = $state(false);
  lastError = $state<LocalWorkspaceApiError | null>(null);
  lastRefreshedAt = $state('');

  #refreshGeneration = 0;
  #tempSourcePath = '';

  /** The path actually used for file operations — real sourcePath, or a temp dir when sourcePath is empty. */
  get #effectiveSourcePath(): string {
    return this.sourcePath || this.#tempSourcePath;
  }

  setWorkspace(sourcePath: string, workspacePath: string): void {
    if (this.sourcePath === sourcePath && this.workspacePath === workspacePath) return;

    const oldSource = this.sourcePath;
    const oldTemp = this.#tempSourcePath;
    const oldWorkspace = this.workspacePath;
    const hadTemp = !oldSource && oldTemp && oldWorkspace;

    this.sourcePath = sourcePath;
    this.workspacePath = workspacePath;
    this.files = [];
    this.activePath = '';
    this.lastError = null;
    this.lastRefreshedAt = '';
    this.#refreshGeneration += 1;

    // If sourcePath just became available, migrate files from temp → real path
    if (hadTemp && sourcePath && workspacePath) {
      this.#migrateFromTemp(oldTemp, oldWorkspace, sourcePath, workspacePath);
    }

    // Ensure temp or real directory exists (fire-and-forget)
    if (workspacePath) {
      void this.#ensureDirAndRefresh();
    }
  }

  async #ensureDirAndRefresh(): Promise<void> {
    const sp = this.#effectiveSourcePath;
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

  async #migrateFromTemp(
    tempSrc: string,
    tempWs: string,
    realSrc: string,
    realWs: string,
  ): Promise<void> {
    try {
      await localWorkspaceApi.ensureDir(realSrc, realWs);
      const tempFiles = await localWorkspaceApi.listFiles(tempSrc, tempWs);
      for (const entry of tempFiles.files) {
        if (entry.dir) continue;
        try {
          const blob = await localWorkspaceApi.downloadFile(tempSrc, tempWs, entry.path);
          const file = new File([blob], entry.path.split('/').pop() ?? entry.path);
          await localWorkspaceApi.uploadFile(realSrc, realWs, file, entry.path);
        } catch {
          // skip individual file errors during migration
        }
      }
    } catch {
      // migration is best-effort; refresh will show current state
    }
  }

  get workspaceID(): string {
    const sp = this.#effectiveSourcePath;
    return sp && this.workspacePath ? `${sp}::${this.workspacePath}` : '';
  }

  async #ensureReady(): Promise<void> {
    if (!this.workspacePath) throw new LocalWorkspaceApiError(0, '未绑定 workspace');
    if (!this.#tempSourcePath && !this.sourcePath) {
      this.#tempSourcePath = `/tmp/agent-compose-ws-${Date.now()}-${++tempSeq}`;
      await localWorkspaceApi.ensureDir(this.#tempSourcePath, this.workspacePath);
    }
  }

  async refresh(): Promise<WorkspaceRefreshResult> {
    const sp = this.#effectiveSourcePath;
    if (!sp || !this.workspacePath) {
      return { files: this.files, error: null };
    }
    const generation = ++this.#refreshGeneration;
    const source = sp;
    const ws = this.workspacePath;
    this.loading = true;
    try {
      const response = await localWorkspaceApi.listFiles(source, ws);
      if (generation !== this.#refreshGeneration || this.#effectiveSourcePath !== source || this.workspacePath !== ws) {
        return { files: this.files, error: null };
      }
      this.files = response.files;
      this.lastError = null;
      this.lastRefreshedAt = new Date().toISOString();
      return { files: response.files, error: null };
    } catch (error) {
      if (generation !== this.#refreshGeneration || this.#effectiveSourcePath !== source || this.workspacePath !== ws) {
        return { files: this.files, error: null };
      }
      const wrapped = error instanceof LocalWorkspaceApiError
        ? error
        : new LocalWorkspaceApiError(0, error instanceof Error ? error.message : String(error));
      this.lastError = wrapped;
      return { files: this.files, error: null };
    } finally {
      if (generation === this.#refreshGeneration && this.#effectiveSourcePath === source && this.workspacePath === ws) {
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
      this.#effectiveSourcePath,
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
    return await localWorkspaceApi.downloadFile(this.#effectiveSourcePath, this.workspacePath, path);
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
    await localWorkspaceApi.deleteFile(this.#effectiveSourcePath, this.workspacePath, path);
    this.removeFile(path);
  }

  async createFolder(path: string): Promise<void> {
    await this.#ensureReady();
    await localWorkspaceApi.createFolder(this.#effectiveSourcePath, this.workspacePath, path);
    await this.refresh();
  }

  async deleteFolder(path: string, recursive: boolean): Promise<void> {
    await this.#ensureReady();
    await localWorkspaceApi.deleteFolder(this.#effectiveSourcePath, this.workspacePath, path, recursive);
    await this.refresh();
  }
}

export const workspaceFiles = new WorkspaceFileStore();
