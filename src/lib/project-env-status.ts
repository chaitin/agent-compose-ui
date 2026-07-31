import { authFetch } from './auth-fetch';

export type ProjectEnvStatus = { pendingSync: boolean };

export async function getProjectEnvStatus(projectId: string): Promise<ProjectEnvStatus> {
  const response = await authFetch(`/api/project-env/status?project_id=${encodeURIComponent(projectId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`读取变量同步状态失败 (${response.status})`);
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).pendingSync !== 'boolean') {
    throw new Error('变量同步状态响应无效');
  }
  return { pendingSync: (value as Record<string, boolean>).pendingSync };
}
