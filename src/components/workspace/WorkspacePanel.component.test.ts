import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  editorContent: `name: demo
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
`,
  setWorkspace: vi.fn(),
  ensure: vi.fn().mockResolvedValue({ projectKey: 'ws_test', sourcePath: '/tmp/project' }),
}));

vi.mock('../../lib/stores.svelte', () => ({
  store: {
    editorContent: mocks.editorContent,
    activeProjectId: '',
    activeDraftId: 'draft-1',
    projects: [],
    browserDrafts: [{ id: 'draft-1', legacyStorageKey: '' }],
    runtimeView: { agentName: '' },
    activeDraftBinding: () => ({ sourcePath: '/tmp/project', projectKey: '', legacyStorageKey: '' }),
    ensureEditorDraftSourcePath: vi.fn(),
    persistActiveDraftBinding: vi.fn(),
    commitEditorContent: vi.fn(),
    addToast: vi.fn(),
  },
}));

vi.mock('../../lib/workspace/bindings', () => ({
  workspaceBindings: { ensure: mocks.ensure },
  setProjectBindingOverride: vi.fn(),
  projectStorageErrorMessage: vi.fn(() => 'binding error'),
  legacyKeyFromSourcePath: vi.fn(() => ''),
}));

vi.mock('../../lib/workspace/store.svelte', () => ({
  workspaceFiles: {
    files: [],
    activePath: '',
    lastError: null,
    setWorkspace: mocks.setWorkspace,
    refresh: vi.fn().mockResolvedValue({ files: [], error: null }),
  },
}));

vi.mock('./WorkspaceFileTree.svelte', async () => ({ default: (await import('../../test/fixtures/WorkspaceFileTreeStub.svelte')).default }));
vi.mock('./WorkspaceFilePreview.svelte', async () => ({ default: (await import('../../test/fixtures/WorkspaceFilePreviewStub.svelte')).default }));

import WorkspacePanel from './WorkspacePanel.svelte';

afterEach(() => {
  mocks.setWorkspace.mockClear();
  mocks.ensure.mockClear();
});

test('renders agent dropdown when YAML defines multiple agents with workspaces', () => {
  render(WorkspacePanel);

  const dropdown = screen.getByRole('combobox', { name: '选择智能体 workspace' }) as HTMLSelectElement;
  const options = Array.from(dropdown.options).map((o) => o.textContent);
  expect(options).toEqual(['alpha', 'beta', 'gamma']);
  expect(dropdown.value).toBe('alpha');
});

test('switching to another agent re-resolves the workspace binding for that agent', async () => {
  render(WorkspacePanel);

  await waitFor(() => {
    expect(mocks.setWorkspace).toHaveBeenCalledWith('ws_test', 'workspace-alpha');
  });

  mocks.setWorkspace.mockClear();

  const dropdown = screen.getByRole('combobox', { name: '选择智能体 workspace' }) as HTMLSelectElement;
  await fireEvent.change(dropdown, { target: { value: 'beta' } });

  await waitFor(() => {
    expect(mocks.setWorkspace).toHaveBeenCalledWith('ws_test', 'workspace-beta');
  });
});

test('first agent workspace is bound on initial render', async () => {
  render(WorkspacePanel);

  await waitFor(() => {
    expect(mocks.setWorkspace).toHaveBeenCalledWith('ws_test', 'workspace-alpha');
  });
});
