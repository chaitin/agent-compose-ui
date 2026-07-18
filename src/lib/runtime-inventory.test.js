import { describe, expect, test } from 'bun:test';
import { Code } from '@connectrpc/connect';
import { classifySandboxProbe, groupSandboxInventory, sortSandboxInventory } from './runtime-inventory';

describe('groupSandboxInventory', () => {
  test('deduplicates v2 run sandboxes and retains newest run context', () => {
    const result = groupSandboxInventory([
      { runId: 'old', sandboxId: 'sb-1', agentName: 'writer', updatedAt: '2026-07-14T01:00:00Z' },
      { runId: 'new', sandboxId: 'sb-1', agentName: 'writer', updatedAt: '2026-07-14T02:00:00Z' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sandboxId: 'sb-1', latestRunId: 'new', agentName: 'writer', runCount: 2,
      firstSeenAt: '2026-07-14T01:00:00Z', updatedAt: '2026-07-14T02:00:00Z',
    });
    expect(result[0].runs.map(run => run.runId)).toEqual(['new', 'old']);
  });

  test('ignores runs without sandbox ids and uses created time as a fallback', () => {
    const result = groupSandboxInventory([
      { runId: 'ignored', sandboxId: '', agentName: 'writer', createdAt: '2026-07-14T00:00:00Z' },
      { runId: 'kept', sandboxId: 'sb-1', agentName: 'writer', createdAt: '2026-07-14T01:00:00Z' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ firstSeenAt: '2026-07-14T01:00:00Z', updatedAt: '2026-07-14T01:00:00Z' });
  });
});

describe('classifySandboxProbe', () => {
  test('maps structured V2 probe outcomes to lifecycle states', () => {
    expect(classifySandboxProbe()).toEqual({ lifecycle: 'running', statsUnavailable: false });
    expect(classifySandboxProbe({ code: Code.NotFound, rawMessage: 'missing' }).lifecycle).toBe('destroyed');
    expect(classifySandboxProbe({ code: Code.FailedPrecondition, rawMessage: 'sandbox sb is not running' }).lifecycle).toBe('stopped');
    expect(classifySandboxProbe({ code: Code.Unimplemented, rawMessage: 'stats unsupported' })).toEqual({ lifecycle: 'running', statsUnavailable: true, message: 'stats unsupported' });
    expect(classifySandboxProbe({ code: Code.FailedPrecondition, rawMessage: 'another precondition' }).lifecycle).toBe('unknown');
    expect(classifySandboxProbe({ code: Code.Unavailable, rawMessage: 'offline' }).lifecycle).toBe('unknown');
  });
});

describe('sortSandboxInventory', () => {
  test('orders actionable states first and newest within one state', () => {
    const items = groupSandboxInventory([
      { runId: 'destroyed', sandboxId: 'destroyed', agentName: 'writer', updatedAt: '2026-07-14T05:00:00Z' },
      { runId: 'unknown', sandboxId: 'unknown', agentName: 'writer', updatedAt: '2026-07-14T04:00:00Z' },
      { runId: 'stopped-old', sandboxId: 'stopped-old', agentName: 'writer', updatedAt: '2026-07-14T01:00:00Z' },
      { runId: 'stopped-new', sandboxId: 'stopped-new', agentName: 'writer', updatedAt: '2026-07-14T03:00:00Z' },
      { runId: 'running', sandboxId: 'running', agentName: 'writer', updatedAt: '2026-07-14T02:00:00Z' },
    ]);
    const sorted = sortSandboxInventory(items, {
      running: 'running', 'stopped-old': 'stopped', 'stopped-new': 'stopped',
      unknown: 'unknown', destroyed: 'destroyed',
    });
    expect(sorted.map(item => item.sandboxId)).toEqual(['running', 'stopped-new', 'stopped-old', 'unknown', 'destroyed']);
  });
});
