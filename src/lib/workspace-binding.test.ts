import { describe, expect, it } from 'vitest';

import {
  isWorkspaceBindingValid,
  listWorkspaceBindings,
  migrateLegacyWorkspaceProviders,
  parseWorkspaceBinding,
  setWorkspacePathForAgent,
  setWorkspacePathForFirstAgent,
} from './workspace-binding';

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

describe('listWorkspaceBindings', () => {
  it('returns bindings for every agent with a workspace block', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    workspace:
      provider: file
      path: workspace-beta
  gamma:
    workspace:
      provider: file
      path: workspace-gamma
`;

    const bindings = listWorkspaceBindings(yaml);

    expect(bindings).toEqual([
      { path: 'workspace-alpha', agentName: 'alpha', provider: 'file' },
      { path: 'workspace-beta', agentName: 'beta', provider: 'file' },
      { path: 'workspace-gamma', agentName: 'gamma', provider: 'file' },
    ]);
  });

  it('skips agents without a workspace block', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    provider: codex
  gamma:
    workspace:
      provider: file
      path: workspace-gamma
`;

    const bindings = listWorkspaceBindings(yaml);

    expect(bindings.map((b) => b.agentName)).toEqual(['alpha', 'gamma']);
  });

  it('returns empty array when no agents have workspace', () => {
    const yaml = 'name: demo\nagents:\n  alpha:\n    provider: codex\n';

    expect(listWorkspaceBindings(yaml)).toEqual([]);
  });

  it('returns empty array when agents is missing or malformed', () => {
    expect(listWorkspaceBindings('name: demo\n')).toEqual([]);
    expect(listWorkspaceBindings('not: valid yaml')).toEqual([]);
    expect(listWorkspaceBindings('agents: []')).toEqual([]);
  });

  it('normalizes legacy local provider to file for each agent', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: local
      path: workspace-alpha
  beta:
    workspace:
      provider: local
      path: workspace-beta
`;

    const bindings = listWorkspaceBindings(yaml);

    expect(bindings.every((b) => b.provider === 'file')).toBe(true);
  });
});

describe('parseWorkspaceBinding with agentName', () => {
  it('returns the binding for the named agent when multiple agents define workspaces', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    workspace:
      provider: file
      path: workspace-beta
`;

    const beta = parseWorkspaceBinding(yaml, 'beta');

    expect(beta).toEqual({ path: 'workspace-beta', agentName: 'beta', provider: 'file' });
  });

  it('returns null when the named agent has no workspace block', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    provider: codex
`;

    expect(parseWorkspaceBinding(yaml, 'beta')).toBeNull();
  });

  it('falls back to first agent when no agentName is provided (backwards compatible)', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    workspace:
      provider: file
      path: workspace-beta
`;

    expect(parseWorkspaceBinding(yaml)?.agentName).toBe('alpha');
  });
});

describe('setWorkspacePathForAgent', () => {
  it('adds a workspace block to the named agent without touching other agents', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
  beta:
    provider: codex
`;

    const next = setWorkspacePathForAgent(yaml, 'beta');

    expect(parseWorkspaceBinding(next, 'alpha')?.path).toBe('workspace-alpha');
    expect(parseWorkspaceBinding(next, 'beta')?.path).toBe('workspace');
    expect(parseWorkspaceBinding(next, 'beta')?.provider).toBe('file');
  });

  it('overwrites the named agent existing workspace path when provider is file', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: old-alpha
  beta:
    workspace:
      provider: file
      path: old-beta
`;

    const next = setWorkspacePathForAgent(yaml, 'beta');

    expect(parseWorkspaceBinding(next, 'alpha')?.path).toBe('old-alpha');
    expect(parseWorkspaceBinding(next, 'beta')?.path).toBe('workspace');
  });

  it('normalizes legacy local provider to file on the named agent', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: local
      path: old-alpha
`;

    const next = setWorkspacePathForAgent(yaml, 'alpha');

    expect(parseWorkspaceBinding(next, 'alpha')?.provider).toBe('file');
  });

  it('throws when the named agent has a non-file provider without force', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: git
      path: old-alpha
`;

    expect(() => setWorkspacePathForAgent(yaml, 'alpha')).toThrow();
  });

  it('overwrites non-file provider when force is true', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: git
      path: old-alpha
`;

    const next = setWorkspacePathForAgent(yaml, 'alpha', { force: true });

    expect(parseWorkspaceBinding(next, 'alpha')?.provider).toBe('file');
    expect(parseWorkspaceBinding(next, 'alpha')?.path).toBe('workspace');
  });

  it('throws when the named agent does not exist', () => {
    const yaml = `name: demo
agents:
  alpha:
    workspace:
      provider: file
      path: workspace-alpha
`;

    expect(() => setWorkspacePathForAgent(yaml, 'beta')).toThrow();
  });
});
