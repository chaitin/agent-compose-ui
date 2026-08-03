const FILE_CHANGE_BLOCK = /(^|\n)\[file_change\]\s*\n(?:add|update|modify|delete|rename):[^\n]*(?=\n|$)/gimu;

export function presentAgentOutput(value: string): string {
  return value
    .replace(FILE_CHANGE_BLOCK, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
