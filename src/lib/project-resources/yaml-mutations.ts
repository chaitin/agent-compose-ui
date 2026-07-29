import { dumpYamlObject, parseYamlObject, yamlToSpec, type YamlMap } from '../yaml';

export type SkillYaml = { name: string; provider: string; path?: string; url?: string; ref?: string };
export type MountYaml = { type: 'volume' | 'bind'; source: string; target: string; read_only: boolean };

type MutableMap = Record<string, unknown>;

function isMap(value: unknown): value is MutableMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getAgent(root: YamlMap, agentName: string): MutableMap {
  if (!isMap(root.agents)) throw new Error('agents 必须是映射格式');
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

function finish(originalYaml: string, root: YamlMap, changed: boolean): string {
  const result = changed ? dumpYamlObject(root) : originalYaml;
  const { error } = yamlToSpec(result);
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
  definition.skills = next;
  return finish(yaml, root, true);
}

export function upsertAgentMount(yaml: string, agent: string, mount: MountYaml): string {
  const root = parseYamlObject(yaml);
  const definition = getAgent(root, agent);
  const mounts = getList(definition, 'volumes');
  const index = mounts.findIndex((item) => isMap(item) && item.source === mount.source && item.target === mount.target);
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
  const next = mounts.filter((item) => !(isMap(item) && item.source === source && item.target === target));
  if (next.length === mounts.length) return finish(yaml, root, false);
  definition.volumes = next;
  return finish(yaml, root, true);
}
