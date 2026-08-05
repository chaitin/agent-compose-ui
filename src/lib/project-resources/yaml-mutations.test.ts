import { describe, expect, test } from 'vitest';
import { parseYamlObject, yamlToSpec } from '../yaml';
import {
  removeAgentMount,
  removeAgentSkill,
  removeProjectVolume,
  upsertAgentMount,
  upsertAgentSkill,
  upsertProjectVolume,
} from './yaml-mutations';

const sourceYaml = `name: preservation-demo
agents:
  worker:
    model: gpt-5
    scheduler:
      enabled: true
      script: run()
    mcp_servers:
      - name: filesystem
        command: mcp-filesystem
    skills:
      - name: existing
        provider: local
        path: ./skills/existing
        x-skill-note: keep-me
      - name: second
        provider: github
        url: https://example.test/second.git
    volumes:
      - type: bind
        source: ./data
        target: /data
        read_only: false
        x-mount-note: keep-me
      - type: volume
        source: cache
        target: /cache
        read_only: true
    x-agent-extension:
      nested: preserved
  untouched:
    model: other-model
    skills:
      - name: untouched-skill
        provider: local
        path: ./untouched
    x-other-extension: unchanged
`;

type Map = Record<string, any>;

function parsed(yaml: string): Map {
  return parseYamlObject(yaml) as Map;
}

function worker(yaml: string): Map {
  return parsed(yaml).agents.worker;
}

function expectUnrelatedSemanticsPreserved(result: string): void {
  const before = parsed(sourceYaml);
  const after = parsed(result);
  expect(after.agents.untouched).toEqual(before.agents.untouched);
  expect(after.agents.worker.scheduler).toEqual(before.agents.worker.scheduler);
  expect(after.agents.worker.mcp_servers).toEqual(before.agents.worker.mcp_servers);
  expect(after.agents.worker['x-agent-extension']).toEqual(before.agents.worker['x-agent-extension']);
}

