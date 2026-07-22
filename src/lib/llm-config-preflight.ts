import type { EnvVarSpec, ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb';

const SCHEDULER_LLM_CALL = /\bscheduler\s*\.\s*llm\s*\(/;
const REQUIRED_LLM_ENV = ['LLM_API_ENDPOINT', 'LLM_API_KEY'] as const;

export function usesSchedulerLLM(spec: ProjectSpec): boolean {
  return spec.agents.some((agent) => SCHEDULER_LLM_CALL.test(agent.scheduler?.script ?? ''));
}

export function missingLLMConfig(env: EnvVarSpec[]): string[] {
  const configured = new Set(env
    .filter((item) => item.value.trim() !== '')
    .map((item) => item.name.trim().toUpperCase()));
  return REQUIRED_LLM_ENV.filter((name) => !configured.has(name));
}

export function llmConfigWarning(spec: ProjectSpec, env: EnvVarSpec[]): string {
  if (!usesSchedulerLLM(spec)) return '';
  const missing = missingLLMConfig(env);
  if (missing.length === 0) return '';
  return `检测到 YAML 使用 scheduler.llm()，请先在系统管理 → 环境变量中配置 ${missing.join(' 和 ')}，否则运行时会失败。`;
}
