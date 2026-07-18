import { expect, test } from 'bun:test';
import { yamlToSpec } from '../yaml';
import { prepareScriptRequest } from './request-pipeline';

const refYaml = 'name: demo\nagents:\n  worker:\n    scheduler:\n      script: $ref:demo/a.js\n';

test('validate uses in-memory dirty content without saving it', async () => {
  let flushCalls = 0;
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: refYaml,
    workspace: {
      getContent: () => 'dirty code',
      flushDirty: async () => { flushCalls += 1; },
    },
    readFile: async () => ({ content: 'disk code', sha256: 'sha256:disk' }),
    hashContent: async () => 'sha256:dirty',
  });
  expect(flushCalls).toBe(0);
  expect(result.yamlText).toContain('dirty code');
  expect(result.yamlText).not.toContain('$ref:');
  expect(result.references).toEqual([
    { pointer: '/agents/worker/scheduler/script', path: 'demo/a.js', contentSha256: 'sha256:dirty' },
  ]);
});

test('save flushes dirty scripts before expanding', async () => {
  const order = [];
  await prepareScriptRequest({
    mode: 'save',
    editorYaml: refYaml,
    workspace: {
      getContent: () => undefined,
      flushDirty: async () => { order.push('flush'); },
    },
    readFile: async () => { order.push('read'); return { content: 'saved code', sha256: 'sha256:saved' }; },
  });
  expect(order).toEqual(['flush', 'read']);
});

test('run flushes dirty scripts before expanding', async () => {
  const order = [];
  await prepareScriptRequest({
    mode: 'run',
    editorYaml: refYaml,
    workspace: {
      getContent: () => undefined,
      flushDirty: async () => { order.push('flush'); },
    },
    readFile: async () => { order.push('read'); return { content: 'run code', sha256: 'sha256:run' }; },
  });
  expect(order).toEqual(['flush', 'read']);
});

test('validate falls back to disk when no in-memory content exists', async () => {
  const reads = [];
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: refYaml,
    workspace: {
      getContent: () => undefined,
      flushDirty: async () => {},
    },
    readFile: async (path) => { reads.push(path); return { content: 'disk code', sha256: 'sha256:disk' }; },
  });
  expect(reads).toEqual(['demo/a.js']);
  expect(result.yamlText).toContain('disk code');
});

test('inline-only YAML does not access the script service', async () => {
  const inlineYaml = 'name: demo\nagents:\n  worker:\n    scheduler:\n      script: inline-code\n';
  let reads = 0;
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: inlineYaml,
    workspace: {
      getContent: () => undefined,
      flushDirty: async () => {},
    },
    readFile: async () => {
      reads += 1;
      throw new Error('script service unavailable');
    },
  });
  expect(reads).toBe(0);
  expect(result.yamlText).toContain('script: inline-code');
  expect(result.references).toEqual([]);
});

test('a referenced script blocks the request when the service is unavailable', async () => {
  await expect(prepareScriptRequest({
    mode: 'validate',
    editorYaml: refYaml,
    workspace: {
      getContent: () => undefined,
      flushDirty: async () => {},
    },
    readFile: async () => {
      const error = new Error('脚本服务不可用');
      error.code = 'SERVICE_UNAVAILABLE';
      throw error;
    },
  })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
});

test('expands ${VAR} from globalEnv before returning yamlText', async () => {
  const yaml = 'name: demo\nagents:\n  worker:\n    env:\n      ANTHROPIC_MODEL:\n        value: ${LLM_MODEL}\n';
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: yaml,
    workspace: { getContent: () => undefined, flushDirty: async () => {} },
    readFile: async () => ({ content: '', sha256: '' }),
    globalEnv: [{ name: 'LLM_MODEL', value: 'GLM-5.2', secret: false }],
  });
  expect(result.yamlText).toContain('value: GLM-5.2');
  expect(result.yamlText).not.toContain('${LLM_MODEL}');
});

test('leaves secret ${VAR} intact when expanding globalEnv', async () => {
  const yaml = 'env:\n  ANTHROPIC_API_KEY:\n    value: ${LLM_API_KEY}\n    secret: true\n';
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: yaml,
    workspace: { getContent: () => undefined, flushDirty: async () => {} },
    readFile: async () => ({ content: '', sha256: '' }),
    globalEnv: [{ name: 'LLM_API_KEY', value: '********', secret: true }],
  });
  expect(result.yamlText).toContain('value: ${LLM_API_KEY}');
});

test('global env values remain strings through request preparation and protobuf decoding', async () => {
  const values = {
    JSON_ARRAY: '[{"webhook":"https://example.test"}]',
    JSON_OBJECT: '{"repository":"owner/repo"}',
    NUMBER: '30000',
    BOOLEAN: 'true',
    NULL_LIKE: 'null',
  };
  const entries = Object.keys(values)
    .map((name) => `      ${name}:\n        value: \${${name}}`)
    .join('\n');
  const result = await prepareScriptRequest({
    mode: 'validate',
    editorYaml: `name: demo\nagents:\n  worker:\n    env:\n${entries}\n`,
    workspace: { getContent: () => undefined, flushDirty: async () => {} },
    readFile: async () => ({ content: '', sha256: '' }),
    globalEnv: Object.entries(values).map(([name, value]) => ({ name, value, secret: false })),
  });

  const decoded = yamlToSpec(result.yamlText);

  expect(decoded.error).toBeUndefined();
  expect(Object.fromEntries(decoded.spec.agents[0].env.map(({ name, value }) => [name, value])))
    .toEqual(values);
});
