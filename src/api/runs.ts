import {
  RunSource,
  RunStatus,
  type RunDetail,
  type RunEvent,
  type RunSummary,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import { runClient } from './client';
import { t } from '$lib/i18n.svelte';

export type RunFilter = {
  query?: string;
  sandboxId?: string;
  status?: RunStatus;
  source?: RunSource;
  offset?: number;
  limit?: number;
};

export async function listRuns(filter: RunFilter = {}): Promise<RunSummary[]> {
  const response = await runClient.listRuns({
    sandboxId: filter.sandboxId,
    status: filter.status,
    source: filter.source,
    offset: filter.offset ?? 0,
    limit: filter.limit ?? 200,
  });
  const query = filter.query?.trim().toLowerCase();
  return query
    ? response.runs.filter((run) =>
        `${run.runId} ${run.runShortId} ${run.agentName} ${run.projectName} ${run.sandboxId}`
          .toLowerCase()
          .includes(query),
      )
    : response.runs;
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

export async function followRunLogs(
  runId: string,
  onChunk: (data: string, final: boolean) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const chunk of runClient.followRunLogs(
    { runId, tailLines: 1000, tailSet: true, follow: true, includeMetadata: true },
    { signal },
  ))
    onChunk(chunk.data, chunk.isFinal);
}

export type ProjectRunDebugTarget = { runId: string; sandboxId: string };
export async function getProjectRunDebugTarget(runId: string): Promise<ProjectRunDebugTarget> {
  const summary = (await getRun(runId)).summary;
  if (!summary) throw new Error('运行记录不存在');
  if (!summary.sandboxId) throw new Error('当前运行没有关联的调试沙箱');
  return { runId: summary.runId, sandboxId: summary.sandboxId };
}

export function runStatusName(status: RunStatus): 'running' | 'success' | 'failed' | 'skipped' | 'pending' {
  if (status === RunStatus.RUNNING) return 'running';
  if (status === RunStatus.SUCCEEDED) return 'success';
  if (status === RunStatus.FAILED || status === RunStatus.CANCELED) return 'failed';
  return 'pending';
}

export function sourceName(source: RunSource): string {
  return source === RunSource.MANUAL
    ? t('手动')
    : source === RunSource.SCHEDULER
      ? t('调度')
      : source === RunSource.API
        ? 'API'
        : t('未知');
}
export function durationName(ms: bigint): string {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
