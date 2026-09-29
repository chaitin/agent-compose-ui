// Webhook 事件按「任务」分组：关联 ID 相同的事件（同一个任务的创建、控制、重试……）合成一行。
// 没有关联 ID 的事件各自单独一行。只用 correlation_id 和 dispatch_status 这两个结构化字段。
import type { TopicEvent } from '../api/loaders';
import { dispatchStatus, type EventSemanticStatus } from './event-status';

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
