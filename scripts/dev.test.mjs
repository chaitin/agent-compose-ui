import { expect, test } from 'bun:test';
import { childSpecs } from './dev.mjs';
import viteConfig from '../vite.config.ts';

function matchingProxy(path) {
  const proxies = viteConfig.server.proxy;
  const context = Object.keys(proxies).find((key) =>
    key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key),
  );
  return context ? proxies[context] : undefined;
}

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

test('routes every protected backend path through the gateway without injecting a script token', () => {
  const protectedPaths = [
    '/agentcompose.v1.Service/Call',
    '/agentcompose.v2.Service/Call',
    '/health.v1.Health/Status',
    '/api/projects',
    '/oauth/callback',
    '/agent-compose/session/current',
    '/jupyter',
    '/jupyter/lab',
    '/script-api/v1/health',
  ];

  for (const path of protectedPaths) {
    const proxy = matchingProxy(path);
    expect(proxy?.target, path).toBe('http://127.0.0.1:8080');
    expect(proxy?.headers, path).toBeUndefined();
  }

  for (const path of ['/api', '/apiary', '/script-api', '/script-apiary', '/jupyterevil']) {
    expect(matchingProxy(path), path).toBeUndefined();
  }
});
