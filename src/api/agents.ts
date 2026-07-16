import { AgentSpec, AgentStatus, DriverSpec, EnvVarSpec, ProjectAgentAvailability, ProjectAgentHealth, RunSandboxCleanupPolicy, RunSource, RunStatus, WorkspaceSpec, type Project, type ProjectAgent } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { projectClient, runClient } from './client';
import { listWorkspacePresets, type WorkspacePreset } from './config';

export type AgentWorkFiles = { source: 'empty' | 'file' | 'git'; workspaceId: string; workspaceName: string; workspaceType: string; summary: string; configJson: string };
export type AgentEnvItem = { name: string; value: string; secret: boolean };
export type AgentRunSummary = { text: string; runningSessionCount: number; runningLoaderRunCount: number };
export type AgentLatestRun = { runType: string; status: string; runId: string; title: string; at: string };
export type AgentDefinition = { id:string;agentName:string;name:string;description:string;enabled:boolean;provider:string;model:string;systemPrompt:string;runtimeImageId:string;driver:string;guestImage:string;workspaceId:string;envItems:AgentEnvItem[];configJson:string;capsetIds:string[];availability:string;availabilityClass:'green'|'amber'|'red';health:string;healthClass:'green'|'amber'|'red';workFiles:AgentWorkFiles;currentRun:AgentRunSummary;latestRun:AgentLatestRun|null;createdAt:string;updatedAt:string;deletedAt:string;projectId?:string };
export type AgentDefinitionInput = {agentName:string;name:string;description:string;enabled:boolean;provider:string;model:string;systemPrompt:string;runtimeImageId:string;driver:string;guestImage:string;workspaceId:string;envItems:AgentEnvItem[];configJson:string;capsetIds:string[]};

export async function listAgentDefinitions(query = ''): Promise<AgentDefinition[]> {
  const [projects, presets] = await Promise.all([listProjects(), listWorkspacePresets()]);
  const result: AgentDefinition[] = [];
  for (const summary of projects) {
    const response = await projectClient.getProject({ project: { projectId: summary.projectId }, includeSpec: true });
    const project = response.project;
    if (!project) continue;
    for (const agent of project.agents) {
      const spec = project.spec?.agents.find((value) => value.name === agent.agentName);
      const mapped = agentFromV2(project, agent, spec, presets);
      if (!query || `${mapped.name} ${mapped.agentName} ${mapped.description}`.toLowerCase().includes(query.toLowerCase())) {
        result.push(mapped);
      }
    }
  }
  return result;
}

export async function createAgentDefinition(input: AgentDefinitionInput): Promise<AgentDefinition> {
  const normalized = requestFromInput(input);
  const [existing, presets] = await Promise.all([findUIProject(), listWorkspacePresets()]);
  const agentName = validateStableAgentName(normalized.agentName);
  if ((existing?.spec?.agents ?? []).some((value) => value.name === agentName)) {
    throw new Error(`调用标识 ${agentName} 已存在`);
  }
  const agents = [...(existing?.spec?.agents ?? []), specFromInput(normalized, agentName, existing, presets)];
  const response = await projectClient.applyProject({ spec: { ...(existing?.spec ?? {}), name: existing?.spec?.name || 'ui-agents', agents } });
  const agent = response.project?.agents.find((value) => value.agentName === agentName);
  if (!response.project || !agent) throw new Error('智能体保存失败');
  return agentFromV2(response.project, agent, response.project.spec?.agents.find((value) => value.name === agent.agentName), presets);
}

export async function updateAgentDefinition(id: string, input: AgentDefinitionInput): Promise<AgentDefinition> {
  const found = await findAgent(id);
  if (!found) throw new Error('智能体不存在');
  const normalized = requestFromInput(input);
  const presets = await listWorkspacePresets();
  const currentSpec = found.project.spec?.agents.find((value) => value.name === found.agent.agentName);
  const nextSpec = specFromInput(normalized, found.agent.agentName, found.project, presets, currentSpec);
  const agents = (found.project.spec?.agents ?? []).map((value) => value.name === found.agent.agentName ? nextSpec : value);
  const response = await projectClient.applyProject({ spec: { ...found.project.spec!, agents } });
  const agent = response.project?.agents.find((value) => value.agentName === found.agent.agentName);
  if (!response.project || !agent) throw new Error('智能体保存失败');
  return agentFromV2(response.project, agent, response.project.spec?.agents.find((value) => value.name === agent.agentName), presets);
}
export async function deleteAgentDefinition(id:string):Promise<void>{const found=await findAgent(id);if(!found)return;const agents=(found.project.spec?.agents??[]).filter((value)=>value.name!==found.agent.agentName);await projectClient.applyProject({spec:{...found.project.spec!,agents}})}
export async function runAgentDefinition(input:{agentId:string;driver:string;message:string}):Promise<{runId:string;sandboxId:string}>{const found=await findAgent(input.agentId);if(!found)throw new Error('智能体不存在');const response=await runClient.runAgent({projectId:found.project.summary?.projectId??'',agentName:found.agent.agentName,prompt:input.message,source:RunSource.MANUAL,driver:input.driver,cleanupPolicy:RunSandboxCleanupPolicy.KEEP_RUNNING});return{runId:response.run?.summary?.runId??'',sandboxId:response.run?.summary?.sandboxId??''}}

