import { parseYamlObject, type YamlMap } from '../yaml';

export interface LocalSkillLocation {
  name: string;
  path?: string;
  expectedPath: string;
}

export interface SkillLocation {
  agentName: string;
  line: number;
  state: 'add' | 'manage' | 'repair';
  localSkills: LocalSkillLocation[];
}

type MapValue = Record<string, unknown>;

function isMap(value: unknown): value is MapValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function keyOf(line: string): string | undefined {
  const match = /^\s*([A-Za-z0-9_.-]+):(?:\s|$)/u.exec(line);
  return match?.[1];
}

function agentsOf(root: YamlMap): Map<string, MapValue> {
  if (!isMap(root.agents)) return new Map();
  return new Map(Object.entries(root.agents).filter((entry): entry is [string, MapValue] => isMap(entry[1])));
}

function localSkillsOf(agent: MapValue): LocalSkillLocation[] {
  if (!Array.isArray(agent.skills)) return [];
  return agent.skills.flatMap((value) => {
    if (!isMap(value) || typeof value.name !== 'string') return [];
    const source = typeof value.source === 'string' ? value.source : value.provider;
    if (source !== 'file' && source !== 'local') return [];
    const path = typeof value.path === 'string' ? value.path : undefined;
    return [{ name: value.name, ...(path === undefined ? {} : { path }), expectedPath: `./skills/${value.name}` }];
  });
}

export function listSkillLocations(source: string): SkillLocation[] {
  let root: YamlMap;
  try { root = parseYamlObject(source); } catch { return []; }
  const agents = agentsOf(root);
  if (!agents.size) return [];

  const lines = source.split(/\r?\n/u);
  const agentsLine = lines.findIndex((line) => keyOf(line) === 'agents');
  if (agentsLine < 0) return [];
  const agentsIndent = indentOf(lines[agentsLine]);
  let currentAgent = '';
  let agentIndent = -1;
  const result: SkillLocation[] = [];

  for (let index = agentsLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent <= agentsIndent) break;
    const key = keyOf(line);
    if (!key) continue;
    if (agents.has(key) && (agentIndent < 0 || indent <= agentIndent)) {
      currentAgent = key;
      agentIndent = indent;
      continue;
    }
    if (!currentAgent || indent !== agentIndent + 2 || key !== 'skills') continue;
    const agent = agents.get(currentAgent);
    if (!agent || !Object.prototype.hasOwnProperty.call(agent, 'skills')) continue;
    const localSkills = localSkillsOf(agent);
    const itemCount = Array.isArray(agent.skills) ? agent.skills.length : 0;
    result.push({
      agentName: currentAgent,
      line: index + 1,
      state: localSkills.some((skill) => skill.path !== skill.expectedPath)
        ? 'repair'
        : itemCount === 0 ? 'add' : 'manage',
      localSkills,
    });
  }
  return result;
}
