import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { posix } from 'node:path';
import { VolumeService } from '../../src/gen/agentcompose/v2/agentcompose_connect';
import {
  ApplyProjectRequest,
  GetProjectRequest,
  InspectVolumeRequest,
  NamedWorkspaceSpec,
  ProjectRef,
  ProjectSource,
  type ProjectSpec,
  ProjectVolumeSpec,
  RemoveVolumeRequest,
  RunAgentRequest,
  RunSandboxCleanupPolicy,
  RunSource,
  RunStatus,
  SkillSpec,
  VolumeMountSpec,
  WorkspaceSpec,
} from '../../src/gen/agentcompose/v2/agentcompose_pb';
import { managedVolumeName } from '../../src/lib/project-resources/volume-names';
import type { RealDataContext } from './api';
import { exact, predicate } from './api';

type JsonResult = { response: Response; body: any };

async function jsonRequest(base: string, path: string, init: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return { response, body };
}

async function projectKey(batchId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(batchId));
  return `ws_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
}

function query(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

export function resourceWorkspaceSnapshot(spec: ProjectSpec, projectDir = ''): string {
  return JSON.stringify({
    project: spec.workspaces.map(item => ({ ...item.toJson({ emitDefaultValues: true }), resolvedPath: projectDir && item.workspace?.path ? posix.resolve(projectDir, item.workspace.path) : '' })),
    agents: spec.agents.map(agent => ({
      name: agent.name,
      workspace: agent.workspace?.toJson({ emitDefaultValues: true }) ?? null,
    })),
  });
}

export function resourceMountProbeCommand(marker: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(marker)) throw new Error('unsafe resource probe marker');
  const probe = `/shared/read-only/.agent-compose-e2e-${marker}`;
  return `sh -c "probe='${probe}'; trap 'rm -f \"\$probe\" 2>/dev/null || true' EXIT; test -r /shared/read-only && test ! -e \"\$probe\"; if touch \"\$probe\"; then rm -f \"\$probe\"; exit 42; fi; printf '${marker}' > /data/e2e/agent.txt; printf '${marker}-npm' > /root/.npm/e2e-marker"`;
}

type CleanupVolumeClient = {
  removeVolume(request: RemoveVolumeRequest): Promise<{ removed: boolean }>;
  inspectVolume(request: InspectVolumeRequest): Promise<unknown>;
};

export async function cleanupProjectResources(input: {
  gateway: string;
  projectKey: string;
  skills: Set<string>;
  volumes: Set<string>;
  volumeClient: CleanupVolumeClient;
  fetcher?: typeof fetch;
}): Promise<string[]> {
  const errors: string[] = [];
  const fetcher = input.fetcher ?? fetch;
  for (const path of input.skills) {
    try {
      const response = await fetcher(`${input.gateway}/api/project-files/folder?${query({ projectKey: input.projectKey, path, recursive: 'true' })}`, { method: 'DELETE' });
      if (response.ok || response.status === 404) input.skills.delete(path);
      else errors.push(`skill ${path}: HTTP ${response.status}`);
    } catch (error) { errors.push(`skill ${path}: ${String(error)}`); }
  }
  for (const name of input.volumes) {
    try {
      const response = await input.volumeClient.removeVolume(new RemoveVolumeRequest({ name, force: true }));
      if (response.removed) input.volumes.delete(name);
      else {
        try {
          await input.volumeClient.inspectVolume(new InspectVolumeRequest({ name }));
          errors.push(`volume ${name}: still exists after cleanup`);
        } catch (error) {
          if (/not[_ ]found|not exist/i.test(String(error))) input.volumes.delete(name);
          else errors.push(`volume ${name}: cleanup state unknown: ${String(error)}`);
        }
      }
    } catch (error) {
      if (/not[_ ]found|not exist/i.test(String(error))) input.volumes.delete(name);
      else errors.push(`volume ${name}: ${String(error)}`);
    }
  }
  return errors;
}

/** Runs the destructive project-resource scenario only against resources owned by this E2E batch. */
export async function runProjectResourceCases(context: RealDataContext): Promise<void> {
  const { recorder, fixture, clients } = context;
  const gateway = context.frontendUrl;
  const key = await projectKey(fixture.batchId);
  const skillName = `resource-${fixture.batchId.slice(-12).toLowerCase()}`.replace(/[^a-z0-9-]/g, '-');
  const dataVolume = await managedVolumeName(key, 'e2e-data');
  const npmVolume = await managedVolumeName(key, 'npm-cache');
  const marker = `${fixture.batchId}-volume-data`;
  const source = new ProjectSource({
    composePath: `/data/work/projects/${key}/agent-compose.yml`,
    projectDir: `/data/work/projects/${key}`,
  });
  const volumeClient = createClient(VolumeService, createConnectTransport({ baseUrl: context.daemonUrl }));
  const skillPath = `skills/${skillName}`;
  const pendingSkills = new Set([skillPath]);
  const pendingVolumes = new Set([dataVolume, npmVolume]);

  try {
    const before = await clients.project.getProject(new GetProjectRequest({
      project: new ProjectRef({ projectId: context.projectId }), includeSpec: true,
    }));
    const spec = before.project?.spec;
    if (!spec) throw new Error('project resource E2E requires the applied fixture project spec');
    spec.name = `${fixture.projectName}-resources`;
    spec.workspaces = [new NamedWorkspaceSpec({ name: 'resource-workspace', workspace: new WorkspaceSpec({ provider: 'local', path: 'workspace' }) })];
    const resourceAgent = spec.agents.find(item => item.name === 'deterministic-agent');
    if (!resourceAgent) throw new Error('deterministic fixture agent is missing');
    resourceAgent.workspace = new WorkspaceSpec({ name: 'resource-workspace' });
    let resourceProjectId = '';
    let workspaceSnapshot = '';

  await recorder.run('create-skill', '项目资源', { projectKey: key, skillName }, { created: true, persisted: true }, async () => {
    const created = await jsonRequest(gateway, '/api/project-files/skills/create', {
      method: 'POST', body: JSON.stringify({ projectKey: key, name: skillName }),
    });
    const content = `---\nname: ${skillName}\ndescription: ${fixture.batchId}\n---\n\n# ${skillName}\n`;
    const written = await jsonRequest(gateway, '/api/project-files/file', {
      method: 'PUT',
      body: JSON.stringify({ projectKey: key, path: `skills/${skillName}/SKILL.md`, content, expectedSHA256: created.body.file.sha256 }),
    });
    const read = await jsonRequest(gateway, `/api/project-files/file?${query({ projectKey: key, path: `skills/${skillName}/SKILL.md` })}`);
    return { actual: { created: created.response.status === 201, persisted: read.body.file.content === content, sha256: written.body.file.sha256 }, assertions: [exact('created', true, created.response.status === 201), exact('persisted', true, read.body.file.content === content)] };
  });

  await recorder.run('workspace-baseline', '项目资源', { projectDir: source.projectDir }, { applied: true, resolvedPath: `${source.projectDir}/workspace` }, async () => {
    const applied = await clients.project.applyProject(new ApplyProjectRequest({ spec, source }));
    resourceProjectId = applied.project?.summary?.projectId ?? '';
    if (resourceProjectId) context.ledger.projects.add(resourceProjectId);
    const baseline = resourceProjectId ? await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: resourceProjectId }), includeSpec: true })) : undefined;
    workspaceSnapshot = baseline?.project?.spec ? resourceWorkspaceSnapshot(baseline.project.spec, source.projectDir) : '';
    return { actual: { applied: applied.applied, projectId: resourceProjectId, workspaceSnapshot }, assertions: [exact('applied', true, applied.applied && Boolean(resourceProjectId)), predicate('resolvedPath', `${source.projectDir}/workspace`, workspaceSnapshot, workspaceSnapshot.includes(`${source.projectDir}/workspace`))] };
  });

  let sharePath = '';
  await recorder.run('configure-apply', '项目资源', { npmCache: true, readOnlyShare: true }, { applied: true, shareReadOnly: true, workspaceUnchanged: true }, async () => {
    const catalog = await jsonRequest(gateway, '/api/shared-directories');
    sharePath = catalog.body.entries?.[0]?.path ?? '';
    if (!sharePath) throw new Error('project resource E2E requires at least one approved shared directory');
    spec.volumes = [
      ...spec.volumes.filter(item => ![dataVolume, npmVolume].includes(item.name)),
      new ProjectVolumeSpec({ key: 'e2e-data', name: dataVolume, driver: 'local', labels: { 'agent-compose-ui.managed': 'true', 'agent-compose-ui.project-key': key, 'agent-compose-ui.logical-name': 'e2e-data' } }),
      new ProjectVolumeSpec({ key: 'npm-cache', name: npmVolume, driver: 'local', labels: { 'agent-compose-ui.managed': 'true', 'agent-compose-ui.project-key': key, 'agent-compose-ui.cache-preset': 'npm' } }),
    ];
    const agent = spec.agents.find(item => item.name === 'deterministic-agent');
    if (!agent) throw new Error('deterministic fixture agent is missing');
    agent.skills = [...agent.skills.filter(item => item.name !== skillName), new SkillSpec({ name: skillName, source: 'file', path: `./skills/${skillName}` })];
    agent.volumes = [
      ...agent.volumes.filter(item => !['/data/e2e', '/root/.npm', '/shared/read-only'].includes(item.target)),
      new VolumeMountSpec({ type: 'volume', source: 'e2e-data', target: '/data/e2e', readOnly: false }),
      new VolumeMountSpec({ type: 'volume', source: 'npm-cache', target: '/root/.npm', readOnly: false }),
      new VolumeMountSpec({ type: 'bind', source: sharePath, target: '/shared/read-only', readOnly: true }),
    ];
    const applied = await clients.project.applyProject(new ApplyProjectRequest({ spec, source }));
    const appliedProjectId = applied.project?.summary?.projectId ?? '';
    if (appliedProjectId) {
      context.ledger.projects.add(appliedProjectId);
    }
    const currentWorkspace = resourceWorkspaceSnapshot(spec, source.projectDir);
    return {
      actual: { applied: applied.applied, shareReadOnly: agent.volumes.at(-1)?.readOnly, workspaceSnapshot: currentWorkspace },
      assertions: [
        exact('applied', true, applied.applied && Boolean(appliedProjectId)),
        exact('projectStable', resourceProjectId, appliedProjectId),
        exact('shareReadOnly', true, agent.volumes.at(-1)?.readOnly),
        exact('workspaceUnchanged', workspaceSnapshot, currentWorkspace),
      ],
    };
  });

  await recorder.run('agent-write-gateway-read', '项目资源', { volume: dataVolume }, { status: 'SUCCEEDED', content: marker }, async () => {
    const command = resourceMountProbeCommand(marker);
    const result = await clients.run.runAgent(new RunAgentRequest({ projectId: resourceProjectId, agentName: 'deterministic-agent', command, source: RunSource.API, cleanupPolicy: RunSandboxCleanupPolicy.REMOVE_ON_COMPLETION, clientRequestId: `${fixture.batchId}-resources-write` }));
    const [preview, npmPreview] = await Promise.all([
      jsonRequest(gateway, `/api/volume-files/preview?${query({ projectKey: key, volume: dataVolume, path: 'agent.txt' })}`),
      jsonRequest(gateway, `/api/volume-files/preview?${query({ projectKey: key, volume: npmVolume, path: 'e2e-marker' })}`),
    ]);
    const status = RunStatus[result.run?.summary?.status ?? RunStatus.UNSPECIFIED];
    return { actual: { status, content: preview.body.content, npmContent: npmPreview.body.content }, assertions: [exact('status', 'SUCCEEDED', status), exact('content', marker, preview.body.content), exact('npmPersisted', `${marker}-npm`, npmPreview.body.content)] };
  });

  await recorder.run('gateway-write-agent-read', '项目资源', { volume: dataVolume }, { status: 'SUCCEEDED', containsMarker: true }, async () => {
    await jsonRequest(gateway, '/api/volume-files/file', { method: 'PUT', body: JSON.stringify({ projectKey: key, volume: dataVolume, path: 'gateway.txt', content: marker, expectedSHA256: '' }) });
    const command = `sh -c "test \"$(cat /data/e2e/gateway.txt)\" = '${marker}' && test \"$(cat /root/.npm/e2e-marker)\" = '${marker}-npm' && printf '${marker}'"`;
    const result = await clients.run.runAgent(new RunAgentRequest({ projectId: resourceProjectId, agentName: 'deterministic-agent', command, source: RunSource.API, cleanupPolicy: RunSandboxCleanupPolicy.REMOVE_ON_COMPLETION, clientRequestId: `${fixture.batchId}-resources-read` }));
    const status = RunStatus[result.run?.summary?.status ?? RunStatus.UNSPECIFIED];
    return { actual: { status, output: result.run?.output }, assertions: [exact('status', 'SUCCEEDED', status), predicate('containsMarker', marker, result.run?.output, result.run?.output.includes(marker) ?? false)] };
  });

  await recorder.run('unmount-delete', '项目资源', { volumes: [dataVolume, npmVolume] }, { unmounted: true, deleted: true, workspaceUnchanged: true }, async () => {
    const agent = spec.agents.find(item => item.name === 'deterministic-agent')!;
    agent.volumes = agent.volumes.filter(item => !['/data/e2e', '/root/.npm', '/shared/read-only'].includes(item.target));
    agent.skills = agent.skills.filter(item => item.name !== skillName);
    spec.volumes = spec.volumes.filter(item => ![dataVolume, npmVolume].includes(item.name));
    const applied = await clients.project.applyProject(new ApplyProjectRequest({ spec, source }));
    await jsonRequest(gateway, `/api/project-files/folder?${query({ projectKey: key, path: skillPath, recursive: 'true' })}`, { method: 'DELETE' });
    pendingSkills.delete(skillPath);
    const removed: boolean[] = [];
    for (const name of [dataVolume, npmVolume]) {
      try {
        await volumeClient.removeVolume(new RemoveVolumeRequest({ name, force: false }));
        const deleted = (await volumeClient.removeVolume(new RemoveVolumeRequest({ name, force: true }))).removed;
        removed.push(deleted);
        if (deleted) pendingVolumes.delete(name);
      } catch {
        removed.push(false);
      }
    }
    const after = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: resourceProjectId }), includeSpec: true }));
    const afterWorkspace = after.project?.spec ? resourceWorkspaceSnapshot(after.project.spec, source.projectDir) : '';
    const unmounted = applied.applied && agent.volumes.every(item => !['/data/e2e', '/root/.npm', '/shared/read-only'].includes(item.target));
    return { actual: { unmounted, removed, workspaceSnapshot: afterWorkspace }, assertions: [exact('unmounted', true, unmounted), exact('deleted', true, removed.every(Boolean)), exact('workspaceUnchanged', workspaceSnapshot, afterWorkspace)] };
  });
  } finally {
    await recorder.run('cleanup', '项目资源', { skills: [...pendingSkills], volumes: [...pendingVolumes] }, { cleanupErrors: 0 }, async () => {
      const errors = await cleanupProjectResources({ gateway, projectKey: key, skills: pendingSkills, volumes: pendingVolumes, volumeClient });
      return { actual: { errors, remainingSkills: [...pendingSkills], remainingVolumes: [...pendingVolumes] }, assertions: [exact('cleanupErrors', 0, errors.length), exact('remainingSkills', 0, pendingSkills.size), exact('remainingVolumes', 0, pendingVolumes.size)] };
    });
  }
}
