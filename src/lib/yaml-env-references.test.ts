import { describe, expect, test } from 'vitest';
import { listAgentEnvReferences, missingAgentEnvReferences } from './yaml-env-references';

const yaml = `name: demo
agents:
  coder:
    env:
      API_KEY:
        value: \${OPENAI_API_KEY}
      URL:
        value: "\${HOST}/v1/\${TENANT}"
    prompt: ignored \${NOT_ENV}
  reviewer:
    env:
      TOKEN:
        value: \${OPENAI_API_KEY}
scripts:
  x: \${NOT_AN_AGENT}
`;

describe('agent env references', () => {
  test('locates references by agent and source line', () => {
    expect(listAgentEnvReferences(yaml).map(({ agentName, envName, names, line, envLine }) => ({ agentName, envName, names, line, envLine }))).toEqual([
      { agentName: 'coder', envName: 'API_KEY', names: ['OPENAI_API_KEY'], line: 6, envLine: 4 },
      { agentName: 'coder', envName: 'URL', names: ['HOST', 'TENANT'], line: 8, envLine: 4 },
      { agentName: 'reviewer', envName: 'TOKEN', names: ['OPENAI_API_KEY'], line: 13, envLine: 11 },
    ]);
  });

  test('filters configured names without losing other references on a line', () => {
    expect(missingAgentEnvReferences(yaml, ['OPENAI_API_KEY', 'HOST']).map((item) => item.names)).toEqual([['TENANT']]);
  });

  test('locates references in mixed object and scalar env values', () => {
    const mixedYaml = `agents:
  claude:
    env:
      ANTHROPIC_API_KEY:
        value: \${ANTHROPIC_API_KEY}
        secret: true
      ANTHROPIC_BASE_URL: \${ANTHROPIC_BASE_URL}
      ANTHROPIC_MODEL: \${ANTHROPIC_MODEL}
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
`;

    expect(listAgentEnvReferences(mixedYaml).map(({ envName, names, line }) => ({ envName, names, line }))).toEqual([
      { envName: 'ANTHROPIC_API_KEY', names: ['ANTHROPIC_API_KEY'], line: 5 },
      { envName: 'ANTHROPIC_BASE_URL', names: ['ANTHROPIC_BASE_URL'], line: 7 },
      { envName: 'ANTHROPIC_MODEL', names: ['ANTHROPIC_MODEL'], line: 8 },
    ]);
  });
});
