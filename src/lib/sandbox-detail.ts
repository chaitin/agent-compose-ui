import type {
  ListSandboxHistoryResponse,
  ListSandboxRunEventsResponse,
  RunEvent,
  Sandbox,
  SandboxHistoryCell,
  SandboxHistoryEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';

export interface SandboxDetailSnapshot {
  sandbox: Sandbox;
  cells: SandboxHistoryCell[];
  events: SandboxHistoryEvent[];
  runEvents: RunEvent[];
  legacyHistory: boolean;
}

export interface SandboxTimelineEntry {
  id: string;
  timestamp: string;
  sortTime: number;
  kind: 'cell' | 'sandbox' | 'run';
  label: string;
  source: string;
  content: string;
  level: 'info' | 'error';
  sections?: SandboxTimelineSection[];
}

export interface SandboxTimelineSection {
  label: string;
  content: string;
  collapsible: boolean;
}

function timestamp(value?: { seconds: bigint; nanos: number }): string {
  if (!value) return '';
  return new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000).toISOString();
}

export function buildSandboxTimeline(snapshot: SandboxDetailSnapshot): SandboxTimelineEntry[] {
  const entries: SandboxTimelineEntry[] = [];
  for (const cell of snapshot.cells) {
    const createdAt = timestamp(cell.createdAt);
    const duplicatedSuccessfulStderr = !cell.running
      && cell.success
      && cell.exitCode === 0
      && Boolean(cell.stderr)
      && cell.stderr === cell.output;
    const visibleStderr = duplicatedSuccessfulStderr ? '' : cell.stderr;
    const agentProcessStderr = cell.type === 'agent'
      && (cell.running || (cell.success && cell.exitCode === 0));
    const stderrLabel = agentProcessStderr ? '执行过程' : '标准错误';
    const status = !cell.running ? `退出码 ${cell.exitCode}${cell.stopReason ? ` · ${cell.stopReason}` : ''}` : '';
    const parts = [
      cell.source && `输入\n${cell.source}`,
      cell.stdout && `标准输出\n${cell.stdout}`,
      visibleStderr && `${stderrLabel}\n${visibleStderr}`,
      cell.output && `结果\n${cell.output}`,
      status,
    ].filter(Boolean);
    const sections = [
      cell.source && { label: '输入', content: cell.source, collapsible: true },
      cell.stdout && { label: '标准输出', content: cell.stdout, collapsible: false },
      visibleStderr && { label: stderrLabel, content: visibleStderr, collapsible: agentProcessStderr },
      cell.output && { label: '结果', content: cell.output, collapsible: true },
      status && { label: '状态', content: status, collapsible: false },
    ].filter((section): section is SandboxTimelineSection => Boolean(section));
    entries.push({
      id: `cell:${cell.id}`,
      timestamp: createdAt,
      sortTime: createdAt ? Date.parse(createdAt) : 0,
      kind: 'cell',
      label: cell.agent || cell.type || 'Cell',
      source: cell.agentThreadId ? `Thread ${cell.agentThreadId}` : cell.id,
      content: parts.join('\n\n') || (cell.running ? '运行中' : cell.success ? '成功' : '无输出'),
      level: (visibleStderr && !agentProcessStderr) || (!cell.running && !cell.success) ? 'error' : 'info',
      sections,
    });
  }
  for (const event of snapshot.events) {
    const createdAt = timestamp(event.createdAt);
    entries.push({
      id: `sandbox:${event.id}`,
      timestamp: createdAt,
      sortTime: createdAt ? Date.parse(createdAt) : 0,
      kind: 'sandbox',
      label: event.type || 'Sandbox 事件',
      source: event.level || 'sandbox',
      content: event.message || '无内容',
      level: /error|fatal|failed/i.test(event.level) ? 'error' : 'info',
    });
  }
  for (const event of snapshot.runEvents) {
    const createdAt = timestamp(event.createdAt);
    const content = [event.text, event.payloadJson, event.stopReason && `停止原因：${event.stopReason}`].filter(Boolean).join('\n');
    entries.push({
      id: `run:${event.id}`,
      timestamp: createdAt,
      sortTime: createdAt ? Date.parse(createdAt) : 0,
      kind: 'run',
      label: event.name || event.agent || 'Run 事件',
      source: event.runId || 'run',
      content: content || `退出码 ${event.exitCode}`,
      level: event.success || (!event.stopReason && event.exitCode === 0) ? 'info' : 'error',
    });
  }
  return entries.sort((left, right) => left.sortTime - right.sortTime || left.id.localeCompare(right.id));
}

export function buildSandboxDetailSnapshot(
  sandbox: Sandbox,
  history: ListSandboxHistoryResponse,
  runHistory: ListSandboxRunEventsResponse,
): SandboxDetailSnapshot {
  return {
    sandbox,
    cells: [...history.cells],
    events: [...history.events],
    runEvents: [...runHistory.events],
    legacyHistory: history.legacyHistory,
  };
}
