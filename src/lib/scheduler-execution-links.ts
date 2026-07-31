import type { SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';

export interface LinkedResourceId {
  id: string;
  introducedBy: string[];
}

export interface LinkWarning {
  eventId: string;
  message: string;
}

export interface LinkedSandboxRun {
  sandboxId: string;
  runId: string;
  introducedBy: string[];
}

export interface LinkedSandboxCell {
  sandboxId: string;
  cellId: string;
  introducedBy: string[];
}

export interface SchedulerExecutionLinks {
  sandboxes: LinkedResourceId[];
  cells: LinkedResourceId[];
  runs: LinkedResourceId[];
  sandboxRuns: LinkedSandboxRun[];
  sandboxCells: LinkedSandboxCell[];
  warnings: LinkWarning[];
}

type LinkKind = 'sandboxes' | 'cells' | 'runs';

const keyKind: ReadonlyMap<string, LinkKind> = new Map([
  ['sandboxId', 'sandboxes'], ['sandbox_id', 'sandboxes'],
  ['cellId', 'cells'], ['cell_id', 'cells'],
  ['runId', 'runs'], ['run_id', 'runs'],
] as const);
type LinkMaps = Record<LinkKind, Map<string, Set<string>>>;
type SandboxRunMap = Map<string, { sandboxId: string; runId: string; introducedBy: Set<string> }>;
type SandboxCellMap = Map<string, { sandboxId: string; cellId: string; introducedBy: Set<string> }>;

function directIds(value: Record<string, unknown>, kind: LinkKind): string[] {
  const ids = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    if (keyKind.get(key) !== kind || typeof child !== 'string') continue;
    const id = child.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function visit(value: unknown, eventId: string, links: LinkMaps, sandboxRuns: SandboxRunMap, sandboxCells: SandboxCellMap): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, eventId, links, sandboxRuns, sandboxCells);
    return;
  }

  if (value === null || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const sandboxId of directIds(record, 'sandboxes')) {
    for (const runId of directIds(record, 'runs')) {
      const key = JSON.stringify([sandboxId, runId]);
      const pair = sandboxRuns.get(key) ?? { sandboxId, runId, introducedBy: new Set<string>() };
      pair.introducedBy.add(eventId);
      sandboxRuns.set(key, pair);
    }
    for (const cellId of directIds(record, 'cells')) {
      const key = JSON.stringify([sandboxId, cellId]);
      const pair = sandboxCells.get(key) ?? { sandboxId, cellId, introducedBy: new Set<string>() };
      pair.introducedBy.add(eventId);
      sandboxCells.set(key, pair);
    }
  }

  for (const [key, child] of Object.entries(record)) {
    const kind = keyKind.get(key);
    if (kind && typeof child === 'string') {
      const id = child.trim();
      if (id) {
        const introducedBy = links[kind].get(id) ?? new Set<string>();
        introducedBy.add(eventId);
        links[kind].set(id, introducedBy);
      }
    }
    visit(child, eventId, links, sandboxRuns, sandboxCells);
  }
}

function toLinkedResources(resources: Map<string, Set<string>>): LinkedResourceId[] {
  return [...resources]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, introducedBy]) => ({ id, introducedBy: [...introducedBy] }));
}

export function extractSchedulerExecutionLinks(events: readonly SchedulerEvent[]): SchedulerExecutionLinks {
  const links: LinkMaps = {
    sandboxes: new Map(),
    cells: new Map(),
    runs: new Map(),
  };
  const sandboxRuns: SandboxRunMap = new Map();
  const sandboxCells: SandboxCellMap = new Map();
  const warnings: LinkWarning[] = [];

  for (const event of events) {
    if (!event.payloadJson.trim()) continue;

    try {
      visit(JSON.parse(event.payloadJson), event.id, links, sandboxRuns, sandboxCells);
    } catch {
      warnings.push({ eventId: event.id, message: 'Scheduler event payload is not valid JSON' });
    }
  }

  return {
    sandboxes: toLinkedResources(links.sandboxes),
    cells: toLinkedResources(links.cells),
    runs: toLinkedResources(links.runs),
    sandboxRuns: [...sandboxRuns.values()]
      .sort((left, right) => left.sandboxId.localeCompare(right.sandboxId) || left.runId.localeCompare(right.runId))
      .map(pair => ({ ...pair, introducedBy: [...pair.introducedBy] })),
    sandboxCells: [...sandboxCells.values()]
      .sort((left, right) => left.sandboxId.localeCompare(right.sandboxId) || left.cellId.localeCompare(right.cellId))
      .map(pair => ({ ...pair, introducedBy: [...pair.introducedBy] })),
    warnings,
  };
}
