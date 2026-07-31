import {
  RunEventKind,
  type RunEvent,
  type SandboxHistoryCell,
  type SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { mapRunEventsToTranscript } from './agent-run-transcript';
import type { RuntimeTimelineEntry, RuntimeTimelineFilterTag } from './runtime-timeline';

export function resultCellId(resultJson: string): string {
  try {
    const value = JSON.parse(resultJson || '{}');
    return typeof value?.cellId === 'string' ? value.cellId.trim() : '';
  } catch {
    return '';
  }
}

export function confirmedCell(cells: readonly SandboxHistoryCell[], resultJson: string): SandboxHistoryCell | undefined {
  const cellId = resultCellId(resultJson);
  return cellId ? cells.find(cell => cell.id === cellId) : undefined;
}

export function confirmedSandboxRunEvents(events: readonly RunEvent[], runId: string): RunEvent[] {
  return events.filter(event => event.runId === runId);
}

function timestamp(value?: { seconds: bigint; nanos: number }): string {
  if (!value) return '';
  return new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000).toISOString();
}

function sortTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function uniqueTags(tags: RuntimeTimelineFilterTag[]): RuntimeTimelineFilterTag[] {
  return [...new Set(tags)];
}

function ownedByExisting(content: string, existing?: ReadonlySet<string>): boolean {
  const value = content.trim();
  if (!value) return true;
  return [...(existing ?? [])].some(item => item.trim() === value || item.includes(value));
}

function schedulerContent(event: SchedulerEvent, existing?: ReadonlySet<string>): string {
  if (event.type === 'loader.run.completed') return event.message || 'loader run completed';
  if (event.type !== 'loader.agent.completed') {
    return [event.message, event.payloadJson].filter(value => value && !ownedByExisting(value, existing)).join('\n') || event.type || '调度事件';
  }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(event.payloadJson || '{}'); } catch {}
  const metadata = Object.fromEntries(['sandboxId', 'cellId', 'agent', 'stopReason', 'success', 'exitCode']
    .filter(key => payload[key] !== undefined)
    .map(key => [key, payload[key]]));
  return [
    ownedByExisting(event.message, existing) ? 'Agent 调用完成' : event.message,
    Object.keys(metadata).length ? JSON.stringify(metadata) : '',
  ].filter(Boolean).join('\n');
}

export interface ConfirmedEvidenceTimelineInput {
  schedulerEvents: readonly SchedulerEvent[];
  cell?: SandboxHistoryCell;
  sandboxRunEvents: readonly RunEvent[];
  existingRunEventIds: ReadonlySet<string>;
  logsPath: string;
  artifactsDir: string;
  output?: string;
  resultJson?: string;
  existingRunEventContents?: ReadonlySet<string>;
  completedAt: string;
  updatedAt: string;
  startedAt: string;
}

