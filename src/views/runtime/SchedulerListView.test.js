import { expect, test } from 'bun:test'; import { readFileSync } from 'node:fs';
test('reads scheduler definitions and uses direct v2 scheduler controls', () => {
  const source=readFileSync(new URL('./SchedulerListView.svelte', import.meta.url),'utf8');
  expect(source).toContain('projectService.getProject(new GetProjectRequest');
  expect(source).toContain('const request = new RunAgentRequest');
  expect(source).toContain('runService.runAgent(request)');
  expect(source).toContain('runService.startRun(new StartRunRequest({ run: request }))');
  expect(source).toContain("store.navigateTo('run-detail'");
  expect(source).toContain('projectService.listSchedulerEvents(new ListSchedulerEventsRequest');
  expect(source).toContain('projectService.setSchedulerEnabled(new SetSchedulerEnabledRequest');
  expect(source).toContain('projectService.setSchedulerTriggerEnabled(new SetSchedulerTriggerEnabledRequest');
  expect(source).not.toContain("V2_CAPABILITIES['scheduler-control']");
  expect(source).not.toContain('loaderService');
});
test('clears scheduler rows before a new project request and on failure', () => {
  const source=readFileSync(new URL('./SchedulerListView.svelte', import.meta.url),'utf8');
  expect(source).toMatch(/const generation = \+\+loadGeneration;\s*rows = \[\];\s*payloads = \{\};\s*overrides = \{\};\s*sandboxIds = \[\];\s*running = '';\s*controlling = '';\s*error = '';/);
  expect(source).toMatch(/catch \(cause: any\) \{\s*if \(generation !== loadGeneration \|\| projectId !== store\.activeProjectId\) return;\s*rows = \[\];/);
  expect(source).toContain('type SchedulerRow = { sourceProjectId: string;');
  expect(source).toContain('projectId, agentName: row.summary.agentName');
});
