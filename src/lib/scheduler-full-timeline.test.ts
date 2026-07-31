import { Timestamp } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import {
  RunDetail,
  RunEvent,
  RunEventKind,
  RunSummary,
  SandboxHistoryCell,
  SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { buildFullExecutionTimeline, type SchedulerExecutionRawData } from './scheduler-full-timeline';

function time(seconds: bigint): Timestamp {
  return new Timestamp({ seconds });
}

function fixture(values: Partial<SchedulerExecutionRawData>): SchedulerExecutionRawData {
  return {
    schedulerEvents: [], sandboxes: [], cells: [], runDetails: [], runEvents: [], runLogs: [], sourceStatuses: [],
    ...values,
  };
}

describe('buildFullExecutionTimeline', () => {
  test('keeps distinct repeated output, deduplicates stable IDs, and puts unknown times last', () => {
    const scheduler = new SchedulerEvent({ id: 's1', createdAt: time(2n), message: 'same' });
    const entries = buildFullExecutionTimeline(fixture({
      schedulerEvents: [scheduler, scheduler],
      runEvents: [
        { runId: 'run', value: new RunEvent({ id: 'r1', seq: 1n, createdAt: time(1n), text: 'same' }), parentSourceIds: [] },
        { runId: 'run', value: new RunEvent({ id: 'r2', seq: 2n, createdAt: time(1n), text: 'same' }), parentSourceIds: [] },
      ],
      cells: [{
        sandboxId: 'box', cellId: 'cell-1',
        value: new SandboxHistoryCell({ id: 'cell-1', output: 'complete output' }), parentSourceIds: [],
      }],
    }));

    expect(entries.map(entry => entry.id)).toEqual([
      'run-event:r1', 'run-event:r2', 'scheduler-event:s1', 'cell:box:cell-1',
    ]);
    expect(entries.at(-1)?.timestamp).toBe('');
    expect(entries.at(-1)?.content).toContain('complete output');
  });

  test('normalizes every source, preserves generated JSON, and classifies filters', () => {
    const entries = buildFullExecutionTimeline(fixture({
      schedulerEvents: [new SchedulerEvent({ id: 'scheduler', type: 'loader.run.failed', level: 'error', message: 'failed', createdAt: time(1n) })],
      sandboxes: [{ sandboxId: 'box', value: { id: 'box', updatedAt: '2024-01-01T00:00:02Z', state: 'running', revision: 9n }, parentSourceIds: ['scheduler-event:scheduler'] }],
      cells: [{ sandboxId: 'box', cellId: 'cell', value: new SandboxHistoryCell({ id: 'cell', source: 'prompt', stdout: 'out', stderr: 'warn', output: 'answer', createdAt: time(3n) }), parentSourceIds: ['sandbox:box'] }],
      runDetails: [{ runId: 'run', value: new RunDetail({ summary: new RunSummary({ runId: 'run', createdAt: '2024-01-01T00:00:04Z', error: 'boom' }), prompt: 'question', output: 'answer', resultJson: '{"artifact":true}' }), parentSourceIds: ['scheduler-event:scheduler'] }],
      runEvents: [{ runId: 'run', value: new RunEvent({ id: 'event', kind: RunEventKind.AGENT_MESSAGE, seq: 5n, text: 'message', createdAt: time(5n) }), parentSourceIds: ['run-detail:run'] }],
      runLogs: [{ runId: 'run', offset: 6n, data: 'log data', createdAt: '2024-01-01T00:00:06Z', parentSourceIds: ['run-detail:run'] }],
      sourceStatuses: [{ source: 'run-log', resourceId: 'missing', state: 'failed', error: 'network problem' }],
    }));

    expect(entries.map(entry => entry.sourceType)).toEqual([
      'scheduler-event', 'cell', 'run-event', 'sandbox', 'run-detail', 'run-log', 'source-status',
    ]);
    expect(entries.find(entry => entry.id === 'cell:box:cell')?.raw).toContain('"stdout": "out"');
    expect(entries.find(entry => entry.id === 'sandbox:box')?.raw).toContain('"revision": "9"');
    expect(entries.find(entry => entry.id === 'run-event:event')?.raw).toContain('"seq": "5"');
    expect(entries.find(entry => entry.id === 'run-log:run:6')?.content).toBe('log data');
    expect(entries.find(entry => entry.id === 'run-detail:run')?.filterTags).toEqual(expect.arrayContaining(['run', 'message', 'artifact', 'problem']));
    expect(entries.find(entry => entry.id === 'cell:box:cell')?.filterTags).toEqual(expect.arrayContaining(['run', 'message', 'activity', 'artifact']));
    expect(entries.find(entry => entry.id === 'source-status:run-log:missing')?.filterTags).toEqual(expect.arrayContaining(['problem']));
  });

  test('derives deterministic identities for missing IDs and sorts invalid dates last', () => {
    const first = { runId: 'run', value: new RunEvent({ seq: 7n, text: 'same' }), parentSourceIds: ['run:parent-a'] };
    const second = { runId: 'run', value: new RunEvent({ seq: 7n, text: 'same' }), parentSourceIds: ['run:parent-b'] };
    const entries = buildFullExecutionTimeline(fixture({
      schedulerEvents: [new SchedulerEvent({ id: 'known', createdAt: time(1n) })],
      runEvents: [second, first],
      runLogs: [{ runId: 'run', offset: 0n, data: 'invalid time', createdAt: 'not-a-date', parentSourceIds: [] }],
    }));

    expect(entries).toHaveLength(4);
    expect(entries[0].id).toBe('scheduler-event:known');
    const generatedIds = entries.filter(entry => entry.sourceType === 'run-event').map(entry => entry.id);
    expect(generatedIds[0]).not.toBe(generatedIds[1]);
    expect(generatedIds[0] < generatedIds[1]).toBe(true);
    expect(entries.find(entry => entry.sourceType === 'run-log')?.timestamp).toBe('');
  });

  test('normalizes an out-of-range protobuf timestamp as unknown without throwing', () => {
    const entries = buildFullExecutionTimeline(fixture({
      schedulerEvents: [
        new SchedulerEvent({ id: 'known', createdAt: time(1n) }),
        new SchedulerEvent({ id: 'malformed', createdAt: time(8_640_000_000_001n) }),
      ],
    }));

    expect(entries.map(entry => entry.id)).toEqual(['scheduler-event:known', 'scheduler-event:malformed']);
    expect(entries[1].timestamp).toBe('');
  });
});
