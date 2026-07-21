import {
  ApplyProjectRequest,
  type ApplyProjectResponse,
  ProjectSource,
  ProjectRef,
  RemoveProjectRequest,
  type RemoveProjectResponse,
  ListRunsRequest,
  RunAgentRequest,
  StartRunRequest,
  GetRunRequest,
  FollowRunLogsRequest,
  RunSource,
  RunStatus,
  ProjectChangeAction,
  StopRunRequest,
  type RunLogChunk,
  type RunSummary,
  type StartRunResponse,
  type GetRunResponse,
  type ListRunsResponse,
  ListSchedulersRequest,
  type ListSchedulersResponse,
  ListSchedulerRunsRequest,
  type ListSchedulerRunsResponse,
  SchedulerRunStatus,
  StopSchedulerRunRequest,
  GetSchedulerRequest,
  type GetSchedulerResponse,
  SetSchedulerEnabledRequest,
  type SetSchedulerEnabledResponse,
  ListSandboxesRequest,
  type ListSandboxesResponse,
  RemoveSandboxRequest,
  type RemoveSandboxResponse,
  StopSandboxRequest,
} from '../gen/agentcompose/v2/agentcompose_pb';
import { yamlToSpec } from './yaml';
import { isSameProjectId } from './projects';

export interface ApplyProjectClient {
  applyProject(request: ApplyProjectRequest, options?: { signal?: AbortSignal }): Promise<ApplyProjectResponse>;
}

export interface RunAgentClient {
  runAgent(request: RunAgentRequest): Promise<unknown>;
}

export interface TrackedRunClient {
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  followRunLogs(request: FollowRunLogsRequest, options?: { signal?: AbortSignal }): AsyncIterable<RunLogChunk>;
  getRun(request: GetRunRequest, options?: { signal?: AbortSignal }): Promise<GetRunResponse>;
}

export interface RunYamlBatchOptions {
  projectId: string;
  agents: Array<{ name: string; prompt: string }>;
  client: TrackedRunClient;
  signal?: AbortSignal;
  startOffset?: bigint;
  isCurrent(): boolean;
  onStarting(name: string): void;
  onStarted(name: string, run: RunSummary): void;
  onChunk(name: string, chunk: RunLogChunk): void;
  onFinished(name: string, status: RunStatus, detail?: NonNullable<GetRunResponse['run']>): void;
  onStartFailed(name: string, error: unknown): void;
  onTrackingError(name: string, error: unknown): void;
}

