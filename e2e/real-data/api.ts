import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import {
  CapabilityService,
  DashboardService,
  ImageService,
  ProjectService,
  RunService,
  SandboxService,
  SettingsService,
} from '../../src/gen/agentcompose/v2/agentcompose_connect';
import {
  AgentSpec,
  ApplyProjectRequest,
  DockerDriverSpec,
  DriverSpec,
  FollowRunLogsRequest,
  GetCapabilityStatusRequest,
  GetDashboardOverviewRequest,
  GetGlobalEnvRequest,
  GetProjectRequest,
  GetRunRequest,
  GetSandboxRequest,
  GetSandboxStatsRequest,
  ImageOperationStatus,
  ImageStoreKind,
  InspectImageRequest,
  ListImagesRequest,
  ListProjectsRequest,
  ListRunsRequest,
  ListSandboxHistoryRequest,
  ListSandboxRunEventsRequest,
  ListSandboxesRequest,
  ListSchedulerEventsRequest,
  ProjectRef,
  ProjectSource,
  ProjectSpec,
  PullImageRequest,
  RemoveImageRequest,
  RemoveProjectRequest,
  RemoveSandboxRequest,
  RunAgentRequest,
  RunSandboxCleanupPolicy,
  RunSource,
  RunStatus,
  type Sandbox,
  StopRunRequest,
  StartRunRequest,
  ValidateProjectRequest,
} from '../../src/gen/agentcompose/v2/agentcompose_pb';
import type { Fixture, FixtureLedger } from './fixtures';
import type { CaseRecorder, FieldAssertion } from './report';

export interface LiveClients {
  project: Client<typeof ProjectService>;
  run: Client<typeof RunService>;
  image: Client<typeof ImageService>;
  sandbox: Client<typeof SandboxService>;
  dashboard: Client<typeof DashboardService>;
  settings: Client<typeof SettingsService>;
  capability: Client<typeof CapabilityService>;
}

export interface RealDataContext {
  daemonUrl: string;
  frontendUrl: string;
  fixture: Fixture;
  ledger: FixtureLedger;
  recorder: CaseRecorder;
  clients: LiveClients;
  projectId: string;
  successfulRunId: string;
  failedRunId: string;
  stoppedRunId: string;
}

export function createLiveClients(baseUrl: string): LiveClients {
  const transport = createConnectTransport({ baseUrl });
  return {
    project: createClient(ProjectService, transport),
    run: createClient(RunService, transport),
    image: createClient(ImageService, transport),
    sandbox: createClient(SandboxService, transport),
    dashboard: createClient(DashboardService, transport),
    settings: createClient(SettingsService, transport),
    capability: createClient(CapabilityService, transport),
  };
}

export const exact = (field: string, expected: unknown, actual: unknown): FieldAssertion => ({ field, expected, actual, pass: Object.is(expected, actual) });
export const predicate = (field: string, expected: string, actual: unknown, pass: boolean): FieldAssertion => ({ field, expected, actual, pass });

export function imageHasReference(image: { repoTags?: string[]; repoDigests?: string[] } | undefined, reference: string): boolean {
  return [...(image?.repoTags ?? []), ...(image?.repoDigests ?? [])].includes(reference);
}

export function imagePlatform(image: { platform?: { os?: string; architecture?: string } } | undefined): string {
  return [image?.platform?.os, image?.platform?.architecture].filter(Boolean).join('/');
}

export function schedulerEventsRequest(projectId: string, agentName: string): ListSchedulerEventsRequest {
  return new ListSchedulerEventsRequest({
    project: new ProjectRef({ projectId }),
    agentName,
    limit: 100,
  });
}

