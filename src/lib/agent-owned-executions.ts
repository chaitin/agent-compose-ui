import { RunSource, RunStatus, type RunSummary, type SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import { stableProjectRunId } from './run-scheduler-evidence';

export type SchedulerExecutionStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'unknown';
export type SchedulerCapability = 'agent' | 'llm' | 'command' | 'event' | 'sandbox' | 'log';

export interface SchedulerOwnedExecution {
  schedulerRunId: string;
  triggerId: string;
  status: SchedulerExecutionStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  capabilities: SchedulerCapability[];
  sandboxIds: string[];
  warningCount: number;
  error: string;
  events: SchedulerEvent[];
  historyComplete: boolean;
}

export interface AgentOwnedExecution {
  id: string;
  kind: 'project-run' | 'scheduler-run';
  projectRunId: string;
  schedulerRunId: string;
  triggerId: string;
  source: RunSource;
  status: SchedulerExecutionStatus | 'pending' | 'canceled';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  capabilities: SchedulerCapability[];
  sandboxIds: string[];
  warningCount: number;
  error: string;
  projectRun?: RunSummary;
  schedulerExecution?: SchedulerOwnedExecution;
}

export interface AgentOwnedExecutionFilters {
  source: RunSource;
  status: RunStatus;
  startedFrom: string;
  startedTo: string;
  sandboxId: string;
}

function eventTimestamp(event: SchedulerEvent): string {
  if (!event.createdAt) return '';
  return new Date(Number(event.createdAt.seconds) * 1000 + event.createdAt.nanos / 1_000_000).toISOString();
}

const capabilityOrder: SchedulerCapability[] = ['agent', 'llm', 'command', 'event', 'sandbox', 'log'];

export function schedulerEventCapabilities(events: readonly SchedulerEvent[]): SchedulerCapability[] {
  const found = new Set<SchedulerCapability>();
  for (const event of events) {
    if (event.type.startsWith('loader.agent.')) found.add('agent');
    else if (event.type.startsWith('loader.llm.')) found.add('llm');
    else if (event.type.startsWith('loader.command.')) found.add('command');
    else if (event.type.startsWith('loader.event.')) found.add('event');
    else if (event.type.startsWith('loader.sandbox.')) found.add('sandbox');
    else if (event.type === 'loader.log') found.add('log');
  }
  return capabilityOrder.filter(value => found.has(value));
}

function collectSandboxIds(value: unknown, target: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectSandboxIds(item, target);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'sandboxId' || key === 'sandbox_id') && typeof child === 'string' && child.trim()) target.add(child.trim());
    else collectSandboxIds(child, target);
  }
}

function schedulerSandboxIds(events: readonly SchedulerEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    try { collectSandboxIds(JSON.parse(event.payloadJson || '{}'), ids); } catch {}
  }
  return [...ids];
}

export function groupSchedulerExecutions(events: readonly SchedulerEvent[]): SchedulerOwnedExecution[] {
  const groups = new Map<string, SchedulerEvent[]>();
  for (const event of events) {
    if (!event.runId) continue;
    const group = groups.get(event.runId) ?? [];
    group.push(event);
    groups.set(event.runId, group);
  }
  const results: SchedulerOwnedExecution[] = [];
  for (const [schedulerRunId, values] of groups) {
    const ordered = [...values].sort((left, right) => eventTimestamp(left).localeCompare(eventTimestamp(right)) || left.id.localeCompare(right.id));
    const started = ordered.find(event => event.type === 'loader.run.started');
    const terminal = [...ordered].reverse().find(event => ['loader.run.completed', 'loader.run.failed', 'loader.run.skipped'].includes(event.type));
    let status: SchedulerExecutionStatus = started ? 'running' : 'unknown';
    if (terminal?.type === 'loader.run.completed') status = 'succeeded';
    if (terminal?.type === 'loader.run.failed') status = 'failed';
    if (terminal?.type === 'loader.run.skipped') status = 'skipped';
    const startedAt = started ? eventTimestamp(started) : '';
    const completedAt = terminal ? eventTimestamp(terminal) : '';
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(completedAt);
    results.push({
      schedulerRunId,
      triggerId: ordered.find(event => event.triggerId)?.triggerId ?? '',
      status,
      startedAt,
      completedAt,
      durationMs: Number.isNaN(startMs) || Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startMs),
      capabilities: schedulerEventCapabilities(ordered),
      sandboxIds: schedulerSandboxIds(ordered),
      warningCount: ordered.filter(event => /warn/i.test(event.level) || event.type.includes('.warning')).length,
      error: [...ordered].reverse().find(event => /error|fatal/i.test(event.level) || event.type.endsWith('.failed'))?.message ?? '',
      events: ordered,
      historyComplete: Boolean(started),
    });
  }
  return results.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.schedulerRunId.localeCompare(left.schedulerRunId));
}

