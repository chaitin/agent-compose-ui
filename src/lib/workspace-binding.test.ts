import { describe, expect, it } from 'vitest';

import { isWorkspaceBindingValid, migrateLegacyWorkspaceProviders, parseWorkspaceBinding, setWorkspacePathForFirstAgent } from './workspace-binding';

describe('workspace binding provider compatibility', () => {
  it('creates the local provider accepted by the published daemon', () => {
    const yaml = setWorkspacePathForFirstAgent('name: demo\nagents:\n  analyst:\n    provider: codex\n');

    expect(yaml).toContain('provider: local');
    expect(parseWorkspaceBinding(yaml)).toEqual({
      path: 'workspace',
      agentName: 'analyst',
      provider: 'local',
    });
  });

  it('recognizes local bindings and rejects unsupported providers', () => {
    expect(isWorkspaceBindingValid({ path: 'workspace', agentName: 'analyst', provider: 'local' })).toBe(true);
    expect(isWorkspaceBindingValid({ path: 'workspace', agentName: 'analyst', provider: 'git' })).toBe(false);
  });

  it('treats file as a legacy alias and migrates inline and named workspaces', () => {
    const legacy = 'name: demo\nworkspaces:\n  shared:\n    provider: file\n    path: shared\nagents:\n  analyst:\n    workspace:\n      provider: file\n      path: workspace\n';

    expect(parseWorkspaceBinding(legacy)?.provider).toBe('local');
    const migrated = migrateLegacyWorkspaceProviders(legacy);
    expect(migrated).not.toContain('provider: file');
    expect(migrated.match(/provider: local/g)).toHaveLength(2);
  });
});
