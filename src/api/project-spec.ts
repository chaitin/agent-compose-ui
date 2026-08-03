import {
  AgentSpec,
  DockerDriverSpec,
  DriverSpec,
  Project,
  ProjectSpec,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { projectClient } from './client';
import { projectById } from './project-ref';

export function projectSpecForUpdate(spec: ProjectSpec | undefined): ProjectSpec {
  if (!spec) throw new Error('项目配置不存在');
  return new ProjectSpec({
    ...spec,
    agents: spec.agents.map(
      (agent) =>
        new AgentSpec({
          ...agent,
          driver: normalizedDriver(agent.driver),
        }),
    ),
  });
}

export async function patchProjectSpecUpdate(project: Project, spec: ProjectSpec): Promise<void> {
  const projectId = project.summary?.projectId.trim() ?? '';
  const expectedCurrentSpecHash = project.summary?.specHash.trim() ?? '';
  if (!projectId) throw new Error('项目 ID 不存在');
  if (!expectedCurrentSpecHash) throw new Error('项目配置指纹不存在，请重新加载');

  const response = await projectClient.patchProject({
    project: projectById(projectId),
    expectedCurrentSpecHash,
    spec,
  });
  if (response.applied || response.unchanged) return;
  const details = response.issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .filter(Boolean)
    .join('\n');
  throw new Error(details || '项目配置未保存');
}

function normalizedDriver(driver: DriverSpec | undefined): DriverSpec | undefined {
  if (!driver || driver.name !== 'docker' || driver.config.case) return driver;
  return new DriverSpec({
    name: driver.name,
    config: { case: 'docker', value: new DockerDriverSpec() },
  });
}