export async function runYamlBatch(options: RunYamlBatchOptions): Promise<void> {
  const active = () => !options.signal?.aborted && options.isCurrent();

  for (const agent of options.agents) {
    if (!active()) return;
    options.onStarting(agent.name);

    let response: StartRunResponse;
    try {
      response = await options.client.startRun(new StartRunRequest({
        run: new RunAgentRequest({
          projectId: options.projectId,
          agentName: agent.name,
          prompt: agent.prompt,
          source: RunSource.MANUAL,
        }),
      }));
    } catch (error) {
      if (!active()) return;
      options.onStartFailed(agent.name, error);
      continue;
    }

    if (!active()) return;
    if (!response.started || !response.run?.runId) {
      const warnings = (response.warnings ?? []).map((warning) => warning.trim()).filter(Boolean);
      const message = warnings.length > 0
        ? warnings.join('; ')
        : response.started ? '运行未返回 Run ID' : '运行未启动';
      options.onStartFailed(agent.name, new Error(message));
      continue;
    }

    const run = response.run;
    options.onStarted(agent.name, run);
    const getDetail = async () => {
      const result = await options.client.getRun(
        new GetRunRequest({ projectId: options.projectId, runId: run.runId }),
        { signal: options.signal },
      );
      return result.run;
    };
    let initialDetail: Awaited<ReturnType<typeof getDetail>>;
    try {
      initialDetail = await getDetail();
    } catch {
      initialDetail = undefined;
    }
    if (!active()) return;
    if (initialDetail && ![RunStatus.PENDING, RunStatus.RUNNING, RunStatus.UNSPECIFIED].includes(initialDetail.summary?.status ?? RunStatus.UNSPECIFIED)) {
      options.onFinished(agent.name, initialDetail.summary?.status ?? RunStatus.UNSPECIFIED, initialDetail);
      continue;
    }
    let offset = options.startOffset ?? 0n;
    let lastStatus = run.status;
    try {
      const request = new FollowRunLogsRequest({
        projectId: options.projectId,
        runId: run.runId,
        startOffset: offset,
        follow: true,
      });
      for await (const chunk of options.client.followRunLogs(request, { signal: options.signal })) {
        if (!active()) return;
        const hasNewData = chunk.offset > offset;
        lastStatus = chunk.runStatus;
        options.onChunk(agent.name, hasNewData || !chunk.data ? chunk : { ...chunk, data: '' } as RunLogChunk);
        if (hasNewData) {
          offset = chunk.offset;
        }
        if (chunk.isFinal) {
          break;
        }
      }
    } catch (error) {
      if (active()) options.onTrackingError(agent.name, error);
      return;
    }
    if (!active()) return;
    let finalDetail: Awaited<ReturnType<typeof getDetail>>;
    try {
      finalDetail = await getDetail();
    } catch (error) {
      if (!active()) return;
      if ([RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELED].includes(lastStatus)) {
        options.onFinished(agent.name, lastStatus);
        continue;
      }
      options.onTrackingError(agent.name, error);
      return;
    }
    if (!active() || !finalDetail) return;
    if ([RunStatus.PENDING, RunStatus.RUNNING, RunStatus.UNSPECIFIED].includes(finalDetail.summary?.status ?? RunStatus.UNSPECIFIED)) return;
    options.onFinished(agent.name, finalDetail.summary?.status ?? RunStatus.UNSPECIFIED, finalDetail);
  }
}

export interface StopProjectRunsClient {
  listRuns(request: ListRunsRequest): Promise<ListRunsResponse>;
  stopRun(request: StopRunRequest): Promise<unknown>;
}

export interface SoftPauseProjectClient extends StopProjectRunsClient {
  listSchedulers(request: ListSchedulersRequest): Promise<ListSchedulersResponse>;
  getScheduler(request: GetSchedulerRequest): Promise<GetSchedulerResponse>;
  setSchedulerEnabled(request: SetSchedulerEnabledRequest): Promise<SetSchedulerEnabledResponse>;
  listSchedulerRuns(request: ListSchedulerRunsRequest): Promise<ListSchedulerRunsResponse>;
  stopSchedulerRun(request: StopSchedulerRunRequest): Promise<unknown>;
  listSandboxes(request: ListSandboxesRequest): Promise<ListSandboxesResponse>;
  stopSandbox(request: StopSandboxRequest): Promise<unknown>;
}

export type ProjectRuntimeActivityClient = Pick<SoftPauseProjectClient,
  'listSchedulers' | 'getScheduler' | 'listSchedulerRuns' | 'listRuns' | 'listSandboxes'>;

export interface ProjectRuntimeActivity {
  scheduler: boolean;
  schedulerRun: boolean;
  run: boolean;
  sandbox: boolean;
  active: boolean;
}

export async function probeProjectRuntimeActivity(options: {
  projectId: string;
  client: ProjectRuntimeActivityClient;
}): Promise<ProjectRuntimeActivity> {
  const { projectId, client } = options;
  const [scheduler, schedulerRun, run, sandbox] = await Promise.all([
    hasEnabledScheduler(projectId, client),
    hasActiveSchedulerRun(projectId, client),
    hasActiveRun(projectId, client),
    hasRunningSandbox(projectId, client),
  ]);
  return { scheduler, schedulerRun, run, sandbox, active: scheduler || schedulerRun || run || sandbox };
}

