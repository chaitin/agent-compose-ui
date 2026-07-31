const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface AgentEnvReference {
  agentName: string;
  envName: string;
  names: string[];
  line: number;
  envLine: number;
  startColumn: number;
  endColumn: number;
}

interface Section {
  indent: number;
  name?: string;
  line?: number;
}

function keyAt(line: string): { indent: number; key: string; value: string } | null {
  if (!line.trim() || line.trimStart().startsWith('#') || line.includes('\t')) return null;
  const match = /^(\s*)(?:([A-Za-z_][A-Za-z0-9_-]*)|["']([^"']+)["'])\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  return { indent: match[1].length, key: match[2] ?? match[3], value: match[4] };
}

/** Locate global-variable references specifically in agents.<name>.env.<name>.value. */
export function listAgentEnvReferences(yaml: string): AgentEnvReference[] {
  const result: AgentEnvReference[] = [];
  let agents: Section | null = null;
  let agent: Section | null = null;
  let env: Section | null = null;
  let envItem: Section | null = null;

  function addReference(text: string, value: string, line: number): void {
    if (!agent?.name || !envItem?.name || !env?.line) return;

    const names: string[] = [];
    let firstStart = -1;
    let lastEnd = -1;
    for (const match of value.matchAll(ENV_REFERENCE)) {
      if (!names.includes(match[1])) names.push(match[1]);
      const valueOffset = text.indexOf(value);
      const start = valueOffset + (match.index ?? 0);
      if (firstStart < 0) firstStart = start;
      lastEnd = start + match[0].length;
    }
    if (names.length) result.push({
      agentName: agent.name, envName: envItem.name, names, line, envLine: env.line,
      startColumn: firstStart + 1, endColumn: lastEnd + 1,
    });
  }

  yaml.split(/\r?\n/).forEach((text, index) => {
    const entry = keyAt(text);
    if (!entry) return;

    if (agents && entry.indent <= agents.indent && entry.key !== 'agents') {
      agents = agent = env = envItem = null;
    }
    if (entry.key === 'agents') {
      agents = { indent: entry.indent };
      agent = env = envItem = null;
      return;
    }
    if (!agents || entry.indent <= agents.indent) return;

    if (!agent || entry.indent <= agent.indent) {
      agent = { indent: entry.indent, name: entry.key };
      env = envItem = null;
      return;
    }
    if (entry.indent <= agent.indent) return;

    if (entry.key === 'env') {
      env = { indent: entry.indent, line: index + 1 };
      envItem = null;
      return;
    }
    if (!env || entry.indent <= env.indent) {
      env = envItem = null;
      return;
    }
    if (!envItem || entry.indent <= envItem.indent) {
      envItem = { indent: entry.indent, name: entry.key };
      addReference(text, entry.value, index + 1);
      return;
    }
    if (entry.key !== 'value' || !agent.name || !envItem.name || !env.line) return;
    addReference(text, entry.value, index + 1);
  });
  return result;
}

export function missingAgentEnvReferences(yaml: string, configured: Iterable<string>): AgentEnvReference[] {
  const known = new Set(configured);
  return listAgentEnvReferences(yaml)
    .map((reference) => ({ ...reference, names: reference.names.filter((name) => !known.has(name)) }))
    .filter((reference) => reference.names.length > 0);
}
