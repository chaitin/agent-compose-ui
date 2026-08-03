export type StoppedRuntimePresentation = {
  status: 'success' | 'failed' | 'pending' | 'stopped';
  label: string;
  description: string;
};

export function stoppedRuntimePresentation(sandbox: {
  status: string;
  stoppedRuntimePolicy: string;
  stoppedRuntimeState: string;
  stoppedRuntimeLastError: string;
}): StoppedRuntimePresentation | null {
  const state = sandbox.stoppedRuntimeState.trim().toLowerCase();
  const policy = sandbox.stoppedRuntimePolicy.trim().toLowerCase();
  const error = sandbox.stoppedRuntimeLastError.trim();
  if (error) return { status: 'failed', label: '释放运行环境失败', description: error };
  if (state === 'release_pending') {
    return { status: 'pending', label: '正在释放运行环境', description: '恢复时会先完成释放' };
  }
  if (state === 'released') {
    return { status: 'success', label: '运行环境已释放', description: '恢复时将创建新运行环境' };
  }
  if ((state === 'retained' || (!state && policy === 'retain')) && sandbox.status.trim().toLowerCase() === 'stopped') {
    return { status: 'stopped', label: '运行环境已保留', description: '恢复时继续使用原运行环境' };
  }
  return null;
}