async function listProjectSchedulers(
  projectId: string,
  client: Pick<SoftPauseProjectClient, 'listSchedulers'>,
): Promise<Array<{ projectId: string; agentName: string }>> {
  const schedulers: Array<{ projectId: string; agentName: string }> = [];
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSchedulers(new ListSchedulersRequest({ limit: 500, cursor }));
    schedulers.push(...(response.schedulers ?? []).filter((item) => (
      isSameProjectId(item.projectId, projectId) && !!item.agentName
    )).map((item) => ({ projectId: item.projectId, agentName: item.agentName })));
    const next = response.nextCursor?.trim() ?? '';
    if (!next) return schedulers;
    if (seen.has(next)) throw new Error(`ListSchedulers returned repeated cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }
}

async function hasEnabledScheduler(projectId: string, client: ProjectRuntimeActivityClient): Promise<boolean> {
  const schedulers = await listProjectSchedulers(projectId, client);
  const details = await Promise.all(schedulers.map((item) => client.getScheduler(new GetSchedulerRequest({
    project: new ProjectRef({ projectId: item.projectId }),
    agentName: item.agentName,
  }))));
  return details.some((detail) => detail.scheduler?.enabled === true);
}

async function hasActiveSchedulerRun(projectId: string, client: ProjectRuntimeActivityClient): Promise<boolean> {
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSchedulerRuns(new ListSchedulerRunsRequest({
      project: new ProjectRef({ projectId }), limit: 500, cursor,
    }));
    if ((response.runs ?? []).some((run) => run.status === SchedulerRunStatus.RUNNING)) return true;
    const next = response.nextCursor?.trim() ?? '';
    if (!next) return false;
    if (seen.has(next)) throw new Error(`ListSchedulerRuns returned repeated cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }
}

async function hasActiveRun(projectId: string, client: ProjectRuntimeActivityClient): Promise<boolean> {
  for (const status of [RunStatus.PENDING, RunStatus.RUNNING]) {
    let offset = 0;
    while (true) {
      const response = await client.listRuns(new ListRunsRequest({ projectId, status, limit: 500, offset }));
      if ((response.runs ?? []).some((item) => !item.projectId || item.projectId === projectId)) return true;
      if ((response.runs?.length ?? 0) < 500) break;
      offset += response.runs.length;
    }
  }
  return false;
}

