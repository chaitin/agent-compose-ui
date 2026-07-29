import {
  AgentSpec,
  ProjectAgentAvailability,
  ProjectAgentHealth,
  RunSource,
  RunStatus,
  WorkspaceSpec,
  type Project,
  type ProjectAgent,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { timestampToISOString as timestampString } from '../model/timestamps';
import { projectClient } from './client';
import { listWorkspacePresets, type WorkspacePreset } from './config';
import { nextPageOffset, projectById } from './project-ref';

export type AgentWorkFiles = {
  source: 'empty' | 'file' | 'git';
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  summary: string;
  configJson: string;
};
export type AgentEnvItem = { name: string; value: string; secret: boolean };
export type AgentRunSummary = { text: string; runningSessionCount: number; runningLoaderRunCount: number };
export type AgentLatestRun = { runType: string; status: string; runId: string; title: string; at: string };
export type AgentDefinition = {
  id: string;
  agentName: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: string;
  model: string;
  systemPrompt: string;
  runtimeImageId: string;
  driver: string;
  guestImage: string;
  workspaceId: string;
  envItems: AgentEnvItem[];
  configJson: string;
  capsetIds: string[];
  availability: string;
  availabilityClass: 'green' | 'amber' | 'red';
  health: string;
  healthClass: 'green' | 'amber' | 'red';
  workFiles: AgentWorkFiles;
  currentRun: AgentRunSummary;
  latestRun: AgentLatestRun | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string;
  projectId?: string;
  projectName: string;
};
export async function listAgentDefinitions(query = ''): Promise<AgentDefinition[]> {
  const [projects, presets] = await Promise.all([listProjects(), listWorkspacePresets()]);
  const result: AgentDefinition[] = [];
  for (const summary of projects) {
    const response = await projectClient.getProject({ project: projectById(summary.projectId), includeSpec: true });
    const project = response.project;
    if (!project) continue;
    for (const agent of project.agents) {
      const spec = project.spec?.agents.find((value) => value.name === agent.agentName);
      const mapped = agentFromV2(project, agent, spec, presets);
      if (
        !query ||
        `${mapped.name} ${mapped.agentName} ${mapped.description}`.toLowerCase().includes(query.toLowerCase())
      ) {
        result.push(mapped);
      }
    }
  }
  return result;
}

async function listProjects() {
  const result = [];
  let offset = 0;
  for (;;) {
    const response = await projectClient.listProjects({ limit: 200, offset });
    result.push(...response.projects);
    const next = nextPageOffset(offset, response.projects.length, response.total);
    if (next === undefined) break;
    offset = next;
  }
  return result;
}

function workspaceSpecFromPreset(preset: WorkspacePreset): WorkspaceSpec {
  const config = jsonObject(preset.configJson);
  if (preset.type === 'git') {
    const rawURL = stringValue(config.url) || stringValue(config.repo_url) || stringValue(config.repoUrl);
    return new WorkspaceSpec({
      name: preset.id,
      provider: 'git',
      url: applyGitCredentials(rawURL, config),
      ref: stringValue(config.commit) || stringValue(config.branch),
      path: stringValue(config.path) || '.',
    });
  }
  return new WorkspaceSpec({ name: preset.id, provider: 'local', path: stringValue(config.path) || preset.id });
}

type AgentWorkspaceResolution = {
  workspace?: WorkspaceSpec;
  referenceName: string;
  preset?: WorkspacePreset;
};

function resolveAgentWorkspace(
  project: Project,
  spec: AgentSpec | undefined,
  presets: WorkspacePreset[],
): AgentWorkspaceResolution {
  const declared = spec?.workspace;
  if (!declared) return { referenceName: '' };
  const referenceName = declared.name.trim();
  const named = isNamedWorkspaceReference(declared)
    ? project.spec?.workspaces.find((item) => item.name === referenceName)
    : undefined;
  const workspace = named?.workspace ?? declared;
  return {
    workspace,
    referenceName,
    preset: findWorkspacePreset(referenceName, workspace, presets),
  };
}

function isNamedWorkspaceReference(workspace: WorkspaceSpec): boolean {
  return (
    Boolean(workspace.name.trim()) &&
    !workspace.provider.trim() &&
    !workspace.url.trim() &&
    !workspace.ref.trim() &&
    !workspace.path.trim()
  );
}

function findWorkspacePreset(
  referenceName: string,
  workspace: WorkspaceSpec,
  presets: WorkspacePreset[],
): WorkspacePreset | undefined {
  const workspaceType = workspaceTypeFromProvider(workspace.provider);
  const candidates = workspaceType ? presets.filter((preset) => preset.type === workspaceType) : presets;
  const byID = candidates.find((preset) => preset.id === referenceName);
  if (byID) return byID;
  const byDefinition = candidates.filter((preset) => workspaceMatchesPreset(workspace, preset));
  if (byDefinition.length === 1) return byDefinition[0];
  const byName = candidates.filter((preset) => preset.name.trim() === referenceName);
  return byName.length === 1 ? byName[0] : undefined;
}

function workspaceMatchesPreset(workspace: WorkspaceSpec | undefined, preset: WorkspacePreset): boolean {
  if (!workspace || workspaceTypeFromProvider(workspace.provider) !== preset.type) return false;
  if (preset.type === 'git') {
    const candidate = workspaceSpecFromPreset(preset);
    return (
      normalizedGitURL(candidate.url) === normalizedGitURL(workspace.url) &&
      candidate.ref.trim() === workspace.ref.trim() &&
      normalizedWorkspacePath(candidate.path) === normalizedWorkspacePath(workspace.path)
    );
  }
  const segments = workspace.path.split(/[\\/]+/).filter(Boolean);
  return workspace.path.trim() === preset.id || segments.includes(preset.id);
}

function workspaceTypeFromProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'git') return 'git';
  if (normalized === 'local') return 'file';
  return '';
}

