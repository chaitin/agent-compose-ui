import { describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../gen/agentcompose/v2/agentcompose_pb';
import { filterSandboxes, listAllSandboxes, sandboxLifecycle } from './sandbox-inventory';

describe('sandbox inventory', () => {
  it('walks every cursor page exactly once', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'one' })], nextCursor: 'next' })
      .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'two' })], nextCursor: '' });

    await expect(listAllSandboxes(fetchPage)).resolves.toHaveLength(2);
    expect(fetchPage.mock.calls.map(([request]) => request.cursor)).toEqual(['', 'next']);
  });

  it('rejects a repeated cursor', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ sandboxes: [], nextCursor: 'next' })
      .mockResolvedValueOnce({ sandboxes: [], nextCursor: 'next' });

    await expect(listAllSandboxes(fetchPage)).rejects.toThrow(/repeated cursor/i);
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
    expect(sandboxLifecycle('RUNNING')).toBe('running');
    expect(sandboxLifecycle('stopped')).toBe('stopped');
    expect(sandboxLifecycle('REMOVED')).toBe('destroyed');
    expect(sandboxLifecycle('pending')).toBe('unknown');
  });
});
