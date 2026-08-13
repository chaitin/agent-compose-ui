import yaml from 'js-yaml';
import { ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb';
import type { JsonObject } from '@bufbuild/protobuf';

export type YamlMap = Record<string, unknown>;

export function parseYamlObject(yamlText: string): YamlMap {
  const value = yaml.load(yamlText);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('YAML 必须是映射格式');
  }
  return structuredClone(value as YamlMap);
}

export function dumpYamlObject(value: YamlMap): string {
  return yaml.dump(value, { indent: 2, lineWidth: -1, noRefs: true });
}

function convertAgentsMapToArray(obj: YamlMap): void {
  if (obj.agents && typeof obj.agents === 'object' && !Array.isArray(obj.agents)) {
    const agentsObj = obj.agents as Record<string, unknown>;
    obj.agents = Object.entries(agentsObj).map(([name, def]) => {
      const agent = def as Record<string, unknown>;
      // Convert env map to array: { KEY: { value: "v" } } -> [{ name: "KEY", value: "v" }]
      if (agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env)) {
        const envObj = agent.env as Record<string, unknown>;
        agent.env = Object.entries(envObj).map(([envName, envDef]) => {
          if (envDef && typeof envDef === 'object') {
            return { name: envName, ...envDef as Record<string, unknown> };
          }
          return { name: envName, value: String(envDef ?? '') };
        });
      }
      return { name, ...agent };
    });
  }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envMapToArray(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.entries(value as Record<string, unknown>).map(([name, definition]) => {
    if (definition && typeof definition === 'object') return { name, ...definition as Record<string, unknown> };
    return { name, value: String(definition ?? '') };
  });
}

function convertMcpServerMapToArray(value: unknown): unknown {
  if (!isMap(value)) return value;
  return Object.entries(value).map(([name, definition]) => {
    const mcp: Record<string, unknown> = isMap(definition) ? { name, ...definition } : { name };
    if (mcp.env !== undefined) mcp.env = envMapToArray(mcp.env);
    if (mcp.headers !== undefined) mcp.headers = envMapToArray(mcp.headers);
    return mcp;
  });
}

function normalizeMcpAliases(target: Record<string, unknown>, owner: string): void {
  if (!Object.prototype.hasOwnProperty.call(target, 'mcps')) return;
  if (Object.prototype.hasOwnProperty.call(target, 'mcp_servers')) {
    throw new Error(`${owner} 不能同时包含 mcps 和 mcp_servers`);
  }
  target.mcp_servers = target.mcps;
  delete target.mcps;
}

function normalizeVolumeMountTypes(agent: Record<string, unknown>): void {
  if (!Array.isArray(agent.volumes)) return;
  for (const item of agent.volumes) {
    if (!isMap(item) || typeof item.type !== 'string') continue;
    if (item.type === 'bind') item.type = 'VOLUME_MOUNT_TYPE_BIND';
    else if (item.type === 'volume') item.type = 'VOLUME_MOUNT_TYPE_VOLUME';
  }
}

function convertCanonicalMapsToArrays(obj: YamlMap): void {
  if (obj.variables !== undefined) obj.variables = envMapToArray(obj.variables);
  if (obj.workspaces && typeof obj.workspaces === 'object' && !Array.isArray(obj.workspaces)) {
    obj.workspaces = Object.entries(obj.workspaces as Record<string, unknown>).map(([name, workspace]) => ({ name, workspace }));
  }
  if (obj.volumes && typeof obj.volumes === 'object' && !Array.isArray(obj.volumes)) {
    obj.volumes = Object.entries(obj.volumes as Record<string, unknown>).map(([key, definition]) => ({
      key,
      ...definition as Record<string, unknown>,
    }));
  }
  normalizeMcpAliases(obj, 'Project');
  if (obj.mcp_servers && typeof obj.mcp_servers === 'object' && !Array.isArray(obj.mcp_servers)) {
    obj.mcp_servers = convertMcpServerMapToArray(obj.mcp_servers);
  }
  if (obj.agents && typeof obj.agents === 'object') {
    const agents = Array.isArray(obj.agents) ? obj.agents : Object.values(obj.agents);
    for (const agent of agents) {
      if (!isMap(agent)) continue;
      normalizeMcpAliases(agent, 'Agent');
      if (agent.mcp_servers && typeof agent.mcp_servers === 'object' && !Array.isArray(agent.mcp_servers)) {
        agent.mcp_servers = convertMcpServerMapToArray(agent.mcp_servers);
      }
      normalizeVolumeMountTypes(agent);
    }
  }
}

