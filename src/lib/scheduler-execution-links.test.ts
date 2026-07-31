import { expect, test } from 'vitest';
import { SchedulerEvent } from '../gen/agentcompose/v2/agentcompose_pb';
import { extractSchedulerExecutionLinks } from './scheduler-execution-links';

test('extracts only named explicit links and retains introducing events', () => {
  const result = extractSchedulerExecutionLinks([
    new SchedulerEvent({ id: 'e1', payloadJson: JSON.stringify({ sandboxId: ' box-1 ', cell_id: 'cell-1' }) }),
    new SchedulerEvent({ id: 'e2', payloadJson: JSON.stringify({ result: { runId: 'run-1', sandbox_id: 'box-1' }, text: 'cell-fake' }) }),
  ]);
  expect(result.sandboxes).toEqual([{ id: 'box-1', introducedBy: ['e1', 'e2'] }]);
  expect(result.cells).toEqual([{ id: 'cell-1', introducedBy: ['e1'] }]);
  expect(result.runs).toEqual([{ id: 'run-1', introducedBy: ['e2'] }]);
  expect(result.sandboxRuns).toEqual([{ sandboxId: 'box-1', runId: 'run-1', introducedBy: ['e2'] }]);
  expect(result.sandboxCells).toEqual([{ sandboxId: 'box-1', cellId: 'cell-1', introducedBy: ['e1'] }]);
  expect(result.warnings).toEqual([]);
});

test('preserves malformed payload as a warning without inventing links', () => {
  const result = extractSchedulerExecutionLinks([new SchedulerEvent({ id: 'bad', payloadJson: '{' })]);
  expect(result.sandboxes).toEqual([]);
  expect(result.warnings).toEqual([{ eventId: 'bad', message: 'Scheduler event payload is not valid JSON' }]);
});

test('sorts resources lexically while retaining unique introducers in event order', () => {
  const result = extractSchedulerExecutionLinks([
    new SchedulerEvent({ id: 'later-name', payloadJson: JSON.stringify({ cells: [{ cellId: 'cell-z' }, { cell_id: 'cell-a' }] }) }),
    new SchedulerEvent({ id: 'duplicate', payloadJson: JSON.stringify({ cellId: ' cell-a ', nested: { cell_id: 'cell-a' } }) }),
  ]);

  expect(result.cells).toEqual([
    { id: 'cell-a', introducedBy: ['later-name', 'duplicate'] },
    { id: 'cell-z', introducedBy: ['later-name'] },
  ]);
});

test('ignores empty, non-string, and arbitrary string values and the loader run id', () => {
  const result = extractSchedulerExecutionLinks([
    new SchedulerEvent({
      id: 'event-1',
      runId: 'loader-run',
      payloadJson: JSON.stringify({
        sandboxId: '   ',
        cellId: 42,
        run_id: null,
        output: 'run-fake',
        nested: ['sandbox-fake', { message: 'cell-fake' }],
      }),
    }),
    new SchedulerEvent({ id: 'event-2', payloadJson: '' }),
    new SchedulerEvent({ id: 'event-3', payloadJson: '   ' }),
  ]);

  expect(result).toEqual({ sandboxes: [], cells: [], runs: [], sandboxRuns: [], sandboxCells: [], warnings: [] });
});

test('preserves exact sandbox and run pairs in separate nested objects', () => {
  const result = extractSchedulerExecutionLinks([new SchedulerEvent({
    id: 'pairs',
    payloadJson: JSON.stringify({ links: [
      { sandboxId: 'box-a', runId: 'run-a' },
      { sandbox_id: 'box-b', run_id: 'run-b' },
      { runId: 'unpaired-run' },
    ] }),
  })]);

  expect(result.sandboxRuns).toEqual([
    { sandboxId: 'box-a', runId: 'run-a', introducedBy: ['pairs'] },
    { sandboxId: 'box-b', runId: 'run-b', introducedBy: ['pairs'] },
  ]);
});

test('preserves exact sandbox and cell pairs without creating a cross product', () => {
  const result = extractSchedulerExecutionLinks([new SchedulerEvent({
    id: 'cell-pairs',
    payloadJson: JSON.stringify({ links: [
      { sandboxId: 'box-a', cellId: 'shared-cell' },
      { sandboxId: 'box-b', cellId: 'cell-b' },
      { cellId: 'unpaired-cell' },
    ] }),
  })]);

  expect(result.sandboxCells).toEqual([
    { sandboxId: 'box-a', cellId: 'shared-cell', introducedBy: ['cell-pairs'] },
    { sandboxId: 'box-b', cellId: 'cell-b', introducedBy: ['cell-pairs'] },
  ]);
});
