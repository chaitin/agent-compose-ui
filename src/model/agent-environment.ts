export type AgentEnvironmentVariable = {
  name: string;
  value: string;
  secret: boolean;
};

export function validateAgentEnvironment(items: AgentEnvironmentVariable[]): string {
  const names = items.map((item) => item.name.trim());
  if (names.some((name) => !name)) return '环境变量名称不能为空';
  if (new Set(names).size !== names.length) return '环境变量名称不能重复';
  return '';
}
