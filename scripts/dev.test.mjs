import { expect, test } from 'bun:test';
import { childSpecs } from './dev.mjs';

test('starts the gateway, Vite, and isolated script service with one shared token', () => {
  const specs = childSpecs({ executable: '/usr/local/bin/bun', token: 'abc' });
  expect(specs.map(({ name }) => name)).toEqual(['gateway', 'web', 'scripts']);
  expect(specs[0].args).toEqual(['run', './cmd/agent-compose-ui-server']);
  expect(specs.every(({ env }) => env.SCRIPT_SERVICE_TOKEN === 'abc')).toBe(true);
  expect(specs[0].env.AUTH_MODE).toBe('disabled');
});

test('passes the configured auth mode to the gateway', () => {
  const specs = childSpecs({ executable: '/usr/local/bin/bun', token: 'abc', authMode: 'password' });
  expect(specs[0].env.AUTH_MODE).toBe('password');
});

test('childSpecs is a pure function and does not mutate inputs', () => {
  const input = { executable: '/usr/local/bin/bun', token: 't' };
  const a = childSpecs(input);
  const b = childSpecs(input);
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
});
