import {
  RunSource,
  RunStatus,
  type RunDetail,
  type RunEvent,
  RunSummary,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import type { JsonValue } from '@bufbuild/protobuf';
import { runClient } from './client';
import { t } from '$lib/i18n.svelte';
import { apiFetchJson } from './http';
import { isoStringToTimestamp } from '../model/timestamps';
import { listProjectViews } from './projects';

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
  const response = await runClient.listRuns({
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
  });
  return response.runs;
}

export async function listUnlinkedRuns(
  cursor = 0,
  limit = 50,
): Promise<{ runs: RunSummary[]; nextCursor: number; hasMore: boolean }> {
  const response = await apiFetchJson<{ items?: JsonValue[]; nextCursor?: number; hasMore?: boolean }>(
    `/api/ui/v1/runs/unlinked?cursor=${cursor}&limit=${limit}`,
  );
  return {
    runs: (response.items ?? []).map((item) => RunSummary.fromJson(item)),
    nextCursor: Number(response.nextCursor ?? cursor),
    hasMore: Boolean(response.hasMore),
  };
}

export async function listRunActors(): Promise<RunActor[]> {
  const actors: RunActor[] = [];
  for (const project of await listProjectViews()) {
    for (const agent of project.agents) {
      actors.push({
        projectId: project.projectId,
        projectName: project.name,
        agentName: agent.agentName,
        agentLabel: agent.displayName || agent.agentName,
      });
    }
  }
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

export async function followRunLogs(
  runId: string,
  onChunk: (data: string, final: boolean) => void,
  signal?: AbortSignal,
  follow = true,
  projectId?: string,
): Promise<void> {
  // Always request the complete persisted log before following live output.
  // In particular, do not use a tail/start offset when opening a run detail
  // page: the server treats an omitted tail as the full log history.
  for await (const chunk of runClient.followRunLogs(
    { projectId, runId, follow, includeMetadata: true, startOffset: 0n, tailLines: 0, tailSet: false },
    { signal },
  )) onChunk(chunk.data, chunk.isFinal);
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
