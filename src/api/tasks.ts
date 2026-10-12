// 任务信息（标题、链接）在触发事件的 payload 里，payload 不会发给浏览器；
// 由 UI server 按部署配置（SANDBOX_TASK_FIELDS）取出后经这些接口返回。
import { apiFetchJson } from './http';
import type { TaskExecution, TaskLink, TaskSummary } from '../model/task-list';

type TaskLookupResponse<Key extends string> = {
  enabled?: boolean;
  tasks?: Array<{ title: string; url: string } & Record<Key, string>>;
};

type TaskListResponse = {
  titles_enabled?: boolean;
  truncated?: boolean;
  tasks?: Array<{
    key: string;
    correlation_id: string;
    title: string;
    url: string;
    status: string;
    started_at: string;
    latest_at: string;
    executions?: Array<{
      run_id: string;
      scheduler_id: string;
      scheduler_name: string;
      project_id: string;
      agent_name: string;
      status: string;
      started_at: string;
      completed_at: string;
      duration_ms: number;
      error: string;
      event_id: string;
      sandbox_ids?: string[];
    }>;
  }>;
};

/** enabled 为 false 表示这套部署没有配置任务字段。 */
export async function listSandboxTasks(
  items: Array<{ sandboxId: string; projectId: string }>,
): Promise<{ enabled: boolean; tasks: Map<string, TaskLink> }> {
  const response = await apiFetchJson<TaskLookupResponse<'sandbox_id'>>('/api/ui/v1/sandbox-tasks', {
    method: 'POST',
    body: JSON.stringify({
      sandboxes: items.map((item) => ({ sandbox_id: item.sandboxId, project_id: item.projectId })),
    }),
  });
  return {
    enabled: response.enabled ?? false,
    tasks: new Map((response.tasks ?? []).map((item) => [item.sandbox_id, { title: item.title, url: item.url }])),
  };
}

/** 只返回带任务的事件；没有任务或读不到的事件不在结果里。 */
export async function listEventTasks(eventIds: string[]): Promise<Map<string, TaskLink>> {
  if (eventIds.length === 0) return new Map();
  const response = await apiFetchJson<TaskLookupResponse<'event_id'>>('/api/ui/v1/event-tasks', {
    method: 'POST',
    body: JSON.stringify({ event_ids: eventIds }),
  });
  return new Map((response.tasks ?? []).map((item) => [item.event_id, { title: item.title, url: item.url }]));
}

/**
 * 最近的任务，每个任务带着为它跑过的自动化执行。titlesEnabled 为 false 时没有配置任务字段，
 * 列出的是全部自动化执行，没有标题。truncated 表示还有更早的执行没有读取。
 */
export async function listTasks(
  signal?: AbortSignal,
): Promise<{ tasks: TaskSummary[]; titlesEnabled: boolean; truncated: boolean }> {
  const response = await apiFetchJson<TaskListResponse>('/api/ui/v1/tasks', { signal });
  return {
    titlesEnabled: response.titles_enabled ?? false,
    truncated: response.truncated ?? false,
    tasks: (response.tasks ?? []).map((item) => ({
      key: item.key,
      correlationId: item.correlation_id,
      title: item.title,
      url: item.url,
      status: item.status,
      startedAt: item.started_at,
      latestAt: item.latest_at,
      executions: (item.executions ?? []).map((execution): TaskExecution => ({
        runId: execution.run_id,
        schedulerId: execution.scheduler_id,
        schedulerName: execution.scheduler_name,
        projectId: execution.project_id,
        agentName: execution.agent_name,
        status: execution.status,
        startedAt: execution.started_at,
        completedAt: execution.completed_at,
        durationMs: execution.duration_ms,
        error: execution.error,
        eventId: execution.event_id,
        sandboxIds: execution.sandbox_ids ?? [],
      })),
    })),
  };
}
