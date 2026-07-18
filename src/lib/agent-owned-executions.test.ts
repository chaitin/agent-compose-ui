import { describe, expect, test } from 'vitest';
import { RunSource, RunStatus, RunSummary, SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import { stableProjectRunId } from './run-scheduler-evidence';
import {
  filterAgentOwnedExecutions,
  groupSchedulerExecutions,
  mergeAgentOwnedExecutions,
} from './agent-owned-executions';

const event = (data: Partial<SchedulerEvent> & { id: string; runId: string; type: string }, seconds: bigint) => new SchedulerEvent({
  level: 'info', triggerId: 'trigger-1', createdAt: { seconds }, ...data,
});

test('groups every Scheduler operation family into one owned execution', () => {
  const events = [
    event({ id: 'start', runId: 'loader-1', type: 'loader.run.started' }, 1n),
    event({ id: 'command', runId: 'loader-1', type: 'loader.command.completed', payloadJson: '{"sandboxId":"sandbox-1"}' }, 2n),
    event({ id: 'llm', runId: 'loader-1', type: 'loader.llm.completed' }, 3n),
    event({ id: 'agent', runId: 'loader-1', type: 'loader.agent.completed' }, 4n),
    event({ id: 'publish', runId: 'loader-1', type: 'loader.event.published' }, 5n),
    event({ id: 'sandbox', runId: 'loader-1', type: 'loader.sandbox.rpc.completed' }, 6n),
    event({ id: 'log', runId: 'loader-1', type: 'loader.log' }, 7n),
    event({ id: 'warning', runId: 'loader-1', type: 'loader.deprecated_alias.warning', level: 'warning' }, 8n),
    event({ id: 'done', runId: 'loader-1', type: 'loader.run.completed' }, 9n),
  ];

  const [execution] = groupSchedulerExecutions(events);
  expect(execution).toMatchObject({
    schedulerRunId: 'loader-1', status: 'succeeded', triggerId: 'trigger-1',
    startedAt: '1970-01-01T00:00:01.000Z', completedAt: '1970-01-01T00:00:09.000Z',
    warningCount: 1, sandboxIds: ['sandbox-1'], historyComplete: true,
  });
  expect(execution.capabilities).toEqual(['agent', 'llm', 'command', 'event', 'sandbox', 'log']);
});

test('derives running, failed, and skipped lifecycle states without message guessing', () => {
  const grouped = groupSchedulerExecutions([
    event({ id: 'running', runId: 'running', type: 'loader.run.started' }, 1n),
    event({ id: 'failed', runId: 'failed', type: 'loader.run.failed', level: 'error', message: 'boom' }, 2n),
    event({ id: 'skipped', runId: 'skipped', type: 'loader.run.skipped', level: 'warn', message: 'busy' }, 3n),
  ]);
  expect(Object.fromEntries(grouped.map(item => [item.schedulerRunId, item.status]))).toEqual({ running: 'running', failed: 'failed', skipped: 'skipped' });
  expect(grouped.find(item => item.schedulerRunId === 'failed')?.error).toBe('boom');
});

test('merges current sequenced Scheduler Agent runs by exact stable ID only', async () => {
  const firstLinkedId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-multiple:agent:1');
  const secondLinkedId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-multiple:agent:2');
  const legacyId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-legacy');
  const projectRuns = [
    new RunSummary({ runId: firstLinkedId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED, startedAt: '2026-01-03T00:00:00Z' }),
    new RunSummary({ runId: secondLinkedId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED, startedAt: '2026-01-02T00:00:00Z' }),
    new RunSummary({ runId: legacyId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED, startedAt: '2026-01-01T00:00:00Z' }),
  ];
  const scheduler = groupSchedulerExecutions([
    event({ id: 'first', runId: 'loader-multiple', type: 'loader.agent.completed' }, 1n),
    event({ id: 'second', runId: 'loader-multiple', type: 'loader.agent.failed', level: 'error' }, 2n),
    event({ id: 'legacy', runId: 'loader-legacy', type: 'loader.agent.completed' }, 3n),
    event({ id: 'other', runId: 'loader-other', type: 'loader.command.completed' }, 4n),
  ]);

  const merged = await mergeAgentOwnedExecutions(projectRuns, scheduler, { projectId: 'project-1', agentName: 'worker' });
  expect(merged).toHaveLength(5);
  expect(merged.find(item => item.projectRunId === firstLinkedId)).toMatchObject({ schedulerRunId: 'loader-multiple', kind: 'project-run' });
  expect(merged.find(item => item.projectRunId === secondLinkedId)).toMatchObject({ schedulerRunId: 'loader-multiple', kind: 'project-run' });
  expect(merged.find(item => item.projectRunId === legacyId)).toMatchObject({ schedulerRunId: '', kind: 'project-run' });
  expect(merged.find(item => item.id === 'scheduler:loader-legacy')).toMatchObject({ kind: 'scheduler-run' });
  expect(merged.find(item => item.schedulerRunId === 'loader-other')).toMatchObject({ kind: 'scheduler-run' });
});

test('merges the next sequenced Agent Run while its Scheduler execution is still running', async () => {
  const firstLinkedId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-running:agent:1');
  const secondLinkedId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-running:agent:2');
  const projectRuns = [
    new RunSummary({ runId: firstLinkedId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED }),
    new RunSummary({ runId: secondLinkedId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.RUNNING }),
  ];
  const scheduler = groupSchedulerExecutions([
    event({ id: 'start', runId: 'loader-running', type: 'loader.run.started' }, 1n),
    event({ id: 'first', runId: 'loader-running', type: 'loader.agent.completed' }, 2n),
  ]);

  const merged = await mergeAgentOwnedExecutions(projectRuns, scheduler, { projectId: 'project-1', agentName: 'worker' });

  expect(merged).toHaveLength(2);
  expect(merged.find(item => item.projectRunId === firstLinkedId)).toMatchObject({ schedulerRunId: 'loader-running' });
  expect(merged.find(item => item.projectRunId === secondLinkedId)).toMatchObject({ schedulerRunId: 'loader-running' });
});

describe('unified filters', () => {
  test('Scheduler source includes every Scheduler execution and applies status, date, and Sandbox exactly', async () => {
    const items = await mergeAgentOwnedExecutions([], groupSchedulerExecutions([
      event({ id: 'start', runId: 'loader-1', type: 'loader.run.started', payloadJson: '{"sandboxId":"sandbox-1"}' }, 1n),
      event({ id: 'done', runId: 'loader-1', type: 'loader.run.completed' }, 2n),
      event({ id: 'other', runId: 'loader-2', type: 'loader.llm.completed' }, 3n),
    ]), { projectId: 'project-1', agentName: 'worker' });

    expect(filterAgentOwnedExecutions(items, { source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED, startedFrom: '', startedTo: '', sandboxId: 'sandbox-1' }).map(item => item.schedulerRunId)).toEqual(['loader-1']);
    expect(filterAgentOwnedExecutions(items, { source: RunSource.MANUAL, status: RunStatus.UNSPECIFIED, startedFrom: '', startedTo: '', sandboxId: '' })).toEqual([]);
  });
});
