import { apiFetchJson } from './http';

export type ProjectAgentEnv = { name: string; value: string; secret: boolean };
export type ProjectAgent = {
  id: string;
  agentName: string;
  displayName: string;
  description: string;
  enabled: boolean;
  provider: string;
  model: string;
  systemPrompt: string;
  image: string;
  driver: Record<string, unknown>;
  env: ProjectAgentEnv[];
  workspace: Record<string, unknown>;
  stoppedRuntimePolicy: string;
  capsetIds: string[];
  availability: string;
  health: string;
  schedulerEnabled: boolean;
  hasScheduler: boolean;
  jupyterEnabled: boolean;
  mcpCount: number;
  skillCount: number;
  volumeCount: number;
  hasBuild: boolean;
};

export type ProjectView = {
  projectId: string;
  name: string;
  sourcePath: string;
  currentRevision: string;
  specHash: string;
  agentCount: number;
  schedulerCount: number;
  runningRunCount: number;
  updatedAt: string;
  editable: boolean;
  blockedReasons: string[];
  variables: ProjectAgentEnv[];
  agents: ProjectAgent[];
};

export type AgentEditableSpec = {
  provider: string;
  model: string;
  systemPrompt?: string;
  image?: string;
  driver?: Record<string, unknown>;
  env?: ProjectAgentEnv[];
  workspace?: Record<string, unknown>;
  sandbox?: { stoppedRuntimePolicy: string };
  capsetIds?: string[];
  enabled: boolean;
  displayName: string;
  description?: string;
};

export type SchedulerEditableSpec = {
  enabled: boolean;
  triggers: Array<Record<string, unknown>>;
  script: string;
  sandboxPolicy: string;
  displayName: string;
  description: string;
  concurrencyPolicy: string;
};

export type ProjectMutation = {
  kind:
    | 'create_project_with_agent'
    | 'update_project_variables'
    | 'create_agent'
    | 'update_agent'
    | 'delete_agent'
    | 'create_scheduler'
    | 'update_scheduler'
    | 'delete_scheduler';
  projectId?: string;
  baseSpecHash?: string;
  projectName?: string;
  agentName?: string;
  variables?: ProjectAgentEnv[];
  agent?: AgentEditableSpec | Pick<AgentEditableSpec, 'env'>;
  scheduler?: SchedulerEditableSpec;
};

export type ProjectChange = {
  action: string;
  resourceType: string;
  resourceId?: string;
  name: string;
  message?: string;
};
export type ProjectIssue = { severity: string; path: string; message: string };
export type ProjectDeploymentPreview = {
  previewId: string;
  expiresAt: string;
  projectId: string;
  projectName: string;
  baseSpecHash: string;
  candidateSpecHash: string;
  changes: ProjectChange[];
  issues: ProjectIssue[];
  deployable: boolean;
  mutation: { kind: ProjectMutation['kind']; agentName?: string };
};

export type ProjectYAML = {
  projectName: string;
  revision: string;
  yaml: string;
};

export async function listProjectViews(): Promise<ProjectView[]> {
  return normalizeProjects((await apiFetchJson<{ projects?: ProjectView[] }>('/api/ui/v1/projects')).projects ?? []);
}

export async function getProjectView(projectId: string): Promise<ProjectView> {
  const response = await apiFetchJson<{ project: ProjectView }>(`/api/ui/v1/projects/${encodeURIComponent(projectId)}`);
  return normalizeProject(response.project);
}

export async function getProjectYAML(projectId: string): Promise<ProjectYAML> {
  return apiFetchJson<ProjectYAML>(`/api/ui/v1/projects/${encodeURIComponent(projectId)}/yaml`);
}

export async function previewProjectMutation(mutation: ProjectMutation): Promise<ProjectDeploymentPreview> {
  return apiFetchJson<ProjectDeploymentPreview>('/api/ui/v1/project-deployment-previews', {
    method: 'POST',
    body: JSON.stringify(mutation),
  });
}

export async function applyProjectPreview(previewId: string): Promise<void> {
  await apiFetchJson(`/api/ui/v1/project-deployment-previews/${encodeURIComponent(previewId)}/apply`, {
    method: 'POST',
  });
}

function normalizeProjects(projects: ProjectView[]): ProjectView[] {
  return projects.map(normalizeProject);
}

function normalizeProject(project: ProjectView): ProjectView {
  return {
    ...project,
    sourcePath: project.sourcePath ?? '',
    updatedAt: project.updatedAt ?? '',
    blockedReasons: project.blockedReasons ?? [],
    variables: project.variables ?? [],
    agents: (project.agents ?? []).map((agent) => ({
      ...agent,
      description: agent.description ?? '',
      systemPrompt: agent.systemPrompt ?? '',
      image: agent.image ?? '',
      driver: agent.driver ?? {},
      env: agent.env ?? [],
      workspace: agent.workspace ?? {},
      stoppedRuntimePolicy: agent.stoppedRuntimePolicy || 'remove',
      capsetIds: agent.capsetIds ?? [],
      availability: agent.availability ?? '',
      health: agent.health ?? '',
    })),
  };
}
