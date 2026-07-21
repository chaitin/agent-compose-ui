import type { ScriptFile, ScriptTreeNode } from './types';
import { scriptApi, type ScriptApiError } from './api';

export interface EditableScriptFile extends ScriptFile {
  savedContent: string;
  dirty: boolean;
  saving: boolean;
}

export interface ScriptWorkspaceApi {
  listTree(): Promise<ScriptTreeNode>;
  readFile(path: string): Promise<ScriptFile>;
  writeFile(input: { path: string; content: string; expectedSha256: string | null }): Promise<ScriptFile>;
  createFolder(path: string): Promise<void>;
  deleteFile(path: string, expectedSha256?: string): Promise<void>;
  deleteFolder(path: string, recursive: boolean): Promise<void>;
}

const DEFAULT_NEW_SCRIPT = '// 新脚本\n';

export function createScriptWorkspace(api: ScriptWorkspaceApi = scriptApi): ScriptWorkspace {
  return new ScriptWorkspace(api);
}

export class ScriptWorkspace {
  tree = $state<ScriptTreeNode | null>(null);
  files = $state<Map<string, EditableScriptFile>>(new Map());
  activePath = $state('');
  projectId = $state('');
  projectName = $state('');
  panelOpen = $state(false);
  activeTab = $state<'scripts' | 'workspace'>('scripts');
  loading = $state(false);
  serviceAvailable = $state(true);
  contextRevision = $state(0);
  warnings = $state<Array<{ path: string; reason: string }>>([]);

  readonly #api: ScriptWorkspaceApi;
  #treeRequestGeneration = 0;

  constructor(api: ScriptWorkspaceApi) {
    this.#api = api;
  }

  get activeFile(): EditableScriptFile | null {
    return this.files.get(this.activePath) ?? null;
  }

  openWorkspaceTab(): void {
    this.activeTab = 'workspace';
    this.panelOpen = true;
  }

  openScriptsTab(): void {
    this.activeTab = 'scripts';
    this.panelOpen = true;
  }

  getContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  async refreshTree(): Promise<void> {
    const generation = ++this.#treeRequestGeneration;
    const projectId = this.projectId;
    try {
      const tree = await this.#api.listTree();
      if (generation !== this.#treeRequestGeneration || projectId !== this.projectId) return;
      this.tree = tree;
      this.serviceAvailable = true;
    } catch (error) {
      if (generation !== this.#treeRequestGeneration || projectId !== this.projectId) return;
      this.serviceAvailable = false;
      throw error;
    }
  }

  async openFile(path: string): Promise<void> {
    if (this.files.has(path)) {
      this.activePath = path;
      return;
    }
    const file = await this.#api.readFile(path);
    const editable: EditableScriptFile = {
      ...file,
      savedContent: file.content,
      dirty: false,
      saving: false,
    };
    const next = new Map(this.files);
    next.set(path, editable);
    this.files = next;
    this.activePath = path;
  }

  updateActiveContent(content: string): void {
    const file = this.activeFile;
    if (!file) return;
    const next = new Map(this.files);
    next.set(this.activePath, { ...file, content, dirty: content !== file.savedContent });
    this.files = next;
  }

  async writeFileForce(path: string, content: string): Promise<void> {
    let existing = this.files.get(path);
    // 如果缓存中没有但文件可能存在于磁盘，先尝试读取以获取 sha256
    if (!existing) {
      try {
        const file = await this.#api.readFile(path);
        existing = { ...file, savedContent: file.content, dirty: false, saving: false };
      } catch {
        // 文件不存在，expectedSha256 传 null 让后端创建新文件
      }
    }
    if (!existing) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) {
        try {
          await this.#api.createFolder(parent);
        } catch (error) {
          if ((error as { code?: string })?.code !== 'ALREADY_EXISTS') throw error;
        }
      }
    }
    const written = await this.#api.writeFile({ path, content, expectedSha256: existing?.sha256 ?? null });
    const next = new Map(this.files);
    next.set(path, { ...written, savedContent: written.content, dirty: false, saving: false });
    this.files = next;
    this.activePath = path;
    await this.refreshTree();
  }

  async #persist(file: EditableScriptFile): Promise<EditableScriptFile> {
    const written = await this.#api.writeFile({
      path: file.path,
      content: file.content,
      expectedSha256: file.sha256,
    });
    return {
      ...written,
      savedContent: written.content,
      dirty: false,
      saving: false,
    };
  }

  async saveActive(): Promise<void> {
    const file = this.activeFile;
    if (!file || !file.dirty || file.saving) return;
    const next = new Map(this.files);
    next.set(this.activePath, { ...file, saving: true });
    this.files = next;
    try {
      const updated = await this.#persist(file);
      const after = new Map(this.files);
      after.set(this.activePath, updated);
      this.files = after;
    } catch (error) {
      const after = new Map(this.files);
      after.set(this.activePath, { ...file, saving: false });
      this.files = after;
      throw error;
    }
  }

  async flushDirty(): Promise<void> {
    for (const [path, file] of this.files) {
      if (!file.dirty) continue;
      const updated = await this.#persist(file);
      const next = new Map(this.files);
      next.set(path, updated);
      this.files = next;
    }
  }

  async createFile(path: string, content: string = DEFAULT_NEW_SCRIPT): Promise<void> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent) {
      try {
        await this.#api.createFolder(parent);
      } catch (error) {
        if ((error as { code?: string })?.code !== 'ALREADY_EXISTS') throw error;
      }
    }
    const created = await this.#api.writeFile({ path, content, expectedSha256: null });
    const editable: EditableScriptFile = {
      ...created,
      savedContent: created.content,
      dirty: false,
      saving: false,
    };
    const next = new Map(this.files);
    next.set(path, editable);
    this.files = next;
    this.activePath = path;
    await this.refreshTree();
  }

  async createFolder(path: string): Promise<void> {
    await this.#api.createFolder(path);
    await this.refreshTree();
  }

  async deleteFile(path: string): Promise<void> {
    const file = this.files.get(path);
    await this.#api.deleteFile(path, file?.sha256);
    const next = new Map(this.files);
    next.delete(path);
    this.files = next;
    if (this.activePath === path) this.activePath = '';
    await this.refreshTree();
  }

  async deleteFolder(path: string): Promise<void> {
    await this.#api.deleteFolder(path, true);
    const prefix = `${path}/`;
    const next = new Map(this.files);
    for (const filePath of next.keys()) {
      if (filePath.startsWith(prefix)) next.delete(filePath);
    }
    this.files = next;
    if (this.activePath.startsWith(prefix)) this.activePath = '';
    await this.refreshTree();
  }

  resetForProject(projectId: string, projectName: string): void {
    this.#treeRequestGeneration += 1;
    this.projectId = projectId;
    this.projectName = projectName;
    this.contextRevision += 1;
    this.files = new Map();
    this.activePath = '';
    this.warnings = [];
    this.tree = null;
  }
}

export const scriptWorkspace = createScriptWorkspace();

export type { ScriptApiError };
