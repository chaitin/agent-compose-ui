import type { ProjectSpec } from '../gen/agentcompose/v2/agentcompose_pb';
import { projectStorageApi } from './workspace/bindings';
import { localWorkspaceApi, type WorkspaceFileEntry } from './workspace/local-api';

export interface ProjectImageFileSource {
  agentName: string;
  imageRef: string;
  context: string;
  storagePath: string;
  dockerfile: string;
  manageable: boolean;
  error: string;
}

function isAbsolutePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function normalizedRelativePath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.').join('/');
}

function containsParentSegment(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').includes('..');
}

export function buildFileSources(spec: ProjectSpec): ProjectImageFileSource[] {
  return spec.agents.flatMap((agent) => {
    if (!agent.build) return [];

    const rawContext = agent.build.context.trim() || '.';
    const absoluteContext = isAbsolutePath(rawContext);
    const context = absoluteContext
      ? rawContext.replaceAll('\\', '/').replace(/\/$/, '')
      : normalizedRelativePath(rawContext) || '.';
    const rawDockerfile = agent.build.dockerfile.trim() || 'Dockerfile';
    const dockerfile = normalizedRelativePath(rawDockerfile) || 'Dockerfile';
    let error = '';

    if (isAbsolutePath(rawDockerfile) || containsParentSegment(rawDockerfile)) {
      error = 'Dockerfile 必须使用构建目录内的相对路径';
    } else if (absoluteContext) {
      error = '绝对路径由服务端管理，不能在浏览器中管理文件';
    } else if (context === '.') {
      error = '当前上传能力不支持项目根目录，请将 build.context 配置为项目子目录';
    } else if (containsParentSegment(rawContext)) {
      error = '构建目录不能包含 .. 或超出项目目录';
    }

    return [{
      agentName: agent.name,
      imageRef: agent.image.trim() || agent.build.tags.find((tag) => tag.trim())?.trim() || '',
      context,
      storagePath: error ? '' : context,
      dockerfile,
      manageable: !error,
      error,
    }];
  });
}

export interface ProjectImageFileCheck extends ProjectImageFileSource {
  files: WorkspaceFileEntry[];
  ready: boolean;
  message: string;
}

export async function checkProjectImageFiles(options: {
  spec: ProjectSpec;
  sourcePath: string;
  selectedAgentNames?: Set<string>;
  resolve?: typeof projectStorageApi.resolve;
  listFiles?: typeof localWorkspaceApi.listFiles;
}): Promise<ProjectImageFileCheck[]> {
  const sources = buildFileSources(options.spec).filter((source) =>
    !options.selectedAgentNames || options.selectedAgentNames.has(source.agentName));
  const manageableSources = sources.filter((source) => source.manageable);
  let binding: Awaited<ReturnType<typeof projectStorageApi.resolve>> | undefined;
  let resolveError = '';

  if (manageableSources.length > 0) {
    try {
      binding = await (options.resolve ?? projectStorageApi.resolve)(options.sourcePath);
    } catch (cause) {
      resolveError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return await Promise.all(sources.map(async (source): Promise<ProjectImageFileCheck> => {
    if (!source.manageable) {
      const serverManaged = source.error.startsWith('绝对路径由服务端管理');
      return { ...source, files: [], ready: serverManaged, message: serverManaged ? '' : source.error };
    }
    if (!binding) return { ...source, files: [], ready: false, message: resolveError || '无法解析项目存储' };

    try {
      const response = await (options.listFiles ?? localWorkspaceApi.listFiles)(binding.projectKey, source.storagePath);
      const ready = response.files.some((file) => !file.dir && file.path === source.dockerfile);
      return { ...source, files: response.files, ready, message: ready ? '' : `缺少 ${source.dockerfile}` };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ...source, files: [], ready: false, message: `无法读取构建目录 ${source.context}：${detail}` };
    }
  }));
}
