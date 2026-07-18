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

function envMapToArray(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.entries(value as Record<string, unknown>).map(([name, definition]) => {
    if (definition && typeof definition === 'object') return { name, ...definition as Record<string, unknown> };
    return { name, value: String(definition ?? '') };
  });
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
  if (obj.mcps && typeof obj.mcps === 'object' && !Array.isArray(obj.mcps)) {
    obj.mcps = Object.entries(obj.mcps as Record<string, unknown>).map(([name, definition]) => {
      const mcp: Record<string, unknown> = { name, ...definition as Record<string, unknown> };
      if (mcp.env !== undefined) mcp.env = envMapToArray(mcp.env);
      if (mcp.headers !== undefined) mcp.headers = envMapToArray(mcp.headers);
      return mcp;
    });
  }
}

export function yamlToSpec(yamlText: string): { spec: ProjectSpec; error?: string } {
  try {
    const obj = parseYamlObject(yamlText);
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
  if (Array.isArray(obj.mcps)) {
    const mcpsMap: Record<string, unknown> = {};
    for (const item of obj.mcps as Array<Record<string, unknown>>) {
      const { name, ...definition } = item;
      if (name) mcpsMap[name as string] = definition;
    }
    obj.mcps = mcpsMap;
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
