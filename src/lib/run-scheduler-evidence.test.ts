import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ListSchedulerEventsResponse,
  SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { findSchedulerRunEvidence, stableProjectRunId } from './run-scheduler-evidence';

describe('stableProjectRunId', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('matches the backend stable ID vector', async () => {
    await expect(stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-run-1'))
      .resolves.toBe('93114a8fb7f5c877f7afb25d5efb06bff4100665458170783504846711b15f1f');
  });

  test('uses UTF-8 byte lengths for Unicode parts', async () => {
    await expect(stableProjectRunId('项目一', '智能体', 'scheduler', '调度运行一'))
      .resolves.toBe('0c956cf6028eb72cd3c320462d3eb2ee4a0cbf87ea07b55b90da11a1006ea105');
  });

  test('matches the backend when Web Crypto subtle digest is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    await expect(stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-run-1'))
      .resolves.toBe('93114a8fb7f5c877f7afb25d5efb06bff4100665458170783504846711b15f1f');
  });
});

describe('findSchedulerRunEvidence', () => {
  test('finds the exact loader run and continues through its start event', async () => {
    const projectRunId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-target:agent:1');
    const cursors: string[] = [];
    const result = await findSchedulerRunEvidence({
      projectId: 'project-1',
      agentName: 'worker',
      triggerId: 'trigger-1',
      projectRunId,
    }, async request => {
      cursors.push(request.cursor);
      if (!request.cursor) return new ListSchedulerEventsResponse({
        events: [
          new SchedulerEvent({ id: 'other', runId: 'loader-other', triggerId: 'trigger-1', type: 'loader.run.completed' }),
          new SchedulerEvent({ id: 'agent', runId: 'loader-target', triggerId: 'trigger-1', type: 'loader.agent.completed' }),
          new SchedulerEvent({ id: 'done', runId: 'loader-target', triggerId: 'trigger-1', type: 'loader.run.completed' }),
        ],
        nextCursor: 'next',
      });
      return new ListSchedulerEventsResponse({
        events: [
          new SchedulerEvent({ id: 'noise', runId: 'loader-noise', triggerId: 'trigger-2', type: 'loader.run.started' }),
          new SchedulerEvent({ id: 'start', runId: 'loader-target', triggerId: 'trigger-1', type: 'loader.run.started' }),
        ],
      });
    });

    expect(cursors).toEqual(['', 'next']);
    expect(result.loaderRunId).toBe('loader-target');
    expect(result.events.map(event => event.id)).toEqual(['agent', 'done', 'start']);
  });

  test('finds a sequenced Project Run before its Scheduler Agent event completes', async () => {
    const projectRunId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-running:agent:1');

    const result = await findSchedulerRunEvidence({
      projectId: 'project-1', agentName: 'worker', triggerId: 'trigger-1', projectRunId,
    }, async () => new ListSchedulerEventsResponse({
      events: [new SchedulerEvent({ id: 'start', runId: 'loader-running', triggerId: 'trigger-1', type: 'loader.run.started' })],
    }));

    expect(result.loaderRunId).toBe('loader-running');
    expect(result.events.map(event => event.id)).toEqual(['start']);
  });

  test('returns no evidence instead of guessing from trigger ID', async () => {
    const result = await findSchedulerRunEvidence({
      projectId: 'project-1', agentName: 'worker', triggerId: 'trigger-1', projectRunId: 'not-a-match',
    }, async () => new ListSchedulerEventsResponse({
      events: [new SchedulerEvent({ id: 'same-trigger', runId: 'loader-other', triggerId: 'trigger-1' })],
    }));

    expect(result).toEqual({ loaderRunId: '', events: [] });
  });

  test('rejects a repeated pagination cursor', async () => {
    await expect(findSchedulerRunEvidence({
      projectId: 'project-1', agentName: 'worker', triggerId: '', projectRunId: 'not-a-match',
    }, async () => new ListSchedulerEventsResponse({ nextCursor: 'repeat' })))
      .rejects.toThrow('repeated cursor');
  });
});