function projectStatus(status: RunStatus): AgentOwnedExecution['status'] {
  if (status === RunStatus.PENDING) return 'pending';
  if (status === RunStatus.RUNNING) return 'running';
  if (status === RunStatus.SUCCEEDED) return 'succeeded';
  if (status === RunStatus.FAILED) return 'failed';
  if (status === RunStatus.CANCELED) return 'canceled';
  return 'unknown';
}

export async function mergeAgentOwnedExecutions(
  projectRuns: readonly RunSummary[],
  schedulerExecutions: readonly SchedulerOwnedExecution[],
  context: { projectId: string; agentName: string },
): Promise<AgentOwnedExecution[]> {
  const schedulerByProjectRun = new Map<string, SchedulerOwnedExecution>();
  for (const execution of schedulerExecutions) {
    const terminalAgentRunCount = execution.events.filter(event => event.type === 'loader.agent.completed' || event.type === 'loader.agent.failed').length;
    const agentRunCount = terminalAgentRunCount + Number(execution.status === 'running');
    for (let sequence = 1; sequence <= agentRunCount; sequence++) {
      const clientRequestId = `${execution.schedulerRunId}:agent:${sequence}`;
      schedulerByProjectRun.set(await stableProjectRunId(context.projectId, context.agentName, 'scheduler', clientRequestId), execution);
    }
  }
  const consumed = new Set<string>();
  const merged: AgentOwnedExecution[] = projectRuns.map(run => {
    const scheduler = schedulerByProjectRun.get(run.runId);
    if (scheduler) consumed.add(scheduler.schedulerRunId);
    return {
      id: run.runId,
      kind: 'project-run',
      projectRunId: run.runId,
      schedulerRunId: scheduler?.schedulerRunId ?? '',
      triggerId: run.triggerId || scheduler?.triggerId || '',
      source: run.source,
      status: projectStatus(run.status),
      startedAt: run.startedAt || scheduler?.startedAt || '',
      completedAt: run.completedAt || scheduler?.completedAt || '',
      durationMs: Number(run.durationMs) || scheduler?.durationMs || 0,
      capabilities: scheduler?.capabilities ?? [],
      sandboxIds: [...new Set([run.sandboxId, ...(scheduler?.sandboxIds ?? [])].filter(Boolean))],
      warningCount: run.warnings.length + (scheduler?.warningCount ?? 0),
      error: run.error || scheduler?.error || '',
      projectRun: run,
      schedulerExecution: scheduler,
    };
  });
  for (const scheduler of schedulerExecutions) {
    if (consumed.has(scheduler.schedulerRunId)) continue;
    merged.push({
      id: `scheduler:${scheduler.schedulerRunId}`,
      kind: 'scheduler-run',
      projectRunId: '',
      schedulerRunId: scheduler.schedulerRunId,
      triggerId: scheduler.triggerId,
      source: RunSource.SCHEDULER,
      status: scheduler.status,
      startedAt: scheduler.startedAt,
      completedAt: scheduler.completedAt,
      durationMs: scheduler.durationMs,
      capabilities: scheduler.capabilities,
      sandboxIds: scheduler.sandboxIds,
      warningCount: scheduler.warningCount,
      error: scheduler.error,
      schedulerExecution: scheduler,
    });
  }
  return merged.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
}

function runStatusFilter(status: AgentOwnedExecution['status']): RunStatus {
  if (status === 'pending') return RunStatus.PENDING;
  if (status === 'running') return RunStatus.RUNNING;
  if (status === 'succeeded') return RunStatus.SUCCEEDED;
  if (status === 'failed') return RunStatus.FAILED;
  if (status === 'canceled') return RunStatus.CANCELED;
  return RunStatus.UNSPECIFIED;
}

export function filterAgentOwnedExecutions(items: readonly AgentOwnedExecution[], filters: AgentOwnedExecutionFilters): AgentOwnedExecution[] {
  const from = filters.startedFrom ? new Date(`${filters.startedFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const to = filters.startedTo ? new Date(`${filters.startedTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  const sandbox = filters.sandboxId.trim();
  return items.filter(item => {
    if (filters.source !== RunSource.UNSPECIFIED && item.source !== filters.source) return false;
    if (filters.status !== RunStatus.UNSPECIFIED && runStatusFilter(item.status) !== filters.status) return false;
    if (sandbox && !item.sandboxIds.includes(sandbox)) return false;
    if (filters.startedFrom || filters.startedTo) {
      const started = Date.parse(item.startedAt);
      if (Number.isNaN(started) || started < from || started > to) return false;
    }
    return true;
  });
}
