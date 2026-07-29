import type { ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb.js';

export function projectSpecForUpdate(spec: ProjectSpec | undefined): ProjectSpec {
  if (!spec) throw new Error('项目配置不存在');
  if (spec.octobusServers.length > 0) {
    throw new Error('该项目包含项目级 OctoBus 配置，请使用 compose 或 CLI 修改；当前页面仅管理全局能力网关');
  }
  return spec;
}
