import { describe, expect, test } from 'bun:test';
import { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb';
import { buildRunDateRange, consumeRunWindow } from './run-history';

const runs = (...ids) => ids.map(runId => new RunSummary({ runId }));

describe('run history windows', () => {
  test('uses one lookahead record so exactly 50 has no more and 51 has more', () => {
    const exact = consumeRunWindow(runs(...Array.from({ length: 50 }, (_, i) => `run-${i}`)), 50);
    expect(exact).toMatchObject({ hasMore: false, serverOffset: 50 });
    expect(exact.runs).toHaveLength(50);
    const lookahead = consumeRunWindow(runs(...Array.from({ length: 51 }, (_, i) => `run-${i}`)), 50);
    expect(lookahead).toMatchObject({ hasMore: true, serverOffset: 50 });
    expect(lookahead.runs).toHaveLength(50);
  });

  test('deduplicates by run id while preserving first server position and latest value', () => {
    const duplicate = new RunSummary({ runId: 'b', agentName: 'latest' });
    const window = consumeRunWindow([new RunSummary({ runId: 'a' }), new RunSummary({ runId: 'b', agentName: 'old' }), duplicate, new RunSummary({ runId: 'c' })], 3);
    expect(window.runs.map(run => [run.runId, run.agentName])).toEqual([['a', ''], ['b', 'latest']]);
    expect(window.serverOffset).toBe(3);
    expect(window.hasMore).toBe(true);
  });

  test('builds UTC query bounds from local calendar midnights', () => {
    const range = buildRunDateRange('2026-07-01', '2026-07-15');
    expect(range.startedFrom).toBe(new Date(2026, 6, 1, 0, 0, 0, 0).toISOString());
    expect(range.startedTo).toBe(new Date(new Date(2026, 6, 16, 0, 0, 0, 0).getTime() - 1).toISOString());
    expect(new Date(range.startedTo).getTime()).toBe(new Date(2026, 6, 16, 0, 0, 0, 0).getTime() - 1);
  });
});
