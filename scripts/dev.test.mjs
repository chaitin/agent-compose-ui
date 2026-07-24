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

test('passes project environment database paths only to the gateway', () => {
  const specs = childSpecs({
    executable: '/usr/local/bin/bun', token: 'abc',
    agentComposeDBPath: '/data/agent-compose/data.db', uiStateDBPath: '/data/ui/project-env.db',
    agentComposeURL: 'http://127.0.0.1:7410', scriptServiceURL: 'http://127.0.0.1:7420',
    goCache: '/cache/go-build',
    goModCache: '/cache/go-mod',
  });
  expect(specs[0].env.AGENT_COMPOSE_DB_PATH).toBe('/data/agent-compose/data.db');
  expect(specs[0].env.UI_STATE_DB_PATH).toBe('/data/ui/project-env.db');
  expect(specs[0].env.AGENT_COMPOSE_URL).toBe('http://127.0.0.1:7410');
  expect(specs[0].env.SCRIPT_SERVICE_URL).toBe('http://127.0.0.1:7420');
  expect(specs[0].env.GOCACHE).toBe('/cache/go-build');
  expect(specs[0].env.GOMODCACHE).toBe('/cache/go-mod');
  expect(specs[1].env.AGENT_COMPOSE_DB_PATH).toBeUndefined();
  expect(specs[2].env.UI_STATE_DB_PATH).toBeUndefined();
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
