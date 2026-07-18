import { expect, test } from 'bun:test';
import yaml from 'js-yaml';
import { interpolateGlobalEnv } from './env-interpolation';

test('expands non-secret ${VAR} from global env', () => {
  const yaml = 'model: ${LLM_MODEL}\nbase: ${LLM_API_ENDPOINT}';
  const env = [
    { name: 'LLM_MODEL', value: 'GLM-5.2', secret: false },
    { name: 'LLM_API_ENDPOINT', value: 'https://ark.example/api', secret: false },
  ];
  expect(interpolateGlobalEnv(yaml, env)).toBe('model: GLM-5.2\nbase: https://ark.example/api');
});

test('leaves secret ${VAR} intact (panel redacts to ********)', () => {
  const yaml = 'key: ${LLM_API_KEY}';
  const env = [{ name: 'LLM_API_KEY', value: '********', secret: true }];
  expect(interpolateGlobalEnv(yaml, env)).toBe('key: ${LLM_API_KEY}');
});

test('leaves unknown ${VAR} intact for backend resolution', () => {
  expect(interpolateGlobalEnv('x: ${UNKNOWN}', [
    { name: 'OTHER', value: 'v', secret: false },
  ])).toBe('x: ${UNKNOWN}');
});

test('case-insensitive name match (mirrors backend EqualFold)', () => {
  const yaml = 'm: ${llm_model}';
  const env = [{ name: 'LLM_MODEL', value: 'GLM-5.2', secret: false }];
  expect(interpolateGlobalEnv(yaml, env)).toBe('m: GLM-5.2');
});

test('no-op when env is empty or missing', () => {
  expect(interpolateGlobalEnv('x: ${A}', [])).toBe('x: ${A}');
  expect(interpolateGlobalEnv('x: ${A}', undefined)).toBe('x: ${A}');
  expect(interpolateGlobalEnv('x: ${A}', null)).toBe('x: ${A}');
});

test('expands multiple references in one value', () => {
  const yaml = 'url: ${ENDPOINT}/${PATH}';
  const env = [
    { name: 'ENDPOINT', value: 'https://x', secret: false },
    { name: 'PATH', value: 'v1', secret: false },
  ];
  expect(interpolateGlobalEnv(yaml, env)).toBe('url: https://x/v1');
});

test('skips redacted sentinel value even on a non-secret entry', () => {
  const yaml = 'x: ${WEIRD}';
  const env = [{ name: 'WEIRD', value: '********', secret: false }];
  expect(interpolateGlobalEnv(yaml, env)).toBe('x: ${WEIRD}');
});

test('preserves YAML map value form {value: ${VAR}}', () => {
  const yaml = 'ANTHROPIC_BASE_URL:\n  value: ${LLM_API_ENDPOINT}';
  const env = [{ name: 'LLM_API_ENDPOINT', value: 'https://ark.example/api', secret: false }];
  expect(interpolateGlobalEnv(yaml, env)).toBe('ANTHROPIC_BASE_URL:\n  value: https://ark.example/api');
});

test('preserves every interpolated global env value as a YAML string', () => {
  const source = [
    'env:',
    '  JSON_ARRAY:',
    '    value: ${JSON_ARRAY}',
    '  JSON_OBJECT:',
    '    value: ${JSON_OBJECT}',
    '  NUMBER:',
    '    value: ${NUMBER}',
    '  BOOLEAN:',
    '    value: ${BOOLEAN}',
    '  NULL_LIKE:',
    '    value: ${NULL_LIKE}',
    '  ORDINARY:',
    '    value: ${ORDINARY}',
  ].join('\n');
  const values = {
    JSON_ARRAY: '[{"webhook":"https://example.test"}]',
    JSON_OBJECT: '{"repository":"owner/repo"}',
    NUMBER: '30000',
    BOOLEAN: 'true',
    NULL_LIKE: 'null',
    ORDINARY: 'claude-sonnet',
  };
  const env = Object.entries(values).map(([name, value]) => ({ name, value, secret: false }));

  const parsed = yaml.load(interpolateGlobalEnv(source, env));

  for (const [name, value] of Object.entries(values)) {
    expect(parsed.env[name].value).toBe(value);
    expect(typeof parsed.env[name].value).toBe('string');
  }
});