function convertLegacySkillSources(obj: YamlMap): void {
  if (!obj.agents || typeof obj.agents !== 'object' || Array.isArray(obj.agents)) return;
  for (const agent of Object.values(obj.agents as Record<string, unknown>)) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const skills = (agent as Record<string, unknown>).skills;
    if (!Array.isArray(skills)) continue;
    for (const value of skills) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const skill = value as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(skill, 'source')) continue;
      if (Object.prototype.hasOwnProperty.call(skill, 'provider')) {
        throw new Error('Skill 不能同时包含 source 和 provider');
      }
      skill.provider = skill.source;
      delete skill.source;
    }
  }
}

export function yamlToSpec(yamlText: string): { spec: ProjectSpec; error?: string } {
  try {
    const obj = parseYamlObject(yamlText);
    convertLegacySkillSources(obj);
    convertCanonicalMapsToArrays(obj);
    convertAgentsMapToArray(obj);
    const spec = ProjectSpec.fromJson(obj as unknown as JsonObject);
    return { spec };
  } catch (e) {
    return { spec: new ProjectSpec(), error: String(e) };
  }
}

export function specToYaml(spec: ProjectSpec): string {
  const obj = spec.toJson() as Record<string, unknown>;
  if (Array.isArray(obj.mcpServers)) {
    obj.mcp_servers = obj.mcpServers;
    delete obj.mcpServers;
  }
  // Convert agents from array back to map: [{ name: "x", env: [...] }] -> { x: { env: {...} } }
  if (Array.isArray(obj.agents)) {
    const agentsMap: Record<string, unknown> = {};
    for (const a of obj.agents as Array<Record<string, unknown>>) {
      const { name, ...rest } = a;
      if (!name) continue;
      // Convert env array back to map: [{ name: "K", value: "v" }] -> { K: { value: "v" } }
      if (Array.isArray(rest.env)) {
        const envMap: Record<string, unknown> = {};
        for (const e of rest.env as Array<Record<string, unknown>>) {
          if (e.name) {
            const { name: en, ...envRest } = e;
            envMap[en as string] = envRest;
          }
        }
        rest.env = envMap;
      }
      if (Array.isArray(rest.volumes)) {
        for (const item of rest.volumes as Array<Record<string, unknown>>) {
          if (item.type === 'VOLUME_MOUNT_TYPE_BIND') item.type = 'bind';
          else if (item.type === 'VOLUME_MOUNT_TYPE_VOLUME') item.type = 'volume';
        }
      }
      if (Array.isArray(rest.mcpServers)) {
        rest.mcp_servers = rest.mcpServers;
        delete rest.mcpServers;
      }
      agentsMap[name as string] = rest;
    }
    obj.agents = agentsMap;
  }
  // Convert variables from array back to map: [{ name: "x", value: "v" }] -> { x: "v" }
  if (Array.isArray(obj.variables)) {
    const varsMap: Record<string, unknown> = {};
    for (const v of obj.variables as Array<Record<string, unknown>>) {
      if (v.name) varsMap[v.name as string] = v.value ?? '';
    }
    obj.variables = varsMap;
  }
  if (Array.isArray(obj.workspaces)) {
    const workspacesMap: Record<string, unknown> = {};
    for (const item of obj.workspaces as Array<Record<string, unknown>>) {
      if (item.name) workspacesMap[item.name as string] = item.workspace ?? {};
    }
    obj.workspaces = workspacesMap;
  }
  if (Array.isArray(obj.volumes)) {
    const volumesMap: Record<string, unknown> = {};
    for (const item of obj.volumes as Array<Record<string, unknown>>) {
      const { key, ...definition } = item;
      if (key) volumesMap[key as string] = definition;
    }
    obj.volumes = volumesMap;
  }
  if (Array.isArray(obj.mcp_servers)) {
    const mcpsMap: Record<string, unknown> = {};
    for (const item of obj.mcp_servers as Array<Record<string, unknown>>) {
      const { name, ...definition } = item;
      if (name) mcpsMap[name as string] = definition;
    }
    obj.mcp_servers = mcpsMap;
  }
  return yaml.dump(obj, { indent: 2, lineWidth: -1, noRefs: true });
}

export function countAgents(yamlText: string): number {
  const { spec } = yamlToSpec(yamlText);
  return spec.agents.length;
}

export function countSchedulers(yamlText: string): number {
  const { spec } = yamlToSpec(yamlText);
  return spec.agents.filter(a => a.scheduler).length;
}

export const EMPTY_YAML_TEMPLATE = `name: ""
agents: []
`;
