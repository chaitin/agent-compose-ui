// 事件追踪树：一个事件 → 若干自动化执行 → 每次执行启动的 Sandbox。
// 结构、状态和时间都来自 trace 接口的结构化字段；排序、折叠只看状态。
import type { TopicEventTrace, TopicEventTraceRun } from '../api/loaders';
import { deliveryStatus, type EventSemanticStatus } from './event-status';
import type { EventTimelineItem } from './event-detail';

export type TraceNode = {
  id: string;
  kind: 'execution' | 'sandbox';
  name: string;
  detail: string;
  status: EventSemanticStatus;
  statusLabel: string;
  startedAt: string;
  endedAt: string;
  error: string;
  sandboxId: string;
  schedulerRunId: string;
  trace: TopicEventTraceRun | null;
  children: TraceNode[];
  /** 触发这次执行的事件；同一任务的重试会来自不同的事件。 */
  triggerEventId: string;
  /** sandbox 节点：同一个 sandbox 在这次追踪里被几次执行使用（>1 表示被复用，日志里不止这一次）。 */
  sharedBy: number;
};

export type TraceTimeline = { from: number; to: number };

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function executionKey(trace: TopicEventTraceRun): string {
  return trace.delivery.runId || [trace.delivery.schedulerId, trace.delivery.triggerId].join(':');
}

export function buildTraceTree(trace: TopicEventTrace): TraceNode[] {
  const sandboxesByRun = new Map<string, TopicEventTrace['sandboxes']>();
  for (const item of trace.sandboxes) {
    const key = item.link.runId;
    if (!key) continue;
    const list = sandboxesByRun.get(key) ?? [];
    if (!list.some((existing) => existing.link.sandboxId === item.link.sandboxId)) list.push(item);
    sandboxesByRun.set(key, list);
  }
  const executions = trace.runs.map((item): TraceNode => {
    const status = deliveryStatus(item.run?.status || item.delivery.status);
    const startedAt = item.run?.startedAt || item.delivery.createdAt;
    const endedAt = item.run?.completedAt || (status.semantic === 'running' ? '' : item.delivery.updatedAt);
    const children = (sandboxesByRun.get(item.delivery.runId) ?? []).map((sandbox): TraceNode => ({
      // 同一个 sandbox 可能挂在多次执行下，ID 带上执行，选中时才分得清是哪一次。
      id: `sandbox:${executionKey(item)}:${sandbox.link.sandboxId}`,
      kind: 'sandbox',
      name: sandbox.sandbox?.agentName || item.scheduler?.agentName || '',
      detail: sandbox.sandbox?.title || '',
      status: status.semantic,
      statusLabel: status.label,
      startedAt: sandbox.sandbox?.createdAt || sandbox.link.createdAt,
      endedAt: sandbox.sandbox?.updatedAt || endedAt,
      error: '',
      sandboxId: sandbox.link.sandboxId,
      schedulerRunId: item.delivery.runId,
      trace: item,
      children: [],
      triggerEventId: item.delivery.eventId,
      sharedBy: 1,
    }));
    return {
      id: `execution:${executionKey(item)}`,
      kind: 'execution',
      name: item.scheduler?.name || item.delivery.schedulerId,
      detail: item.delivery.schedulerId,
      status: status.semantic,
      statusLabel: status.label,
      startedAt,
      endedAt,
      error: item.run?.error || item.delivery.error,
      sandboxId: '',
      schedulerRunId: item.delivery.runId,
      trace: item,
      children,
      triggerEventId: item.delivery.eventId,
      sharedBy: 1,
    };
  });
  executions.sort((left, right) => (time(left.startedAt) || 0) - (time(right.startedAt) || 0));
  const usage = new Map<string, number>();
  for (const node of executions)
    for (const child of node.children) usage.set(child.sandboxId, (usage.get(child.sandboxId) ?? 0) + 1);
  for (const node of executions) for (const child of node.children) child.sharedBy = usage.get(child.sandboxId) ?? 1;
  return executions;
}

export type TraceSummary = {
  executions: number;
  failed: number;
  succeeded: number;
  last: TraceNode | undefined;
};

export function traceSummary(nodes: TraceNode[]): TraceSummary {
  return {
    executions: nodes.length,
    failed: nodes.filter((node) => node.status === 'failed').length,
    succeeded: nodes.filter((node) => node.status === 'success').length,
    last: nodes.at(-1),
  };
}