describe('Agent skill YAML mutations', () => {
  test('adds a skill while preserving unrelated Agent fields and other Agents', () => {
    const result = upsertAgentSkill(sourceYaml, 'worker', {
      name: 'new-skill', provider: 'github', url: 'https://example.test/new.git', ref: 'v1',
    });

    expect(worker(result).skills).toEqual([
      ...worker(sourceYaml).skills,
      { name: 'new-skill', provider: 'github', url: 'https://example.test/new.git', ref: 'v1' },
    ]);
    expectUnrelatedSemanticsPreserved(result);
  });

  test('updates a skill in place by name', () => {
    const result = upsertAgentSkill(sourceYaml, 'worker', {
      name: 'existing', provider: 'github', url: 'https://example.test/replacement.git',
    });

    expect(worker(result).skills).toEqual([
      { name: 'existing', provider: 'github', url: 'https://example.test/replacement.git' },
      worker(sourceYaml).skills[1],
    ]);
    expectUnrelatedSemanticsPreserved(result);
  });

  test('removes a skill by name and is idempotent when it is not found', () => {
    const removed = removeAgentSkill(sourceYaml, 'worker', 'existing');
    expect(worker(removed).skills).toEqual([worker(sourceYaml).skills[1]]);
    expect(removeAgentSkill(removed, 'worker', 'not-found')).toBe(removed);
    expectUnrelatedSemanticsPreserved(removed);
  });

  test('removes the skills property after deleting its final item while preserving other fields', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    model: gpt-5\n    skills:\n      - name: only\n        provider: local\n`;
    const result = removeAgentSkill(yaml, 'worker', 'only');

    expect(worker(result)).toEqual({ model: 'gpt-5' });
    expect(worker(result)).not.toHaveProperty('skills');
  });
});

describe('Agent mount YAML mutations', () => {
  test('adds a mount while preserving unrelated Agent fields and other Agents', () => {
    const result = upsertAgentMount(sourceYaml, 'worker', {
      type: 'bind', source: './logs', target: '/logs', read_only: true,
    });

    expect(worker(result).volumes).toEqual([
      ...worker(sourceYaml).volumes,
      { type: 'bind', source: './logs', target: '/logs', read_only: true },
    ]);
    expectUnrelatedSemanticsPreserved(result);
  });

  test('updates a mount in place by source and target', () => {
    const result = upsertAgentMount(sourceYaml, 'worker', {
      type: 'volume', source: './data', target: '/data', read_only: true,
    });

    expect(worker(result).volumes).toEqual([
      { type: 'volume', source: './data', target: '/data', read_only: true },
      worker(sourceYaml).volumes[1],
    ]);
    expectUnrelatedSemanticsPreserved(result);
  });

  test('removes a mount by source and target and is idempotent when it is not found', () => {
    const removed = removeAgentMount(sourceYaml, 'worker', './data', '/data');
    expect(worker(removed).volumes).toEqual([worker(sourceYaml).volumes[1]]);
    expect(removeAgentMount(removed, 'worker', 'missing', '/missing')).toBe(removed);
    expectUnrelatedSemanticsPreserved(removed);
  });

  test('removes the volumes property after deleting its final item while preserving other fields', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    model: gpt-5\n    volumes:\n      - type: volume\n        source: cache\n        target: /cache\n        read_only: false\n`;
    const result = removeAgentMount(yaml, 'worker', 'cache', '/cache');

    expect(worker(result)).toEqual({ model: 'gpt-5' });
    expect(worker(result)).not.toHaveProperty('volumes');
  });

  test('upserts by normalized source and target and uses the requested payload', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    volumes:\n      - type: bind\n        source: " ./data// "\n        target: " /data// "\n        read_only: false\n      - type: volume\n        source: cache//legacy\n        target: /legacy//cache/\n        read_only: true\n`;
    const requested = { type: 'bind' as const, source: './data', target: '/data', read_only: true };
    const result = upsertAgentMount(yaml, 'worker', requested);

    expect(worker(result).volumes).toEqual([
      requested,
      { type: 'volume', source: 'cache//legacy', target: '/legacy//cache/', read_only: true },
    ]);
  });

  test('does not treat internal repeated separators as equivalent mount identity', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    volumes:\n      - type: volume\n        source: cache//nested\n        target: /cache//nested\n        read_only: false\n`;
    const requested = { type: 'volume' as const, source: 'cache/nested', target: '/cache/nested', read_only: true };
    const result = upsertAgentMount(yaml, 'worker', requested);

    expect(worker(result).volumes).toEqual([
      { type: 'volume', source: 'cache//nested', target: '/cache//nested', read_only: false },
      requested,
    ]);
  });

  test('removes a mount using normalized source and target identity', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    model: gpt-5\n    volumes:\n      - type: bind\n        source: ./data//\n        target: /data///\n        read_only: false\n`;
    const result = removeAgentMount(yaml, 'worker', ' ./data/ ', ' /data ');

    expect(worker(result)).toEqual({ model: 'gpt-5' });
  });

  test('treats repeated and dot target separators as the same mount identity', () => {
    const yaml = 'agents:\n  worker:\n    volumes:\n      - { type: bind, source: /srv/data, target: /data//x/./ }\n';
    const removed = removeAgentMount(yaml, 'worker', '/srv//data/', '/data/x');
    expect(parsed(removed).agents.worker.volumes).toBeUndefined();
  });
});

