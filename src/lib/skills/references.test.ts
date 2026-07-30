import { expect, test } from 'vitest';
import { listAgentNames, listSkillReferences, removeSkillReferences } from './references';

const yaml = `
name: sample
agents:
  zeta:
    skills:
      - name: demo
        provider: file
        path: ./skills/demo
        x-note: keep-local
      - name: demo
        provider: git
        path: ./skills/demo
        x-note: keep-git
  alpha:
    x-agent: preserved
    skills:
      - name: alias
        source: file
        path: ./skills/demo
      - name: demo
        source: http
        url: https://example.test/demo
  broken:
    skills: nope
`;

test('lists every local reference deterministically by stable name or project-local path', () => {
  expect(listSkillReferences(yaml, 'demo')).toEqual([
    { agentName: 'alpha', skillName: 'alias', path: './skills/demo' },
    { agentName: 'zeta', skillName: 'demo', path: './skills/demo' },
  ]);
  expect(listAgentNames(yaml)).toEqual(['alpha', 'broken', 'zeta']);
});

test('removes all and only local references while preserving unrelated fields', () => {
  const result = removeSkillReferences(yaml, 'demo');
  expect(result.references.map((item) => item.agentName)).toEqual(['alpha', 'zeta']);
  expect(result.yaml).toContain('x-agent: preserved');
  expect(result.yaml).toContain('provider: git');
  expect(result.yaml).toContain('x-note: keep-git');
  expect(result.yaml).toContain('source: http');
  expect(listSkillReferences(result.yaml, 'demo')).toEqual([]);
});

test('is safe for malformed YAML shapes and rejects ambiguous provider aliases', () => {
  expect(listSkillReferences('agents: []', 'demo')).toEqual([]);
  expect(listSkillReferences('agents:\n  a:\n    skills: [null, 4, {}]', 'demo')).toEqual([]);
  expect(() => listSkillReferences('agents:\n  a:\n    skills:\n      - name: demo\n        provider: file\n        source: file', 'demo')).toThrow(/source.*provider|provider.*source/);
});

test('does not traverse prototype properties', () => {
  expect(listSkillReferences('agents:\n  __proto__:\n    skills:\n      - name: demo\n        provider: file', 'demo')).toEqual([]);
});

test('treats an explicit local path as authoritative over the stable name', () => {
  const source = `agents:
  a:
    skills:
      - { name: demo, provider: file, path: ./skills/other }
      - { name: alias, provider: file, path: skills//demo/ }
      - { name: demo, provider: file }
`;
  expect(listSkillReferences(source, 'demo').map((item) => item.skillName)).toEqual(['alias', 'demo']);
  const removed = removeSkillReferences(source, 'demo').yaml;
  expect(removed).toContain('path: ./skills/other');
  expect(removed).not.toContain('path: skills//demo/');
});

test('does not match unsafe or ambiguous local paths', () => {
  for (const path of ['../skills/demo', '/skills/demo', '.\\skills\\demo', './skills/../demo']) {
    const source = `agents:\n  a:\n    skills:\n      - { name: demo, provider: file, path: '${path}' }`;
    expect(listSkillReferences(source, 'demo')).toEqual([]);
    expect(removeSkillReferences(source, 'demo').yaml).toBe(source);
  }
});
