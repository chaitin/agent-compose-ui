// @ts-nocheck -- Executed by Bun, while svelte-check intentionally has no Bun test globals.
import { Window } from 'happy-dom';

const browser = new Window();
Object.assign(globalThis, { window: browser, localStorage: browser.localStorage });
const { buildHash, defaultNavigationURL, loadBrowserDrafts, parseHash, store } = await import('./stores.svelte');

const idle = { level: 'agents' as const, agentName: '', runId: '', sessionId: '' };

test('does not force the files tab onto standalone event URLs', () => {
  expect(defaultNavigationURL('/agent-compose/events/evt-1')).toBe('/agent-compose/events/evt-1#/project/new');
  expect(defaultNavigationURL('/events/evt-1')).toBe('/events/evt-1#/project/new');
  expect(defaultNavigationURL('/')).toBe('/?sandboxTab=files#/project/new');
});

test('round-trips cache and volume resource routes', () => {
  expect(parseHash('#/resources/caches')?.page).toBe('caches');
  expect(parseHash('#/resources/volumes')?.page).toBe('volumes');
  expect(buildHash('caches', '', idle)).toBe('#/resources/caches');
  expect(buildHash('volumes', '', idle)).toBe('#/resources/volumes');
});

test('uses canonical system management routes and accepts legacy aliases', () => {
  expect(parseHash('#/system/images')?.page).toBe('images');
  expect(parseHash('#/system/environment')?.page).toBe('environment');
  expect(parseHash('#/system/capabilities')?.page).toBe('settings');
  expect(parseHash('#/resources/images')?.page).toBe('images');
  expect(parseHash('#/settings')?.page).toBe('settings');
  expect(buildHash('images', '', idle)).toBe('#/system/images');
  expect(buildHash('environment', '', idle)).toBe('#/system/environment');
  expect(buildHash('settings', '', idle)).toBe('#/system/capabilities');
});

test('round-trips an Agent-owned Scheduler Run detail route', () => {
  const view = { level: 'scheduler-run-detail' as const, agentName: 'radar/collector', runId: 'loader-run-1', sessionId: '' };
  const hash = buildHash('project', 'project-1', view);
  expect(hash).toBe('#/project/project-1/agent/radar%2Fcollector/scheduler-run/loader-run-1');
  expect(parseHash(hash)?.runtimeView).toEqual(view);
});

test('commitEditorContent caches the raw YAML under editor:<id>', () => {
  localStorage.clear();
  store.activeProjectId = 'proj-cache';
  const raw = 'name: P\nenv:\n  ANTHROPIC_BASE_URL:\n    value: ${LLM_API_ENDPOINT}\n';
  store.commitEditorContent(raw);
  // The ${VAR} reference must be preserved verbatim in the per-project cache.
  expect(store.loadProjectEditor('proj-cache')).toBe(raw);
});

test('commitEditorContent does not cache when no project is active (unsaved new project)', () => {
  localStorage.clear();
  store.activeProjectId = '';
  store.commitEditorContent('name: P\n');
  // No per-project key should be written, so an existing project's cache is not polluted.
  expect(store.loadProjectEditor('')).toBeNull();
});

test('saveProjectEditor / loadProjectEditor / removeProjectEditor round-trip', () => {
  localStorage.clear();
  expect(store.loadProjectEditor('proj-rt')).toBeNull();
  store.saveProjectEditor('proj-rt', 'yaml-body');
  expect(store.loadProjectEditor('proj-rt')).toBe('yaml-body');
  store.removeProjectEditor('proj-rt');
  expect(store.loadProjectEditor('proj-rt')).toBeNull();
});

test('saveEditorDraft persists multiple new-project drafts with stable identities', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: first-draft\n';

  const first = store.saveEditorDraft();
  store.beginEditorDraft();
  store.editorContent = 'name: second-draft\n';
  const second = store.saveEditorDraft();

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(store.browserDrafts.map((draft) => draft.name)).toEqual(['first-draft', 'second-draft']);
  expect(store.browserDrafts[0].id).not.toBe(store.browserDrafts[1].id);
});

test('new project source identity comes from its persisted server binding', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: first-draft\n';

  expect(store.ensureEditorDraftSourcePath()).toBe('');
  const firstPath = '/data/work/projects/ws_0123456789abcdef0123456789abcdef/agent-compose.yml';
  store.persistActiveDraftBinding({ projectKey: 'ws_0123456789abcdef0123456789abcdef', sourcePath: firstPath });
  expect(store.ensureEditorDraftSourcePath()).toBe(firstPath);

  store.beginEditorDraft();
  expect(store.ensureEditorDraftSourcePath()).toBe('');
});

test('saveEditorDraft updates the selected draft and rejects another draft with the same name', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: first-draft\n# value: 1\n';
  const first = store.saveEditorDraft();
  store.beginEditorDraft();
  store.editorContent = 'name: second-draft\n';
  store.saveEditorDraft();

  store.selectEditorDraft(first.draft.id);
  store.editorContent = 'name: first-draft\n# value: 2\n';
  expect(store.saveEditorDraft().ok).toBe(true);
  expect(store.browserDrafts.find((draft) => draft.id === first.draft.id)?.content).toContain('value: 2');

  store.editorContent = 'name: second-draft\n# duplicate\n';
  expect(store.saveEditorDraft()).toEqual({ ok: false, reason: 'duplicate-name', name: 'second-draft' });
});

test('removeEditorDraft deletes only the specified draft', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: keep\n';
  const keep = store.saveEditorDraft();
  store.beginEditorDraft();
  store.editorContent = 'name: remove\n';
  const remove = store.saveEditorDraft();

  store.removeEditorDraft(remove.draft.id);

  expect(store.browserDrafts.map((draft) => draft.id)).toEqual([keep.draft.id]);
});

test('loadBrowserDrafts migrates the legacy singleton draft', () => {
  localStorage.clear();
  localStorage.setItem('editor:__new_project_draft__', 'name: legacy-draft\n');

  expect(loadBrowserDrafts()).toMatchObject([{ name: 'legacy-draft', content: 'name: legacy-draft\n' }]);
  expect(localStorage.getItem('editor:__new_project_draft__')).toBeNull();
});

test('draft workspace binding survives persistence and selection', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: bound-draft\n';

  store.persistActiveDraftBinding({
    projectKey: 'ws_0123456789abcdef0123456789abcdef',
    sourcePath: '/data/work/projects/ws_0123456789abcdef0123456789abcdef/agent-compose.yml',
  });

  const loaded = loadBrowserDrafts();
  expect(loaded).toHaveLength(1);
  expect(loaded[0].projectKey).toBe('ws_0123456789abcdef0123456789abcdef');
  expect(loaded[0].sourcePath).toContain('/data/work/projects/');
});

test('a late workspace binding response cannot recreate a removed draft', () => {
  localStorage.clear();
  store.browserDrafts = [];
  store.activeDraftId = '';
  store.activeProjectId = '';
  store.editorContent = 'name: enabled-project\n';

  store.ensureEditorDraftSourcePath();
  const removedDraftId = store.activeDraftId;
  store.removeEditorDraft(removedDraftId);

  expect(store.persistActiveDraftBinding({
    projectKey: 'ws_late',
    sourcePath: '/data/work/projects/ws_late/agent-compose.yml',
  }, removedDraftId)).toBeUndefined();
  expect(store.browserDrafts).toEqual([]);
  expect(store.activeDraftId).toBe('');
});
