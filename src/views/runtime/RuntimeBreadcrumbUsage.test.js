import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const runtimePages = [
  'AgentListView.svelte',
  'AgentRunListView.svelte',
  'LatestRunView.svelte',
  'ProjectRuntimeView.svelte',
  'RunDetailView.svelte',
  'SandboxDetailView.svelte',
  'SandboxListView.svelte',
  'SchedulerListView.svelte',
];

test('all right-side runtime pages use the shared Agent-detail breadcrumb', () => {
  for (const file of runtimePages) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).toContain("import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte'");
    expect(source).toContain('<RuntimeBreadcrumb');
    expect(source).not.toMatch(/<header[^>]*>\s*<button[^>]*>← 返回/);
    expect(source).not.toContain('class="console-header"');
  }
});
