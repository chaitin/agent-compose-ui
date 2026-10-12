// 任务信息（标题、链接）在触发事件的 payload 里，payload 不会发给浏览器；
// 由 UI server 按部署配置（SANDBOX_TASK_FIELDS）取出后经这些接口返回。
import { apiFetchJson } from './http';
import type { AutomationExecutionRecord } from '../model/sandbox-activity';
import type { TaskLink } from '../model/task-list';

type TaskLookupResponse<Key extends string> = {
  enabled?: boolean;
  tasks?: Array<{ title: string; url: string } & Record<Key, string>>;
};

/** UI server 一次最多接受这么多个查询项，超过的分批发。 */
const LOOKUP_BATCH = 500;

function batches<Item>(items: Item[]): Item[][] {
  const result: Item[][] = [];
  for (let start = 0; start < items.length; start += LOOKUP_BATCH)
    result.push(items.slice(start, start + LOOKUP_BATCH));
  return result;
}

type SandboxActivityResponse = TaskLookupResponse<'sandbox_id'> & {
  executions?: Array<{
    sandbox_id: string;
    status: string;
    trigger_kind: string;
    started_at: string;
    completed_at: string;
    duration_ms: number;
    error: string;
  }>;
};

/**
 * 每个 sandbox 最近一次自动化执行，以及这次执行处理的任务（这套部署没有配置任务字段时没有任务）。
 * 执行记录带着完整的 payload 和结果，一页有几百 KB；UI server 读完只把列表要显示的字段发回来。
 */
export async function listSandboxActivity(
  items: Array<{ sandboxId: string; projectId: string }>,
): Promise<{ tasks: Map<string, TaskLink>; executions: Map<string, AutomationExecutionRecord> }> {
  const tasks = new Map<string, TaskLink>();
  const executions = new Map<string, AutomationExecutionRecord>();
  for (const batch of batches(items)) {
    const response = await apiFetchJson<SandboxActivityResponse>('/api/ui/v1/sandbox-tasks', {
      method: 'POST',
      body: JSON.stringify({
        sandboxes: batch.map((item) => ({ sandbox_id: item.sandboxId, project_id: item.projectId })),
      }),
    });
    for (const item of response.tasks ?? []) tasks.set(item.sandbox_id, { title: item.title, url: item.url });
    for (const item of response.executions ?? [])
      executions.set(item.sandbox_id, {
        status: item.status,
        triggerKind: item.trigger_kind,
        startedAt: item.started_at,
        completedAt: item.completed_at,
        durationMs: item.duration_ms,
        error: item.error,
      });
  }
  return { tasks, executions };
}

/** 只返回带任务的事件；没有任务或读不到的事件不在结果里。 */
export async function listEventTasks(eventIds: string[]): Promise<Map<string, TaskLink>> {
  const tasks = new Map<string, TaskLink>();
  for (const batch of batches(eventIds)) {
    const response = await apiFetchJson<TaskLookupResponse<'event_id'>>('/api/ui/v1/event-tasks', {
      method: 'POST',
      body: JSON.stringify({ event_ids: batch }),
    });
    for (const item of response.tasks ?? []) tasks.set(item.event_id, { title: item.title, url: item.url });
  }
  return tasks;
}