async function hasRunningSandbox(projectId: string, client: ProjectRuntimeActivityClient): Promise<boolean> {
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSandboxes(new ListSandboxesRequest({ limit: 500, cursor }));
    if ((response.sandboxes ?? []).some((item) => (
      item.projectId === projectId && item.status.trim().toUpperCase() === 'RUNNING'
    ))) return true;
    const next = response.nextCursor?.trim() ?? '';
    if (!next) return false;
    if (seen.has(next)) throw new Error(`ListSandboxes returned repeated cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }
}

export interface PauseStageResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export interface SoftPauseProjectResult {
  schedulers: PauseStageResult;
  schedulerRuns: PauseStageResult;
  runs: PauseStageResult;
  sandboxes: PauseStageResult;
  failed: number;
}

export interface DeleteProjectClient {
  removeProject(request: RemoveProjectRequest): Promise<RemoveProjectResponse | unknown>;
}

export interface CascadeDeleteProjectClient extends DeleteProjectClient {
  listSandboxes(request: ListSandboxesRequest): Promise<ListSandboxesResponse>;
  removeSandbox(request: RemoveSandboxRequest): Promise<RemoveSandboxResponse>;
}

interface ProjectNameEntry {
  summary: {
    projectId: string;
    name: string;
    sourcePath?: string;
    specHash?: string;
  };
}

export function createPreviewGeneration(onInvalidate: () => void) {
  let current = 0;
  return {
    begin() { onInvalidate(); return ++current; },
    invalidate() { ++current; onInvalidate(); },
    isCurrent(token: number) { return token === current; },
  };
}

export interface PreparedProjectPreview<TPrepared> {
  currentProjectId: string;
  editorContent: string;
  prepared: TPrepared;
  response: ApplyProjectResponse;
  apply: (signal?: AbortSignal) => ReturnType<typeof saveProject>;
}

export async function prepareProjectPreview<TPrepared extends { yamlText: string }>(options: {
  mode: 'save' | 'run';
  currentProjectId: string;
  editorContent: string;
  projects: ProjectNameEntry[];
  fallbackSpecHash: string;
  prepare: (editorContent: string) => Promise<TPrepared>;
  preflight?: (prepared: TPrepared) => Promise<void>;
  client: ApplyProjectClient;
  isCurrent: (projectId: string) => boolean;
}): Promise<PreparedProjectPreview<TPrepared> | undefined> {
  const snapshotProjects = options.projects.map((project) => ({ summary: { ...project.summary } }));
  const snapshotProject = snapshotProjects.find((project) => isSameProjectId(project.summary.projectId, options.currentProjectId));
  const prepared = await options.prepare(options.editorContent);
  if (!options.isCurrent(options.currentProjectId)) return undefined;
  if (options.preflight) await options.preflight(prepared);
  if (!options.isCurrent(options.currentProjectId)) return undefined;
  const preview = await previewProject(options.editorContent, options.client, {
    currentProjectId: options.currentProjectId,
    projects: snapshotProjects,
    preparedYaml: prepared.yamlText,
    expectedSpecHash: snapshotProject?.summary.specHash || options.fallbackSpecHash,
  });
  if (!options.isCurrent(options.currentProjectId)) return undefined;
  return { currentProjectId: options.currentProjectId, editorContent: options.editorContent, prepared, ...preview };
}

export async function consumePendingApply<T>(slot: {
  take: () => { apply: (signal?: AbortSignal) => Promise<T> } | undefined;
  restore: (pending: { apply: (signal?: AbortSignal) => Promise<T> }) => void;
}, signal?: AbortSignal): Promise<T | undefined> {
  const pending = slot.take();
  if (!pending) return undefined;
  try {
    return await pending.apply(signal);
  } catch (error) {
    slot.restore(pending);
    throw error;
  }
}

export interface SaveProjectOptions {
  currentProjectId: string;
  projects: ProjectNameEntry[];
  preparedYaml?: string;
  expectedSpecHash?: string;
}

function prepareApplyRequest(editorContent: string, options?: SaveProjectOptions) {
  const sourceYaml = options?.preparedYaml ?? editorContent;
  const { spec, error } = yamlToSpec(sourceYaml);
  if (error) throw new Error(`YAML 解析错误: ${error}`);

  const projectName = spec.name.trim();
  const duplicate = options?.projects.find((project) => (
    !isSameProjectId(project.summary.projectId, options.currentProjectId) &&
    project.summary.name.trim() === projectName
  ));
  if (projectName && duplicate) throw new Error(`智能体应用名称 "${projectName}" 已存在，请修改名称`);

  const currentProject = options?.projects.find((project) => isSameProjectId(project.summary.projectId, options.currentProjectId));
  return {
    spec,
    source: new ProjectSource({ composePath: currentProject?.summary.sourcePath?.trim() || 'agent-compose.yml' }),
    expectedSpecHash: options?.expectedSpecHash || '',
  };
}

export async function previewProject(editorContent: string, client: ApplyProjectClient, options?: SaveProjectOptions) {
  const prepared = prepareApplyRequest(editorContent, options);
  const response = await client.applyProject(new ApplyProjectRequest({
    ...prepared,
    expectedSpecHash: '',
    dryRun: true,
  }));
  const savedSpecHash = prepared.expectedSpecHash.trim();
  const previewSpecHash = response.revision?.specHash.trim() || '';
  if (savedSpecHash && savedSpecHash === previewSpecHash) {
    for (const change of response.changes) {
      if (change.action === ProjectChangeAction.CREATED) {
        change.action = ProjectChangeAction.UNCHANGED;
      }
    }
    response.unchanged = response.changes.every(
      (change) => change.action === ProjectChangeAction.UNCHANGED,
    );
  }
  const confirmed = {
    ...prepared,
    expectedSpecHash: response.revision?.specHash || '',
  };
  return {
    response,
    apply: (signal?: AbortSignal) => saveProject(editorContent, client, options, confirmed, signal),
  };
}

export function getAppliedProjectId(
  response: Pick<ApplyProjectResponse, 'project'>,
  currentProjectId: string,
): string {
  return response.project?.summary?.projectId || currentProjectId;
}

export async function saveProject(
  editorContent: string,
  client: ApplyProjectClient,
  options?: SaveProjectOptions,
  preparedRequest = prepareApplyRequest(editorContent, options),
  signal?: AbortSignal,
) {
  const { spec } = preparedRequest;
  const request = new ApplyProjectRequest({
    ...preparedRequest,
    dryRun: false,
  });
  const response = signal
    ? await client.applyProject(request, { signal })
    : await client.applyProject(request);
  if (!response.applied && !response.unchanged) throw new Error('保存未生效');

  const appliedProjectId = getAppliedProjectId(response, '');
  const currentProjectId = options?.currentProjectId || '';
  const supersededProjectId = currentProjectId.startsWith('sha256:') &&
    appliedProjectId !== currentProjectId &&
    isSameProjectId(currentProjectId, appliedProjectId)
    ? currentProjectId
    : '';

  const agents = spec.agents
    .filter((agent) => !!agent.name)
    .map((agent) => ({
      name: agent.name,
      prompt: agent.systemPrompt || '',
      hasScheduler: !!agent.scheduler,
    }));

  return {
    response,
    agentNames: agents.map((agent) => agent.name),
    agents,
    supersededProjectId,
  };
}

export async function deleteProject(
  projectId: string,
  client: DeleteProjectClient,
  options: { stopRunningSessions?: boolean } = {},
) {
  return client.removeProject(new RemoveProjectRequest({
    project: new ProjectRef({ projectId }),
    removeHistory: false,
    stopRunningSandboxes: options.stopRunningSessions ?? true,
  }));
}

function sandboxBelongsToProjectForDeletion(
  sandbox: { projectId?: string; tags?: Array<{ name: string; value: string }> },
  projectId: string,
): boolean {
  if (isSameProjectId(sandbox.projectId ?? '', projectId)) return true;
  const tag = (sandbox.tags ?? []).find((item) => item.name === 'project');
  return !!tag && isSameProjectId(tag.value, projectId);
}

export async function cascadeDeleteProject(projectId: string, client: CascadeDeleteProjectClient) {
  const related: string[] = [];
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSandboxes(new ListSandboxesRequest({ limit: 500, cursor }));
    for (const sandbox of response.sandboxes ?? []) {
      if (!sandboxBelongsToProjectForDeletion(sandbox, projectId)) continue;
      if (!sandbox.sandboxId) throw new Error('关联 Sandbox 缺少 ID，项目未删除');
      related.push(sandbox.sandboxId);
    }
    const next = response.nextCursor?.trim() ?? '';
    if (!next) break;
    if (seen.has(next)) throw new Error(`ListSandboxes returned repeated cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }
  for (const sandboxId of related) {
    const response = await client.removeSandbox(new RemoveSandboxRequest({ sandboxId, force: true }));
    if (!response.removed) throw new Error(`Sandbox ${sandboxId} 未能删除，项目未删除`);
  }
  await client.removeProject(new RemoveProjectRequest({
    project: new ProjectRef({ projectId }),
    removeHistory: true,
    stopRunningSandboxes: true,
  }));
  return { removedSandboxes: related.length };
}

