import { describe, expect, test, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  GetRunResponse, GetSandboxResponse, ListRunEventsResponse, ListSandboxHistoryResponse,
  ListSandboxRunEventsResponse, ListSchedulerEventsResponse, RunDetail, RunEvent, RunEventKind, RunLogChunk,
  RunSummary, Sandbox, SandboxHistoryCell, SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { loadFullSchedulerExecution, type FullExecutionDependencies } from './scheduler-full-execution';
import { stableProjectRunId } from './run-scheduler-evidence';

async function* chunks(...values: RunLogChunk[]) { yield* values; }

function dependencies(overrides: Partial<FullExecutionDependencies> = {}): FullExecutionDependencies {
  return {
    listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
      new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started' }),
    ] })),
    getSandbox: vi.fn(async request => new GetSandboxResponse({ sandbox: new Sandbox({ sandboxId: request.sandboxId }) })),
    listSandboxHistory: vi.fn(async () => new ListSandboxHistoryResponse()),
    listSandboxRunEvents: vi.fn(async () => new ListSandboxRunEventsResponse()),
    getRun: vi.fn(async () => new GetRunResponse({ run: new RunDetail() })),
    listRunEvents: vi.fn(async () => new ListRunEventsResponse({ historyAvailable: true })),
    followRunLogs: vi.fn(() => chunks(new RunLogChunk({ isFinal: true }))),
    ...overrides,
  };
}

const input = { projectId: 'project', agentName: 'agent', schedulerRunId: 'scheduler-run' };

