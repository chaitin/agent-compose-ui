import { expect, test } from 'bun:test';
import { expandScriptReferences, restoreScriptReferences, replaceInlineWithRef, replaceRefWithInline } from './references';

const yamlText = `name: demo\nagents:\n  worker:\n    scheduler:\n      enabled: true\n      script: $ref:demo/scripts/job.js\n`;

test('expands only a cloned request YAML and returns manifest references', async () => {
  const result = await expandScriptReferences(yamlText, async (path) => ({ path, content: 'engine.notify("ok");', sha256: 'sha256:ok' }));
  expect(yamlText).toContain('$ref:demo/scripts/job.js');
  expect(result.yamlText).toContain('engine.notify');
  expect(result.yamlText).not.toContain('$ref:');
  expect(result.references).toEqual([{ pointer: '/agents/worker/scheduler/script', path: 'demo/scripts/job.js', contentSha256: 'sha256:ok' }]);
});

test('expand does not mutate refs that are not $ref values', async () => {
  const inlineYaml = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: console.log("inline")\n`;
  const result = await expandScriptReferences(inlineYaml, async () => ({ path: '', content: '', sha256: '' }));
  expect(result.references).toEqual([]);
  expect(result.yamlText).toContain('console.log');
});

test('restores a ref only when disk and daemon content hashes both match', async () => {
  const inline = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: |\n        engine.notify("ok");\n`;
  const manifest = { version: 1, projectId: 'p', projectName: 'demo', updatedAt: '', references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/scripts/job.js', contentSha256: 'sha256:ok' }] };
  const restored = await restoreScriptReferences(inline, manifest, {
    readFile: async () => ({ content: 'engine.notify("ok");\n', sha256: 'sha256:ok' }),
    hashContent: async () => 'sha256:ok',
  });
  expect(restored.yamlText).toContain('$ref:demo/scripts/job.js');
  expect(restored.warnings).toEqual([]);
});

test('keeps daemon inline code when the referenced file is missing', async () => {
  const inline = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: old-code\n`;
  const manifest = { version: 1, projectId: 'p', projectName: 'demo', updatedAt: '', references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/missing.js', contentSha256: 'sha256:old' }] };
  const restored = await restoreScriptReferences(inline, manifest, { readFile: async () => { throw new Error('missing'); }, hashContent: async () => 'sha256:old' });
  expect(restored.yamlText).toContain('script: old-code');
  expect(restored.warnings[0].path).toBe('demo/missing.js');
});

test('keeps daemon inline code when daemon hash no longer matches manifest', async () => {
  const inline = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: changed-code\n`;
  const manifest = { version: 1, projectId: 'p', projectName: 'demo', updatedAt: '', references: [{ pointer: '/agents/worker/scheduler/script', path: 'demo/scripts/job.js', contentSha256: 'sha256:original' }] };
  const restored = await restoreScriptReferences(inline, manifest, {
    readFile: async () => ({ content: 'changed-code', sha256: 'sha256:original' }),
    hashContent: async () => 'sha256:changed',
  });
  expect(restored.yamlText).toContain('script: changed-code');
  expect(restored.warnings[0].path).toBe('demo/scripts/job.js');
});

test('restore with null manifest returns the daemon YAML unchanged', async () => {
  const inline = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: code\n`;
  const restored = await restoreScriptReferences(inline, null, {
    readFile: async () => ({ content: '', sha256: '' }),
    hashContent: async () => '',
  });
  expect(restored.references).toEqual([]);
  expect(restored.warnings).toEqual([]);
  expect(restored.yamlText).toContain('script: code');
});

test('replaceInlineWithRef swaps an inline script value for a $ref', () => {
  const inline = `name: demo\nagents:\n  worker:\n    scheduler:\n      script: real-code\n`;
  const result = replaceInlineWithRef(inline, '/agents/worker/scheduler/script', 'demo/worker.js');
  expect(result).toContain('$ref:demo/worker.js');
  expect(result).not.toContain('real-code');
});

test('replaceRefWithInline swaps a $ref value for inline content', () => {
  const result = replaceRefWithInline(yamlText, '/agents/worker/scheduler/script', 'engine.notify("ok")');
  expect(result).toContain('engine.notify("ok")');
  expect(result).not.toContain('$ref:');
});
