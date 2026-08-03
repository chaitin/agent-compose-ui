export type SandboxTag = { name: string; value: string };
export type PresentedSandboxTag = {
  key: string;
  label: string;
  value: string;
  identifier: boolean;
};

const tagPresentation: Record<string, { label: string; identifier?: boolean; priority: number }> = {
  project: { label: '项目 ID', identifier: true, priority: 10 },
  project_id: { label: '项目 ID', identifier: true, priority: 11 },
  agent_name: { label: '智能体', priority: 20 },
  agent: { label: '智能体', priority: 21 },
  agent_id: { label: '智能体 ID', identifier: true, priority: 30 },
  run_id: { label: '运行 ID', identifier: true, priority: 40 },
  source: { label: '来源', priority: 50 },
  agent_provider: { label: '模型服务', priority: 60 },
  provider: { label: '模型服务', priority: 61 },
};

export function presentSandboxTags(tags: SandboxTag[]): {
  known: PresentedSandboxTag[];
  other: SandboxTag[];
} {
  const known = new Map<string, PresentedSandboxTag & { priority: number }>();
  const other = new Map<string, SandboxTag>();
  for (const tag of tags) {
    const name = tag.name.trim();
    const value = tag.value.trim();
    if (!name || !value) continue;
    const presentation = tagPresentation[name.toLowerCase()];
    if (!presentation) {
      other.set(`${name}:${value}`, { name, value });
      continue;
    }
    const presentedValue = name.toLowerCase() === 'source' ? sourceLabel(value) : value;
    const key = `${presentation.label}:${presentedValue}`;
    const existing = known.get(key);
    if (!existing || presentation.priority < existing.priority) {
      known.set(key, {
        key,
        label: presentation.label,
        value: presentedValue,
        identifier: Boolean(presentation.identifier),
        priority: presentation.priority,
      });
    }
  }
  return {
    known: [...known.values()]
      .sort((left, right) => left.priority - right.priority)
      .map(({ priority: _, ...tag }) => tag),
    other: [...other.values()],
  };
}

function sourceLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'manual') return '手动';
  if (normalized === 'scheduler') return '自动化';
  if (normalized === 'api') return 'API';
  return value;
}
