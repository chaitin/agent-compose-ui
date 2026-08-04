import { describe, expect, test } from 'vitest';
import { listSkillLocations } from './locations';

describe('listSkillLocations', () => {
  test('finds only skills fields that belong to agents', () => {
    const yaml = `skills: []
agents:
  alpha:
    model: gpt-5
    skills:
      - name: investigation
        source: file
        path: /workspace/SKILL.md
  beta:
    skills: []
`;

    expect(listSkillLocations(yaml)).toEqual([
      {
        agentName: 'alpha', line: 5, state: 'repair',
        localSkills: [{ name: 'investigation', path: '/workspace/SKILL.md', expectedPath: './skills/investigation' }],
      },
      { agentName: 'beta', line: 10, state: 'add', localSkills: [] },
    ]);
  });

  test('manages valid local skills and ignores remote skills when deciding path repair', () => {
    const yaml = `agents:
  worker:
    skills:
      - name: local-skill
        provider: file
        path: ./skills/local-skill
      - name: remote-skill
        source: github
        url: https://example.test/skill.git
`;

    expect(listSkillLocations(yaml)).toEqual([{
      agentName: 'worker', line: 3, state: 'manage',
      localSkills: [{ name: 'local-skill', path: './skills/local-skill', expectedPath: './skills/local-skill' }],
    }]);
  });

  test('returns no stale locations for invalid yaml', () => {
    expect(listSkillLocations('agents:\n  alpha:\n    skills: [')).toEqual([]);
  });
});
