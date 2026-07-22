import { describe, expect, test } from 'vitest';
import { AgentSpec, EnvVarSpec, ProjectSpec, SchedulerSpec } from '../gen/agentcompose/v2/agentcompose_pb';
import { llmConfigWarning, missingLLMConfig, usesSchedulerLLM } from './llm-config-preflight';

function projectWithScript(script: string) {
  return new ProjectSpec({
    agents: [new AgentSpec({ scheduler: new SchedulerSpec({ script }) })],
  });
}

describe('LLM config preflight', () => {
  test('detects scheduler.llm calls in scheduler scripts', () => {
    expect(usesSchedulerLLM(projectWithScript('const result = scheduler . llm("hello");'))).toBe(true);
    expect(usesSchedulerLLM(projectWithScript('scheduler.agent("hello");'))).toBe(false);
  });

  test('reports missing or empty required global variables', () => {
    expect(missingLLMConfig([
      new EnvVarSpec({ name: 'LLM_API_ENDPOINT', value: 'https://gateway.example/openai' }),
      new EnvVarSpec({ name: 'LLM_API_KEY', value: '  ' }),
    ])).toEqual(['LLM_API_KEY']);
  });

  test('builds a warning only when scheduler.llm config is incomplete', () => {
    const spec = projectWithScript('scheduler.llm("hello")');
    expect(llmConfigWarning(spec, [])).toContain('LLM_API_ENDPOINT 和 LLM_API_KEY');
    expect(llmConfigWarning(spec, [
      new EnvVarSpec({ name: 'LLM_API_ENDPOINT', value: 'https://gateway.example/openai' }),
      new EnvVarSpec({ name: 'LLM_API_KEY', value: 'secret' }),
    ])).toBe('');
    expect(llmConfigWarning(projectWithScript('scheduler.agent("hello")'), [])).toBe('');
  });
});
