import { render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ actions: new Map<string, any>(), run: vi.fn() }));

vi.mock('./Toolbar.svelte', async () => ({ default: (await import('../test/fixtures/ToolbarBindingStub.svelte')).default }));
vi.mock('./ResourcePanel.svelte', async () => ({ default: (await import('../test/fixtures/ResourcePanelApplyStub.svelte')).default }));
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor', () => ({
  KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 }, editor: {
    OverviewRulerLane: { Right: 1 }, create: () => ({
      createContextKey: () => ({ set: vi.fn(), reset: vi.fn() }), onDidChangeModelContent: () => ({ dispose: vi.fn() }),
      onDidChangeCursorPosition: () => ({ dispose: vi.fn() }), onMouseDown: vi.fn(), addAction: (action: any) => mocks.actions.set(action.id, action),
      onDidScrollChange: () => ({ dispose: vi.fn() }), onDidLayoutChange: () => ({ dispose: vi.fn() }),
      getPosition: () => null, getValue: () => 'agents: {}', getScrollTop: () => 0, getScrollLeft: () => 0, getSelections: () => [],
      getModel: () => null,
      deltaDecorations: () => [], setValue: vi.fn(), setSelections: vi.fn(), setScrollPosition: vi.fn(),
      layoutContentWidget: vi.fn(), removeContentWidget: vi.fn(), dispose: vi.fn(), getLayoutInfo: () => ({ contentLeft: 0, contentWidth: 100 }),
    }),
  },
}));
vi.mock('../lib/stores.svelte', () => ({ store: {
  editorCollapsed: false, editorContent: 'agents: {}', activeProjectId: '', activeDraftId: '', projects: [], browserDrafts: [], runtimeView: { agentName: '' },
  activeDraftBinding: () => ({}), commitEditorContent: vi.fn(), addToast: vi.fn(),
} }));
vi.mock('../lib/scripts/workspace.svelte', () => ({ scriptWorkspace: { projectName: '', panelOpen: false, tree: undefined, files: new Map(), refreshTree: vi.fn() } }));
vi.mock('../lib/rpc', () => ({ settingsService: { getGlobalEnv: vi.fn().mockResolvedValue({ env: [] }) } }));

import YamlEditor from './YamlEditor.svelte';

afterEach(() => { delete (globalThis as any).__toolbarRunProject; mocks.actions.clear(); });

test('routes Monaco save to the primary action button click', async () => {
  mocks.run.mockResolvedValue(undefined);
  (globalThis as any).__toolbarRunProject = mocks.run;
  render(YamlEditor);

  await waitFor(() => expect(mocks.actions.has('apply-project')).toBe(true));
  // Monaco save action now clicks the primary button in the DOM
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.click = mocks.run;
  document.body.appendChild(btn);
  await mocks.actions.get('apply-project').run();
  expect(mocks.run).toHaveBeenCalledOnce();
  document.body.removeChild(btn);
});
