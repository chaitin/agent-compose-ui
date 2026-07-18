import { describe, expect, it } from 'vitest';
import {
  Sandbox, SandboxHistoryCell, SandboxHistoryEvent, SandboxWatchEventType, StdioStream, WatchSandboxResponse,
} from '../gen/agentcompose/v2/agentcompose_pb';
import type { SandboxDetailSnapshot } from './sandbox-detail';
import { mergeSandboxWatchEvent } from './sandbox-watch';

function snapshot(cell?: SandboxHistoryCell): SandboxDetailSnapshot {
  return { sandbox: new Sandbox({ sandboxId: 's1', status: 'RUNNING' }), cells: cell ? [cell] : [], events: [], runEvents: [], legacyHistory: false };
}

describe('mergeSandboxWatchEvent', () => {
  it('appends a streamed stdout chunk to the matching cell immutably', () => {
    const initial = snapshot(new SandboxHistoryCell({ id: 'cell-1', stdout: 'a' }));
    const next = mergeSandboxWatchEvent(initial, new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_OUTPUT, cellId: 'cell-1', chunk: 'b', stream: StdioStream.STDOUT,
    }));
    expect(next.cells[0].stdout).toBe('ab');
    expect(initial.cells[0].stdout).toBe('a');
  });

  it('appends stderr separately', () => {
    const next = mergeSandboxWatchEvent(snapshot(new SandboxHistoryCell({ id: 'cell-1', stderr: 'a' })), new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_OUTPUT, cellId: 'cell-1', chunk: 'b', stream: StdioStream.STDERR,
    }));
    expect(next.cells[0].stderr).toBe('ab');
  });

  it('replaces lifecycle metadata from a sandbox update', () => {
    const next = mergeSandboxWatchEvent(snapshot(), new WatchSandboxResponse({
      eventType: SandboxWatchEventType.SANDBOX_UPDATED,
      sandbox: new Sandbox({ sandboxId: 's1', status: 'STOPPED' }),
    }));
    expect(next.sandbox.status).toBe('STOPPED');
  });

  it('starts and completes cells in place without changing their order', () => {
    const first = new SandboxHistoryCell({ id: 'cell-1', source: 'one' });
    const started = mergeSandboxWatchEvent(snapshot(first), new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_STARTED, cell: new SandboxHistoryCell({ id: 'cell-2', source: 'two', running: true }),
    }));
    const completed = mergeSandboxWatchEvent(started, new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_COMPLETED, cell: new SandboxHistoryCell({ id: 'cell-2', source: 'two', output: 'done', success: true }),
    }));
    expect(completed.cells.map(cell => cell.id)).toEqual(['cell-1', 'cell-2']);
    expect(completed.cells[1]).toMatchObject({ output: 'done', success: true });
  });

  it('preserves streamed output when a sparse completion payload arrives', () => {
    const started = snapshot(new SandboxHistoryCell({ id: 'cell-1', source: 'echo hello', running: true }));
    const withStdout = mergeSandboxWatchEvent(started, new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_OUTPUT, cellId: 'cell-1', chunk: 'hello\n', stream: StdioStream.STDOUT,
    }));
    const withStderr = mergeSandboxWatchEvent(withStdout, new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_OUTPUT, cellId: 'cell-1', chunk: 'warning\n', stream: StdioStream.STDERR,
    }));
    const completed = mergeSandboxWatchEvent(withStderr, new WatchSandboxResponse({
      eventType: SandboxWatchEventType.CELL_COMPLETED,
      cell: new SandboxHistoryCell({ id: 'cell-1', running: false, success: true, exitCode: 0 }),
    }));

    expect(completed.cells[0]).toMatchObject({
      source: 'echo hello', stdout: 'hello\n', stderr: 'warning\n', running: false, success: true, exitCode: 0,
    });
  });

  it('deduplicates cells and events by id', () => {
    const cell = new SandboxHistoryCell({ id: 'cell-1', source: 'one' });
    const event = new SandboxHistoryEvent({ id: 'event-1', message: 'ready' });
    const withCell = mergeSandboxWatchEvent(snapshot(cell), new WatchSandboxResponse({ eventType: SandboxWatchEventType.CELL_STARTED, cell }));
    const withEvent = mergeSandboxWatchEvent(withCell, new WatchSandboxResponse({ eventType: SandboxWatchEventType.EVENT_ADDED, event }));
    const duplicate = mergeSandboxWatchEvent(withEvent, new WatchSandboxResponse({ eventType: SandboxWatchEventType.EVENT_ADDED, event }));
    expect(duplicate.cells).toHaveLength(1);
    expect(duplicate.events).toHaveLength(1);
  });
});