export function traceTimeline(eventAt: string, nodes: TraceNode[]): TraceTimeline {
  const from = time(eventAt);
  const ends = nodes.flatMap((node) => [node, ...node.children]).map((node) => time(node.endedAt || node.startedAt));
  const to = Math.max(from + 1000, ...ends.filter(Number.isFinite));
  return { from, to };
}

/** 节点在时间轴上的位置（百分比）；时间缺失时返回 null。 */
export function barPosition(node: TraceNode, timeline: TraceTimeline): { left: number; width: number } | null {
  const start = time(node.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(timeline.from)) return null;
  const end = time(node.endedAt);
  const span = timeline.to - timeline.from;
  const left = Math.max(0, Math.min(100, ((start - timeline.from) / span) * 100));
  const width = Number.isFinite(end) ? Math.max(0.6, ((end - start) / span) * 100) : Math.max(0.6, 100 - left);
  return { left, width: Math.min(width, 100 - left) };
}

export function offsetLabel(value: string, from: string): string {
  const seconds = Math.round((time(value) - time(from)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `+${Math.max(0, seconds)}s`;
  if (seconds < 3600) return `+${Math.floor(seconds / 60)}m`;
  return `+${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}

export function spanLabel(from: string, to: string): string {
  const ms = time(to) - time(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function defaultSelection(nodes: TraceNode[]): string {
  // 最后一次失败的执行最接近现状；没有失败就看最后一次。有 sandbox 时选它，右侧直接是日志。
  const target = [...nodes].reverse().find((node) => node.status === 'failed') ?? nodes.at(-1);
  return target?.children[0]?.id ?? target?.id ?? '';
}

export function findTraceNode(nodes: TraceNode[], id: string): TraceNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children.find((candidate) => candidate.id === id);
    if (child) return child;
  }
  return undefined;
}

/** 选中 Sandbox 时，把关联的调度事件作为日志上下文交给工作台。 */
export function sandboxContextEntries(nodes: TraceNode[], sandboxId: string): EventTimelineItem[] {
  return nodes
    .map((node) => node.trace)
    .filter((trace): trace is TopicEventTraceRun => Boolean(trace))
    .filter((trace) => trace.events.some((item) => item.linkedSessionId === sandboxId))
    .flatMap((trace) =>
      trace.events.map((item) => ({ id: item.id, createdAt: item.createdAt, type: item.type, message: item.message })),
    );
}

/** 事件 → 它扇出的自动化执行。同一个任务（关联 ID）的多次事件各成一组，按时间排列。 */
export type TraceBranch = {
  eventId: string;
  topic: string;
  receivedAt: string;
  dispatchStatus: string;
  /** 这是任务的第几个事件（从 1 开始）。 */
  order: number;
  executions: TraceNode[];
  /** 这组里最需要注意的执行状态：失败 > 运行中 > 其它；没有执行时为 null。 */
  status: EventSemanticStatus | null;
};

type BranchEvent = { eventId: string; topic: string; createdAt: string; dispatchStatus: string };

/**
 * 按触发事件分组。events 是这个任务的全部事件（含没有触发执行的）；
 * 执行里出现、但不在 events 里的事件（比如事件列表只取了一页）也会补成一组。
 */
export function traceBranches(nodes: TraceNode[], events: BranchEvent[]): TraceBranch[] {
  const known = new Map(events.map((item) => [item.eventId, item]));
  for (const node of nodes)
    if (node.triggerEventId && !known.has(node.triggerEventId))
      known.set(node.triggerEventId, {
        eventId: node.triggerEventId,
        topic: '',
        createdAt: node.trace?.delivery.createdAt || node.startedAt,
        dispatchStatus: '',
      });
  const branches = [...known.values()]
    .sort((left, right) => (time(left.createdAt) || 0) - (time(right.createdAt) || 0))
    .map((item, index): TraceBranch => {
      const executions = nodes.filter((node) => node.triggerEventId === item.eventId);
      const status = executions.some((node) => node.status === 'failed')
        ? 'failed'
        : executions.some((node) => node.status === 'running')
          ? 'running'
          : (executions[0]?.status ?? null);
      return {
        eventId: item.eventId,
        topic: item.topic,
        receivedAt: item.createdAt,
        dispatchStatus: item.dispatchStatus,
        order: index + 1,
        executions,
        status,
      };
    });
  return branches;
}
