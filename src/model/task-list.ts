// 任务列表：一个任务是关联 ID 相同的一组自动化执行（没有关联 ID 的执行各自成一个任务）。
// 状态、时间都来自 UI server 返回的结构化字段。
import { groupByDay, type DayGroup } from './day-groups';

/** 任务标题和（可能为空的）任务页面链接。 */
export type TaskLink = { title: string; url: string };

export type TaskExecution = {
  runId: string;
  schedulerId: string;
  schedulerName: string;
  projectId: string;
  agentName: string;
  status: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string;
  eventId: string;
  sandboxIds: string[];
};

export type TaskSummary = TaskLink & {
  key: string;
  correlationId: string;
  status: string;
  startedAt: string;
  latestAt: string;
  /** 按开始时间正序。 */
  executions: TaskExecution[];
};

export type TaskStatusFilter = 'all' | 'failed' | 'running' | 'succeeded';

export const TASK_STATUS_FILTERS: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
];

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  skipped: '跳过',
  pending: '等待中',
};

export function taskStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function taskStatusCounts(tasks: TaskSummary[]): Record<TaskStatusFilter, number> {
  const counts: Record<TaskStatusFilter, number> = { all: tasks.length, failed: 0, running: 0, succeeded: 0 };
  for (const task of tasks)
    if (task.status === 'failed' || task.status === 'running' || task.status === 'succeeded') counts[task.status] += 1;
  return counts;
}

export function filterTasks(tasks: TaskSummary[], status: TaskStatusFilter, query: string): TaskSummary[] {
  const needle = query.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      (status === 'all' || task.status === status) &&
      (!needle ||
        task.title.toLowerCase().includes(needle) ||
        task.executions.some((execution) => executionName(execution).toLowerCase().includes(needle))),
  );
}

export function groupTasksByDay(tasks: TaskSummary[], now: number): DayGroup<TaskSummary>[] {
  return groupByDay(tasks, (task) => task.latestAt, now);
}

export function executionName(execution: TaskExecution): string {
  return execution.schedulerName || execution.agentName;
}

/** 实际处理任务的那次执行：最后开始的一次。前面的执行是把任务转交过来的环节。 */
export function taskWorker(task: TaskSummary): TaskExecution | undefined {
  return task.executions.at(-1);
}

/** 列表行的主标签：有任务标题用标题，否则用处理它的自动化名称。 */
export function taskLabel(task: TaskSummary): string {
  const worker = taskWorker(task);
  return task.title || (worker ? executionName(worker) : '');
}

/** 处理任务的自动化一共为它执行了几次；大于 1 说明任务被重试或重新触发过。 */
export function taskAttempts(task: TaskSummary): number {
  const worker = taskWorker(task);
  return worker ? task.executions.filter((execution) => execution.schedulerId === worker.schedulerId).length : 0;
}

/** 列表行要显示的失败原因：处理任务的那次执行失败时的错误原文。 */
export function taskError(task: TaskSummary): string {
  const worker = taskWorker(task);
  return worker?.status === 'failed' ? worker.error : '';
}

/** 点开任务时落在处理它的那次执行的触发事件上，那一页直接显示这次执行的日志。 */
export function taskHref(task: TaskSummary): string {
  const worker = taskWorker(task);
  if (worker?.eventId) return `/tasks/${encodeURIComponent(worker.eventId)}`;
  if (worker)
    return `/automation-runs/${encodeURIComponent(worker.runId)}?loaderId=${encodeURIComponent(worker.schedulerId)}`;
  return '';
}

/** 处理任务的那次执行的耗时；任务可能隔几天被重新触发，从头算到尾没有意义。仍在运行时算到 now。 */
export function taskDuration(task: TaskSummary, now: number): string {
  const worker = taskWorker(task);
  if (!worker) return '—';
  const elapsed =
    worker.status === 'running'
      ? now - Date.parse(worker.startedAt)
      : worker.durationMs || Date.parse(worker.completedAt) - Date.parse(worker.startedAt);
  const seconds = Math.round(elapsed / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