export function buildConfirmedEvidenceTimeline(input: ConfirmedEvidenceTimelineInput): RuntimeTimelineEntry[] {
  const entries: RuntimeTimelineEntry[] = [];
  let sequence = 10_000;
  const add = (entry: Omit<RuntimeTimelineEntry, 'sequence' | 'sortTime'>) => {
    entries.push({ ...entry, sequence: sequence++, sortTime: sortTime(entry.timestamp) });
  };

  for (const event of input.schedulerEvents) {
    const createdAt = timestamp(event.createdAt);
    const level = /error|fatal|fail/i.test(`${event.level} ${event.type}`) ? 'error' : event.level === 'warning' ? 'warning' : 'info';
    add({
      id: `scheduler:${event.id || sequence}`,
      timestamp: createdAt,
      kind: 'scheduler',
      source: '调度器',
      level,
      content: schedulerContent(event, input.existingRunEventContents),
      timestampInferred: false,
      filterTags: uniqueTags(['run', ...(level === 'error' || level === 'warning' ? ['problem' as const] : [])]),
    });
  }

  if (input.cell) {
    const cell = input.cell;
    const createdAt = timestamp(cell.createdAt);
    const grouped = new Map<string, string[]>();
    for (const [label, content] of [['输入', cell.source], ['stdout', cell.stdout], ['stderr', cell.stderr], ['输出', cell.output]] as const) {
      if (!content || ownedByExisting(content, input.existingRunEventContents)) continue;
      grouped.set(content, [...(grouped.get(content) ?? []), label]);
    }
    const parts = [...grouped].map(([content, labels]) => `${labels.join(' / ')}\n${content}`);
    if (!cell.running && (!cell.success || cell.exitCode !== 0 || (cell.stopReason && cell.stopReason !== 'completed'))) {
      parts.push(`退出码 ${cell.exitCode}${cell.stopReason ? ` · ${cell.stopReason}` : ''}`);
    }
    if (parts.length > 0) {
      const hasArtifact = Boolean(cell.stdout || cell.stderr || cell.output);
      const hasProblem = Boolean(!cell.running && (!cell.success || cell.exitCode !== 0));
      const hasWarning = Boolean(cell.stderr && !hasProblem);
      add({
        id: `cell:${cell.id}`,
        timestamp: createdAt,
        kind: 'output',
        source: 'Agent Cell',
        level: hasProblem ? 'error' : hasWarning ? 'warning' : 'info',
        content: parts.join('\n\n'),
        timestampInferred: false,
        filterTags: uniqueTags([
          ...(cell.source ? ['message' as const] : []),
          ...(hasArtifact ? ['artifact' as const] : []),
          ...(hasProblem || hasWarning ? ['problem' as const] : []),
        ]),
      });
    }
  }

  const sandboxEvents = input.sandboxRunEvents.filter(event => !input.existingRunEventIds.has(event.id));
  const sandboxEventsById = new Map(sandboxEvents.map(event => [event.id || `run-event-${event.seq}`, event]));
  for (const transcript of mapRunEventsToTranscript(sandboxEvents)) {
    const original = sandboxEventsById.get(transcript.id);
    const problem = transcript.kind === 'diagnostic';
    add({
      id: `sandbox-run:${transcript.id}`,
      timestamp: transcript.timestamp,
      kind: problem ? 'error' : 'process',
      source: 'Sandbox Run',
      level: problem ? 'error' : 'info',
      content: transcript.content,
      timestampInferred: !transcript.timestamp,
      ...(!transcript.timestamp ? { timestampBasis: 'run-start' as const } : {}),
      filterTags: uniqueTags([
        original?.kind === RunEventKind.USER_MESSAGE || original?.kind === RunEventKind.AGENT_MESSAGE ? 'message' : 'run',
        ...(original?.kind === RunEventKind.AGENT_MESSAGE ? ['artifact' as const] : []),
        ...(problem ? ['problem' as const] : []),
      ]),
    });
  }

  const terminalTimestamp = input.completedAt || input.updatedAt || input.startedAt;
  const terminalBasis = input.completedAt ? 'run-end' as const : input.updatedAt ? 'run-updated' as const : 'run-start' as const;
  for (const [id, label, content, tags] of [
    ['output', 'Agent 输出', input.output || '', ['message', 'artifact'] as RuntimeTimelineFilterTag[]],
    ['result-json', 'Result JSON', input.resultJson || '', ['artifact'] as RuntimeTimelineFilterTag[]],
  ] as const) {
    if (!content || ownedByExisting(content, input.existingRunEventContents)) continue;
    add({
      id: `run:${id}`,
      timestamp: terminalTimestamp,
      kind: id === 'output' ? 'output' : 'result',
      source: label,
      level: 'info',
      content,
      timestampInferred: true,
      timestampBasis: terminalBasis,
      filterTags: [...tags],
    });
  }
  for (const [id, label, path] of [
    ['logs-path', '运行日志位置', input.logsPath],
    ['artifacts-dir', 'Artifacts 位置', input.artifactsDir],
  ] as const) {
    if (!path) continue;
    add({
      id: `run:${id}`,
      timestamp: terminalTimestamp,
      kind: 'result',
      source: label,
      level: 'info',
      content: path,
      timestampInferred: true,
      timestampBasis: terminalBasis,
      filterTags: ['artifact'],
    });
  }

  return entries.sort((left, right) => left.sortTime - right.sortTime || left.sequence - right.sequence || left.id.localeCompare(right.id));
}
