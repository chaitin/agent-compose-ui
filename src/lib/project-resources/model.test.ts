import { describe, expect, test } from 'vitest';
import { deriveProjectResourceSummary, deriveProjectResources } from './model';

describe('deriveProjectResources', () => {
  test('summarizes declared resources and all validated volume and bind mounts', () => {
    expect(deriveProjectResourceSummary(`
volumes:
  data: {}
  cache: {}
agents:
  worker:
    volumes:
      - { type: volume, source: data, target: /data }
      - { type: volume, source: missing, target: /missing }
      - { type: bind, source: /srv/shared, target: /shared }
`)).toMatchObject({
      resources: [{ key: 'data' }, { key: 'cache' }],
      mounts: [
        { type: 'volume', source: 'data', target: '/data' },
        { type: 'volume', source: 'missing', target: '/missing' },
        { type: 'bind', source: '/srv/shared', target: '/shared' },
      ],
    });
  });

  test('uses explicit system names and defaults empty or absent names to the declaration key', () => {
    const resources = deriveProjectResources(`
volumes:
  cache:
    name: daemon-cache
  data:
    name: ''
  logs: {}
`);

    expect(resources.map(({ key, systemName }) => ({ key, systemName }))).toEqual([
      { key: 'cache', systemName: 'daemon-cache' },
      { key: 'data', systemName: 'data' },
      { key: 'logs', systemName: 'logs' },
    ]);
  });

  test('marks only the exact managed label string as managed', () => {
    const resources = deriveProjectResources(`
volumes:
  exact: { labels: { agent-compose-ui.managed: 'true' } }
  boolean: { labels: { agent-compose-ui.managed: true } }
  upper: { labels: { agent-compose-ui.managed: TRUE } }
  other: { labels: { purpose: cache } }
`);

    expect(resources.map((resource) => resource.managed)).toEqual([true, false, false, false]);
  });

  test('returns declared resources with no mounts', () => {
    expect(deriveProjectResources('volumes:\n  cache: {}\n')).toEqual([
      { key: 'cache', systemName: 'cache', mounts: [], managed: false },
    ]);
  });

  test('retains shared and repeated volume mounts in deterministic agent and mount order', () => {
    const resources = deriveProjectResources(`
volumes:
  cache: {}
agents:
  builder:
    volumes:
      - { type: volume, source: cache, target: /npm, read_only: true }
      - { type: volume, source: cache, target: /tools }
  tester:
    volumes:
      - { type: volume, source: cache, target: /cache, read_only: false }
`);

    expect(resources[0].mounts).toEqual([
      { agent: 'builder', type: 'volume', source: 'cache', target: '/npm', readOnly: true },
      { agent: 'builder', type: 'volume', source: 'cache', target: '/tools', readOnly: false },
      { agent: 'tester', type: 'volume', source: 'cache', target: '/cache', readOnly: false },
    ]);
  });

  test('preserves declaration order and exact mount source and target text', () => {
    const resources = deriveProjectResources(`
volumes:
  second: {}
  first: {}
agents:
  worker:
    volumes:
      - { type: volume, source: 'first', target: ' /cache/ ' }
`);

    expect(resources.map((resource) => resource.key)).toEqual(['second', 'first']);
    expect(resources[1].mounts[0]).toMatchObject({ source: 'first', target: ' /cache/ ' });
  });

  test('ignores bind mounts, dangling volume mounts, and explicit system-name aliases', () => {
    const resources = deriveProjectResources(`
volumes:
  cache: { name: daemon-cache }
agents:
  worker:
    volumes:
      - { type: bind, source: ./cache, target: /bind }
      - { type: volume, source: missing, target: /missing }
      - { type: volume, source: daemon-cache, target: /alias }
`);

    expect(resources[0].mounts).toEqual([]);
  });

  test('ignores unrelated extension fields', () => {
    const resources = deriveProjectResources(`
x-root: keep
volumes:
  cache:
    x-volume: keep
agents:
  worker:
    x-agent: keep
    volumes:
      - { type: volume, source: cache, target: /cache, x-mount: keep }
`);

    expect(resources[0].mounts).toHaveLength(1);
  });

  test.each([
    ['root timestamp', '2026-07-30\n', 'root must be a mapping'],
    ['volumes timestamp', 'volumes: 2026-07-30\n', 'volumes must be a mapping'],
    ['volume timestamp', 'volumes:\n  cache: 2026-07-30\n', 'volumes.cache must be a mapping'],
    ['labels timestamp', 'volumes:\n  cache:\n    labels: 2026-07-30\n', 'volumes.cache.labels must be a mapping'],
    ['volumes list', 'volumes: []\n', 'volumes must be a mapping'],
    ['volume scalar', 'volumes:\n  cache: invalid\n', 'volumes.cache must be a mapping'],
    ['volume name', 'volumes:\n  cache: { name: 42 }\n', 'volumes.cache.name must be a string'],
    ['labels list', 'volumes:\n  cache: { labels: [] }\n', 'volumes.cache.labels must be a mapping'],
    ['agents list', 'volumes: {}\nagents: []\n', 'agents must be a mapping'],
    ['agent scalar', 'volumes: {}\nagents:\n  worker: bad\n', 'agents.worker must be a mapping'],
    ['agent timestamp', 'volumes: {}\nagents:\n  worker: 2026-07-30\n', 'agents.worker must be a mapping'],
    ['mounts map', 'volumes: {}\nagents:\n  worker:\n    volumes: {}\n', 'agents.worker.volumes must be a list'],
    ['mount scalar', 'volumes: {}\nagents:\n  worker:\n    volumes: [bad]\n', 'agents.worker.volumes[0] must be a mapping'],
    ['mount timestamp', 'volumes: {}\nagents:\n  worker:\n    volumes: [2026-07-30]\n', 'agents.worker.volumes[0] must be a mapping'],
    ['mount type', 'volumes: {}\nagents:\n  worker:\n    volumes: [{ type: 1, source: x, target: /x }]\n', 'agents.worker.volumes[0].type must be a string'],
    ['mount source', 'volumes: {}\nagents:\n  worker:\n    volumes: [{ type: volume, source: 1, target: /x }]\n', 'agents.worker.volumes[0].source must be a string'],
    ['mount target', 'volumes: {}\nagents:\n  worker:\n    volumes: [{ type: volume, source: x, target: 1 }]\n', 'agents.worker.volumes[0].target must be a string'],
    ['read only', 'volumes: {}\nagents:\n  worker:\n    volumes: [{ type: volume, source: x, target: /x, read_only: yes }]\n', 'agents.worker.volumes[0].read_only must be a boolean'],
  ])('rejects malformed %s values', (_name, yaml, message) => {
    expect(() => deriveProjectResources(yaml)).toThrow(message);
  });

  test.each([
    ['volumes:\n  __proto__: {}\n', 'volumes.__proto__ is not a safe project volume key'],
    ['volumes:\n  prototype: {}\n', 'volumes.prototype is not a safe project volume key'],
    ['volumes:\n  constructor: {}\n', 'volumes.constructor is not a safe project volume key'],
    ['volumes:\n  toString: {}\n', 'volumes.toString is not a safe project volume key'],
    ['volumes: {}\nagents:\n  __proto__: {}\n', 'agents.__proto__ is not a safe key'],
    ['volumes: {}\nagents:\n  prototype: {}\n', 'agents.prototype is not a safe key'],
    ['volumes: {}\nagents:\n  constructor: {}\n', 'agents.constructor is not a safe key'],
    ['volumes: {}\nagents:\n  toString: {}\n', 'agents.toString is not a safe key'],
  ])('rejects prototype-sensitive mapping keys', (yaml, message) => {
    expect(() => deriveProjectResources(yaml)).toThrow(message);
  });

  test.each([
    ' has-space',
    'has/slash',
    'a'.repeat(256),
  ])('rejects invalid project volume declaration key %j', (key) => {
    expect(() => deriveProjectResources(`volumes:\n  ${JSON.stringify(key)}: {}\n`))
      .toThrow(`volumes.${key} is not a safe project volume key`);
  });

  test('does not mutate the authoring YAML input', () => {
    const yaml = 'volumes:\n  cache: {}\nagents:\n  worker:\n    volumes: [{ type: volume, source: cache, target: /cache }]\n';
    const before = yaml;

    deriveProjectResources(yaml);

    expect(yaml).toBe(before);
  });
});
