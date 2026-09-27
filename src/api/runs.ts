import {
  RunSource,
  RunStatus,
  type RunDetail,
  type RunEvent,
  RunSummary,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { runClient } from './client';
import { t } from '$lib/i18n.svelte';
import { isoStringToTimestamp } from '../model/timestamps';
import { textBetween } from '../model/log-buffer';
import { listProjectAgentContext } from './agents';

export type RunFilter = {
  projectId?: string;
  agentName?: string;
  schedulerId?: string;
  schedulerRunId?: string;
  sandboxId?: string;
  status?: RunStatus;
  source?: RunSource;
  startedFrom?: string;
  startedTo?: string;
  offset?: number;
  limit?: number;
};

export type RunActor = {
  projectId: string;
  projectName: string;
  agentName: string;
  agentLabel: string;
};

export async function listRuns(filter: RunFilter = {}): Promise<RunSummary[]> {
  return (await listRunsPage(filter)).runs;
}

/** 同 listRuns，但保留服务端的匹配总数，用于分页与筛选计数。 */
export async function listRunsPage(
  filter: RunFilter = {},
  signal?: AbortSignal,
): Promise<{ runs: RunSummary[]; total: number }> {
  const response = await runClient.listRuns(
    {
      projectId: filter.projectId,
      agentName: filter.agentName,
      schedulerId: filter.schedulerId,
      schedulerRunId: filter.schedulerRunId,
      sandboxId: filter.sandboxId,
      status: filter.status,
      source: filter.source,
      startedFrom: isoStringToTimestamp(filter.startedFrom),
      startedTo: isoStringToTimestamp(filter.startedTo),
      offset: filter.offset ?? 0,
      limit: filter.limit ?? 200,
    },
    { signal },
  );
  return { runs: response.runs, total: response.total };
}

export async function listRunActors(): Promise<RunActor[]> {
  const context = await listProjectAgentContext();
  const actors = context.agents.map((agent) => ({
    projectId: agent.projectId,
    projectName: agent.projectName,
    agentName: agent.agentName,
    agentLabel: agent.name,
  }));
  return actors.sort(
    (left, right) =>
      left.projectName.localeCompare(right.projectName) || left.agentLabel.localeCompare(right.agentLabel),
  );
}

export async function getRun(runId: string): Promise<RunDetail> {
  const response = await runClient.getRun({ runId });
  if (!response.run) throw new Error('运行记录不存在');
  return response.run;
}

export async function stopRun(runId: string): Promise<void> {
  await runClient.stopRun({ runId, reason: 'stopped from web UI' });
}
export async function listRunEvents(runId: string): Promise<RunEvent[]> {
  return (await runClient.listRunEvents({ runId, limit: 500 })).events;
}

/**
 * 只取运行最后的若干条事件。事件按序号升序返回：先取一页拿到总数，
 * 事件不多时一次就够；否则再按总数定位到最后一页。
 */
export async function listRunEventsTail(runId: string, count: number): Promise<RunEvent[]> {
  const probe = Math.max(count, 20);
  const first = await runClient.listRunEvents({ runId, limit: probe });
  if (first.total <= probe) return first.events.slice(-count);
  const offset = Math.max(0, first.total - count);
  return (await runClient.listRunEvents({ runId, limit: count, offset })).events;
}

export type RunLogChunk = {
  data: string;
  /** Byte offset after this chunk. The first data chunk's previous offset is the window start. */
  offset: bigint;
  final: boolean;
};

export type FollowRunLogsOptions = {
  follow?: boolean;
  projectId?: string;
  /**
   * Recent newline-delimited lines. Omit for the full history.
   * Run detail keeps the full history; event and sandbox logs must pass this explicitly.
   */
  tailLines?: number;
  /** Byte offset. Used to read earlier than an observed tail window; not a line number. */
  startOffset?: bigint;
};

export async function followRunLogs(
  runId: string,
  onChunk: (chunk: RunLogChunk) => void,
  signal?: AbortSignal,
  options: FollowRunLogsOptions = {},
): Promise<void> {
  // Default remains the complete persisted log. An omitted tail is full history
  // on the server; do not infer a tail here. Callers that only render a window
  // must pass tailLines or startOffset themselves.
  const tailLines = options.tailLines ?? 0;
  const tailSet = options.tailLines != null;
  for await (const chunk of runClient.followRunLogs(
    {
      projectId: options.projectId,
      runId,
      follow: options.follow ?? true,
      includeMetadata: true,
      startOffset: options.startOffset ?? 0n,
      tailLines,
      tailSet,
    },
    { signal },
  ))
    onChunk({ data: chunk.data, offset: chunk.offset, final: chunk.isFinal });
}

/**
 * 读取日志里 [from, until) 这一段字节，给「加载更早」用。
 * FollowRunLogs 只能指定起点，读到 until 就主动断开，避免把之后的内容也读下来。
 */
export async function readRunLogRange(
  runId: string,
  projectId: string,
  from: bigint,
  until: bigint,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let text = '';
  let reached = false;
  try {
    await followRunLogs(
      runId,
      (chunk) => {
        // 按起点和终点都截一遍：不依赖后端一定从 startOffset 开始返回。
        text += textBetween(chunk, from, until);
        if (chunk.offset >= until) {
          reached = true;
          controller.abort();
        }
      },
      controller.signal,
      { follow: false, projectId, startOffset: from },
    );
  } catch (cause) {
    if (!reached) throw cause;
  }
  return text;
}

export type ProjectRunDebugTarget = { runId: string; sandboxId: string };
export async function getProjectRunDebugTarget(runId: string): Promise<ProjectRunDebugTarget> {
  const summary = (await getRun(runId)).summary;
  if (!summary) throw new Error('运行记录不存在');
  if (!summary.sandboxId) throw new Error('当前运行没有关联的调试沙箱');
  return { runId: summary.runId, sandboxId: summary.sandboxId };
}

export function runStatusName(status: RunStatus): 'running' | 'success' | 'failed' | 'stopped' | 'pending' {
  if (status === RunStatus.RUNNING) return 'running';
  if (status === RunStatus.SUCCEEDED) return 'success';
  if (status === RunStatus.FAILED) return 'failed';
  if (status === RunStatus.CANCELED) return 'stopped';
  return 'pending';
}

export function sourceName(source: RunSource): string {
  return source === RunSource.MANUAL
    ? t('手动')
    : source === RunSource.SCHEDULER
      ? t('自动化')
      : source === RunSource.API
        ? 'API'
        : t('未知');
}
export function durationName(ms: bigint): string {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
