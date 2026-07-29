import { describe, expect, test } from 'vitest';
import { parseYamlObject } from '../yaml';
import {
  removeAgentMount,
  removeAgentSkill,
  upsertAgentMount,
  upsertAgentSkill,
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
});

describe('Agent YAML mutation validation', () => {
  test.each([
    ['invalid YAML', 'agents: [', 'worker'],
    ['missing Agent', 'name: demo\nagents:\n  other: {}\n', 'worker'],
    ['non-map Agent', 'name: demo\nagents:\n  worker: text\n', 'worker'],
    ['non-map agents', 'name: demo\nagents: []\n', 'worker'],
  ])('rejects %s', (_label, yaml, agent) => {
    expect(() => upsertAgentSkill(yaml, agent, { name: 'x', provider: 'local' })).toThrow();
  });

  test.each([
    ['skills', 'name: demo\nagents:\n  worker:\n    skills: invalid\n', () => upsertAgentSkill],
    ['volumes', 'name: demo\nagents:\n  worker:\n    volumes: invalid\n', () => upsertAgentMount],
  ])('rejects a malformed %s list', (_label, yaml, operation) => {
    const mutate = operation();
    expect(() => mutate(yaml, 'worker', _label === 'skills'
      ? { name: 'x', provider: 'local' } as any
      : { type: 'bind', source: '.', target: '/x', read_only: false } as any)).toThrow();
  });

  test('returns byte-identical YAML for an idempotent upsert', () => {
    const skill = { name: 'existing', provider: 'local', path: './skills/existing', 'x-skill-note': 'keep-me' };
    const mount = { type: 'bind' as const, source: './data', target: '/data', read_only: false, 'x-mount-note': 'keep-me' };
    expect(upsertAgentSkill(sourceYaml, 'worker', skill)).toBe(sourceYaml);
    expect(upsertAgentMount(sourceYaml, 'worker', mount)).toBe(sourceYaml);
  });
});
