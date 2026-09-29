// 运行列表的领域逻辑：筛选条件与 URL 互转、时间窗口、按天分组、行展示字段。
// 只使用 RunSummary / RunEvent 的结构化字段，不解析日志或错误文本。
import {
  RunEventKind,
  RunSource,
  RunStatus,
  type RunEvent,
  type RunSummary,
} from '../gen/agentcompose/v2/agentcompose_pb.js';
import type { RunFilter } from '../api/runs';
import { t } from '$lib/i18n.svelte';
import { groupByDay, type DayGroup } from './day-groups';
import { timestampToISOString } from './timestamps';

export type RunStatusFilter = 'all' | 'failed' | 'running' | 'succeeded' | 'canceled';
export type RunSourceFilter = 'all' | 'manual' | 'scheduler' | 'api';
export type RunWindow = '24h' | '7d' | '30d' | 'all';

export type RunListQuery = {
  status: RunStatusFilter;
  source: RunSourceFilter;
  projectId: string;
  agentName: string;
  window: RunWindow;
};

export const DEFAULT_RUN_LIST_QUERY: RunListQuery = {
  status: 'all',
  source: 'all',
  projectId: '',
  agentName: '',
  window: '7d',
};

export const RUN_STATUS_FILTERS: Array<{ value: RunStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'canceled', label: '已取消' },
];

export const RUN_SOURCE_FILTERS: Array<{ value: RunSourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'scheduler', label: '自动化' },
  { value: 'manual', label: '手动' },
  { value: 'api', label: 'API' },
];

export const RUN_WINDOWS: Array<{ value: RunWindow; label: string }> = [
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'all', label: '全部时间' },
];

const STATUS_ENUM: Record<Exclude<RunStatusFilter, 'all'>, RunStatus> = {
  failed: RunStatus.FAILED,
  running: RunStatus.RUNNING,
  succeeded: RunStatus.SUCCEEDED,
  canceled: RunStatus.CANCELED,
};

const SOURCE_ENUM: Record<Exclude<RunSourceFilter, 'all'>, RunSource> = {
  manual: RunSource.MANUAL,
  scheduler: RunSource.SCHEDULER,
  api: RunSource.API,
};

const WINDOW_MS: Record<Exclude<RunWindow, 'all'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

function oneOf<T extends string>(value: string | null, options: Array<{ value: T }>, fallback: T): T {
  return options.some((option) => option.value === value) ? (value as T) : fallback;
}

export function runListQueryFromSearch(search: string): RunListQuery {
  const params = new URLSearchParams(search);
  return {
    status: oneOf(params.get('status'), RUN_STATUS_FILTERS, DEFAULT_RUN_LIST_QUERY.status),
    source: oneOf(params.get('source'), RUN_SOURCE_FILTERS, DEFAULT_RUN_LIST_QUERY.source),
    projectId: params.get('project') ?? '',
    agentName: params.get('agent') ?? '',
    window: oneOf(params.get('window'), RUN_WINDOWS, DEFAULT_RUN_LIST_QUERY.window),
  };
}

export function runListQueryToSearch(query: RunListQuery): string {
  const params = new URLSearchParams();
  if (query.status !== DEFAULT_RUN_LIST_QUERY.status) params.set('status', query.status);
  if (query.source !== DEFAULT_RUN_LIST_QUERY.source) params.set('source', query.source);
  if (query.projectId) params.set('project', query.projectId);
  if (query.agentName) params.set('agent', query.agentName);
  if (query.window !== DEFAULT_RUN_LIST_QUERY.window) params.set('window', query.window);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 把列表筛选转换成 ListRuns 请求；status 可以单独覆盖，用来计算各状态的数量。 */
export function runFilterFor(query: RunListQuery, now: number, status: RunStatusFilter = query.status): RunFilter {
  return {
    projectId: query.projectId || undefined,
    agentName: query.agentName || undefined,
    status: status === 'all' ? undefined : STATUS_ENUM[status],
    source: query.source === 'all' ? undefined : SOURCE_ENUM[query.source],
    startedFrom: query.window === 'all' ? undefined : new Date(now - WINDOW_MS[query.window]).toISOString(),
  };
}

export type RunState = 'running' | 'success' | 'failed' | 'stopped' | 'pending';

export function runState(status: RunStatus): RunState {
  if (status === RunStatus.RUNNING) return 'running';
  if (status === RunStatus.SUCCEEDED) return 'success';
  if (status === RunStatus.FAILED) return 'failed';
  if (status === RunStatus.CANCELED) return 'stopped';
  return 'pending';
}

export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  stopped: '已取消',
  pending: '排队中',
};

export function runStartedAt(run: RunSummary): string {
  return timestampToISOString(run.startedAt || run.createdAt);
}

export function runSourceLabel(source: RunSource): string {
  if (source === RunSource.SCHEDULER) return t('自动化');
  if (source === RunSource.MANUAL) return t('手动');
  if (source === RunSource.API) return 'API';
  return t('未知');
}

/** 触发者：自动化运行显示调度器，其余来源没有更细的结构化信息。 */
export function runTriggerDetail(run: RunSummary): string {
  return run.source === RunSource.SCHEDULER ? run.schedulerId : '';
}

export function runDuration(run: RunSummary): string {
  if (run.status === RunStatus.PENDING) return '—';
  const ms = Number(run.durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return run.status === RunStatus.RUNNING ? '' : '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 失败的运行才展示错误原文；已取消的运行由状态本身说明，不再用红色重复。 */
export function runShowsError(run: RunSummary): boolean {
  return run.status === RunStatus.FAILED;
}

export type RunDayGroup = DayGroup<RunSummary>;

export function groupRunsByDay(runs: RunSummary[], now: number): RunDayGroup[] {
  return groupByDay(runs, runStartedAt, now);
}

export type RunActivity = {
  id: string;
  at: string;
  kind: 'input' | 'reply' | 'tool' | 'status';
  text: string;
  failed: boolean;
  exitCode: number;
};

const ACTIVITY_KIND: Partial<Record<RunEventKind, RunActivity['kind']>> = {
  [RunEventKind.USER_MESSAGE]: 'input',
  [RunEventKind.AGENT_MESSAGE]: 'reply',
  [RunEventKind.AGENT_ACTIVITY]: 'tool',
  [RunEventKind.STATUS]: 'status',
};

export const RUN_ACTIVITY_LABEL: Record<RunActivity['kind'], string> = {
  input: '输入',
  reply: '回复',
  tool: '工具',
  status: '状态',
};

/** RunEvent → 活动行。失败只看 exit_code，不看文本。 */
export function runActivities(events: RunEvent[]): RunActivity[] {
  return events.map((event) => ({
    id: event.id,
    at: timestampToISOString(event.createdAt),
    kind: ACTIVITY_KIND[event.kind] ?? 'status',
    text: event.text || event.name || event.stopReason || '',
    failed: event.exitCode !== 0,
    exitCode: event.exitCode,
  }));
}

/** 相对运行开始的偏移，如 00:42、12:05。 */
export function activityOffset(at: string, startedAt: string): string {
  const offset = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(offset)) return '';
  const minutes = Math.floor(offset / 60);
  return `${String(minutes).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`;
}
