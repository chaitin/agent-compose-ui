const missingRuntimeSignatures = [
  'runtime state for stopped sandbox',
  'only canonical legacy UUID sandboxes may be reconstructed',
];

export function sandboxResumeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (missingRuntimeSignatures.some((signature) => message.includes(signature))) {
    return '该 Sandbox 已被删除，无法恢复';
  }
  return message || '恢复 Sandbox 失败';
}