function normalizedWorkspacePath(path: string): string {
  return path.trim() || '.';
}

function normalizedGitURL(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return trimmed.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
  }
}

function applyGitCredentials(rawURL: string, config: Record<string, unknown>): string {
  const trimmedURL = rawURL.trim();
  if (!trimmedURL) return '';
  let credential = stringValue(config.credential);
  if (!credential) {
    const username = stringValue(config.username);
    const password = stringValue(config.password);
    if (username || password) credential = `${queryEscape(username)}:${queryEscape(password)}`;
  }
  if (!credential || trimmedURL.includes('@')) return trimmedURL;
  for (const prefix of ['https://', 'http://']) {
    if (trimmedURL.startsWith(prefix)) return `${prefix}${credential}@${trimmedURL.slice(prefix.length)}`;
  }
  return trimmedURL;
}

function queryEscape(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}
function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function agentFromV2(
  project: Project,
  item: ProjectAgent,
  spec?: AgentSpec,
  presets: WorkspacePreset[] = [],
): AgentDefinition {
  const enabled = spec?.enabled ?? item.enabled;
  const resolvedWorkspace = resolveAgentWorkspace(project, spec, presets);
  const workspace = resolvedWorkspace.workspace;
  const workspaceId = resolvedWorkspace.preset?.id ?? resolvedWorkspace.referenceName;
  const projectId = project.summary?.projectId ?? '';
  const completeSpecProjection = Boolean(
    spec && item.managedAgentId.trim() && item.agentName.trim() && item.provider.trim(),
  );
  const canonicalSpecMisread =
    completeSpecProjection && item.availability === ProjectAgentAvailability.VALIDATION_FAILED;
  const availability = canonicalSpecMisread
    ? enabled
      ? ProjectAgentAvailability.AVAILABLE
      : ProjectAgentAvailability.UNAVAILABLE
    : enabled
      ? item.availability
      : ProjectAgentAvailability.UNAVAILABLE;
  const health =
    canonicalSpecMisread && item.latestRun?.status !== RunStatus.FAILED ? ProjectAgentHealth.HEALTHY : item.health;
  const displayName = item.displayName.trim() || spec?.displayName.trim() || item.agentName;
  const description = item.description.trim() || spec?.description.trim() || '';
  const workspaceSource = workspace?.provider.trim().toLowerCase() === 'git' ? 'git' : workspace ? 'file' : 'empty';
  return {
    id: agentIdFromV2(projectId, item),
    agentName: item.agentName,
    name: displayName,
    description,
    enabled,
    provider: item.provider || 'codex',
    model: item.model,
    systemPrompt: spec?.systemPrompt ?? '',
    runtimeImageId: '',
    driver: item.driver,
    guestImage: item.image,
    workspaceId,
    envItems: (spec?.env ?? []).map((value) => ({ name: value.name, value: value.value, secret: value.secret })),
    configJson: '{}',
    capsetIds: spec?.capsetIds ?? [],
    availability:
      availability === ProjectAgentAvailability.AVAILABLE
        ? '可用'
        : availability === ProjectAgentAvailability.UNAVAILABLE
          ? '不可用'
          : availability === ProjectAgentAvailability.VALIDATION_FAILED
            ? '校验失败'
            : '未知',
    availabilityClass:
      availability === ProjectAgentAvailability.AVAILABLE
        ? 'green'
        : availability === ProjectAgentAvailability.UNAVAILABLE
          ? 'amber'
          : 'red',
    health: health === ProjectAgentHealth.HEALTHY ? '健康' : health === ProjectAgentHealth.AT_RISK ? '有风险' : '未知',
    healthClass:
      health === ProjectAgentHealth.HEALTHY ? 'green' : health === ProjectAgentHealth.AT_RISK ? 'amber' : 'red',
    workFiles: {
      source: workspaceSource,
      workspaceId,
      workspaceName: resolvedWorkspace.referenceName,
      workspaceType: workspace?.provider ?? '',
      summary: workspace?.path ?? '',
      configJson: '',
    },
    currentRun: {
      text: item.currentRun?.text ?? '暂无运行',
      runningSessionCount: item.currentRun?.runningRunCount ?? 0,
      runningLoaderRunCount: item.currentRun?.runningSchedulerRunCount ?? 0,
    },
    latestRun: item.latestRun
      ? {
          runType: item.latestRun.source === RunSource.SCHEDULER ? 'scheduler' : 'manual',
          status: RunStatus[item.latestRun.status] ?? '',
          runId: item.latestRun.runId,
          title: '',
          at: timestampString(item.latestRun.at),
        }
      : null,
    createdAt: '',
    updatedAt: '',
    deletedAt: '',
    projectId,
    projectName: project.summary?.name ?? '',
  };
}
function agentIdFromV2(projectId: string, item: ProjectAgent): string {
  return (
    item.managedAgentId.trim() || `project:${encodeURIComponent(projectId)}:agent:${encodeURIComponent(item.agentName)}`
  );
}
