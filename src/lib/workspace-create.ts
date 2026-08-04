import { projectNameFromYaml, setWorkspacePathForAgent, setWorkspacePathForFirstAgent, defaultWorkspacePath } from './workspace-binding';

export interface CreateWorkspaceResult {
  yaml: string;
  workspacePath: string;
}

// Set YAML workspace.path to the default project-relative path. The Workspace
// panel creates the server-owned storage binding after the YAML becomes valid.
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

  return { yaml: nextYaml, workspacePath };
}

// Same as createWorkspaceAndBind but targets a specific agent by name.
// Used by the Workspace panel when multiple agents are defined and the user
// selects one that does not yet have a workspace block.
export async function createWorkspaceForAgent(
  yamlText: string,
  agentName: string,
  sourcePath: string,
  options?: { force?: boolean },
): Promise<CreateWorkspaceResult> {
  const projectName = projectNameFromYaml(yamlText);
  if (!projectName) {
    throw new Error('请先在 YAML 中填写 name 字段（项目名）');
  }
  const nextYaml = setWorkspacePathForAgent(yamlText, agentName, options);
  const workspacePath = defaultWorkspacePath();

  return { yaml: nextYaml, workspacePath };
}