describe('loadFullSchedulerExecution', () => {
  test('exposes a Sandbox discovered from an associated Run detail', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
        new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"runId":"run-1"}' }),
      ] })),
      getRun: vi.fn(async () => new GetRunResponse({ run: new RunDetail({
        summary: new RunSummary({ runId: 'run-1', sandboxId: 'sandbox-from-run' }),
      }) })),
    });

    const result = await loadFullSchedulerExecution(input, deps);

    expect(result.sandboxIds).toEqual(['sandbox-from-run']);
  });

  test('pages scheduler history until the target start and exhausts resource cursors', async () => {
    const schedulerCursors: string[] = [];
    const sandboxCursors: string[] = [];
    const runCursors: string[] = [];
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async request => {
        schedulerCursors.push(request.cursor);
        return request.cursor
          ? new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"sandboxId":"box","runId":"run"}' })] })
          : new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'other', runId: 'other' })], nextCursor: 'scheduler-2' });
      }),
      listSandboxRunEvents: vi.fn(async request => {
        sandboxCursors.push(request.cursor);
        return new ListSandboxRunEventsResponse({ events: [new RunEvent({ id: `sandbox-${request.cursor || '1'}`, runId: 'run' })], nextCursor: request.cursor ? '' : 'sandbox-2', historyAvailableRunIds: ['run'] });
      }),
      listRunEvents: vi.fn(async request => {
        runCursors.push(request.cursor);
        return new ListRunEventsResponse({ events: [new RunEvent({ id: `run-${request.cursor || '1'}`, runId: 'run' })], nextCursor: request.cursor ? '' : 'run-2', historyAvailable: true });
      }),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    expect(schedulerCursors).toEqual(['', 'scheduler-2']);
    expect(sandboxCursors).toEqual(['', 'sandbox-2']);
    expect(runCursors).toEqual(['', 'run-2']);
    expect(result.entries.filter(entry => entry.sourceType === 'run-event')).toHaveLength(4);
    expect(result.complete).toBe(true);
  });

  test('marks repeated cursors failed and false history availability unavailable', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"sandboxId":"box","runId":"run"}' })] })),
      listSandboxRunEvents: vi.fn(async () => new ListSandboxRunEventsResponse({ nextCursor: 'same' })),
      listRunEvents: vi.fn(async () => new ListRunEventsResponse({ historyAvailable: false })),
    });
    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'sandbox-run-events', resourceId: 'box', state: 'failed', error: expect.stringContaining('repeated cursor') }),
      expect.objectContaining({ source: 'run-events', resourceId: 'run', state: 'unavailable' }),
    ]));
    expect(result.complete).toBe(false);
  });

  test('keeps run event history unavailable when an early page reports false', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"runId":"run"}' })] })),
      listRunEvents: vi.fn(async request => request.cursor
        ? new ListRunEventsResponse({ events: [new RunEvent({ id: 'second', runId: 'run' })], historyAvailable: true })
        : new ListRunEventsResponse({ events: [new RunEvent({ id: 'first', runId: 'run' })], nextCursor: 'next', historyAvailable: false })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.entries.filter(entry => entry.sourceType === 'run-event').map(entry => entry.sourceId)).toEqual(['first', 'second']);
    expect(result.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'run-events', resourceId: 'run', state: 'unavailable' }));
    expect(result.complete).toBe(false);
  });

  test('marks sandbox run history unavailable when a relevant linked run is never confirmed', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"sandboxId":"box","runId":"run"}' })] })),
      listSandboxRunEvents: vi.fn(async request => request.cursor
        ? new ListSandboxRunEventsResponse({ events: [new RunEvent({ id: 'second', runId: 'run' })] })
        : new ListSandboxRunEventsResponse({ events: [new RunEvent({ id: 'first', runId: 'run' })], nextCursor: 'next' })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.entries.filter(entry => entry.sourceType === 'run-event').map(entry => entry.sourceId)).toEqual(expect.arrayContaining(['first', 'second']));
    expect(result.sourceStatuses).toContainEqual(expect.objectContaining({
      source: 'sandbox-run-events', resourceId: 'box', state: 'unavailable', error: expect.stringContaining('run'),
    }));
    expect(result.complete).toBe(false);
  });

  test('accumulates sandbox run history confirmations across pages', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"links":[{"sandboxId":"box","runId":"run-a"},{"sandboxId":"box","runId":"run-b"}]}' })] })),
      listSandboxRunEvents: vi.fn(async request => request.cursor
        ? new ListSandboxRunEventsResponse({ historyAvailableRunIds: ['run-b'] })
        : new ListSandboxRunEventsResponse({ nextCursor: 'next', historyAvailableRunIds: ['run-a'] })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'sandbox-run-events', resourceId: 'box', state: 'complete', error: '' }));
    expect(result.complete).toBe(true);
  });

  test('uses exact structural sandbox and run pairs for filtering and completeness', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({
        id: 'start', runId: 'scheduler-run', type: 'loader.run.started',
        payloadJson: '{"links":[{"sandboxId":"box-a","runId":"run-a"},{"sandboxId":"box-b","runId":"run-b"},{"runId":"run-unpaired"}]}',
      })] })),
      listSandboxRunEvents: vi.fn(async request => new ListSandboxRunEventsResponse({
        events: [
          new RunEvent({ id: `${request.sandboxId}-a`, runId: 'run-a' }),
          new RunEvent({ id: `${request.sandboxId}-b`, runId: 'run-b' }),
        ],
        historyAvailableRunIds: [request.sandboxId === 'box-a' ? 'run-a' : 'run-b'],
      })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    const sandboxEvents = result.entries.filter(entry => entry.sourceType === 'run-event' && entry.parentSourceIds.some(id => id.startsWith('sandbox:')));
    expect(sandboxEvents.map(entry => [entry.sourceId, entry.parentSourceIds])).toEqual([
      ['box-a-a', ['sandbox:box-a', 'run-detail:run-a']],
      ['box-b-b', ['sandbox:box-b', 'run-detail:run-b']],
    ]);
    expect(result.sourceStatuses.filter(status => status.source === 'sandbox-run-events')).toEqual([
      { source: 'sandbox-run-events', resourceId: 'box-a', state: 'complete', error: '' },
      { source: 'sandbox-run-events', resourceId: 'box-b', state: 'complete', error: '' },
    ]);
    expect(vi.mocked(deps.getRun).mock.calls.map(([request]) => request.runId).sort()).toEqual(['run-a', 'run-b', 'run-unpaired']);
    expect(result.complete).toBe(true);
  });

  test('retains only explicitly linked cells and runs', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"sandboxId":"box","cellId":"wanted-cell","runId":"wanted-run"}' })] })),
      listSandboxHistory: vi.fn(async () => new ListSandboxHistoryResponse({ cells: [new SandboxHistoryCell({ id: 'wanted-cell' }), new SandboxHistoryCell({ id: 'other-cell' })] })),
      listSandboxRunEvents: vi.fn(async () => new ListSandboxRunEventsResponse({ events: [new RunEvent({ id: 'wanted-event', runId: 'wanted-run' }), new RunEvent({ id: 'other-event', runId: 'other-run' })], historyAvailableRunIds: ['wanted-run'] })),
    });
    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.entries.filter(entry => entry.sourceType === 'cell').map(entry => entry.sourceId)).toEqual(['wanted-cell']);
    expect(result.entries.filter(entry => entry.sourceType === 'run-event').map(entry => entry.sourceId)).not.toContain('other-event');
    expect(deps.getRun).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.getRun).mock.calls[0][0].runId).toBe('wanted-run');
  });

  test('loads the stable scheduler Project Run only when agent activity is explicit', async () => {
    const stableId = await stableProjectRunId('project', 'agent', 'scheduler', 'scheduler-run:agent:1');
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
        new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started' }),
        new SchedulerEvent({ id: 'agent-start', runId: 'scheduler-run', type: 'loader.agent.started' }),
      ] })),
      getRun: vi.fn(async request => new GetRunResponse({ run: new RunDetail({ prompt: request.runId }) })),
      listRunEvents: vi.fn(async request => new ListRunEventsResponse({
        events: [new RunEvent({ id: 'stable-event', runId: request.runId })], historyAvailable: true,
      })),
      followRunLogs: vi.fn(request => chunks(new RunLogChunk({ data: request.runId, isFinal: true }))),
    });

    const result = await loadFullSchedulerExecution(input, deps);

    expect(vi.mocked(deps.getRun).mock.calls.map(([request]) => request.runId)).toEqual([stableId]);
    expect(vi.mocked(deps.listRunEvents).mock.calls.map(([request]) => request.runId)).toEqual([stableId]);
    expect(vi.mocked(deps.followRunLogs).mock.calls.map(([request]) => request.runId)).toEqual([stableId]);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `run-detail:${stableId}`, parentSourceIds: ['scheduler-event:agent-start'] }),
      expect.objectContaining({ sourceId: 'stable-event' }),
      expect.objectContaining({ id: `run-log:${stableId}:0` }),
    ]));
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'run-detail', resourceId: stableId, state: 'complete' }),
      expect.objectContaining({ source: 'run-events', resourceId: stableId, state: 'complete' }),
      expect.objectContaining({ source: 'run-log', resourceId: stableId, state: 'complete' }),
    ]));
    expect(result.complete).toBe(true);
  });

  test('does not probe a stable Project Run for scheduler executions without agent activity', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
        new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started' }),
        new SchedulerEvent({ id: 'shell', runId: 'scheduler-run', type: 'loader.command.completed' }),
        new SchedulerEvent({ id: 'llm', runId: 'scheduler-run', type: 'loader.llm.completed' }),
      ] })),
    });

    const result = await loadFullSchedulerExecution(input, deps);

    expect(deps.getRun).not.toHaveBeenCalled();
    expect(deps.listRunEvents).not.toHaveBeenCalled();
    expect(deps.followRunLogs).not.toHaveBeenCalled();
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      { source: 'run-detail', resourceId: '', state: 'not-applicable', error: '' },
      { source: 'run-events', resourceId: '', state: 'not-applicable', error: '' },
      { source: 'run-log', resourceId: '', state: 'not-applicable', error: '' },
    ]));
    expect(result.complete).toBe(true);
  });

  test('filters each sandbox history by structural cell pairs and preserves introducers', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({
        id: 'pair-event', runId: 'scheduler-run', type: 'loader.run.started',
        payloadJson: JSON.stringify({ links: [
          { sandboxId: 'box-a', cellId: 'shared-cell' },
          { sandboxId: 'box-b', cellId: 'cell-b' },
          { cellId: 'unpaired-cell' },
        ] }),
      })] })),
      listSandboxHistory: vi.fn(async () => new ListSandboxHistoryResponse({ cells: [
        new SandboxHistoryCell({ id: 'shared-cell' }),
        new SandboxHistoryCell({ id: 'cell-b' }),
        new SandboxHistoryCell({ id: 'unpaired-cell' }),
      ] })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    const cells = result.entries.filter(entry => entry.sourceType === 'cell');

    expect(cells.map(entry => [entry.sourceId, entry.parentSourceIds])).toEqual([
      ['shared-cell', ['sandbox:box-a', 'scheduler-event:pair-event']],
      ['cell-b', ['sandbox:box-b', 'scheduler-event:pair-event']],
    ]);
  });

  test('deduplicates a payload run ID that equals the derived stable run ID', async () => {
    const stableId = await stableProjectRunId('project', 'agent', 'scheduler', 'scheduler-run:agent:1');
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
        new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: JSON.stringify({ runId: stableId }) }),
        new SchedulerEvent({ id: 'agent', runId: 'scheduler-run', type: 'loader.agent.completed' }),
      ] })),
    });

    const result = await loadFullSchedulerExecution(input, deps);
    expect(deps.getRun).toHaveBeenCalledTimes(1);
    expect(result.entries.find(entry => entry.id === `run-detail:${stableId}`)?.parentSourceIds).toEqual([
      'scheduler-event:start', 'scheduler-event:agent',
    ]);
  });

  test('preserves successful resources when one resource fails and requires final log chunks', async () => {
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"runId":"good"}\n{"runId":"bad"}' })] })),
    });
    // Use two valid scheduler payloads because malformed JSON is deliberately only a warning.
    vi.mocked(deps.listSchedulerEvents).mockResolvedValue(new ListSchedulerEventsResponse({ events: [
      new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: '{"runId":"good"}' }),
      new SchedulerEvent({ id: 'link', runId: 'scheduler-run', payloadJson: '{"runId":"bad"}' }),
    ] }));
    vi.mocked(deps.getRun).mockImplementation(async request => {
      if (request.runId === 'bad') throw new Error('detail offline');
      return new GetRunResponse({ run: new RunDetail() });
    });
    vi.mocked(deps.followRunLogs).mockImplementation(request => request.runId === 'good'
      ? chunks(new RunLogChunk({ data: 'partial', offset: 1n }))
      : chunks(new RunLogChunk({ isFinal: true })));

    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.entries.some(entry => entry.id === 'run-detail:good')).toBe(true);
    expect(result.entries.some(entry => entry.id === 'run-log:good:1')).toBe(true);
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'run-detail', resourceId: 'bad', state: 'failed' }),
      expect.objectContaining({ source: 'run-log', resourceId: 'good', state: 'unavailable' }),
    ]));
  });

  test('keeps persisted run conversation and logs when the linked sandbox was removed', async () => {
    const removed = new ConnectError('read /data/sessions/box-gone/metadata.json: no such file', Code.NotFound);
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({
        id: 'start', runId: 'scheduler-run', type: 'loader.run.started',
        payloadJson: '{"sandboxId":"box-gone","runId":"run-kept"}',
      })] })),
      getSandbox: vi.fn(async () => { throw removed; }),
      listSandboxHistory: vi.fn(async () => { throw removed; }),
      getRun: vi.fn(async () => new GetRunResponse({ run: new RunDetail({ prompt: '保留的提问', output: '保留的回答' }) })),
      listRunEvents: vi.fn(async () => new ListRunEventsResponse({
        events: [new RunEvent({ id: 'kept-message', runId: 'run-kept', kind: RunEventKind.AGENT_MESSAGE, text: '结构化对话仍然存在' })],
        historyAvailable: true,
      })),
      followRunLogs: vi.fn(() => chunks(new RunLogChunk({ data: '持久化运行日志', isFinal: true }))),
    });

    const result = await loadFullSchedulerExecution(input, deps);

    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'run-detail:run-kept', content: expect.stringContaining('保留的回答') }),
      expect.objectContaining({ sourceId: 'kept-message', content: '结构化对话仍然存在' }),
      expect.objectContaining({ id: 'run-log:run-kept:0', content: '持久化运行日志' }),
    ]));
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      { source: 'sandbox-detail', resourceId: 'box-gone', state: 'unavailable', error: 'Sandbox 已被清理，详情不可用' },
      { source: 'sandbox-history', resourceId: 'box-gone', state: 'unavailable', error: 'Sandbox 已被清理，单元历史不可用' },
    ]));
    expect(result.sourceStatuses.map(status => status.error).join('\n')).not.toContain('/data/sessions/box-gone/metadata.json');
  });

  test('malformed payloads create warning statuses', async () => {
    const deps = dependencies({ listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [
      new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started' }),
      new SchedulerEvent({ id: 'bad-json', runId: 'scheduler-run', payloadJson: '{' }),
    ] })) });
    const result = await loadFullSchedulerExecution(input, deps);
    expect(result.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'scheduler-link', resourceId: 'bad-json', state: 'unavailable' }));
    expect(result.complete).toBe(false);
  });

  test('abort rejects with AbortError and stops scheduling queued resources', async () => {
    const controller = new AbortController();
    let calls = 0;
    const deps = dependencies({
      listSchedulerEvents: vi.fn(async () => new ListSchedulerEventsResponse({ events: [new SchedulerEvent({ id: 'start', runId: 'scheduler-run', type: 'loader.run.started', payloadJson: JSON.stringify({ runId: ['ignored'], links: Array.from({ length: 8 }, (_, i) => ({ runId: `run-${i}` })) }) })] })),
      getRun: vi.fn(async () => {
        calls += 1;
        if (calls === 1) controller.abort();
        return new GetRunResponse({ run: new RunDetail() });
      }),
    });
    await expect(loadFullSchedulerExecution({ ...input, signal: controller.signal }, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBeLessThanOrEqual(4);
  });
});
