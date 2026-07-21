import { projectNameFromYaml, setWorkspacePathForFirstAgent, defaultWorkspacePath } from './workspace-binding';
import { localWorkspaceApi } from './workspace/local-api';

export interface CreateWorkspaceResult {
  yaml: string;
  workspacePath: string;
}

// Ensure the workspace directory exists under the project root and set the
// YAML workspace.path to the default project-relative path.
// Does NOT create a daemon workspace preset.
// Does NOT commit the YAML to the store - the caller is responsible for that.
export async function createWorkspaceAndBind(
  yamlText: string,
  sourcePath: string,
  options?: { force?: boolean },
): Promise<CreateWorkspaceResult> {
  const projectName = projectNameFromYaml(yamlText);
  if (!projectName) {
    throw new Error('请先在 YAML 中填写 name 字段（项目名）');
  }
  const nextYaml = setWorkspacePathForFirstAgent(yamlText, options);
  const workspacePath = defaultWorkspacePath();

  // Ensure the directory exists under the project root (only if sourcePath is known)
  if (sourcePath) {
    try {
      await localWorkspaceApi.ensureDir(sourcePath, workspacePath);
    } catch (error) {
      throw new Error(
        '创建 workspace 目录失败：' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return { yaml: nextYaml, workspacePath };
}
