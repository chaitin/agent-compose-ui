import { describe, expect, test } from 'vitest';
import {
  RunEvent,
  RunEventKind,
  SandboxHistoryCell,
  SchedulerEvent,
} from '../gen/agentcompose/v2/agentcompose_pb';
import {
  buildConfirmedEvidenceTimeline,
  confirmedCell,
  confirmedSandboxRunEvents,
  resultCellId,
} from './run-confirmed-evidence';

describe('confirmed Cell evidence', () => {
  const cells = [
    new SandboxHistoryCell({ id: 'other', output: 'wrong' }),
    new SandboxHistoryCell({ id: 'cell-1', source: 'prompt', stdout: 'out', stderr: 'warn', output: 'answer', exitCode: 1 }),
  ];

  test('extracts and matches only the exact result Cell ID', () => {
    expect(resultCellId('{"cellId":"cell-1"}')).toBe('cell-1');
    expect(confirmedCell(cells, '{"cellId":"cell-1"}')?.output).toBe('answer');
  });

  test('does not guess a Cell for malformed or missing result metadata', () => {
    expect(resultCellId('{bad')).toBe('');
    expect(confirmedCell(cells, '{}')).toBeUndefined();
    expect(confirmedCell(cells, '{"cellId":"missing"}')).toBeUndefined();
  });
});

test('keeps only Sandbox Run events with the exact Project Run ID', () => {
  const events = [
    new RunEvent({ id: 'current', runId: 'run-1' }),
    new RunEvent({ id: 'other', runId: 'run-10' }),
  ];
  expect(confirmedSandboxRunEvents(events, 'run-1').map(event => event.id)).toEqual(['current']);
});

test('does not mark a successful Cell as error only because stderr contains warnings', () => {
  const entries = buildConfirmedEvidenceTimeline({
    schedulerEvents: [],
    cell: new SandboxHistoryCell({ id: 'cell-ok', stderr: 'metadata fallback warning', output: 'answer', success: true, exitCode: 0 }),
    sandboxRunEvents: [],
    existingRunEventIds: new Set(),
    logsPath: '', artifactsDir: '', completedAt: '', updatedAt: '', startedAt: '',
  });

  expect(entries[0]).toMatchObject({ id: 'cell:cell-ok', level: 'warning' });
  expect(entries[0].filterTags).toEqual(expect.arrayContaining(['artifact', 'problem']));
});

test('projects confirmed evidence, removes duplicate Run events, and tags artifacts', () => {
  const entries = buildConfirmedEvidenceTimeline({
    schedulerEvents: [new SchedulerEvent({
      id: 'scheduler-start', type: 'loader.run.started', message: 'started', runId: 'loader-1', createdAt: { seconds: 1n },
    })],
    cell: new SandboxHistoryCell({
      id: 'cell-1', source: 'prompt', stdout: 'stdout', stderr: 'stderr', output: 'answer', exitCode: 1,
      stopReason: 'failed', createdAt: { seconds: 2n },
    }),
    sandboxRunEvents: [
      new RunEvent({ id: 'already-loaded', runId: 'run-1', text: 'duplicate' }),
      new RunEvent({ id: 'sandbox-status', runId: 'run-1', kind: RunEventKind.STATUS, text: 'done', success: true, createdAt: { seconds: 3n } }),
    ],
    existingRunEventIds: new Set(['already-loaded']),
    logsPath: '/logs/output.txt',
    artifactsDir: '/artifacts/cell-1',
    completedAt: '1970-01-01T00:00:04.000Z',
    updatedAt: '',
    startedAt: '',
  });

  expect(entries.map(entry => entry.id)).toEqual(expect.arrayContaining([
    'scheduler:scheduler-start', 'cell:cell-1', 'sandbox-run:sandbox-status', 'run:logs-path', 'run:artifacts-dir',
  ]));
  expect(entries.some(entry => entry.content.includes('duplicate'))).toBe(false);
  expect(entries.find(entry => entry.id === 'cell:cell-1')).toMatchObject({
    source: 'Agent Cell', level: 'error', filterTags: expect.arrayContaining(['message', 'artifact', 'problem']),
  });
  expect(entries.find(entry => entry.id === 'run:logs-path')).toMatchObject({
    timestamp: '1970-01-01T00:00:04.000Z', timestampInferred: true, timestampBasis: 'run-end', filterTags: ['artifact'],
  });
  expect(entries.map(entry => entry.sortTime)).toEqual([...entries.map(entry => entry.sortTime)].sort((a, b) => a - b));
});

test('deduplicates the real Scheduler child Run shape by semantic ownership', () => {
  const prompt = 'Reply with exactly yaml-script-trigger-ok';
  const answer = 'model warning and final answer yaml-script-trigger-ok';
  const resultJson = '{"cellId":"cell-1","sandboxId":"sandbox-1","exitCode":0,"success":true}';
  const entries = buildConfirmedEvidenceTimeline({
    schedulerEvents: [
      new SchedulerEvent({ id: 'start', type: 'loader.run.started', message: 'loader run started', payloadJson: '{"source":"interval:40000"}' }),
      new SchedulerEvent({ id: 'log', type: 'loader.log', message: 'yaml scheduler script interval executed', payloadJson: '{"source":"full-yaml-e2e"}' }),
      new SchedulerEvent({ id: 'agent', type: 'loader.agent.completed', message: answer, payloadJson: JSON.stringify({ text: answer, output: answer, finalText: answer, sandboxId: 'sandbox-1', cellId: 'cell-1', success: true, exitCode: 0 }) }),
      new SchedulerEvent({ id: 'done', type: 'loader.run.completed', message: 'loader run completed', payloadJson: JSON.stringify({ resultJson }) }),
    ],
    cell: new SandboxHistoryCell({ id: 'cell-1', source: prompt, stderr: answer, output: answer, success: true, exitCode: 0, stopReason: 'completed' }),
    sandboxRunEvents: [],
    existingRunEventIds: new Set(),
    existingRunEventContents: new Set([prompt, answer, `${resultJson}\n成功 · 退出码 0`]),
    output: answer,
    resultJson,
    logsPath: '', artifactsDir: '', completedAt: '', updatedAt: '', startedAt: '',
  });

  const content = entries.map(entry => entry.content).join('\n');
  expect(content).toContain('yaml scheduler script interval executed');
  expect(content).toContain('loader run started');
  expect(content).toContain('loader run completed');
  expect(content).not.toContain(prompt);
  expect(content).not.toContain(answer);
  expect(content).not.toContain('finalText');
  expect(content).not.toContain('resultJson');
  expect(entries.find(entry => entry.id === 'scheduler:agent')?.content).toContain('sandbox-1');
  expect(entries.some(entry => entry.id === 'cell:cell-1')).toBe(false);
});
