import { Code, ConnectError } from '@connectrpc/connect';
import {
  InspectImageRequest,
  ListCapabilitySetsRequest,
  type ProjectSpec,
} from '../gen/agentcompose/v2/agentcompose_pb';

export interface ProjectDependencyImageClient {
  inspectImage(request: InspectImageRequest): Promise<unknown>;
}

export interface ProjectDependencyCapabilityClient {
  listCapabilitySets(request: ListCapabilitySetsRequest): Promise<{ capsets: Array<{
    id: string;
    enabled: boolean;
  }> }>;
}

export interface ProjectDependencyPreflightOptions {
  spec: Pick<ProjectSpec, 'agents'>;
  imageClient: ProjectDependencyImageClient;
  capabilityClient: ProjectDependencyCapabilityClient;
}

export interface ProjectDependencyPreflightResult {
  warnings: string[];
}

function dockerImageAgents(spec: Pick<ProjectSpec, 'agents'>): Map<string, string[]> {
  const images = new Map<string, string[]>();
  for (const agent of spec.agents) {
    const isDocker = agent.driver?.docker !== undefined || agent.driver?.name.trim().toLowerCase() === 'docker';
    const image = agent.image.trim();
    if (!isDocker || !image) continue;
    const agents = images.get(image) ?? [];
    agents.push(agent.name.trim() || '未命名 Agent');
    images.set(image, agents);
  }
  return images;
}

export async function checkProjectDependencies(
  options: ProjectDependencyPreflightOptions,
): Promise<ProjectDependencyPreflightResult> {
  const failures = await Promise.all([...dockerImageAgents(options.spec)].map(async ([image, agents]) => {
    try {
      await options.imageClient.inspectImage(new InspectImageRequest({ imageRef: image }));
      return '';
    } catch (error) {
      const connected = ConnectError.from(error);
      const agentList = agents.join('、');
      if (connected.code === Code.NotFound) {
        return `镜像不存在：${image}（Agent：${agentList}）。请先在镜像管理中拉取该镜像。`;
      }
      return `无法检查镜像 ${image}（Agent：${agentList}）：${connected.message}`;
    }
  }));
  const blocking = failures.filter(Boolean);
  if (blocking.length > 0) throw new Error(blocking.join('\n'));

  const references = options.spec.agents.flatMap(agent => agent.capsetIds
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => ({ agentName: agent.name.trim() || '未命名 Agent', id })));
  if (references.length === 0) return { warnings: [] };

  try {
    const response = await options.capabilityClient.listCapabilitySets(new ListCapabilitySetsRequest());
    const available = new Map(response.capsets.map(capset => [capset.id.trim(), capset]));
    const warnings: string[] = [];
    for (const reference of references) {
      const capset = available.get(reference.id);
      if (!capset) {
        warnings.push(`Agent ${reference.agentName} 引用的能力集 ${reference.id} 不存在`);
      } else if (!capset.enabled) {
        warnings.push(`Agent ${reference.agentName} 引用的能力集 ${reference.id} 未启用`);
      }
    }
    return { warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warnings: [`能力集检查失败，已继续执行：${message}`] };
  }
}
