import { runClient } from './client';

export type ProjectRunDebugTarget = {
  runId: string;
  sessionId: string;
};

export async function getProjectRunDebugTarget(runId: string): Promise<ProjectRunDebugTarget> {
  const response = await runClient.getRun({ runId });
  const summary = response.run?.summary;
  if (!summary) {
    throw new Error('运行记录不存在');
  }
  if (!summary.sessionId) {
    throw new Error('当前运行没有关联的调试会话');
  }
  return {
    runId: summary.runId,
    sessionId: summary.sessionId,
  };
}
