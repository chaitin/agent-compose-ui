import { expect, test } from 'bun:test';
import {
  defaultScriptPath,
  extractInlineScript,
  findScriptAtLine,
  initializeInlineScript,
  inlineScriptReference,
  listScriptRanges,
  referenceExistingScript,
} from './editor-actions';

const yamlWithRef = `name: demo
agents:
  worker:
    scheduler:
      enabled: true
      script: $ref:demo/a.js
`;

const yamlWithInline = `name: demo
agents:
  worker:
    scheduler:
      script: |-
        engine.notify("ok")
        console.log("done")
`;

test('listScriptRanges exposes inline and reference rows for editor decorations', () => {
  const yaml = `name: demo
agents:
  inline-worker:
    scheduler:
      script: |-
        console.log("inline")
  linked-worker:
    scheduler:
      script: $ref:scripts/linked-worker.js
`;

  expect(listScriptRanges(yaml)).toEqual([
    {
      pointer: '/agents/inline-worker/scheduler/script',
      agentName: 'inline-worker',
      kind: 'inline',
      content: 'console.log("inline")',
      startLine: 5,
      endLine: 6,
    },
    {
      pointer: '/agents/linked-worker/scheduler/script',
      agentName: 'linked-worker',
      kind: 'reference',
      path: 'scripts/linked-worker.js',
      startLine: 9,
      endLine: 9,
    },
  ]);
});

test('defaultScriptPath sanitizes agent names for an editable default', () => {
  expect(defaultScriptPath('/agents/report worker@scheduler/scheduler/script')).toBe(
    'scripts/report-worker-scheduler.js',
  );
});

test('defaultScriptPath uses projectName as directory prefix when provided', () => {
  expect(defaultScriptPath('/agents/worker/scheduler/script', 'my-project')).toBe(
    'my-project/worker.js',
  );
});

test('defaultScriptPath preserves readable unicode agent names', () => {
  expect(defaultScriptPath('/agents/日报 生成器/scheduler/script')).toBe('scripts/日报-生成器.js');
});

test('findScriptAtLine locates a reference on the script line (1-based)', () => {
  expect(findScriptAtLine(yamlWithRef, 6)).toEqual({
    pointer: '/agents/worker/scheduler/script',
    kind: 'reference',
    path: 'demo/a.js',
  });
});

test('findScriptAtLine returns null on a non-script line', () => {
  expect(findScriptAtLine(yamlWithRef, 1)).toBeNull();
  expect(findScriptAtLine(yamlWithRef, 4)).toBeNull();
});

test('findScriptAtLine locates inline block content across its line range', () => {
  const location = findScriptAtLine(yamlWithInline, 7);
  expect(location).toEqual({
    pointer: '/agents/worker/scheduler/script',
    kind: 'inline',
    content: 'engine.notify("ok")\nconsole.log("done")',
  });
  expect(findScriptAtLine(yamlWithInline, 5)).not.toBeNull();
  expect(findScriptAtLine(yamlWithInline, 4)).toBeNull();
});

test('extractInlineScript moves inline code into a file and leaves a $ref', () => {
  const result = extractInlineScript(yamlWithInline, '/agents/worker/scheduler/script', 'demo/worker.js');
  expect(result.yamlText).toContain('$ref:demo/worker.js');
  expect(result.yamlText).not.toContain('engine.notify');
  expect(result.content).toContain('engine.notify("ok")');
  expect(result.content).toContain('console.log("done")');
});

test('referenceExistingScript replaces any script value with a $ref', () => {
  const result = referenceExistingScript(yamlWithInline, '/agents/worker/scheduler/script', 'shared/alert.js');
  expect(result).toContain('$ref:shared/alert.js');
});

test('initializeInlineScript turns an empty script value into an editable block', () => {
  const yaml = `agents:
  worker:
    scheduler:
      script:
`;
  const result = initializeInlineScript(yaml, '/agents/worker/scheduler/script');
  expect(result).toContain('script: |-');
  expect(result).not.toContain('__SCRIPT_BLOCK_SENTINEL');
});

test('inlineScriptReference replaces a $ref with a literal block scalar', () => {
  const result = inlineScriptReference(yamlWithRef, '/agents/worker/scheduler/script', 'engine.notify("ok")');
  expect(result).toContain('script: |-');
  expect(result).toContain('engine.notify("ok")');
  expect(result).not.toContain('$ref:');
});

test('inlineScriptReference indents multi-line content under the script key', () => {
  const result = inlineScriptReference(yamlWithRef, '/agents/worker/scheduler/script', 'line1\nline2');
  expect(result).toContain('script: |-');
  expect(result).toMatch(/  line1/);
  expect(result).toMatch(/  line2/);
});

test('round-trip: inline then extract yields the original content', () => {
  const inlined = inlineScriptReference(yamlWithRef, '/agents/worker/scheduler/script', 'round-trip-code');
  const extracted = extractInlineScript(inlined, '/agents/worker/scheduler/script', 'demo/rt.js');
  expect(extracted.content).toBe('round-trip-code');
  expect(extracted.yamlText).toContain('$ref:demo/rt.js');
});
