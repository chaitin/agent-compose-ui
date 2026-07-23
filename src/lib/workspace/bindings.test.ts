import { describe, expect, test } from 'vitest';
import { BindingCoordinator, type ProjectStorageBinding } from './bindings';

const binding: ProjectStorageBinding = {
  projectKey: 'ws_0123456789abcdef0123456789abcdef',
  sourcePath: '/data/work/projects/ws_0123456789abcdef0123456789abcdef/agent-compose.yml',
  workspacePath: 'workspace',
};

describe('BindingCoordinator', () => {
  test('deduplicates concurrent binding creation for one editor identity', async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new BindingCoordinator({
      bind: async () => { calls += 1; await pending; return binding; },
      resolve: async () => binding,
    });
    const first = coordinator.ensure('draft:one', {});
    const second = coordinator.ensure('draft:one', {});
    release();
    expect(await first).toEqual(binding);
    expect(await second).toEqual(binding);
    expect(calls).toBe(1);
  });

  test('resolves a saved project from its canonical source path', async () => {
    let source = '';
    const coordinator = new BindingCoordinator({
      bind: async () => binding,
      resolve: async (sourcePath) => { source = sourcePath; return binding; },
    });
    await coordinator.ensure('project:one', { sourcePath: binding.sourcePath });
    expect(source).toBe(binding.sourcePath);
  });
});
