import { expect, test } from 'bun:test';
import { childSpecs } from './dev.mjs';

test('starts Vite and the isolated script service with one shared token', () => {
  const specs = childSpecs({ executable: '/usr/local/bin/bun', token: 'abc' });
  expect(specs).toEqual([
    { name: 'web', command: '/usr/local/bin/bun', args: ['run', 'dev:web'], env: { SCRIPT_SERVICE_TOKEN: 'abc' } },
    { name: 'scripts', command: '/usr/local/bin/bun', args: ['run', 'dev:scripts'], env: { SCRIPT_SERVICE_TOKEN: 'abc' } },
  ]);
});

test('childSpecs is a pure function and does not mutate inputs', () => {
  const input = { executable: '/usr/local/bin/bun', token: 't' };
  const a = childSpecs(input);
  const b = childSpecs(input);
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
});
