import {
  SandboxHistoryCell,
  SandboxWatchEventType,
  StdioStream,
  type WatchSandboxResponse,
} from '../gen/agentcompose/v2/agentcompose_pb';
import type { SandboxDetailSnapshot } from './sandbox-detail';

function mergeById<T extends { id: string }>(items: readonly T[], item?: T): T[] {
  if (!item) return [...items];
  const index = items.findIndex(existing => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function mergeCompletedCell(items: readonly SandboxHistoryCell[], completed?: SandboxHistoryCell): SandboxHistoryCell[] {
  if (!completed) return [...items];
  const index = items.findIndex(cell => cell.id === completed.id);
  if (index < 0) return [...items, completed];
  const current = items[index];
  const preserveIfEmpty = (next: string, previous: string) => next || previous;
  const merged = new SandboxHistoryCell({
    ...current,
    ...completed,
    type: preserveIfEmpty(completed.type, current.type),
    source: preserveIfEmpty(completed.source, current.source),
    stdout: preserveIfEmpty(completed.stdout, current.stdout),
    stderr: preserveIfEmpty(completed.stderr, current.stderr),
    output: preserveIfEmpty(completed.output, current.output),
    agent: preserveIfEmpty(completed.agent, current.agent),
    agentThreadId: preserveIfEmpty(completed.agentThreadId, current.agentThreadId),
    stopReason: preserveIfEmpty(completed.stopReason, current.stopReason),
    createdAt: completed.createdAt || current.createdAt,
  });
  const next = [...items];
  next[index] = merged;
  return next;
}

export function mergeSandboxWatchEvent(
  snapshot: SandboxDetailSnapshot,
  event: WatchSandboxResponse,
): SandboxDetailSnapshot {
  switch (event.eventType) {
    case SandboxWatchEventType.SANDBOX_UPDATED:
      return event.sandbox ? { ...snapshot, sandbox: event.sandbox } : snapshot;
    case SandboxWatchEventType.CELL_STARTED:
      return event.cell ? { ...snapshot, cells: mergeById(snapshot.cells, event.cell) } : snapshot;
    case SandboxWatchEventType.CELL_COMPLETED:
      return event.cell ? { ...snapshot, cells: mergeCompletedCell(snapshot.cells, event.cell) } : snapshot;
    case SandboxWatchEventType.CELL_OUTPUT: {
      const index = snapshot.cells.findIndex(cell => cell.id === event.cellId);
      if (index < 0 || !event.chunk) return snapshot;
      const cell = snapshot.cells[index];
      const updated = new SandboxHistoryCell({
        ...cell,
        stdout: event.stream === StdioStream.STDERR ? cell.stdout : cell.stdout + event.chunk,
        stderr: event.stream === StdioStream.STDERR ? cell.stderr + event.chunk : cell.stderr,
      });
      const cells = [...snapshot.cells];
      cells[index] = updated;
      return { ...snapshot, cells };
    }
    case SandboxWatchEventType.EVENT_ADDED:
      return event.event ? { ...snapshot, events: mergeById(snapshot.events, event.event) } : snapshot;
    default:
      return snapshot;
  }
}
