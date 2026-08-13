import {
  CacheStatus,
  AgentSpec,
  MCPServerSpec,
  ProjectSpec,
  ResourceKind,
  SkillSpec,
  type CacheItem,
  type Image,
  type Project,
  type ResourceTarget,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { cacheClient, imageClient, projectClient, resourceClient } from './client';
import { patchProjectSpecUpdate, projectSpecForUpdate } from './project-spec';
import { nextPageOffset, projectById } from './project-ref';

export type ImagePage = {
  images: Image[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number;
  available: boolean;
  endpoint: string;
  error: string;
};

export async function listImages(query = '', offset = 0, limit = 100): Promise<ImagePage> {
  const response = await imageClient.listImages({ query, offset, limit, all: true, includeCacheStatus: true });
  return {
    images: response.images,
    totalCount: response.total,
    hasMore: offset + response.images.length < response.total,
    nextOffset: offset + response.images.length,
    available: response.storeStatus?.available ?? false,
    endpoint: response.storeStatus?.endpoint ?? '',
    error: response.storeStatus?.error ?? '',
  };
}

export async function pullImage(imageRef: string): Promise<string[]> {
  const response = await imageClient.pullImage({ imageRef });
  return [
    ...response.progress.map((item) => [item.id, item.status, item.progress].filter(Boolean).join(' · ')),
    ...response.warnings,
  ].filter(Boolean);
}

export async function inspectImage(imageRef: string): Promise<Image | undefined> {
  return (await imageClient.inspectImage({ imageRef, includeCacheStatus: true })).image;
}

export async function removeImage(imageRef: string, force = false): Promise<string[]> {
  const response = await imageClient.removeImage({ imageRef, force, pruneChildren: false });
  return [...response.untaggedRefs, ...response.deletedIds, ...response.warnings];
}

export async function listCaches(): Promise<{ items: CacheItem[]; warnings: string[] }> {
  const response = await cacheClient.listCaches({});
  return { items: response.caches, warnings: response.warnings };
}

export async function removeCache(cacheId: string, force = false) {
  return cacheClient.removeCache({ cacheId, force });
}

export async function pruneUnusedCaches(force = false) {
  return cacheClient.pruneCaches({ filter: { status: CacheStatus.UNUSED }, force });
}

export async function resolveResource(id: string): Promise<{ targets: ResourceTarget[]; warnings: string[] }> {
  const response = await resourceClient.resolveID({ id });
  return { targets: response.targets, warnings: response.warnings };
}

export function routeForTarget(target: ResourceTarget): string | null {
  if (target.kind === ResourceKind.AGENT)
    return target.projectId && target.agentName
      ? `/projects/${encodeURIComponent(target.projectId)}/agents/${encodeURIComponent(target.agentName)}`
      : `/agents/${encodeURIComponent(target.id)}`;
  if (target.kind === ResourceKind.RUN) return `/runs/${encodeURIComponent(target.id)}`;
  if (target.kind === ResourceKind.SANDBOX) return `/sandboxes/${encodeURIComponent(target.id)}`;
  if (target.kind === ResourceKind.IMAGE) return `/images?q=${encodeURIComponent(target.id)}`;
  if (target.kind === ResourceKind.CACHE) return `/settings/caches?q=${encodeURIComponent(target.id)}`;
  return null;
}

export type SpecResource = {
  key: string;
  name: string;
  scope: string;
  projectId: string;
  projectName: string;
  agentName: string;
  details: string;
};

export type SpecResourceTarget = {
  key: string;
  projectId: string;
  projectName: string;
  agentName: string;
  label: string;
};

export async function listSpecResources(kind: 'mcp' | 'skills'): Promise<SpecResource[]> {
  const projects: Project[] = [];
  let offset = 0;
  for (;;) {
    const page = await projectClient.listProjects({ limit: 200, offset });
    for (const summary of page.projects) {
      const project = (await projectClient.getProject({ project: projectById(summary.projectId), includeSpec: true }))
        .project;
      if (project) projects.push(project);
    }
    const next = nextPageOffset(offset, page.projects.length, page.total);
    if (next === undefined) break;
    offset = next;
  }
  const result: SpecResource[] = [];
  for (const project of projects) {
    const projectId = project.summary?.projectId ?? '';
    const projectName = project.summary?.name ?? project.spec?.name ?? projectId;
    if (kind === 'mcp') {
      for (const item of project.spec?.mcpServers ?? [])
        result.push(specResource(item.name, '项目', projectId, projectName, '', item.toJsonString()));
      for (const agent of project.spec?.agents ?? [])
        for (const item of agent.mcpServers)
          result.push(specResource(item.name, '智能体', projectId, projectName, agent.name, item.toJsonString()));
    } else {
      for (const agent of project.spec?.agents ?? [])
        for (const item of agent.skills)
          result.push(specResource(item.name, '智能体', projectId, projectName, agent.name, item.toJsonString()));
    }
  }
  return result;
}

export async function listSpecResourceTargets(kind: 'mcp' | 'skills'): Promise<SpecResourceTarget[]> {
  const targets: SpecResourceTarget[] = [];
  for (const project of await listProjectsWithSpecs()) {
    const projectId = project.summary?.projectId ?? '';
    const projectName = project.summary?.name ?? project.spec?.name ?? projectId;
    if (kind === 'mcp') {
      targets.push({
        key: resourceTargetKey(projectId, ''),
        projectId,
        projectName,
        agentName: '',
        label: `${projectName} / 项目级`,
      });
    }
    for (const agent of project.spec?.agents ?? []) {
      targets.push({
        key: resourceTargetKey(projectId, agent.name),
        projectId,
        projectName,
        agentName: agent.name,
        label: `${projectName} / ${agent.displayName || agent.name}`,
      });
    }
  }
  return targets;
}

export async function saveSpecResource(
  kind: 'mcp' | 'skills',
  target: SpecResourceTarget,
  originalName: string,
  rawJSON: string,
): Promise<void> {
  const project = await getProjectWithSpec(target.projectId);
  const spec = projectSpecForUpdate(project.spec);
  if (kind === 'mcp') {
    const item = MCPServerSpec.fromJsonString(rawJSON);
    requireResourceName(item.name);
    if (target.agentName) {
      const agents = replaceAgentResource(
        spec.agents,
        target.agentName,
        (agent) => new AgentSpec({ ...agent, mcpServers: replaceNamedResource(agent.mcpServers, originalName, item) }),
      );
      await patchProjectSpecUpdate(project, new ProjectSpec({ ...spec, agents }));
    } else {
      await patchProjectSpecUpdate(
        project,
        new ProjectSpec({ ...spec, mcpServers: replaceNamedResource(spec.mcpServers, originalName, item) }),
      );
    }
    return;
  }

  if (!target.agentName) throw new Error('Skill 必须配置到具体智能体');
  const item = SkillSpec.fromJsonString(rawJSON);
  requireResourceName(item.name);
  const agents = replaceAgentResource(
    spec.agents,
    target.agentName,
    (agent) => new AgentSpec({ ...agent, skills: replaceNamedResource(agent.skills, originalName, item) }),
  );
  await patchProjectSpecUpdate(project, new ProjectSpec({ ...spec, agents }));
}

export async function removeSpecResource(kind: 'mcp' | 'skills', item: SpecResource): Promise<void> {
  const project = await getProjectWithSpec(item.projectId);
  const spec = projectSpecForUpdate(project.spec);
  if (kind === 'mcp' && !item.agentName) {
    await patchProjectSpecUpdate(
      project,
      new ProjectSpec({ ...spec, mcpServers: spec.mcpServers.filter((value) => value.name !== item.name) }),
    );
    return;
  }
  const agents = replaceAgentResource(spec.agents, item.agentName, (agent) =>
    kind === 'mcp'
      ? new AgentSpec({ ...agent, mcpServers: agent.mcpServers.filter((value) => value.name !== item.name) })
      : new AgentSpec({ ...agent, skills: agent.skills.filter((value) => value.name !== item.name) }),
  );
  await patchProjectSpecUpdate(project, new ProjectSpec({ ...spec, agents }));
}

function replaceAgentResource(agents: AgentSpec[], name: string, update: (agent: AgentSpec) => AgentSpec): AgentSpec[] {
  let found = false;
  const result = agents.map((agent) => {
    if (agent.name !== name) return agent;
    found = true;
    return update(agent);
  });
  if (!found) throw new Error(`智能体 ${name} 不存在`);
  return result;
}

function replaceNamedResource<T extends { name: string }>(items: T[], originalName: string, next: T): T[] {
  const filtered = items.filter((item) => item.name !== originalName && item.name !== next.name);
  return [...filtered, next];
}

function requireResourceName(name: string): void {
  if (!name.trim()) throw new Error('资源 JSON 中的 name 必填');
}

function resourceTargetKey(projectId: string, agentName: string): string {
  return `${projectId}:${agentName}`;
}

async function listProjectsWithSpecs(): Promise<Project[]> {
  const projects: Project[] = [];
  let offset = 0;
  for (;;) {
    const page = await projectClient.listProjects({ limit: 200, offset });
    for (const summary of page.projects) projects.push(await getProjectWithSpec(summary.projectId));
    const next = nextPageOffset(offset, page.projects.length, page.total);
    if (next === undefined) return projects;
    offset = next;
  }
}

async function getProjectWithSpec(projectId: string): Promise<Project> {
  const project = (await projectClient.getProject({ project: projectById(projectId), includeSpec: true })).project;
  if (!project) throw new Error(`项目 ${projectId} 不存在`);
  return project;
}

function specResource(
  name: string,
  scope: string,
  projectId: string,
  projectName: string,
  agentName: string,
  details: string,
): SpecResource {
  return { key: `${projectId}:${agentName}:${name}`, name, scope, projectId, projectName, agentName, details };
}
