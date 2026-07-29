import { AgentSpec, DockerDriverSpec, DriverSpec, ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { projectClient } from './client';

const redactedSecret = '********';

export function projectSpecForUpdate(spec: ProjectSpec | undefined): ProjectSpec {
  if (!spec) throw new Error('项目配置不存在');
  if (spec.octobusServers.length > 0) {
    throw new Error('该项目包含项目级 OctoBus 配置，请使用 compose 或 CLI 修改；当前页面仅管理全局能力网关');
  }
  if (JSON.stringify(spec.toJson()).includes(redactedSecret)) {
    throw new Error('项目包含已脱敏凭据，无法安全更新完整配置');
  }
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

export async function applyProjectSpecUpdate(spec: ProjectSpec): Promise<void> {
  const response = await projectClient.applyProject({ spec });
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
