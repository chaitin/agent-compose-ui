import {
  BuildImageRequest,
  ImagePlatform,
  ImageStoreKind,
  type BuildSpec,
  type BuildImageEvent,
  type ProjectSpec,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { consumeBuildImageEvents, type BuildStreamState } from '../modals/build-image';

export interface ProjectImageBuildPlan {
  agentName: string;
  imageRef: string;
  contextDisplay: string;
  dockerfile: string;
  request?: BuildImageRequest;
  error: string;
}

export type ProjectImageBuildStatus = 'waiting' | 'building' | 'succeeded' | 'failed' | 'unexecuted';

export interface ProjectImageBuildRunResult {
  agentName: string;
  imageRef: string;
  status: ProjectImageBuildStatus;
  stream: BuildStreamState;
  error: string;
}

export interface ProjectImageBuildClient {
  buildImage(request: BuildImageRequest): AsyncIterable<BuildImageEvent | Partial<BuildImageEvent>>;
}

export class ProjectImageBuildRunError extends Error {
  results: ProjectImageBuildRunResult[];

  constructor(message: string, results: ProjectImageBuildRunResult[]) {
    super(message);
    this.name = 'ProjectImageBuildRunError';
    this.results = results;
  }
}

const emptyStream = (): BuildStreamState => ({ lines: [], warnings: [], imageRef: '', resolvedRef: '' });

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildSignature(build: BuildSpec | undefined): string {
  if (!build) return '';
  return JSON.stringify({
    context: build.context,
    dockerfile: build.dockerfile,
    target: build.target,
    args: Object.entries(build.args).sort(([left], [right]) => left.localeCompare(right)),
    platforms: [...build.platforms],
    tags: [...build.tags],
    noCache: build.noCache,
    pull: build.pull,
  });
}

export function changedBuildAgentNames(previous: ProjectSpec | undefined, current: ProjectSpec): Set<string> {
  const previousAgents = new Map(previous?.agents.map((agent) => [agent.name, agent]) ?? []);
  return new Set(current.agents
    .filter((agent) => agent.build && buildSignature(previousAgents.get(agent.name)?.build) !== buildSignature(agent.build))
    .map((agent) => agent.name));
}

function isAbsoluteDaemonPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizePosixPath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

function daemonDirname(composePath: string): string {
  const normalized = composePath.replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? (separator === 0 ? '/' : '') : normalized.slice(0, separator);
}

function resolveContext(composePath: string, context: string): { value?: string; error?: string } {
  const normalizedContext = context.trim() || '.';
  if (isAbsoluteDaemonPath(normalizedContext)) return { value: normalizePosixPath(normalizedContext) };
  if (!isAbsoluteDaemonPath(composePath.trim())) {
    return { error: '无法解析 daemon 来源路径，请先保存项目后再构建' };
  }
  return { value: normalizePosixPath(`${daemonDirname(composePath.trim())}/${normalizedContext}`) };
}

function parsePlatform(value: string): { platform?: ImagePlatform; error?: string } {
  const normalized = value.trim();
  if (!normalized) return {};
  const parts = normalized.split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part.trim())) {
    return { error: `构建平台格式错误：${normalized}，应为 os/arch[/variant]` };
  }
  return { platform: new ImagePlatform({ os: parts[0], architecture: parts[1], variant: parts[2] || '' }) };
}

export function createProjectImageBuildPlans(spec: ProjectSpec, composePath: string): ProjectImageBuildPlan[] {
  const plans: ProjectImageBuildPlan[] = [];
  for (const agent of spec.agents) {
    const build = agent.build;
    if (!build) continue;
    const tags = uniqueStrings([agent.image, ...build.tags]);
    const base: ProjectImageBuildPlan = {
      agentName: agent.name,
      imageRef: tags[0] || '',
      contextDisplay: build.context.trim() || '.',
      dockerfile: build.dockerfile.trim() || 'Dockerfile',
      error: '',
    };
    if (tags.length === 0) {
      plans.push({ ...base, error: `智能体 ${agent.name} 的构建配置需要 image 或 build.tags` });
      continue;
    }
    if (build.platforms.length > 1) {
      plans.push({ ...base, error: `智能体 ${agent.name} 当前仅支持一个构建平台` });
      continue;
    }
    const context = resolveContext(composePath, build.context);
    if (context.error || !context.value) {
      plans.push({ ...base, error: context.error || '无法解析构建目录' });
      continue;
    }
    const parsedPlatform = parsePlatform(build.platforms[0] || '');
    if (parsedPlatform.error) {
      plans.push({ ...base, error: parsedPlatform.error });
      continue;
    }
    plans.push({
      ...base,
      request: new BuildImageRequest({
        contextDir: context.value,
        dockerfile: base.dockerfile,
        tags,
        buildArgs: { ...build.args },
        target: build.target.trim(),
        store: ImageStoreKind.DOCKER_DAEMON,
        platform: parsedPlatform.platform,
        noCache: build.noCache,
        pull: build.pull,
      }),
    });
  }
  return plans;
}

function cloneStream(stream: BuildStreamState): BuildStreamState {
  return {
    ...stream,
    lines: stream.lines.map((line) => ({ ...line })),
    warnings: [...stream.warnings],
  };
}

export async function runProjectImageBuildPlans(options: {
  plans: ProjectImageBuildPlan[];
  selectedAgentNames: Set<string>;
  client: ProjectImageBuildClient;
  forceNoCache?: boolean;
  forcePull?: boolean;
  onUpdate: (result: ProjectImageBuildRunResult, results: ProjectImageBuildRunResult[]) => void;
}): Promise<ProjectImageBuildRunResult[]> {
  const selected = options.plans.filter((plan) => options.selectedAgentNames.has(plan.agentName));
  const invalid = selected.find((plan) => !plan.request || plan.error);
  if (invalid) throw new ProjectImageBuildRunError(invalid.error || `智能体 ${invalid.agentName} 的构建配置无效`, []);

  const results = selected.map<ProjectImageBuildRunResult>((plan) => ({
    agentName: plan.agentName,
    imageRef: plan.imageRef,
    status: 'waiting',
    stream: emptyStream(),
    error: '',
  }));

  for (let index = 0; index < selected.length; index++) {
    const plan = selected[index];
    const result = results[index];
    result.status = 'building';
    options.onUpdate({ ...result, stream: cloneStream(result.stream) }, results);
    const request = new BuildImageRequest({
      ...plan.request,
      noCache: Boolean(plan.request?.noCache || options.forceNoCache),
      pull: Boolean(plan.request?.pull || options.forcePull),
    });
    try {
      result.stream = await consumeBuildImageEvents(options.client.buildImage(request), (stream) => {
        result.stream = cloneStream(stream);
        options.onUpdate({ ...result, stream: cloneStream(result.stream) }, results);
      });
      result.status = 'succeeded';
      options.onUpdate({ ...result, stream: cloneStream(result.stream) }, results);
    } catch (cause) {
      result.status = 'failed';
      result.error = cause instanceof Error ? cause.message : String(cause);
      for (let later = index + 1; later < results.length; later++) results[later].status = 'unexecuted';
      options.onUpdate({ ...result, stream: cloneStream(result.stream) }, results);
      throw new ProjectImageBuildRunError(result.error, results.map((item) => ({ ...item, stream: cloneStream(item.stream) })));
    }
  }
  return results.map((result) => ({ ...result, stream: cloneStream(result.stream) }));
}
