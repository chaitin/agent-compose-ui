import { dumpYamlObject, parseYamlObject, yamlToSpec, type YamlMap } from '../yaml';
import { assertProjectVolumeKey } from './volume-names';

export type SkillYaml = { name: string; provider: string; path?: string; url?: string; ref?: string };
export type MountYaml = { type: 'volume' | 'bind'; source: string; target: string; read_only: boolean };

type MutableMap = Record<string, unknown>;

const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const MANAGED_LABEL = 'agent-compose-ui.managed';
const PROJECT_KEY_LABEL = 'agent-compose-ui.project-key';

function isMap(value: unknown): value is MutableMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getAgent(root: YamlMap, agentName: string): MutableMap {
  if (!isMap(root.agents)) throw new Error('agents 必须是映射格式');
  if (!Object.prototype.hasOwnProperty.call(root.agents, agentName)) {
    throw new Error(`Agent ${agentName} 不存在或不是映射格式`);
  }
  const agent = root.agents[agentName];
  if (!isMap(agent)) throw new Error(`Agent ${agentName} 不存在或不是映射格式`);
  return agent;
}

function getList(agent: MutableMap, field: 'skills' | 'volumes'): unknown[] {
  const value = agent[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是列表格式`);
  return value;
}

function validateDaemonVolumeName(name: string): void {
  if (!SAFE_VOLUME_NAME.test(name) || name.length > 255) {
    throw new Error('卷名称不是安全的 daemon 卷名称');
  }
}

function getProjectVolumes(root: YamlMap): MutableMap | undefined {
  if (root.volumes === undefined) return undefined;
  if (!isMap(root.volumes)) throw new Error('volumes 必须是映射格式');
  return root.volumes;
}

function getStringMap(value: unknown, field: string): MutableMap {
  if (value === undefined) return {};
  if (!isMap(value)) throw new Error(`${field} 必须是映射格式`);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} 必须是字符串`);
  }
  return value;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  }
  if (isMap(left) && isMap(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]));
  }
  return false;
}

function stripExtensionFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripExtensionFields);
    return;
  }
  if (!isMap(value)) return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('x-')) delete value[key];
    else stripExtensionFields(value[key]);
  }
}

function validationProjection(root: YamlMap): YamlMap {
  const projection = structuredClone(root);
  stripExtensionFields(projection);
  if (!isMap(projection.agents)) return projection;
  for (const value of Object.values(projection.agents)) {
    if (!isMap(value)) continue;
    if (Object.prototype.hasOwnProperty.call(value, 'mcps')
      && Object.prototype.hasOwnProperty.call(value, 'mcp_servers')) {
      throw new Error('Agent 不能同时包含 mcps 和 mcp_servers');
    }
    if (!Array.isArray(value.skills)) continue;
    for (const skill of value.skills) {
      if (!isMap(skill) || !Object.prototype.hasOwnProperty.call(skill, 'source')) continue;
      if (Object.prototype.hasOwnProperty.call(skill, 'provider')) {
        throw new Error('Skill 不能同时包含 source 和 provider');
      }
      skill.provider = skill.source;
      delete skill.source;
    }
  }
  return projection;
}

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (/^\/+$/u.test(trimmed)) return '/';
  if (!trimmed.startsWith('/')) return trimmed.replace(/\/+$/u, '');
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function sameMountIdentity(item: unknown, source: string, target: string): boolean {
  return isMap(item)
    && typeof item.source === 'string'
    && typeof item.target === 'string'
    && normalizeMountPath(item.source) === normalizeMountPath(source)
    && normalizeMountPath(item.target) === normalizeMountPath(target);
}

function finish(originalYaml: string, root: YamlMap, changed: boolean): string {
  const result = changed ? dumpYamlObject(root) : originalYaml;
  const validationYaml = dumpYamlObject(validationProjection(root));
  const { error } = yamlToSpec(validationYaml);
  if (error) throw new Error(`YAML 校验失败: ${error}`);
  return result;
}

