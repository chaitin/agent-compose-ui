import { expect, test } from 'bun:test'; import { readFileSync } from 'node:fs';
test('lists project runtime from v2 runs', () => {
  const source = readFileSync(new URL('./ProjectRuntimeView.svelte', import.meta.url),'utf8');
  expect(source).toContain('runService.listRuns');
  expect(source).toContain('ListRunsRequest');
  expect(source).not.toContain('loader-runs');
});
