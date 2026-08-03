import { ListSchedulerEventsRequest, type ListSchedulerEventsResponse, type SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import type { RuntimeTimelineEntry, RuntimeTimelineFilterTag } from './runtime-timeline';

export async function loadSchedulerRunEvents(
  targetRunId: string,
  fetchPage: (request: ListSchedulerEventsRequest) => Promise<ListSchedulerEventsResponse>,
): Promise<SchedulerEvent[]> {
  const found: SchedulerEvent[] = [];
  let offset = 0;
  let foundStart = false;
  while (true) {
    const page = await fetchPage(new ListSchedulerEventsRequest({ limit: 500, offset }));
    for (const event of page.events) {
      if (event.runId !== targetRunId) continue;
      found.push(event);
      if (event.type === 'scheduler.run.started') foundStart = true;
    }
    if (foundStart || page.events.length === 0 || offset + page.events.length >= page.total) break;
    offset += page.events.length;
  }
  return found.sort(compareEvents);
}

function timestamp(event: SchedulerEvent): string {
  if (!event.createdAt) return '';
  return new Date(Number(event.createdAt.seconds) * 1000 + event.createdAt.nanos / 1_000_000).toISOString();
}

function eventRank(event: SchedulerEvent): number {
  if (event.type === 'scheduler.run.started') return -1;
  if (['scheduler.run.completed', 'scheduler.run.failed', 'scheduler.run.skipped'].includes(event.type)) return 1;
  return 0;
}

function compareEvents(left: SchedulerEvent, right: SchedulerEvent): number {
  return timestamp(left).localeCompare(timestamp(right)) || eventRank(left) - eventRank(right) || left.id.localeCompare(right.id);
}

function tags(event: SchedulerEvent): RuntimeTimelineFilterTag[] {
  const result = new Set<RuntimeTimelineFilterTag>();
  if (event.type.startsWith('scheduler.run.') || event.type.startsWith('scheduler.sandbox.')) result.add('run');
  else result.add('activity');
  if (/scheduler\.(?:command|llm|agent|event)\./.test(event.type) && event.payloadJson) result.add('artifact');
  if (/warn|error|fatal/i.test(event.level) || /\.failed$|\.warning$/.test(event.type)) result.add('problem');
  return [...result];
}

export function buildSchedulerRunTimeline(events: readonly SchedulerEvent[]): RuntimeTimelineEntry[] {
  return [...events]
    .sort(compareEvents)
    .map((event, sequence) => {
      const createdAt = timestamp(event);
      const isError = /error|fatal/i.test(event.level) || event.type.endsWith('.failed');
      const isWarning = /warn/i.test(event.level) || event.type.endsWith('.warning');
      return {
        id: `scheduler-event:${event.id || sequence}`,
        timestamp: createdAt,
        sortTime: createdAt ? Date.parse(createdAt) : 0,
        sequence,
        kind: event.type.startsWith('scheduler.run.') ? 'run' : event.type.startsWith('scheduler.sandbox.') ? 'sandbox' : isError ? 'error' : 'process',
        source: event.type,
        level: isError ? 'error' : isWarning ? 'warning' : 'info',
        content: [event.message, event.payloadJson].filter(Boolean).join('\n') || event.type,
        timestampInferred: false,
        filterTags: tags(event),
      } satisfies RuntimeTimelineEntry;
    });
}
