import { dumpYamlObject, parseYamlObject } from './yaml';

export interface WorkspaceBinding {
  path: string;
  agentName: string | null;
  provider: string | null;
}

const DEFAULT_WORKSPACE_PATH = 'workspace';

function normalizeProvider(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function publishedProvider(value: string | null): string | null {
  return value === 'local' ? 'file' : value;
}

export function parseWorkspaceBinding(yamlText: string): WorkspaceBinding | null {
  let root: ReturnType<typeof parseYamlObject>;
  try {
    root = parseYamlObject(yamlText);
  } catch {
    return null;
  }

  const agents = root.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return null;

  for (const [agentName, def] of Object.entries(agents as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const workspace = (def as Record<string, unknown>).workspace;
    if (!workspace || typeof workspace !== 'object') continue;
    const ws = workspace as Record<string, unknown>;
    const provider = publishedProvider(normalizeProvider(ws.provider));
    const path = typeof ws.path === 'string' ? ws.path.trim() : '';

    return {
      path,
      agentName,
      provider: provider ?? 'file',
    };
  }

  return null;
}

export function migrateLegacyWorkspaceProviders(yamlText: string): string {
  const root = parseYamlObject(yamlText);
  let changed = false;
  const migrate = (workspace: unknown) => {
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return;
    const spec = workspace as Record<string, unknown>;
    if (normalizeProvider(spec.provider) === 'local') {
      spec.provider = 'file';
      changed = true;
    }
  };

  const workspaces = root.workspaces;
  if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    for (const workspace of Object.values(workspaces as Record<string, unknown>)) migrate(workspace);
  }
  const agents = root.agents;
  if (agents && typeof agents === 'object' && !Array.isArray(agents)) {
    for (const agent of Object.values(agents as Record<string, unknown>)) {
      if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
        migrate((agent as Record<string, unknown>).workspace);
      }
    }
  }
  return changed ? dumpYamlObject(root) : yamlText;
}

export function isWorkspaceBindingValid(binding: WorkspaceBinding | null): binding is WorkspaceBinding {
  return binding !== null && binding.path !== '' && binding.provider === 'file';
}

export function defaultWorkspacePath(): string {
  return DEFAULT_WORKSPACE_PATH;
}

// Inject a default workspace.path into the first agent's workspace block.
// - If no agent has a workspace block, creates one on the first agent.
// - If an existing block has provider other than file/local, throws unless `force: true`.
// - Existing local is normalized to the daemon's canonical file provider.
// Returns the new YAML text.
export function setWorkspacePathForFirstAgent(
  yamlText: string,
  options?: { force?: boolean },
): string {
  const root = parseYamlObject(yamlText);
  const agents = root.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    throw new Error('YAML 中没有 agents 配置');
  }
  const agentEntries = Object.entries(agents as Record<string, unknown>);
  if (agentEntries.length === 0) {
    throw new Error('YAML 中没有 agent，无法绑定 workspace');
  }
  const path = DEFAULT_WORKSPACE_PATH;
  for (const [, def] of agentEntries) {
    if (!def || typeof def !== 'object') continue;
    const defObj = def as Record<string, unknown>;
    const existing = defObj.workspace;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const existingWs = existing as Record<string, unknown>;
      const providerRaw = existingWs.provider;
      const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : '';
      if (provider && provider !== 'local' && provider !== 'file') {
        if (!options?.force) {
          throw new Error(`当前 workspace provider 是 ${provider}，无法自动改为 file（会覆盖已有配置）`);
        }
      }
      existingWs.provider = 'file';
      existingWs.path = path;
      return dumpYamlObject(root);
    }
    defObj.workspace = { provider: 'file', path };
    return dumpYamlObject(root);
  }
  throw new Error('无法定位 workspace 配置位置');
}

// Find the 1-indexed line number of the first agent's `workspace:` block.
export function findWorkspaceLine(yamlText: string): number | null {
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+workspace:\s*.*$/.test(lines[i])) {
      return i + 1;
    }
  }
  return null;
}

// Extract project name from the YAML's top-level `name` field.
export function projectNameFromYaml(yamlText: string): string {
  try {
    const root = parseYamlObject(yamlText);
    const name = root.name;
    if (typeof name === 'string') return name.trim();
  } catch {
    // fall through
  }
  return '';
}