async function listProjects(){const result=[];let offset=0;for(;;){const response=await projectClient.listProjects({limit:200,offset});result.push(...response.projects);if(!response.hasMore)break;offset=response.nextOffset}return result}
async function findUIProject():Promise<Project|undefined>{for(const summary of await listProjects()){if(summary.name==='ui-agents'){return (await projectClient.getProject({project:{projectId:summary.projectId},includeSpec:true})).project}}return undefined}
async function findAgent(id:string):Promise<{project:Project;agent:ProjectAgent}|undefined>{const target=parseAgentFallbackId(id);for(const summary of await listProjects()){const project=(await projectClient.getProject({project:{projectId:summary.projectId},includeSpec:true})).project;if(!project)continue;if(target&&project.summary?.projectId!==target.projectId)continue;const agent=target?project.agents.find((value)=>value.agentName===target.agentName):project.agents.find((value)=>(Boolean(id)&&value.managedAgentId===id)||value.agentName===id);if(agent)return{project,agent}}return undefined}
function requestFromInput(input:AgentDefinitionInput):AgentDefinitionInput{return{...input,agentName:input.agentName.trim(),name:input.name.trim(),description:input.description.trim(),provider:normalizeAgentProvider(input.provider),model:input.model.trim(),systemPrompt:input.systemPrompt.trim(),driver:input.driver.trim(),guestImage:input.guestImage.trim(),workspaceId:input.workspaceId.trim(),envItems:input.envItems.map((v)=>({...v,name:v.name.trim()})).filter((v)=>v.name),capsetIds:input.capsetIds.map((v)=>v.trim()).filter(Boolean)}}
function specFromInput(input: AgentDefinitionInput, agentName: string, project: Project | undefined, presets: WorkspacePreset[], existingSpec?: AgentSpec): AgentSpec {
  return new AgentSpec({
    name: agentName,
    displayName: input.name,
    description: input.description,
    provider: input.provider,
    model: input.model,
    systemPrompt: input.systemPrompt,
    image: input.guestImage,
    driver: input.driver ? new DriverSpec({ name: input.driver }) : undefined,
    env: input.envItems.map((value) => new EnvVarSpec(value)),
    workspace: workspaceSpecFromInput(input, project, presets, existingSpec),
    capsetIds: input.capsetIds,
    status: input.enabled ? AgentStatus.ENABLED : AgentStatus.DISABLED,
  });
}

function workspaceSpecFromInput(input: AgentDefinitionInput, project: Project | undefined, presets: WorkspacePreset[], existingSpec?: AgentSpec): WorkspaceSpec | undefined {
  if (!input.workspaceId) return undefined;
  const preset = presets.find((value) => value.id === input.workspaceId);
  if (!preset) throw new Error('Workspace 配置不存在');
  if (project && existingSpec?.workspace) {
    const current = resolveAgentWorkspace(project, existingSpec, presets);
    if (current.preset?.id === preset.id) return new WorkspaceSpec(existingSpec.workspace);
  }
  const projectWorkspace = projectWorkspaceForPreset(project, preset);
  if (projectWorkspace) return new WorkspaceSpec({ name: projectWorkspace.name });
  return workspaceSpecFromPreset(preset);
}

function workspaceSpecFromPreset(preset: WorkspacePreset): WorkspaceSpec {
  const config = jsonObject(preset.configJson);
  if (preset.type === 'git') {
    const rawURL = stringValue(config.url) || stringValue(config.repo_url) || stringValue(config.repoUrl);
    return new WorkspaceSpec({
      name: preset.id,
      provider: 'git',
      url: applyGitCredentials(rawURL, config),
      branch: stringValue(config.branch),
      commit: stringValue(config.commit),
      path: stringValue(config.path) || '.',
    });
  }
  return new WorkspaceSpec({ name: preset.id, provider: 'local', path: stringValue(config.path) || preset.id });
}

function projectWorkspaceForPreset(project: Project | undefined, preset: WorkspacePreset) {
  const workspaces = project?.spec?.workspaces ?? [];
  const byID = workspaces.find((item) => item.name === preset.id);
  if (byID) return byID;
  const byDefinition = workspaces.filter((item) => workspaceMatchesPreset(item.workspace, preset));
  if (byDefinition.length === 1) return byDefinition[0];
  const byName = workspaces.filter((item) => item.name === preset.name.trim());
  return byName.length === 1 ? byName[0] : undefined;
}

