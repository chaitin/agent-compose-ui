import { describe, expect, it } from 'vitest';

import { isWorkspaceBindingValid, migrateLegacyWorkspaceProviders, parseWorkspaceBinding, setWorkspacePathForFirstAgent } from './workspace-binding';

describe('workspace binding provider compatibility', () => {
  it('creates the file provider accepted by the daemon', () => {
    const yaml = setWorkspacePathForFirstAgent('name: demo\nagents:\n  analyst:\n    provider: codex\n');

    expect(yaml).toContain('provider: file');
    expect(parseWorkspaceBinding(yaml)).toEqual({
      path: 'workspace',
      agentName: 'analyst',
      provider: 'file',
    });
  });

  it('recognizes canonical file bindings and rejects unsupported providers', () => {
    expect(isWorkspaceBindingValid({ path: 'workspace', agentName: 'analyst', provider: 'file' })).toBe(true);
    expect(isWorkspaceBindingValid({ path: 'workspace', agentName: 'analyst', provider: 'git' })).toBe(false);
  });

  it('treats local as a legacy alias and migrates inline and named workspaces', () => {
    const legacy = 'name: demo\nworkspaces:\n  shared:\n    provider: local\n    path: shared\nagents:\n  analyst:\n    workspace:\n      provider: local\n      path: workspace\n';

    expect(parseWorkspaceBinding(legacy)?.provider).toBe('file');
    const migrated = migrateLegacyWorkspaceProviders(legacy);
    expect(migrated).not.toContain('provider: local');
    expect(migrated.match(/provider: file/g)).toHaveLength(2);
  });
});