export async function stopProjectRuns(options: {
  projectId: string;
  client: StopProjectRunsClient;
}) {
  const pageSize = 200;
  const activeRuns: { runId: string }[] = [];

  for (const status of [RunStatus.PENDING, RunStatus.RUNNING]) {
    let offset = 0;
    while (true) {
      const response = await options.client.listRuns(new ListRunsRequest({
        projectId: options.projectId,
        status,
        offset,
        limit: pageSize,
      }));
      const runs = response.runs || [];
      activeRuns.push(...runs.filter((run) => !!run.runId));
      if (runs.length < pageSize) break;
      offset += runs.length;
    }
  }

  let stopped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const run of activeRuns) {
    try {
      await options.client.stopRun(new StopRunRequest({
        runId: run.runId,
        reason: 'stopped from web console',
      }));
      stopped++;
    } catch (error) {
      failed++;
      errors.push(`Failed to stop run ${run.runId}: ${pauseError(error)}`);
    }
  }

  return { attempted: activeRuns.length, stopped, failed, errors };
}

function pauseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pauseSchedulers(projectId: string, client: SoftPauseProjectClient): Promise<PauseStageResult> {
  const schedulers = await listProjectSchedulers(projectId, client);

  const result: PauseStageResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
  for (const scheduler of schedulers) {
    let attempted = false;
    try {
      const detail = await client.getScheduler(new GetSchedulerRequest({
        project: new ProjectRef({ projectId: scheduler.projectId }),
        agentName: scheduler.agentName,
      }));
      if (detail.scheduler?.enabled !== true) continue;
      result.attempted++;
      attempted = true;
      const response = await client.setSchedulerEnabled(new SetSchedulerEnabledRequest({
        project: new ProjectRef({ projectId: scheduler.projectId }),
        agentName: scheduler.agentName,
        enabled: false,
      }));
      if (!response.scheduler || response.scheduler.enabled) {
        throw new Error(`Scheduler ${scheduler.agentName} 未确认已禁用`);
      }
      result.succeeded++;
    } catch (error) {
      if (!attempted) result.attempted++;
      result.failed++;
      result.errors.push(pauseError(error));
    }
  }
  return result;
}

