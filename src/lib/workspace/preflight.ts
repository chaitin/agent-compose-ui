import { isWorkspaceBindingValid, parseWorkspaceBinding } from '../workspace-binding';
import { projectStorageApi, projectStorageErrorMessage, type ProjectStorageBinding } from './bindings';

export function requiresManagedWorkspace(yaml: string): boolean {
  return isWorkspaceBindingValid(parseWorkspaceBinding(yaml));
}

export async function assertManagedWorkspace(options: {
  yaml: string;
  sourcePath: string;
  resolve?: (sourcePath: string) => Promise<ProjectStorageBinding>;
}): Promise<void> {
  if (!requiresManagedWorkspace(options.yaml)) return;
  if (!options.sourcePath) throw new Error('项目 Workspace 尚未创建，无法运行');
  try {
    await (options.resolve ?? projectStorageApi.resolve)(options.sourcePath);
  } catch (error) {
    throw new Error(`Workspace 共享存储未就绪：${projectStorageErrorMessage(error)}`);
  }
}
