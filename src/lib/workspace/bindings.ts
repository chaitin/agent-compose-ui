import { authFetch } from '../auth-fetch';

export interface ProjectStorageBinding {
  projectKey: string;
  sourcePath: string;
  workspacePath: string;
}

export interface BindingApi {
  bind(input: { projectKey?: string; workspacePath?: string; ensureWorkspace?: boolean }): Promise<ProjectStorageBinding>;
  resolve(sourcePath: string): Promise<ProjectStorageBinding>;
  migrate?(legacyKey: string, workspacePath: string): Promise<ProjectStorageBinding>;
}

export class ProjectStorageError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ProjectStorageError';
  }
}

async function post(path: string, body: unknown): Promise<ProjectStorageBinding> {
  const response = await authFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { code?: string; error?: string };
    throw new ProjectStorageError(response.status, data.code || 'storage_unavailable', data.error || `项目存储请求失败 (${response.status})`);
  }
  return await response.json() as ProjectStorageBinding;
}

export const projectStorageApi: BindingApi = {
  bind: (input) => post('/api/project-storage/bind', input),
  resolve: (sourcePath) => post('/api/project-storage/resolve', { sourcePath }),
  migrate: (legacyKey, workspacePath) => post('/api/project-storage/migrate', { legacyKey, workspacePath }),
};

export class BindingCoordinator {
  #pending = new Map<string, Promise<ProjectStorageBinding>>();
  constructor(private readonly api: BindingApi = projectStorageApi) {}

  ensure(identity: string, input: { projectKey?: string; sourcePath?: string; legacyKey?: string; ensureWorkspace?: boolean }): Promise<ProjectStorageBinding> {
    const existing = this.#pending.get(identity);
    if (existing) return existing;
    const request = input.projectKey
      ? this.api.bind({ projectKey: input.projectKey, workspacePath: input.ensureWorkspace ? 'workspace' : undefined, ensureWorkspace: input.ensureWorkspace })
      : input.legacyKey && this.api.migrate
          ? this.api.migrate(input.legacyKey, 'workspace')
        : input.sourcePath
          ? this.api.resolve(input.sourcePath)
        : this.api.bind({ workspacePath: input.ensureWorkspace ? 'workspace' : undefined, ensureWorkspace: input.ensureWorkspace });
    this.#pending.set(identity, request);
    void request.finally(() => {
      if (this.#pending.get(identity) === request) this.#pending.delete(identity);
    }).catch(() => {});
    return request;
  }
}

export const workspaceBindings = new BindingCoordinator();

const projectOverrides = new Map<string, ProjectStorageBinding>();
export function setProjectBindingOverride(projectId: string, binding: ProjectStorageBinding): void {
  projectOverrides.set(projectId, binding);
}
export function getProjectBindingOverride(projectId: string): ProjectStorageBinding | undefined {
  return projectOverrides.get(projectId);
}
export function clearProjectBindingOverride(projectId: string): void {
  projectOverrides.delete(projectId);
}

export function projectStorageErrorMessage(error: unknown): string {
  if (!(error instanceof ProjectStorageError)) return error instanceof Error ? error.message : String(error);
  const labels: Record<string, string> = {
    invalid_binding: '项目 Workspace 绑定无效',
    missing_binding: '项目 Workspace 尚未创建',
    unsafe_path: 'Workspace 路径不安全',
    storage_not_writable: 'Workspace 共享存储不可写',
    storage_unavailable: 'Workspace 共享存储不可用',
    legacy_source_unavailable: '旧 Workspace 目录不可用，请重新上传或联系管理员迁移',
  };
  return labels[error.code] ? `${labels[error.code]}：${error.message}` : error.message;
}

export function legacyKeyFromSourcePath(sourcePath: string): string {
  const match = /^\/agent-compose-ui\/projects\/([A-Za-z0-9_-]+)\/agent-compose\.ya?ml$/.exec(sourcePath.trim());
  return match?.[1] || '';
}
