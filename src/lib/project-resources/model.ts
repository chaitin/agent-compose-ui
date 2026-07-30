import { parseYamlObject, type YamlMap } from '../yaml';
import { assertProjectVolumeKey } from './volume-names';

export type AgentMount = {
  agent: string;
  source: string;
  target: string;
  readOnly: boolean;
  type: 'volume';
};

export type ProjectDataResource = {
  key: string;
  systemName: string;
  mounts: AgentMount[];
  managed: boolean;
};

type MapValue = Record<string, unknown>;

const MANAGED_LABEL = 'agent-compose-ui.managed';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString']);

function isPlainRecord(value: unknown): value is MapValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: MapValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalMap(root: YamlMap, field: 'volumes' | 'agents'): MapValue {
  if (!hasOwn(root, field) || root[field] === undefined) return {};
  if (!isPlainRecord(root[field])) throw new Error(`${field} must be a mapping`);
  return root[field];
}

function assertSafeKey(scope: 'volumes' | 'agents', key: string): void {
  if (UNSAFE_KEYS.has(key)) throw new Error(`${scope}.${key} is not a safe key`);
}

function declarationResource(key: string, value: unknown): ProjectDataResource {
  try {
    assertProjectVolumeKey(key);
  } catch {
    throw new Error(`volumes.${key} is not a safe project volume key`);
  }
  if (!isPlainRecord(value)) throw new Error(`volumes.${key} must be a mapping`);

  const name = value.name;
  if (name !== undefined && typeof name !== 'string') {
    throw new Error(`volumes.${key}.name must be a string`);
  }

  const labels = value.labels;
  if (labels !== undefined && !isPlainRecord(labels)) {
    throw new Error(`volumes.${key}.labels must be a mapping`);
  }

  return {
    key,
    systemName: typeof name === 'string' && name.length > 0 ? name : key,
    mounts: [],
    managed: labels !== undefined && hasOwn(labels, MANAGED_LABEL) && labels[MANAGED_LABEL] === 'true',
  };
}

function agentMounts(agent: string, value: unknown): AgentMount[] {
  assertSafeKey('agents', agent);
  if (!isPlainRecord(value)) throw new Error(`agents.${agent} must be a mapping`);
  if (!hasOwn(value, 'volumes') || value.volumes === undefined) return [];
  if (!Array.isArray(value.volumes)) throw new Error(`agents.${agent}.volumes must be a list`);

  return value.volumes.flatMap((mount, index): AgentMount[] => {
    const path = `agents.${agent}.volumes[${index}]`;
    if (!isPlainRecord(mount)) throw new Error(`${path} must be a mapping`);
    if (typeof mount.type !== 'string') throw new Error(`${path}.type must be a string`);
    if (typeof mount.source !== 'string') throw new Error(`${path}.source must be a string`);
    if (typeof mount.target !== 'string') throw new Error(`${path}.target must be a string`);
    if (mount.read_only !== undefined && typeof mount.read_only !== 'boolean') {
      throw new Error(`${path}.read_only must be a boolean`);
    }
    if (mount.type !== 'volume') return [];
    return [{
      agent,
      type: 'volume',
      source: mount.source,
      target: mount.target,
      readOnly: mount.read_only ?? false,
    }];
  });
}

export function deriveProjectResources(yaml: string): ProjectDataResource[] {
  const root = parseYamlObject(yaml);
  if (!isPlainRecord(root)) throw new Error('root must be a mapping');
  const declarations = optionalMap(root, 'volumes');
  const resources = Object.entries(declarations).map(([key, value]) => declarationResource(key, value));
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));

  for (const [agent, definition] of Object.entries(optionalMap(root, 'agents'))) {
    for (const mount of agentMounts(agent, definition)) {
      byKey.get(mount.source)?.mounts.push(mount);
    }
  }
  return resources;
}
