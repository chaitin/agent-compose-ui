import { describe, expect, test } from 'vitest';
import { ListSchedulerEventsResponse, SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import { buildSchedulerRunTimeline, loadSchedulerRunEvents } from './scheduler-run-timeline';

test('loads only the target Scheduler Run through its start event', async () => {
  const offsets: number[] = [];
  const result = await loadSchedulerRunEvents('loader-1', async request => {
    offsets.push(request.offset);
    if (!request.offset) return new ListSchedulerEventsResponse({ events: [
      new SchedulerEvent({ id: 'done', runId: 'loader-1', type: 'scheduler.run.completed' }),
      new SchedulerEvent({ id: 'other', runId: 'other', type: 'scheduler.run.started' }),
    ], total: 3 });
    return new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'loader-1', type: 'scheduler.run.started' })] });
  });
  expect(offsets).toEqual([0, 2]);
  expect(result.map(event => event.id)).toEqual(['start', 'done']);
});

describe('buildSchedulerRunTimeline', () => {
  test('retains raw event evidence and applies overlapping artifact/problem tags', () => {
    const entries = buildSchedulerRunTimeline([
      new SchedulerEvent({ id: 'command', runId: 'loader-1', type: 'scheduler.command.completed', message: '22 items', payloadJson: '{"output":"result"}', createdAt: { seconds: 2n } }),
      new SchedulerEvent({ id: 'warning', runId: 'loader-1', type: 'scheduler.deprecated_alias.warning', level: 'warning', message: 'deprecated', createdAt: { seconds: 3n } }),
      new SchedulerEvent({ id: 'start', runId: 'loader-1', type: 'scheduler.run.started', createdAt: { seconds: 1n } }),
    ]);
    expect(entries.map(entry => entry.content)).toEqual(expect.arrayContaining(['scheduler.run.started', '22 items\n{"output":"result"}', 'deprecated']));
    expect(entries.find(entry => entry.id === 'scheduler-event:command')?.filterTags).toEqual(expect.arrayContaining(['activity', 'artifact']));
    expect(entries.find(entry => entry.id === 'scheduler-event:warning')).toMatchObject({ level: 'warning', filterTags: expect.arrayContaining(['problem']) });
  });
});
