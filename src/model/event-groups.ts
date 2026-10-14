// 关联 ID 相同的事件（同一个任务的创建、控制、重试……）属于同一个任务；没有关联 ID 的事件各自一组。
// 事件列表一行一个事件，分组只用来给每个事件找到它所属的任务。只用 correlation_id 和 dispatch_status 这两个结构化字段。
import type { TopicEvent } from '../api/loaders';
import { dispatchStatus, type EventSemanticStatus } from './event-status';
import type { TaskLink } from './task-list';

export type EventGroup = {
  key: string;
  correlationId: string;
  /** 按时间倒序，第一个是最新的事件。 */
  events: TopicEvent[];
  latest: TopicEvent;
  /** 出现过的事件主题，按首次出现的顺序。 */
  topics: string[];
  /** 组内最需要注意的投递状态：死信 > 投递中/重试 > 无订阅方 > 正常。 */
  attention: EventSemanticStatus | null;
  attentionLabel: string;
  noSubscriber: number;
};

const ATTENTION_ORDER: EventSemanticStatus[] = ['failed', 'running', 'pending', 'skipped'];

/** items 需按时间倒序；分组顺序按每组最新一个事件的时间。 */
export function groupEvents(items: TopicEvent[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const item of items) {
    const key = item.correlationId ? `correlation:${item.correlationId}` : `event:${item.eventId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        correlationId: item.correlationId,
        events: [],
        latest: item,
        topics: [],
        attention: null,
        attentionLabel: '',
        noSubscriber: 0,
      };
      groups.set(key, group);
    }
    group.events.push(item);
    if (!group.topics.includes(item.topic)) group.topics.push(item.topic);
    const status = dispatchStatus(item.dispatchStatus);
    if (item.dispatchStatus === 'no_subscriber') group.noSubscriber += 1;
    if (status.semantic !== 'success' && rank(status.semantic) < rank(group.attention)) {
      group.attention = status.semantic;
      group.attentionLabel = status.label;
    }
  }
  return [...groups.values()];
}

function rank(status: EventSemanticStatus | null): number {
  if (!status) return ATTENTION_ORDER.length;
  const index = ATTENTION_ORDER.indexOf(status);
  return index < 0 ? ATTENTION_ORDER.length : index;
}

/** 一组里拿去查任务的事件：最早的两个。任务由创建类事件带着，它们排在这串事件的最前面。 */
const TASK_CANDIDATES_PER_GROUP = 2;

function earliestEvents(group: EventGroup): TopicEvent[] {
  return group.events.slice(-TASK_CANDIDATES_PER_GROUP).reverse();
}

export function taskCandidates(groups: EventGroup[]): string[] {
  return groups.flatMap((group) => earliestEvents(group).map((event) => event.eventId));
}

/** 这组事件所属的任务；还没查到或不带任务时为 null。 */
function groupTask(group: EventGroup, tasks: Record<string, TaskLink | null>): TaskLink | null {
  for (const event of earliestEvents(group)) {
    const task = tasks[event.eventId];
    if (task) return task;
  }
  return null;
}

/** 每个事件所属的任务：同一组事件共用一个任务。 */
export function tasksByEvent(groups: EventGroup[], tasks: Record<string, TaskLink | null>): Map<string, TaskLink> {
  const result = new Map<string, TaskLink>();
  for (const group of groups) {
    const task = groupTask(group, tasks);
    if (task) for (const event of group.events) result.set(event.eventId, task);
  }
  return result;
}

/** 列表按投递状态筛选：只看没人订阅的，或投递失败的。 */
export type EventStatusFilter = 'all' | 'skipped' | 'failed';

export const EVENT_STATUS_FILTERS: { value: EventStatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'skipped', label: '无订阅方' },
  { value: 'failed', label: '投递失败' },
];

export function filterEventsByStatus(items: TopicEvent[], filter: EventStatusFilter): TopicEvent[] {
  if (filter === 'all') return items;
  return items.filter((item) => dispatchStatus(item.dispatchStatus).semantic === filter);
}
