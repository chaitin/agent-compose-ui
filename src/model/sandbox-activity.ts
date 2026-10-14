// 活动页的一行是一个 sandbox：这里把它最近一次执行整理成行上要显示的内容。
// 只使用自动化执行和 RunSummary 的结构化字段。
import { RunStatus, type RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
import { t } from '$lib/i18n.svelte';
import { triggerKindLabel } from './presentation';
import { RUN_STATE_LABEL, runSourceLabel, runStartedAt, runState } from './run-list';
import { timestampToISOString } from './timestamps';

export type SandboxExecution = {
  /** StatusBadge 认识的状态词。 */
  status: string;
  statusLabel: string;
  running: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string;
  /** 这次执行从哪来；没有任务标题时用它做行的主标签。 */
  origin: string;
};

/** 一次自动化执行里列表要用到的字段，由 UI server 给出。 */
export type AutomationExecutionRecord = {
  status: string;
  triggerKind: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string;
};

const AUTOMATION_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  skipped: '跳过',
};

export function automationExecution(run: AutomationExecutionRecord): SandboxExecution {
  const status = run.status;
  return {
    status,
    statusLabel: AUTOMATION_STATUS_LABEL[status] ?? '等待中',
    running: status === 'running',
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    error: run.error,
    origin: `${t('自动化')} · ${t(triggerKindLabel(run.triggerKind))}`,
  };
}

/** 直接调用智能体的运行；自动化建的 sandbox 没有这类记录。 */
export function directExecution(run: RunSummary): SandboxExecution {
  const state = runState(run.status);
  return {
    status: state,
    statusLabel: RUN_STATE_LABEL[state],
    running: run.status === RunStatus.RUNNING,
    startedAt: runStartedAt(run),
    completedAt: timestampToISOString(run.completedAt),
    durationMs: Number(run.durationMs),
    error: run.error,
    origin: runSourceLabel(run.source),
  };
}

/** 最近一次执行的耗时；仍在运行时算到 now。 */
export function executionDuration(execution: SandboxExecution, now: number): string {
  const elapsed = execution.running
    ? now - Date.parse(execution.startedAt)
    : execution.durationMs || Date.parse(execution.completedAt) - Date.parse(execution.startedAt);
  const seconds = Math.round(elapsed / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
