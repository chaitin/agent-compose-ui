import { describe, expect, test } from 'vitest';
import { ListSchedulerEventsResponse, SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import { buildSchedulerRunTimeline, loadSchedulerRunEvents } from './scheduler-run-timeline';

test('loads only the target Scheduler Run through its start event', async () => {
  const cursors: string[] = [];
  const result = await loadSchedulerRunEvents('loader-1', async request => {
    cursors.push(request.cursor);
    if (!request.cursor) return new ListSchedulerEventsResponse({ events: [
      new SchedulerEvent({ id: 'done', runId: 'loader-1', type: 'loader.run.completed' }),
      new SchedulerEvent({ id: 'other', runId: 'other', type: 'loader.run.started' }),
    ], nextCursor: 'next' });
    return new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'loader-1', type: 'loader.run.started' })] });
  });
  expect(cursors).toEqual(['', 'next']);
  expect(result.map(event => event.id)).toEqual(['start', 'done']);
});

test('rejects repeated Scheduler pagination cursors', async () => {
  await expect(loadSchedulerRunEvents('missing', async () => new ListSchedulerEventsResponse({ nextCursor: 'same' }))).rejects.toThrow('repeated cursor');
});

describe('buildSchedulerRunTimeline', () => {
  test('retains raw event evidence and applies overlapping artifact/problem tags', () => {
    const entries = buildSchedulerRunTimeline([
      new SchedulerEvent({ id: 'command', runId: 'loader-1', type: 'loader.command.completed', message: '22 items', payloadJson: '{"output":"result"}', createdAt: { seconds: 2n } }),
      new SchedulerEvent({ id: 'warning', runId: 'loader-1', type: 'loader.deprecated_alias.warning', level: 'warning', message: 'deprecated', createdAt: { seconds: 3n } }),
      new SchedulerEvent({ id: 'start', runId: 'loader-1', type: 'loader.run.started', createdAt: { seconds: 1n } }),
    ]);
    expect(entries.map(entry => entry.content)).toEqual(expect.arrayContaining(['loader.run.started', '22 items\n{"output":"result"}', 'deprecated']));
    expect(entries.find(entry => entry.id === 'scheduler-event:command')?.filterTags).toEqual(expect.arrayContaining(['activity', 'artifact']));
    expect(entries.find(entry => entry.id === 'scheduler-event:warning')).toMatchObject({ level: 'warning', filterTags: expect.arrayContaining(['problem']) });
  });
});
