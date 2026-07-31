import { ListSchedulerEventsRequest, type ListSchedulerEventsResponse, type SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import type { RuntimeTimelineEntry, RuntimeTimelineFilterTag } from './runtime-timeline';

export async function loadSchedulerRunEvents(
  targetRunId: string,
  fetchPage: (request: ListSchedulerEventsRequest) => Promise<ListSchedulerEventsResponse>,
): Promise<SchedulerEvent[]> {
  const found: SchedulerEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor = '';
  let foundStart = false;
  while (true) {
    const page = await fetchPage(new ListSchedulerEventsRequest({ limit: 500, cursor }));
    for (const event of page.events) {
      if (event.runId !== targetRunId) continue;
      found.push(event);
      if (event.type === 'loader.run.started') foundStart = true;
    }
    if (foundStart || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw new Error('Scheduler event pagination returned repeated cursor');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return found.sort(compareEvents);
}

function timestamp(event: SchedulerEvent): string {
  if (!event.createdAt) return '';
  return new Date(Number(event.createdAt.seconds) * 1000 + event.createdAt.nanos / 1_000_000).toISOString();
}

function eventRank(event: SchedulerEvent): number {
  if (event.type === 'loader.run.started') return -1;
  if (['loader.run.completed', 'loader.run.failed', 'loader.run.skipped'].includes(event.type)) return 1;
  return 0;
}

function compareEvents(left: SchedulerEvent, right: SchedulerEvent): number {
  return timestamp(left).localeCompare(timestamp(right)) || eventRank(left) - eventRank(right) || left.id.localeCompare(right.id);
}

function tags(event: SchedulerEvent): RuntimeTimelineFilterTag[] {
  const result = new Set<RuntimeTimelineFilterTag>();
  if (event.type.startsWith('loader.run.') || event.type.startsWith('loader.sandbox.')) result.add('run');
  else result.add('activity');
  if (/loader\.(?:command|llm|agent|event)\./.test(event.type) && event.payloadJson) result.add('artifact');
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
        kind: event.type.startsWith('loader.run.') ? 'run' : event.type.startsWith('loader.sandbox.') ? 'sandbox' : isError ? 'error' : 'process',
        source: event.type,
        level: isError ? 'error' : isWarning ? 'warning' : 'info',
        content: [event.message, event.payloadJson].filter(Boolean).join('\n') || event.type,
        timestampInferred: false,
        filterTags: tags(event),
      } satisfies RuntimeTimelineEntry;
    });
}