export function upsertAgentSkill(yaml: string, agent: string, skill: SkillYaml): string {
  const root = parseYamlObject(yaml);
  const definition = getAgent(root, agent);
  const skills = getList(definition, 'skills');
  const index = skills.findIndex((item) => isMap(item) && item.name === skill.name);
  if (index >= 0 && equalValue(skills[index], skill)) return finish(yaml, root, false);
  const next = [...skills];
  if (index >= 0) next[index] = structuredClone(skill);
  else next.push(structuredClone(skill));
  definition.skills = next;
  return finish(yaml, root, true);
}

export function removeAgentSkill(yaml: string, agent: string, skillName: string): string {
  const root = parseYamlObject(yaml);
  const definition = getAgent(root, agent);
  const skills = getList(definition, 'skills');
  const next = skills.filter((item) => !(isMap(item) && item.name === skillName));
  if (next.length === skills.length) return finish(yaml, root, false);
  if (next.length === 0) delete definition.skills;
  else definition.skills = next;
  return finish(yaml, root, true);
}

export function upsertAgentMount(yaml: string, agent: string, mount: MountYaml): string {
  const root = parseYamlObject(yaml);
  const definition = getAgent(root, agent);
  const mounts = getList(definition, 'volumes');
  const index = mounts.findIndex((item) => sameMountIdentity(item, mount.source, mount.target));
  if (index >= 0 && equalValue(mounts[index], mount)) return finish(yaml, root, false);
  const next = [...mounts];
  if (index >= 0) next[index] = structuredClone(mount);
  else next.push(structuredClone(mount));
  definition.volumes = next;
  return finish(yaml, root, true);
}

export function removeAgentMount(yaml: string, agent: string, source: string, target: string): string {
  const root = parseYamlObject(yaml);
  const definition = getAgent(root, agent);
  const mounts = getList(definition, 'volumes');
  const next = mounts.filter((item) => !sameMountIdentity(item, source, target));
  if (next.length === mounts.length) return finish(yaml, root, false);
  if (next.length === 0) delete definition.volumes;
  else definition.volumes = next;
  return finish(yaml, root, true);
}

export function upsertProjectVolume(
  yaml: string,
  key: string,
  value: { name: string; driver: 'local'; labels: Record<string, string> },
): string {
  assertProjectVolumeKey(key);
  validateDaemonVolumeName(value.name);
  const root = parseYamlObject(yaml);
  const volumes = getProjectVolumes(root) ?? {};
  const existing = Object.prototype.hasOwnProperty.call(volumes, key) ? volumes[key] : undefined;
  if (existing !== undefined && !isMap(existing)) throw new Error(`卷声明 ${key} 必须是映射格式`);
  const existingLabels = getStringMap(existing?.labels, `volumes.${key}.labels`);
  const requestedLabels = getStringMap(value.labels, `volumes.${key}.labels`);
  const projectKey = requestedLabels[PROJECT_KEY_LABEL];
  if (typeof projectKey !== 'string' || !/^ws_[0-9a-f]{32}$/u.test(projectKey)) {
    throw new Error(`volumes.${key}.labels.${PROJECT_KEY_LABEL} 必须是有效的项目存储键`);
  }
  const next = {
    ...(existing ?? {}),
    name: value.name,
    driver: value.driver,
    labels: {
      ...existingLabels,
      ...requestedLabels,
      [MANAGED_LABEL]: 'true',
      [PROJECT_KEY_LABEL]: projectKey,
    },
  };
  if (existing !== undefined && equalValue(existing, next)) return finish(yaml, root, false);
  volumes[key] = next;
  if (root.volumes === undefined) root.volumes = volumes;
  return finish(yaml, root, true);
}

export function removeProjectVolume(yaml: string, key: string): string {
  assertProjectVolumeKey(key);
  const root = parseYamlObject(yaml);
  const volumes = getProjectVolumes(root);
  if (volumes === undefined || !Object.prototype.hasOwnProperty.call(volumes, key)) {
    return finish(yaml, root, false);
  }
  if (!isMap(volumes[key])) throw new Error(`卷声明 ${key} 必须是映射格式`);
  delete volumes[key];
  if (Object.keys(volumes).length === 0) delete root.volumes;
  return finish(yaml, root, true);
}