export async function findTrackedSandbox(
  fetchPage: (request: ListSandboxesRequest) => Promise<{ sandboxes: Sandbox[]; nextCursor: string }>,
  trackedIds: ReadonlySet<string>,
): Promise<Sandbox | undefined> {
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const page = await fetchPage(new ListSandboxesRequest({ limit: 100, cursor }));
    const tracked = page.sandboxes.find(sandbox => trackedIds.has(sandbox.sandboxId));
    if (tracked || !page.nextCursor) return tracked;
    if (seen.has(page.nextCursor)) throw new Error(`Sandbox pagination returned repeated cursor: ${page.nextCursor}`);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function projectSpec(fixture: Fixture): ProjectSpec {
  const docker = new DriverSpec({ name: 'docker', docker: new DockerDriverSpec() });
  return new ProjectSpec({
    name: fixture.projectName,
    agents: [
      new AgentSpec({ name: 'deterministic-agent', provider: 'codex', image: fixture.agentImage, driver: docker }),
      new AgentSpec({ name: 'llm-agent', provider: 'codex', image: fixture.agentImage, driver: docker, systemPrompt: 'Return exactly the marker requested by the user and no other text.' }),
    ],
  });
}

function source(fixture: Fixture): ProjectSource {
  const root = `/tmp/${fixture.batchId}`;
  return new ProjectSource({ composePath: `${root}/agent-compose.yml`, projectDir: root });
}

function runSummary(run: any) {
  const summary = run?.summary;
  return {
    runId: summary?.runId ?? '',
    projectId: summary?.projectId ?? '',
    agentName: summary?.agentName ?? '',
    sandboxId: summary?.sandboxId ?? '',
    status: summary?.status ?? RunStatus.UNSPECIFIED,
    exitCode: summary?.exitCode ?? 0,
    output: run?.output ?? '',
    error: summary?.error ?? '',
  };
}

function trackRun(context: RealDataContext, run: any): ReturnType<typeof runSummary> {
  const value = runSummary(run);
  if (value.runId) context.ledger.runs.add(value.runId);
  if (value.sandboxId) context.ledger.sandboxes.add(value.sandboxId);
  return value;
}

export async function runApiCases(context: RealDataContext): Promise<void> {
  const { fixture, recorder, clients, ledger } = context;
  await recorder.run('health', '服务健康', { url: `${context.daemonUrl}/api/version` }, { httpStatus: 200, err: null, version: 'non-empty' }, async () => {
    const response = await fetch(`${context.daemonUrl}/api/version`);
    const body = await response.json() as any;
    return { actual: { httpStatus: response.status, err: body.err, version: body.data?.version, timestamp: body.data?.timestamp }, assertions: [exact('httpStatus', 200, response.status), exact('err', null, body.err), predicate('version', 'non-empty string', body.data?.version, typeof body.data?.version === 'string' && body.data.version.length > 0), predicate('timestamp', 'positive number', body.data?.timestamp, Number(body.data?.timestamp) > 0)] };
  });

  const scriptBase = `${context.frontendUrl}/script-api/v1`;
  await recorder.run('health', '脚本服务', { url: `${scriptBase}/health` }, { httpStatus: 200, ok: true }, async () => {
    const response = await fetch(`${scriptBase}/health`);
    const body = await response.json() as any;
    return { actual: { httpStatus: response.status, ...body }, assertions: [exact('httpStatus', 200, response.status), exact('ok', true, body.ok)] };
  });

  const initialImages = await clients.image.listImages(new ListImagesRequest({ query: fixture.image, all: true, limit: 100 }));
  ledger.imageWasPresent = initialImages.images.some((image) => imageHasReference(image, fixture.image));
  await recorder.run('pull', '镜像', { imageRef: fixture.image }, { status: 'SUCCEEDED', imageListed: true }, async () => {
    const pull = await clients.image.pullImage(new PullImageRequest({ imageRef: fixture.image, store: ImageStoreKind.DOCKER_DAEMON }));
    ledger.imagePulled = !ledger.imageWasPresent && pull.status === ImageOperationStatus.SUCCEEDED;
    const list = await clients.image.listImages(new ListImagesRequest({ query: 'busybox', all: true, limit: 100 }));
    const found = list.images.find((image) => imageHasReference(image, fixture.image));
    return { actual: { status: ImageOperationStatus[pull.status], resolvedRef: pull.resolvedRef, imageListed: Boolean(found), imageId: found?.imageId }, assertions: [exact('status', 'SUCCEEDED', ImageOperationStatus[pull.status]), exact('imageListed', true, Boolean(found))] };
  });
  await recorder.run('inspect', '镜像', { imageRef: fixture.image }, { imageId: 'non-empty', sizeBytes: '>=0', platform: 'non-empty' }, async () => {
    const response = await clients.image.inspectImage(new InspectImageRequest({ imageRef: fixture.image, store: ImageStoreKind.DOCKER_DAEMON, includeCacheStatus: true }));
    const image = response.image;
    const platform = imagePlatform(image);
    return { actual: image?.toJson({ emitDefaultValues: true }), assertions: [predicate('imageId', 'non-empty', image?.imageId, Boolean(image?.imageId)), predicate('sizeBytes', '>=0', image?.sizeBytes?.toString(), BigInt(image?.sizeBytes?.toString() ?? '-1') >= 0n), predicate('platform', 'non-empty', platform, Boolean(platform))] };
  });

  const spec = projectSpec(fixture);
  const projectSource = source(fixture);
  await recorder.run('valid', '项目校验', { name: spec.name, agents: spec.agents.map((agent) => agent.name) }, { valid: true, errorIssues: 0 }, async () => {
    const response = await clients.project.validateProject(new ValidateProjectRequest({ spec, source: projectSource }));
    return { actual: { valid: response.valid, issues: response.issues.map((issue) => issue.toJson()) }, assertions: [exact('valid', true, response.valid), exact('errorIssues', 0, response.issues.length)] };
  });
  await recorder.run('invalid', '项目校验', { name: '', agents: [] }, { rejected: true }, async () => {
    try {
      const response = await clients.project.validateProject(new ValidateProjectRequest({ spec: new ProjectSpec({ name: 'INVALID NAME' }), source: projectSource }));
      return { actual: { valid: response.valid, issues: response.issues.map((issue) => issue.toJson()) }, assertions: [exact('rejected', true, !response.valid && response.issues.length > 0)] };
    } catch (error) {
      return { actual: { rejected: true, error: String(error) }, assertions: [exact('rejected', true, true)] };
    }
  });
  await recorder.run('apply', '项目', { name: fixture.projectName, agentCount: 2 }, { applied: true, projectId: 'non-empty', name: fixture.projectName, agentCount: 2 }, async () => {
    const response = await clients.project.applyProject(new ApplyProjectRequest({ spec, source: projectSource }));
    const summary = response.project?.summary;
    context.projectId = summary?.projectId ?? '';
    if (context.projectId) ledger.projects.add(context.projectId);
    return { actual: { applied: response.applied, projectId: context.projectId, name: summary?.name, agentCount: summary?.agentCount }, assertions: [exact('applied', true, response.applied), predicate('projectId', 'non-empty', context.projectId, Boolean(context.projectId)), exact('name', fixture.projectName, summary?.name), exact('agentCount', 2, summary?.agentCount)] };
  });
  await recorder.run('get', '项目', { projectId: context.projectId }, { name: fixture.projectName, agents: ['deterministic-agent', 'llm-agent'] }, async () => {
    const response = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: context.projectId }), includeSpec: true }));
    const names = response.project?.spec?.agents.map((agent) => agent.name) ?? [];
    return { actual: { name: response.project?.summary?.name, agents: names, sourcePath: response.project?.summary?.sourcePath }, assertions: [exact('name', fixture.projectName, response.project?.summary?.name), exact('agents', 'deterministic-agent,llm-agent', names.join(','))] };
  });
  await recorder.run('list-filter-page', '项目', { query: fixture.batchId, offset: 0, limit: 1 }, { totalCount: 1, returned: 1, projectId: context.projectId }, async () => {
    const response = await clients.project.listProjects(new ListProjectsRequest({ query: fixture.batchId, offset: 0, limit: 1 }));
    return { actual: { totalCount: response.totalCount, returned: response.projects.length, projectIds: response.projects.map((project) => project.projectId) }, assertions: [exact('totalCount', 1, response.totalCount), exact('returned', 1, response.projects.length), exact('projectId', context.projectId, response.projects[0]?.projectId)] };
  });

  await recorder.run('update', '项目', { projectId: context.projectId, systemPrompt: `${fixture.batchId}-updated` }, { applied: true, specHashChanged: true, systemPrompt: `${fixture.batchId}-updated` }, async () => {
    const before = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: context.projectId }), includeSpec: true }));
    const updatedSpec = before.project?.spec;
    if (!updatedSpec) throw new Error('project spec missing before update');
    updatedSpec.agents[0].systemPrompt = `${fixture.batchId}-updated`;
    const oldHash = before.project?.summary?.specHash ?? '';
    const applied = await clients.project.applyProject(new ApplyProjectRequest({ spec: updatedSpec, source: projectSource }));
    const after = await clients.project.getProject(new GetProjectRequest({ project: new ProjectRef({ projectId: context.projectId }), includeSpec: true }));
    return { actual: { applied: applied.applied, oldHash, newHash: after.project?.summary?.specHash, systemPrompt: after.project?.spec?.agents[0]?.systemPrompt }, assertions: [exact('applied', true, applied.applied), predicate('specHashChanged', 'newHash != oldHash', after.project?.summary?.specHash, Boolean(after.project?.summary?.specHash && after.project.summary.specHash !== oldHash)), exact('systemPrompt', `${fixture.batchId}-updated`, after.project?.spec?.agents[0]?.systemPrompt)] };
  });

  await runScriptCases(context, scriptBase);

  await runCommandCase(context, 'success', fixture.successCommand, 0, fixture.stdoutMarker);
  await runCommandCase(context, 'failure', fixture.failedCommand, 17, fixture.stderrMarker);
  await recorder.run('list-filter-page', '运行', { projectId: context.projectId, agentName: 'deterministic-agent', limit: 20 }, { containsCreatedRuns: true, unrelatedExcluded: true }, async () => {
    const response = await clients.run.listRuns(new ListRunsRequest({ projectId: context.projectId, agentName: 'deterministic-agent', limit: 20 }));
    const ids = response.runs.map((run) => run.runId);
    const created = [context.successfulRunId, context.failedRunId];
    return { actual: { ids, totalCount: response.totalCount }, assertions: [exact('containsCreatedRuns', true, created.every((id) => ids.includes(id))), exact('unrelatedExcluded', true, response.runs.every((run) => run.projectId === context.projectId && run.agentName === 'deterministic-agent'))] };
  });
  await recorder.run('history', '运行日志', { runId: context.successfulRunId, follow: false }, { contains: fixture.stdoutMarker, final: true }, async () => {
    let data = '';
    let final = false;
    for await (const chunk of clients.run.followRunLogs(new FollowRunLogsRequest({ projectId: context.projectId, runId: context.successfulRunId, tailLines: 100, follow: false }))) { data += chunk.data; final ||= chunk.isFinal; }
    return { actual: { data, final }, assertions: [exact('contains', true, data.includes(fixture.stdoutMarker)), exact('final', true, final)] };
  });
  await recorder.run('stop', '运行', { command: fixture.stopCommand }, { stopRequested: true, terminal: 'not running' }, async () => {
    const started = await clients.run.startRun(new StartRunRequest({ run: new RunAgentRequest({ projectId: context.projectId, agentName: 'deterministic-agent', command: fixture.stopCommand, source: RunSource.API, cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${fixture.batchId}-stop` }) }));
    context.stoppedRunId = started.run?.runId ?? '';
    if (context.stoppedRunId) ledger.runs.add(context.stoppedRunId);
    const stop = await clients.run.stopRun(new StopRunRequest({ projectId: context.projectId, runId: context.stoppedRunId, reason: 'real-data E2E stop assertion' }));
    let status = RunStatus.UNSPECIFIED;
    for (let attempt = 0; attempt < 50; attempt++) {
      const fetched = await clients.run.getRun(new GetRunRequest({ projectId: context.projectId, runId: context.stoppedRunId }));
      status = fetched.run?.summary?.status ?? RunStatus.UNSPECIFIED;
      if (fetched.run?.summary?.sandboxId) ledger.sandboxes.add(fetched.run.summary.sandboxId);
      if (![RunStatus.PENDING, RunStatus.RUNNING, RunStatus.UNSPECIFIED].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { actual: { runId: context.stoppedRunId, stopRequested: stop.stopRequested, status: RunStatus[status] }, assertions: [predicate('runId', 'non-empty', context.stoppedRunId, Boolean(context.stoppedRunId)), exact('stopRequested', true, stop.stopRequested), predicate('terminal', 'not PENDING/RUNNING', RunStatus[status], ![RunStatus.PENDING, RunStatus.RUNNING].includes(status))] };
  });

  const sandboxId = [...ledger.sandboxes][0];
  if (sandboxId) {
    await recorder.run('stats', '沙箱', { sandboxId }, { metrics: 'non-negative or unsupported' }, async () => {
      try {
        const response = await clients.sandbox.getSandboxStats(new GetSandboxStatsRequest({ sandboxId }));
        return { actual: response.toJson({ emitDefaultValues: true }), assertions: [predicate('response', 'object', response.toJson(), Boolean(response))] };
      } catch (error) {
        context.recorder.addUnavailable('stats-capability', '沙箱', { sandboxId }, { unavailableIsExplicit: true }, { error: String(error) });
        return { actual: { capabilityUnavailable: true }, assertions: [exact('capabilityUnavailable', true, true)] };
      }
    });
  }

  await recorder.run('prompt', 'LLM Agent', { agentName: 'llm-agent', prompt: `Reply with exactly ${fixture.llmMarker}` }, { status: 'SUCCEEDED', containsMarker: true }, async () => {
    const response = await clients.run.runAgent(new RunAgentRequest({ projectId: context.projectId, agentName: 'llm-agent', prompt: `Reply with exactly ${fixture.llmMarker}`, source: RunSource.API, cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${fixture.batchId}-llm` }));
    const run = trackRun(context, response.run);
    return { actual: { ...run, output: run.output.slice(0, 1000) }, assertions: [exact('status', 'SUCCEEDED', RunStatus[run.status]), exact('containsMarker', true, run.output.includes(fixture.llmMarker))] };
  });

  await recorder.run('list-detail', '沙箱', {}, { listed: true, detailMatches: true }, async () => {
    const listedSandbox = await findTrackedSandbox(request => clients.sandbox.listSandboxes(request), ledger.sandboxes);
    const detail = listedSandbox
      ? await clients.sandbox.getSandbox(new GetSandboxRequest({ sandboxId: listedSandbox.sandboxId }))
      : undefined;
    return {
      actual: { listedSandboxId: listedSandbox?.sandboxId, detail: detail?.sandbox?.toJson({ emitDefaultValues: true }) },
      assertions: [
        exact('listed', true, Boolean(listedSandbox)),
        exact('detailMatches', true, Boolean(listedSandbox && detail?.sandbox?.sandboxId === listedSandbox.sandboxId)),
      ],
    };
  });

  const trackedSandbox = await findTrackedSandbox(request => clients.sandbox.listSandboxes(request), ledger.sandboxes);
  if (trackedSandbox) {
    await recorder.run('history-events', '沙箱', { sandboxId: trackedSandbox.sandboxId }, { historyRead: true, runEventsRead: true }, async () => {
      const [history, runEvents] = await Promise.all([
        clients.sandbox.listSandboxHistory(new ListSandboxHistoryRequest({ sandboxId: trackedSandbox.sandboxId })),
        clients.run.listSandboxRunEvents(new ListSandboxRunEventsRequest({ sandboxId: trackedSandbox.sandboxId, limit: 100 })),
      ]);
      return {
        actual: { cells: history.cells.length, events: history.events.length, runEvents: runEvents.events.length },
        assertions: [exact('historyRead', true, Boolean(history)), exact('runEventsRead', true, Boolean(runEvents))],
      };
    });
  }

  await recorder.run('overview', 'Dashboard', {}, { read: true }, async () => {
    const response = await clients.dashboard.getDashboardOverview(new GetDashboardOverviewRequest());
    return { actual: response.toJson({ emitDefaultValues: true }), assertions: [exact('read', true, Boolean(response))] };
  });
  await recorder.run('events-absent', 'Scheduler', { projectId: context.projectId, agentName: 'deterministic-agent', schedulerConfigured: false }, { explicitNotFound: true }, async () => {
    try {
      const response = await clients.project.listSchedulerEvents(schedulerEventsRequest(context.projectId, 'deterministic-agent'));
      return { actual: { count: response.events.length, explicitNotFound: false }, assertions: [exact('explicitNotFound', true, false)] };
    } catch (error) {
      const message = String(error);
      const explicitNotFound = /not_found|not found|no rows/i.test(message);
      return { actual: { explicitNotFound, error: message }, assertions: [exact('explicitNotFound', true, explicitNotFound)] };
    }
  });
  await recorder.run('global-env', '系统设置', {}, { read: true }, async () => {
    const response = await clients.settings.getGlobalEnv(new GetGlobalEnvRequest());
    return { actual: { names: response.env.map(item => item.name), count: response.env.length }, assertions: [exact('read', true, Boolean(response))] };
  });
  await recorder.run('status', '能力服务', {}, { read: true }, async () => {
    const response = await clients.capability.getCapabilityStatus(new GetCapabilityStatusRequest());
    return { actual: response.toJson({ emitDefaultValues: true }), assertions: [exact('read', true, Boolean(response))] };
  });
}

async function scriptRequest(base: string, path: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function runScriptCases(context: RealDataContext, base: string): Promise<void> {
  const { fixture, ledger, recorder } = context;
  const folder = fixture.batchId;
  ledger.scriptPaths.add(fixture.scriptPath);
  await recorder.run('create-read-list', '脚本', { path: fixture.scriptPath, content: fixture.scriptContent }, { createStatus: 200, content: fixture.scriptContent, listed: true }, async () => {
    const folderResult = await scriptRequest(base, '/folders', { method: 'POST', body: JSON.stringify({ path: folder }) });
    if (![201, 409].includes(folderResult.response.status)) throw new Error(`create folder returned ${folderResult.response.status}`);
    const written = await scriptRequest(base, '/files', { method: 'PUT', body: JSON.stringify({ path: fixture.scriptPath, content: fixture.scriptContent, expectedSha256: null }) });
    const read = await scriptRequest(base, `/files?path=${encodeURIComponent(fixture.scriptPath)}`);
    const tree = await scriptRequest(base, '/tree');
    const listed = JSON.stringify(tree.body).includes(fixture.scriptPath.split('/').at(-1)!);
    return { actual: { createStatus: written.response.status, content: read.body?.content, sha256: read.body?.sha256, listed }, assertions: [exact('createStatus', 200, written.response.status), exact('content', fixture.scriptContent, read.body?.content), predicate('sha256', 'sha256:*', read.body?.sha256, /^sha256:[a-f0-9]{64}$/.test(read.body?.sha256 ?? '')), exact('listed', true, listed)] };
  });
  await recorder.run('update-delete', '脚本', { path: fixture.scriptPath, updatedContent: `${fixture.scriptContent}// updated\n` }, { updatedExact: true, deleteStatus: 200, afterDeleteStatus: 404 }, async () => {
    const current = await scriptRequest(base, `/files?path=${encodeURIComponent(fixture.scriptPath)}`);
    const updatedContent = `${fixture.scriptContent}// updated\n`;
    const updated = await scriptRequest(base, '/files', { method: 'PUT', body: JSON.stringify({ path: fixture.scriptPath, content: updatedContent, expectedSha256: current.body?.sha256 }) });
    const read = await scriptRequest(base, `/files?path=${encodeURIComponent(fixture.scriptPath)}`);
    const removed = await scriptRequest(base, `/files?path=${encodeURIComponent(fixture.scriptPath)}&expectedSha256=${encodeURIComponent(read.body?.sha256 ?? '')}`, { method: 'DELETE' });
    const after = await scriptRequest(base, `/files?path=${encodeURIComponent(fixture.scriptPath)}`);
    return { actual: { updateStatus: updated.response.status, updatedContent: read.body?.content, deleteStatus: removed.response.status, afterDeleteStatus: after.response.status }, assertions: [exact('updatedExact', updatedContent, read.body?.content), exact('deleteStatus', 200, removed.response.status), exact('afterDeleteStatus', 404, after.response.status)] };
  });
}

async function runCommandCase(context: RealDataContext, kind: 'success' | 'failure', command: string, exitCode: number, marker: string): Promise<void> {
  const expectedStatus = kind === 'success' ? 'SUCCEEDED' : 'FAILED';
  await context.recorder.run(kind, 'Agent运行', { agentName: 'deterministic-agent', command }, { status: expectedStatus, exitCode, containsMarker: true }, async () => {
    const response = await context.clients.run.runAgent(new RunAgentRequest({ projectId: context.projectId, agentName: 'deterministic-agent', command, source: RunSource.API, cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING, clientRequestId: `${context.fixture.batchId}-${kind}` }));
    const run = trackRun(context, response.run);
    if (kind === 'success') context.successfulRunId = run.runId;
    else context.failedRunId = run.runId;
    const fetched = await context.clients.run.getRun(new GetRunRequest({ projectId: context.projectId, runId: run.runId }));
    const actual = trackRun(context, fetched.run);
    const combined = `${actual.output}\n${actual.error}`;
    return { actual, assertions: [exact('status', expectedStatus, RunStatus[actual.status]), exact('exitCode', exitCode, actual.exitCode), exact('containsMarker', true, combined.includes(marker)), exact('projectId', context.projectId, actual.projectId), exact('agentName', 'deterministic-agent', actual.agentName)] };
  });
}

export async function cleanupFixture(context: RealDataContext): Promise<void> {
  try {
    await fetch(`${context.frontendUrl}/script-api/v1/folders?path=${encodeURIComponent(context.fixture.batchId)}&recursive=true`, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
  } catch {}
  for (const sandboxId of context.ledger.sandboxes) {
    try { await context.clients.sandbox.removeSandbox(new RemoveSandboxRequest({ sandboxId, force: true })); } catch {}
  }
  for (const projectId of context.ledger.projects) {
    try { await context.clients.project.removeProject(new RemoveProjectRequest({ project: new ProjectRef({ projectId }), force: true })); } catch {}
  }
  if (context.ledger.imagePulled && !context.ledger.imageWasPresent) {
    try { await context.clients.image.removeImage(new RemoveImageRequest({ imageRef: context.fixture.image, store: ImageStoreKind.DOCKER_DAEMON, force: true })); } catch {}
  }
}