async function pauseSchedulerRuns(projectId: string, client: SoftPauseProjectClient): Promise<PauseStageResult> {
  const activeRuns: Array<{ runId: string }> = [];
  const seenCursors = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSchedulerRuns(new ListSchedulerRunsRequest({
      project: new ProjectRef({ projectId }), limit: 500, cursor,
    }));
    activeRuns.push(...(response.runs ?? []).filter((run) => (
      run.status === SchedulerRunStatus.RUNNING && !!run.runId
    )).map((run) => ({ runId: run.runId })));
    const nextCursor = response.nextCursor?.trim() ?? '';
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error(`ListSchedulerRuns returned repeated cursor: ${nextCursor}`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const result: PauseStageResult = { attempted: activeRuns.length, succeeded: 0, failed: 0, errors: [] };
  for (const run of activeRuns) {
    try {
      await client.stopSchedulerRun(new StopSchedulerRunRequest({
        project: new ProjectRef({ projectId }), runId: run.runId, reason: 'project paused from web console',
      }));
      result.succeeded++;
    } catch (error) {
      result.failed++;
      result.errors.push(`Failed to stop Scheduler Run ${run.runId}: ${pauseError(error)}`);
    }
  }
  return result;
}

// sandboxBelongsToProject matches a sandbox to a project. Scheduler/webhook
// triggered loader runs create sandboxes whose top-level `projectId` is empty
// (the project id only appears in the `project` tag), so a strict equality
// check on `projectId` would skip them. Fall back to the `project` tag so the
// soft-pause flow still stops those sandboxes.
function sandboxBelongsToProject(
  sandbox: { projectId?: string; tags?: Array<{ name: string; value: string }> },
  projectId: string,
): boolean {
  if (isSameProjectId(sandbox.projectId ?? '', projectId)) {
    return true;
  }
  const projectTag = (sandbox.tags ?? []).find((tag) => tag.name === 'project');
  return !!projectTag && isSameProjectId(projectTag.value, projectId);
}

async function pauseSandboxes(projectId: string, client: SoftPauseProjectClient): Promise<PauseStageResult> {
  const sandboxes: Array<{ sandboxId: string }> = [];
  const seenCursors = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSandboxes(new ListSandboxesRequest({ limit: 500, cursor }));
    sandboxes.push(...(response.sandboxes ?? []).filter((sandbox) => (
      sandboxBelongsToProject(sandbox, projectId) &&
      sandbox.status.trim().toUpperCase() === 'RUNNING' &&
      !!sandbox.sandboxId
    )));
    const nextCursor = response.nextCursor?.trim() ?? '';
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) throw new Error(`ListSandboxes returned repeated cursor: ${nextCursor}`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const result: PauseStageResult = { attempted: sandboxes.length, succeeded: 0, failed: 0, errors: [] };
  for (const sandbox of sandboxes) {
    try {
      await client.stopSandbox(new StopSandboxRequest({ sandboxId: sandbox.sandboxId }));
      result.succeeded++;
    } catch (error) {
      result.failed++;
      result.errors.push(pauseError(error));
    }
  }
  return result;
}

async function runPauseStage(stage: () => Promise<PauseStageResult>): Promise<PauseStageResult> {
  try {
    return await stage();
  } catch (error) {
    return { attempted: 0, succeeded: 0, failed: 1, errors: [pauseError(error)] };
  }
}

const pauseConvergenceRounds = 6;
const requiredIdlePauseRounds = 2;

function mergePauseStage(target: PauseStageResult, current: PauseStageResult): void {
  target.attempted += current.attempted;
  target.succeeded += current.succeeded;
  target.failed += current.failed;
  target.errors.push(...current.errors);
}

export async function softPauseProject(options: {
  projectId: string;
  client: SoftPauseProjectClient;
}): Promise<SoftPauseProjectResult> {
  const schedulers = await runPauseStage(() => pauseSchedulers(options.projectId, options.client));
  const schedulerRuns: PauseStageResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
  const runs: PauseStageResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
  const sandboxes: PauseStageResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };
  let idleRounds = 0;
  let stageFailed = false;
  for (let round = 0; round < pauseConvergenceRounds; round++) {
    const currentSchedulerRuns = await runPauseStage(() => pauseSchedulerRuns(options.projectId, options.client));
    const currentRuns = await runPauseStage(async () => {
      const result = await stopProjectRuns(options);
      return { attempted: result.attempted, succeeded: result.stopped, failed: result.failed, errors: result.errors };
    });
    const currentSandboxes = await runPauseStage(() => pauseSandboxes(options.projectId, options.client));
    mergePauseStage(schedulerRuns, currentSchedulerRuns);
    mergePauseStage(runs, currentRuns);
    mergePauseStage(sandboxes, currentSandboxes);

    if (currentSchedulerRuns.failed > 0 || currentRuns.failed > 0 || currentSandboxes.failed > 0) {
      stageFailed = true;
      break;
    }

    if (currentSchedulerRuns.attempted === 0 && currentRuns.attempted === 0 && currentSandboxes.attempted === 0) {
      idleRounds++;
      if (idleRounds >= requiredIdlePauseRounds) break;
    } else {
      idleRounds = 0;
    }
  }
  if (!stageFailed && idleRounds < requiredIdlePauseRounds) {
    runs.failed++;
    runs.errors.push(`项目暂停在 ${pauseConvergenceRounds} 轮检查后仍未收敛`);
  }
  return {
    schedulers,
    schedulerRuns,
    runs,
    sandboxes,
    failed: schedulers.failed + schedulerRuns.failed + runs.failed + sandboxes.failed,
  };
}