describe('Agent YAML mutation validation', () => {
  test.each([
    ['invalid YAML', 'agents: ['],
    ['ordinary missing Agent', 'name: demo\nagents:\n  other: {}\n'],
    ['non-map Agent', 'name: demo\nagents:\n  worker: text\n'],
    ['non-map agents', 'name: demo\nagents: []\n'],
  ])('rejects %s', (_label, yaml) => {
    expect(() => upsertAgentSkill(yaml, 'worker', { name: 'x', provider: 'local' })).toThrow();
  });

  test.each(['__proto__', 'constructor', 'toString'])('rejects inherited Agent name %s without prototype mutation', (agent) => {
    const yaml = 'name: demo\nagents:\n  worker: {}\n';
    try {
      expect(() => upsertAgentSkill(yaml, agent, { name: 'polluted', provider: 'local' })).toThrow();
      expect(Object.prototype).not.toHaveProperty('skills');
    } finally {
      delete (Object.prototype as { skills?: unknown }).skills;
    }
  });

  test('rejects a malformed skills list', () => {
    const yaml = 'name: demo\nagents:\n  worker:\n    skills: invalid\n';
    expect(() => upsertAgentSkill(yaml, 'worker', { name: 'x', provider: 'local' })).toThrow();
  });

  test('rejects a malformed volumes list', () => {
    const yaml = 'name: demo\nagents:\n  worker:\n    volumes: invalid\n';
    expect(() => upsertAgentMount(yaml, 'worker', {
      type: 'bind', source: '.', target: '/x', read_only: false,
    })).toThrow();
  });

  test('returns byte-identical YAML for an idempotent upsert', () => {
    const skill = { name: 'existing', provider: 'local', path: './skills/existing', 'x-skill-note': 'keep-me' };
    const mount = { type: 'bind' as const, source: './data', target: '/data', read_only: false, 'x-mount-note': 'keep-me' };
    expect(upsertAgentSkill(sourceYaml, 'worker', skill)).toBe(sourceYaml);
    expect(upsertAgentMount(sourceYaml, 'worker', mount)).toBe(sourceYaml);
  });

  test('keeps direct yamlToSpec validation strict for unknown fields', () => {
    const { error } = yamlToSpec(`name: demo\nagents:\n  worker:\n    modle: typo\n`);
    expect(error).toContain('key "modle" is unknown');
  });

  test('preserves extensions during mutation but still rejects invalid known fields', () => {
    const invalid = sourceYaml.replace('enabled: true', 'enabled: definitely-not-a-boolean');
    expect(() => upsertAgentSkill(invalid, 'worker', { name: 'new', provider: 'local' })).toThrow(/校验失败/);

    const valid = upsertAgentSkill(sourceYaml, 'worker', { name: 'new', provider: 'local' });
    expect(worker(valid)['x-agent-extension']).toEqual({ nested: 'preserved' });
    expect(worker(valid).mcp_servers).toEqual(worker(sourceYaml).mcp_servers);
  });

  test('rejects colliding mcps and mcp_servers aliases', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    mcps: []\n    mcp_servers: malformed\n`;
    expect(() => upsertAgentSkill(yaml, 'worker', { name: 'new', provider: 'local' }))
      .toThrow(/mcps.*mcp_servers/);
  });

  test('rejects colliding skill source and provider aliases', () => {
    const yaml = `name: demo\nagents:\n  worker:\n    skills:\n      - name: existing\n        source: local\n        provider:\n          malformed: true\n`;
    expect(() => upsertAgentSkill(yaml, 'worker', { name: 'new', provider: 'local' }))
      .toThrow(/source.*provider/);
  });
});

const projectYaml = `name: volume-demo
variables:
  REGION:
    value: local
workspaces:
  main:
    path: .
agents:
  worker:
    model: gpt-5
    scheduler:
      enabled: true
      script: run()
    mcp_servers:
      - name: filesystem
        command: mcp-filesystem
    x-agent-extension: preserved
volumes:
  memory:
    name: old-memory
    driver: old-driver
    external: true
    labels:
      existing: keep
      agent-compose-ui.managed: spoofed
      agent-compose-ui.project-key: wrong-project
    options:
      type: none
      device: /srv/memory
  unrelated:
    name: user-volume
    driver: custom
    labels:
      owner: user
x-project-extension:
  nested: preserved
`;

describe('Project volume YAML mutations', () => {
  test('upserts only the requested declaration while preserving existing options and unrelated project fields', () => {
    const result = upsertProjectVolume(projectYaml, 'memory', {
      name: 'ac-0123456789ab-project-memory',
      driver: 'local',
      labels: {
        requested: 'present',
        'agent-compose-ui.managed': 'false',
        'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef',
      },
    });
    const before = parsed(projectYaml);
    const after = parsed(result);

    expect(after.volumes.memory).toEqual({
      name: 'ac-0123456789ab-project-memory',
      driver: 'local',
      external: true,
      labels: {
        existing: 'keep',
        requested: 'present',
        'agent-compose-ui.managed': 'true',
        'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef',
      },
      options: { type: 'none', device: '/srv/memory' },
    });
    expect(after.variables).toEqual(before.variables);
    expect(after.workspaces).toEqual(before.workspaces);
    expect(after.agents).toEqual(before.agents);
    expect(after.volumes.unrelated).toEqual(before.volumes.unrelated);
    expect(after['x-project-extension']).toEqual(before['x-project-extension']);
  });

  test('adds a declaration without changing existing declarations', () => {
    const result = upsertProjectVolume(projectYaml, 'cache', {
      name: 'ac-0123456789ab-cache', driver: 'local', labels: { purpose: 'build', 'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef' },
    });

    expect(parsed(result).volumes).toEqual({
      ...parsed(projectYaml).volumes,
      cache: {
        name: 'ac-0123456789ab-cache',
        driver: 'local',
        labels: {
          purpose: 'build',
          'agent-compose-ui.managed': 'true',
          'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef',
        },
      },
    });
  });

  test('returns byte-identical YAML when an upsert makes no semantic change', () => {
    const yaml = `name: demo\nvolumes:\n  cache:\n    name: ac-0123456789ab-cache\n    driver: local\n    labels:\n      purpose: build\n      agent-compose-ui.managed: 'true'\n      agent-compose-ui.project-key: ws_0123456789abcdef0123456789abcdef\n`;
    expect(upsertProjectVolume(yaml, 'cache', {
      name: 'ac-0123456789ab-cache', driver: 'local', labels: { purpose: 'build', 'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef' },
    })).toBe(yaml);
  });

  test('removes a declaration and preserves its siblings', () => {
    const result = removeProjectVolume(projectYaml, 'memory');
    expect(parsed(result).volumes).toEqual({ unrelated: parsed(projectYaml).volumes.unrelated });
  });

  test('removes the top-level volumes property after deleting its final declaration', () => {
    const yaml = `name: demo\nvariables:\n  KEEP:\n    value: yes\nvolumes:\n  cache:\n    name: cache\n    driver: local\n`;
    const result = removeProjectVolume(yaml, 'cache');

    expect(parsed(result)).toEqual({ name: 'demo', variables: { KEEP: { value: 'yes' } } });
    expect(parsed(result)).not.toHaveProperty('volumes');
  });

  test('missing-key removal is a byte-identical no-op', () => {
    expect(removeProjectVolume(projectYaml, 'missing')).toBe(projectYaml);
  });
});

describe('Project volume mutation validation', () => {
  const value = { name: 'ac-0123456789ab-cache', driver: 'local' as const, labels: { 'agent-compose-ui.project-key': 'ws_0123456789abcdef0123456789abcdef' } };

  test.each(['', 'memory', 'ws_ABCDEF0123456789abcdef0123456789', 'ws_0123'])('rejects invalid project ownership label %s', (projectKey) => {
    expect(() => upsertProjectVolume('name: demo\n', 'cache', {
      name: 'cache', driver: 'local', labels: { 'agent-compose-ui.project-key': projectKey },
    })).toThrow('必须是有效的项目存储键');
  });

  test.each([
    ['invalid YAML', 'volumes: ['],
    ['non-map root', '- item\n'],
    ['non-map volumes', 'name: demo\nvolumes: []\n'],
    ['non-map declaration', 'name: demo\nvolumes:\n  cache: invalid\n'],
    ['non-map labels', 'name: demo\nvolumes:\n  cache:\n    labels: invalid\n'],
  ])('rejects %s', (_label, yaml) => {
    expect(() => upsertProjectVolume(yaml, 'cache', value)).toThrow();
  });

  test.each(['', '../cache', 'cache/name', '__proto__', 'constructor', 'toString'])
    ('rejects unsafe declaration key %s without prototype mutation', (key) => {
      const yaml = 'name: demo\nvolumes:\n  safe: {}\n';
      try {
        expect(() => upsertProjectVolume(yaml, key, value)).toThrow();
        expect(() => removeProjectVolume(yaml, key)).toThrow();
        expect(Object.prototype).not.toHaveProperty('name');
      } finally {
        delete (Object.prototype as { name?: unknown }).name;
      }
    });

  test.each(['', '../cache', 'cache/name', 'contains newline\n'])('rejects unsafe daemon volume name %s', (name) => {
    expect(() => upsertProjectVolume('name: demo\n', 'cache', { ...value, name })).toThrow();
  });
});
