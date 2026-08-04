import { expect, test } from 'vitest';
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

test('requires managed binding when any agent (not just the first) has a file workspace', () => {
  const multiAgentYaml = `name: demo
agents:
  alpha:
    provider: codex
  beta:
    workspace:
      provider: file
      path: workspace-beta
`;
  expect(requiresManagedWorkspace(multiAgentYaml)).toBe(true);
});

test('requires managed binding when second agent has file workspace but first has git', () => {
  const mixedProvidersYaml = `name: demo
agents:
  alpha:
    workspace:
      provider: git
      path: https://example.com/repo.git
  beta:
    workspace:
      provider: file
      path: workspace-beta
`;
  expect(requiresManagedWorkspace(mixedProvidersYaml)).toBe(true);
});
