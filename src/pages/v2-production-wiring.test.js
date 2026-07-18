import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('toolbar tracks every applied YML agent through the ordinary v2 Run service', () => {
  const toolbar = readFileSync(new URL('../components/Toolbar.svelte', import.meta.url), 'utf8');
  const actions = readFileSync(new URL('../lib/toolbar-actions.ts', import.meta.url), 'utf8');
  expect(toolbar).toContain('runYamlBatch({');
  expect(toolbar).toContain('client: runService');
  expect(toolbar).not.toContain('runProjectTriggers');
  expect(actions).toContain('for (const agent of options.agents)');
  expect(actions).toContain('options.client.startRun(new StartRunRequest({');
  expect(actions).toContain('run: new RunAgentRequest({');
});

test('agent detail lists v2 runs and opens the v2 run detail route', () => {
  const workspace = readFileSync(new URL('./ProjectWorkspace.svelte', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../views/runtime/AgentRunListView.svelte', import.meta.url), 'utf8');
  expect(workspace).toContain("import AgentRunListView from '../views/runtime/AgentRunListView.svelte'");
  expect(workspace).toMatch(/runtimeView\.level === 'agent-detail'[\s\S]*<AgentRunListView/);
  expect(detail).toContain('runService.listRuns(new ListRunsRequest');
  expect(detail).toContain("store.navigateTo('run-detail'");
});

test('event pathname renders the standalone Session page outside the project shell', () => {
  const app = readFileSync(new URL('../App.svelte', import.meta.url), 'utf8');
  expect(app).toContain("import EventSandboxDetailPage from './pages/EventSandboxDetailPage.svelte'");
  expect(app).toContain("/(?:^|\\/agent-compose)\\/events\\/([^/]+)\\/?$/");
  expect(app).toMatch(/\{#if eventId\}[\s\S]*<EventSandboxDetailPage \{eventId\} \/>[\s\S]*\{:else\}[\s\S]*<div class="shell">/);
  expect(app).toContain("window.addEventListener('popstate', syncPathname)");
  expect(app).toContain("window.removeEventListener('popstate', syncPathname)");
  expect(app).toContain('let eventId = $derived');
});
