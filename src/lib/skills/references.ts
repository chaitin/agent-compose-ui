import { dumpYamlObject, parseYamlObject, type YamlMap } from '../yaml';

type MapValue = Record<string, unknown>;
const unsafeNames = new Set(['__proto__', 'prototype', 'constructor']);

export interface SkillReference {
  agentName: string;
  skillName: string;
  path?: string;
}

export interface RemoveSkillReferencesResult {
  yaml: string;
  references: SkillReference[];
}

function isMap(value: unknown): value is MapValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function agentEntries(root: YamlMap): Array<[string, MapValue]> {
  if (!isMap(root.agents)) return [];
  const agents = root.agents;
  return Object.keys(agents)
    .filter((name) => !unsafeNames.has(name) && Object.prototype.hasOwnProperty.call(agents, name) && isMap(agents[name]))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => [name, agents[name] as MapValue]);
}

function providerOf(skill: MapValue): string | undefined {
  const hasProvider = Object.prototype.hasOwnProperty.call(skill, 'provider');
  const hasSource = Object.prototype.hasOwnProperty.call(skill, 'source');
  if (hasProvider && hasSource) throw new Error('Skill 不能同时包含 source 和 provider');
  const value = hasProvider ? skill.provider : skill.source;
  return typeof value === 'string' ? value : undefined;
}

function normalizedLocalPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = value.trim();
  if (!path || path.startsWith('/') || path.includes('\\')) return undefined;
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return undefined;
  return segments.join('/');
}

function isLocalReference(skill: unknown, name: string): skill is MapValue {
  if (!isMap(skill)) return false;
  const provider = providerOf(skill);
  if (provider !== 'file' && provider !== 'local') return false;
  if (Object.prototype.hasOwnProperty.call(skill, 'path')) {
    return normalizedLocalPath(skill.path) === `skills/${name}`;
  }
  return skill.name === name;
}

export function listAgentNames(yaml: string): string[] {
  try { return agentEntries(parseYamlObject(yaml)).map(([name]) => name); } catch { return []; }
}

function traverseSkillReferences(root: YamlMap, skillName: string, remove: boolean): { references: SkillReference[]; changed: boolean } {
  const result: SkillReference[] = [];
  let changed = false;
  for (const [agentName, agent] of agentEntries(root)) {
    if (!Array.isArray(agent.skills)) continue;
    const retained: unknown[] = [];
    for (const skill of agent.skills) {
      if (isLocalReference(skill, skillName)) {
        result.push({
          agentName,
          skillName: typeof skill.name === 'string' ? skill.name : skillName,
          ...(typeof skill.path === 'string' ? { path: skill.path } : {}),
        });
        if (remove) { changed = true; continue; }
      }
      retained.push(skill);
    }
    if (remove && retained.length !== agent.skills.length) {
      if (retained.length) agent.skills = retained;
      else delete agent.skills;
    }
  }
  return { references: result, changed };
}

export function listSkillReferences(yaml: string, skillName: string): SkillReference[] {
  return traverseSkillReferences(parseYamlObject(yaml), skillName, false).references;
}

export function removeSkillReferences(yaml: string, skillName: string): RemoveSkillReferencesResult {
  const root = parseYamlObject(yaml);
  const result = traverseSkillReferences(root, skillName, true);
  return { yaml: result.changed ? dumpYamlObject(root) : yaml, references: result.references };
}