export async function runProjectAgents(options: {
  projectId: string;
  agents: Array<{ name: string; prompt: string }>;
  client: RunAgentClient;
  onStarted(name: string): void;
  onFailed(name: string, error: unknown): void;
  onSettled(): void;
  shouldContinue?: () => boolean;
}) {
  for (const agent of options.agents) {
    if (options.shouldContinue && !options.shouldContinue()) return;
    try {
      await options.client.runAgent(new RunAgentRequest({
        projectId: options.projectId,
        agentName: agent.name,
        prompt: agent.prompt,
        source: RunSource.MANUAL,
      }));
      options.onStarted(agent.name);
    } catch (error) {
      options.onFailed(agent.name, error);
    } finally {
      options.onSettled();
    }
  }
}

export async function runProjectAgentsIfCurrent(options: {
  projectId: string;
  agents: Array<{ name: string; prompt: string }>;
  client: RunAgentClient;
  isCurrent: () => boolean;
  onNavigate(): void;
  onStarted(name: string): void;
  onFailed(name: string, error: unknown): void;
  onSettled(): void;
}) {
  if (!options.isCurrent()) return;
  options.onNavigate();
  if (!options.isCurrent()) return;
  await runProjectAgents({
    projectId: options.projectId,
    agents: options.agents,
    client: options.client,
    shouldContinue: options.isCurrent,
    onStarted: (name) => { if (options.isCurrent()) options.onStarted(name); },
    onFailed: (name, error) => { if (options.isCurrent()) options.onFailed(name, error); },
    onSettled: () => { if (options.isCurrent()) options.onSettled(); },
  });
}