type AgentWorkspaceResolution = {
  workspace?: WorkspaceSpec;
  referenceName: string;
  preset?: WorkspacePreset;
};

function resolveAgentWorkspace(project: Project, spec: AgentSpec | undefined, presets: WorkspacePreset[]): AgentWorkspaceResolution {
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
  return Boolean(workspace.name.trim()) && !workspace.provider.trim() && !workspace.url.trim() && !workspace.branch.trim() && !workspace.commit.trim() && !workspace.path.trim();
}

function findWorkspacePreset(referenceName: string, workspace: WorkspaceSpec, presets: WorkspacePreset[]): WorkspacePreset | undefined {
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
    return normalizedGitURL(candidate.url) === normalizedGitURL(workspace.url)
      && candidate.branch.trim() === workspace.branch.trim()
      && candidate.commit.trim() === workspace.commit.trim()
      && normalizedWorkspacePath(candidate.path) === normalizedWorkspacePath(workspace.path);
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
function jsonObject(value:string):Record<string,unknown>{try{const parsed=JSON.parse(value||'{}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{}}catch{return{}}}
function stringValue(value:unknown):string{return typeof value==='string'?value.trim():''}
function validateStableAgentName(value:string):string{const normalized=value.trim();if(!/^[a-z][a-z0-9_-]*$/.test(normalized))throw new Error('调用标识只能使用小写字母开头，并包含小写字母、数字、- 或 _');return normalized}
function normalizeAgentProvider(value:string):string{const provider=value.trim().toLowerCase();if(['claude','gemini','codex','opencode'].includes(provider))return provider;throw new Error(`不支持的智能体 Provider：${value||'-'}`)}
function agentFromV2(project: Project, item: ProjectAgent, spec?: AgentSpec, presets: WorkspacePreset[] = []): AgentDefinition {
  const enabled = spec ? spec.status !== AgentStatus.DISABLED : item.enabled;
  const resolvedWorkspace = resolveAgentWorkspace(project, spec, presets);
  const workspace = resolvedWorkspace.workspace;
  const workspaceId = resolvedWorkspace.preset?.id ?? resolvedWorkspace.referenceName;
  const projectId = project.summary?.projectId ?? '';
  const completeSpecProjection = Boolean(spec && item.managedAgentId.trim() && item.agentName.trim() && item.provider.trim());
  const canonicalSpecMisread = completeSpecProjection && item.availability === ProjectAgentAvailability.VALIDATION_FAILED;
  const availability = canonicalSpecMisread
    ? (enabled ? ProjectAgentAvailability.AVAILABLE : ProjectAgentAvailability.UNAVAILABLE)
    : (enabled ? item.availability : ProjectAgentAvailability.UNAVAILABLE);
  const health = canonicalSpecMisread && item.latestRun?.status !== RunStatus.FAILED ? ProjectAgentHealth.HEALTHY : item.health;
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
    availability: availability === ProjectAgentAvailability.AVAILABLE ? '可用' : availability === ProjectAgentAvailability.UNAVAILABLE ? '不可用' : availability === ProjectAgentAvailability.VALIDATION_FAILED ? '校验失败' : '未知',
    availabilityClass: availability === ProjectAgentAvailability.AVAILABLE ? 'green' : availability === ProjectAgentAvailability.UNAVAILABLE ? 'amber' : 'red',
    health: health === ProjectAgentHealth.HEALTHY ? '健康' : health === ProjectAgentHealth.AT_RISK ? '有风险' : '未知',
    healthClass: health === ProjectAgentHealth.HEALTHY ? 'green' : health === ProjectAgentHealth.AT_RISK ? 'amber' : 'red',
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
    latestRun: item.latestRun ? {
      runType: item.latestRun.source === RunSource.SCHEDULER ? 'scheduler' : 'manual',
      status: RunStatus[item.latestRun.status] ?? '',
      runId: item.latestRun.runId,
      title: '',
      at: timestampString(item.latestRun.at),
    } : null,
    createdAt: '',
    updatedAt: '',
    deletedAt: '',
    projectId,
  };
}
function agentIdFromV2(projectId:string,item:ProjectAgent):string{return item.managedAgentId.trim()||`project:${encodeURIComponent(projectId)}:agent:${encodeURIComponent(item.agentName)}`}
function parseAgentFallbackId(id:string):{projectId:string;agentName:string}|undefined{const match=/^project:([^:]+):agent:(.+)$/.exec(id);return match?{projectId:decodeURIComponent(match[1]),agentName:decodeURIComponent(match[2])}:undefined}
function timestampString(value?:{seconds:bigint;nanos:number}){return value?new Date(Number(value.seconds)*1000+value.nanos/1e6).toISOString():''}
