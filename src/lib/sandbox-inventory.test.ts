import { describe, expect, it, vi } from 'vitest';
import { Sandbox, SandboxStatus } from '../gen/agentcompose/v2/agentcompose_pb';
import { filterSandboxes, listAllSandboxes, sandboxLifecycle } from './sandbox-inventory';

describe('sandbox inventory', () => {
  it('walks every offset page exactly once', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'one' })], total: 2 })
      .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'two' })], total: 2 });

    await expect(listAllSandboxes(fetchPage)).resolves.toHaveLength(2);
    expect(fetchPage.mock.calls.map(([request]) => request.offset)).toEqual([0, 1]);
  });

  it('filters by authoritative fields and legacy tags', () => {
    const records = [
      new Sandbox({ sandboxId: 'direct', projectId: 'p1', agentName: 'collector' }),
      new Sandbox({ sandboxId: 'tagged', tags: [{ name: 'project', value: 'p1' }, { name: 'agent', value: 'collector' }] }),
      new Sandbox({ sandboxId: 'other', projectId: 'p2', agentName: 'collector' }),
      new Sandbox({ sandboxId: 'direct-wins', projectId: 'p2', agentName: 'collector', tags: [{ name: 'project', value: 'p1' }] }),
    ];

    expect(filterSandboxes(records, { projectId: 'p1', agentName: 'collector' }).map(item => item.sandboxId)).toEqual(['direct', 'tagged']);
  });

  it('normalizes backend lifecycle values', () => {
    expect(sandboxLifecycle(SandboxStatus.RUNNING)).toBe('running');
    expect(sandboxLifecycle(SandboxStatus.STOPPED)).toBe('stopped');
    expect(sandboxLifecycle(SandboxStatus.DELETING)).toBe('destroyed');
    expect(sandboxLifecycle(SandboxStatus.PENDING)).toBe('unknown');
  });
});
