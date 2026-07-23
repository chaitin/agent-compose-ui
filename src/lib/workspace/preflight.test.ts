// @ts-nocheck -- Bun provides test globals.
import { expect, test } from 'bun:test';
import { requiresManagedWorkspace, assertManagedWorkspace } from './preflight';

const localYaml = `name: demo
agents:
  worker:
    workspace:
      provider: local
      path: workspace
`;

test('requires a managed binding only for a valid local workspace', () => {
  expect(requiresManagedWorkspace(localYaml)).toBe(true);
  expect(requiresManagedWorkspace('name: demo\nagents:\n  worker: {}\n')).toBe(false);
});

test('rejects a missing managed binding before a new run', async () => {
  await expect(assertManagedWorkspace({
    yaml: localYaml,
    sourcePath: '/legacy/project/agent-compose.yml',
    resolve: async () => { throw new Error('not managed'); },
  })).rejects.toThrow('Workspace 共享存储');
});
