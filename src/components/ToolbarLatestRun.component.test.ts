import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectChangeAction, RunStatus } from '../gen/agentcompose/v2/agentcompose_pb';
import { yamlRunBatches } from '../lib/yaml-run-batch.svelte';
import Toolbar from './Toolbar.svelte';

const mocks = vi.hoisted(() => ({
  store: {
    activeProjectId: 'p1', editorContent: 'yaml', projects: [{ summary: { projectId: 'p1', name: 'P1', sourcePath: '' } }],
    runtimeView: { level: 'agents' }, toasts: [] as unknown[], runtimeRefreshVersion: 0,
    navigateTo: vi.fn((level: string) => { mocks.store.runtimeView = { level }; }),
    addToast: vi.fn(), triggerRuntimeRefresh: vi.fn(), syncHash: vi.fn(), saveEditorDraft: vi.fn(), removeEditorDraft: vi.fn(),
  },
  startRun: vi.fn(),
  softPauseProject: vi.fn(),
  probeProjectRuntimeActivity: vi.fn(),
  stopProjectRuns: vi.fn(),
  getProject: vi.fn(),
  getScheduler: vi.fn(),
  listSchedulers: vi.fn(),
  setSchedulerEnabled: vi.fn(),
  listSchedulerRuns: vi.fn(),
  stopSchedulerRun: vi.fn(),
  listRuns: vi.fn(),
  stopRun: vi.fn(),
  listSandboxes: vi.fn(),
  stopSandbox: vi.fn(),
  runCalls: [] as Array<any>,
  currentSpec: { name: 'P1', agents: [{ name: 'a', systemPrompt: 'A' }, { name: 'b', systemPrompt: 'B' }] } as any,
  savedSpec: { name: 'P1', agents: [] } as any,
  buildPlans: [] as Array<any>,
  changedBuildAgents: new Set<string>(),
  runProjectImageBuildPlans: vi.fn(),
  checkProjectDependencies: vi.fn(),
  previewResponse: { changes: [] as Array<any>, issues: [] as Array<any>, unchanged: true },
  applyResponse: { applied: true, project: { summary: { projectId: 'p1' } }, changes: [] as Array<any> },
}));

vi.mock('../lib/stores.svelte', () => ({ store: mocks.store }));
vi.mock('../lib/rpc', () => ({
  projectService: { getProject: mocks.getProject, getScheduler: mocks.getScheduler, listSchedulers: mocks.listSchedulers, setSchedulerEnabled: mocks.setSchedulerEnabled, listSchedulerRuns: mocks.listSchedulerRuns, stopSchedulerRun: mocks.stopSchedulerRun }, imageService: {},
  capabilityService: {},
  runService: { startRun: mocks.startRun, followRunLogs: vi.fn(), listRuns: mocks.listRuns, stopRun: mocks.stopRun },
  sandboxService: { listSandboxes: mocks.listSandboxes, stopSandbox: mocks.stopSandbox },
}));
vi.mock('../lib/project-dependency-preflight', () => ({ checkProjectDependencies: mocks.checkProjectDependencies }));
vi.mock('../lib/yaml', () => ({ yamlToSpec: () => ({ spec: mocks.currentSpec }) }));
vi.mock('../lib/scripts/api', () => ({ scriptApi: { readFile: vi.fn(), ensureProject: vi.fn(), writeManifest: vi.fn() }, scriptErrorMessage: (error: unknown) => String(error) }));
vi.mock('../lib/scripts/workspace.svelte', () => ({ scriptWorkspace: { tree: [], files: new Map(), panelOpen: false } }));
vi.mock('../lib/scripts/tree', () => ({ countScriptFiles: () => 0 }));
vi.mock('../lib/scripts/request-pipeline', () => ({ prepareScriptRequest: vi.fn() }));
vi.mock('../lib/scripts/project-lifecycle', () => ({ canonicalProjectId: (id: string) => id }));
vi.mock('../lib/project-image-build', () => ({
  changedBuildAgentNames: () => mocks.changedBuildAgents,
  createProjectImageBuildPlans: () => mocks.buildPlans,
  ProjectImageBuildRunError: class extends Error {},
  runProjectImageBuildPlans: mocks.runProjectImageBuildPlans,
}));
vi.mock('../lib/toolbar-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/toolbar-actions')>();
  return {
    ...actual,
    softPauseProject: mocks.softPauseProject,
    probeProjectRuntimeActivity: mocks.probeProjectRuntimeActivity,
    stopProjectRuns: mocks.stopProjectRuns,
    prepareProjectPreview: vi.fn(async (options: any) => {
      const prepared = { yamlText: 'yaml', references: [] };
      await options.preflight?.(prepared);
      return {
      currentProjectId: 'p1', editorContent: 'yaml', prepared, generation: 0,
      response: mocks.previewResponse,
      apply: async () => ({ response: mocks.applyResponse, agentNames: ['a', 'b'], agents: [{ name: 'a', prompt: 'A', hasScheduler: false }, { name: 'b', prompt: 'B', hasScheduler: false }], supersededProjectId: '' }),
    }; }),
    runYamlBatch: vi.fn((options: any) => {
      mocks.runCalls.push(options);
      options.onStarting('a');
      return new Promise<void>(() => {});
    }),
  };
});

async function applyAndRun() {
  await fireEvent.click(hiddenRunButton());
  await fireEvent.click(await screen.findByRole('button', { name: '启用并运行' }));
  await waitFor(() => expect(mocks.runCalls.length).toBeGreaterThan(0));
}

function hiddenRunButton(): HTMLButtonElement {
  const button = screen.getByText('运行', { selector: 'button' });
  return button as HTMLButtonElement;
}

function hiddenStopAllButton(): HTMLButtonElement {
  const button = screen.getByText('停止全部', { selector: 'button' });
  return button as HTMLButtonElement;
}

function hiddenPauseButton(label = '暂停'): HTMLButtonElement {
  return screen.getByText(label, { selector: 'button' }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.saveEditorDraft.mockReturnValue({ ok: true, draft: null });
  mocks.runCalls.length = 0;
  mocks.store.activeProjectId = 'p1';
  mocks.store.runtimeView = { level: 'agents' };
  mocks.store.projects = [{ summary: { projectId: 'p1', name: 'P1', sourcePath: '/srv/p1/agent-compose.yml' } }];
  mocks.currentSpec = { name: 'P1', agents: [{ name: 'a', systemPrompt: 'A' }, { name: 'b', systemPrompt: 'B' }] };
  mocks.savedSpec = { name: 'P1', agents: [] };
  mocks.buildPlans = [];
  mocks.changedBuildAgents = new Set();
  mocks.runProjectImageBuildPlans.mockResolvedValue([]);
  mocks.checkProjectDependencies.mockResolvedValue({ warnings: [] });
  mocks.getProject.mockResolvedValue({ project: { spec: mocks.savedSpec } });
  mocks.previewResponse = { changes: [], issues: [], unchanged: true };
  mocks.applyResponse = { applied: true, project: { summary: { projectId: 'p1' } }, changes: [] };
  mocks.softPauseProject.mockResolvedValue({
    schedulers: { attempted: 1, succeeded: 1, failed: 0, errors: [] },
    schedulerRuns: { attempted: 1, succeeded: 1, failed: 0, errors: [] },
    runs: { attempted: 1, succeeded: 1, failed: 0, errors: [] },
    sandboxes: { attempted: 1, succeeded: 1, failed: 0, errors: [] },
    failed: 0,
  });
  mocks.probeProjectRuntimeActivity.mockResolvedValue({ scheduler: true, run: false, sandbox: false, active: true });
  mocks.stopProjectRuns.mockResolvedValue({ attempted: 1, stopped: 1, failed: 0 });
  delete (window as any).__refreshProjects;
  yamlRunBatches.clearProject('p1');
  yamlRunBatches.clearProject('p2');
});

test('does not render an operation rail in the confirmation dialog', async () => {
  mocks.buildPlans = [];
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  expect(screen.queryByLabelText('执行顺序')).toBeNull();
});

test('saves a browser draft without starting the enable preview', async () => {
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

  expect(mocks.store.saveEditorDraft).toHaveBeenCalledTimes(1);
  expect(mocks.store.addToast).toHaveBeenCalledWith('草稿已保存到此浏览器', 'success');
  expect(screen.queryByText('确认本次变更')).not.toBeInTheDocument();
});

test('rejects saving a browser draft with a duplicate draft name', async () => {
  mocks.store.saveEditorDraft.mockReturnValueOnce({ ok: false, reason: 'duplicate-name', name: '重复草稿' });
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

  expect(mocks.store.addToast).toHaveBeenCalledWith('草稿名称 "重复草稿" 已存在', 'error');
  expect(mocks.store.addToast).not.toHaveBeenCalledWith('草稿已保存到此浏览器', 'success');
});

test('defaults to skipping image builds when no build configuration changed', async () => {
  mocks.buildPlans = [{ agentName: 'reviewer', imageRef: 'reviewer:dev', contextDisplay: '.', dockerfile: 'Dockerfile', request: {}, error: '' }];
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  expect(await screen.findByRole('radio', { name: /仅应用配置，不构建镜像/ })).toBeChecked();
  expect(screen.getByText('确认启用后，当前配置将覆盖上次启用的版本。')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /reviewer/ })).toBeNull();
});

test('build mode hides image details, exposes build options, and builds every valid YAML image', async () => {
  mocks.buildPlans = [
    { agentName: 'reviewer', imageRef: 'reviewer:dev', contextDisplay: '.', dockerfile: 'Dockerfile', request: {}, error: '' },
    { agentName: 'writer', imageRef: 'writer:dev', contextDisplay: '.', dockerfile: 'Dockerfile', request: {}, error: '' },
  ];
  mocks.changedBuildAgents = new Set(['writer']);
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  expect(await screen.findByRole('radio', { name: /构建 YAML 中配置的镜像/ })).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: /reviewer/ })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /writer/ })).toBeNull();
  expect(screen.getByRole('checkbox', { name: '不使用缓存' })).toBeVisible();
  expect(screen.getByRole('checkbox', { name: '拉取最新基础镜像' })).toBeVisible();
  expect(document.querySelector('.build-options')?.tagName).toBe('DIV');

  await fireEvent.click(screen.getByRole('button', { name: '构建并启用' }));
  await waitFor(() => expect(mocks.runProjectImageBuildPlans).toHaveBeenCalled());
  expect(mocks.runProjectImageBuildPlans.mock.calls[0][0].selectedAgentNames).toEqual(new Set(['reviewer', 'writer']));
});

test('keeps changed content in a dedicated scrolling list', async () => {
  mocks.previewResponse = {
    changes: Array.from({ length: 14 }, (_, index) => ({
      action: ProjectChangeAction.CREATED,
      resourceType: 'agent',
      name: `agent-${index + 1}`,
    })),
    issues: [],
    unchanged: false,
  };
  const view = render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  await waitFor(() => expect(view.container.querySelector('.change-list.changed-scroll')).toBeInTheDocument());
});

test('counts only actual changes in the toolbar while retaining unchanged preview details', async () => {
  mocks.previewResponse = {
    changes: Array.from({ length: 13 }, (_, index) => ({
      action: ProjectChangeAction.UNCHANGED,
      resourceType: 'agent',
      name: `agent-${index + 1}`,
    })),
    issues: [],
    unchanged: true,
  };
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  expect(await screen.findByRole('button', { name: '变更 (0)' })).toBeEnabled();
  expect(screen.getByText('未变更内容')).toBeInTheDocument();
  expect(screen.getByText('13 项')).toBeInTheDocument();
});

test('clears completed Apply records from the pending change button after save', async () => {
  mocks.previewResponse = { changes: [], issues: [], unchanged: true };
  mocks.applyResponse = {
    applied: true,
    project: { summary: { projectId: 'p1' } },
    changes: Array.from({ length: 3 }, (_, index) => ({
      action: ProjectChangeAction.CREATED,
      resourceType: 'agent',
      name: `applied-${index + 1}`,
    })),
  };
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await fireEvent.click(await screen.findByRole('button', { name: '确认启用' }));

  await waitFor(() => expect(screen.getByRole('button', { name: '变更 (0)' })).toBeDisabled());
});

test('shows 启用成功 after Apply succeeds', async () => {
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await fireEvent.click(await screen.findByRole('button', { name: '确认启用' }));

  await waitFor(() => expect(mocks.store.addToast).toHaveBeenCalledWith('启用成功', 'success'));
});

test('removes a new-project browser draft only after Apply succeeds', async () => {
  const toolbarActions = await import('../lib/toolbar-actions');
  vi.mocked(toolbarActions.prepareProjectPreview).mockResolvedValueOnce({
    currentProjectId: '', editorContent: 'yaml', prepared: { yamlText: 'yaml', references: [] },
    response: mocks.previewResponse,
    apply: async () => ({ ...mocks.applyResponse, response: mocks.applyResponse, agentNames: [], agents: [], supersededProjectId: '' }),
  } as any);
  mocks.applyResponse = { applied: true, project: { summary: { projectId: 'new-project' } }, changes: [] };
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await fireEvent.click(await screen.findByRole('button', { name: '确认启用' }));

  await waitFor(() => expect(mocks.store.removeEditorDraft).toHaveBeenCalledTimes(1));
});

test('creates and opens the batch before starting the first Agent without locking the toolbar on the stream', async () => {
  render(Toolbar);
  await applyAndRun();
  expect(mocks.store.runtimeView.level).toBe('latest-run');
  expect(yamlRunBatches.current('p1')?.agents.map((agent) => agent.agentName)).toEqual(['a', 'b']);
  expect(mocks.runCalls[0].client.startRun).toBe(mocks.startRun);
  expect(hiddenRunButton()).not.toBeDisabled();
});

test('refreshes runtime and projects as soon as the first run starts while follow remains deferred', async () => {
  const refreshProjects = vi.fn().mockResolvedValue(undefined);
  (window as any).__refreshProjects = refreshProjects;
  render(Toolbar);
  await applyAndRun();
  refreshProjects.mockClear();
  mocks.store.triggerRuntimeRefresh.mockClear();

  mocks.runCalls[0].onStarted('a', { runId: 'run-a', status: RunStatus.RUNNING });

  await waitFor(() => expect(refreshProjects).toHaveBeenCalledOnce());
  expect(mocks.store.triggerRuntimeRefresh).toHaveBeenCalledOnce();
  expect(yamlRunBatches.current('p1')?.agents).toMatchObject([
    { agentName: 'a', runId: 'run-a', status: 'running' },
    { agentName: 'b', runId: '', status: 'waiting' },
  ]);
});

test('does not duplicate the latest-run entry in the toolbar', async () => {
  yamlRunBatches.create('p1', [{ name: 'a', prompt: '' }, { name: 'b', prompt: '' }], 'active');
  render(Toolbar);
  expect(screen.queryByRole('button', { name: /运行中监控|最近运行结果/ })).toBeNull();
  expect(mocks.runCalls).toHaveLength(0);
  expect(mocks.startRun).not.toHaveBeenCalled();
});

test('a second batch aborts the first and stale callbacks cannot mutate the replacement', async () => {
  const view = render(Toolbar);
  await applyAndRun();
  const first = mocks.runCalls[0];
  const firstBatchId = yamlRunBatches.current('p1')?.batchId;
  view.unmount();
  render(Toolbar);
  await applyAndRun();
  const secondBatch = yamlRunBatches.current('p1');
  expect(secondBatch?.batchId).not.toBe(firstBatchId);
  expect(first.signal.aborted).toBe(true);
  first.onStarted('a', { runId: 'stale', status: RunStatus.RUNNING });
  first.onChunk('a', { runStatus: RunStatus.SUCCEEDED, isFinal: true });
  expect(yamlRunBatches.current('p1')).toEqual(secondBatch);
});

test('does not expose another project batch', async () => {
  yamlRunBatches.create('p2', [{ name: 'other', prompt: '' }], 'other');
  render(Toolbar);
  expect(screen.queryByRole('button', { name: /运行中监控|最近运行结果/ })).toBeNull();
});

test('does not restore a persisted batch into a duplicate toolbar entry', async () => {
  const projectId = 'persisted-only';
  mocks.store.activeProjectId = projectId;
  localStorage.setItem(`agent-compose:yaml-run:${projectId}`, JSON.stringify({
    version: 1,
    batchId: 'persisted',
    projectId,
    startedAt: '2026-07-15T00:00:00Z',
    completedAt: 'done',
    agents: [{ agentName: 'a', prompt: '', runId: 'run-a', status: 'succeeded', startError: '' }],
  }));

  expect(() => render(Toolbar)).not.toThrow();
  expect(screen.queryByRole('button', { name: '最近运行结果' })).toBeNull();
});

test('shows Pause in the YAML toolbar', () => {
  render(Toolbar);

  expect(screen.getAllByRole('button').slice(0, 5).map((button) => button.textContent?.trim())).toEqual([
    '校验', '变更 (0)', '保存草稿', '启用', '暂停',
  ]);
  expect(hiddenPauseButton()).toBeVisible();
});

test('keeps Run in the DOM but hides it from the YAML toolbar', () => {
  render(Toolbar);

  expect(hiddenRunButton()).not.toBeVisible();
});

test('keeps Stop All in the DOM but hides it from the YAML toolbar', () => {
  render(Toolbar);

  expect(hiddenStopAllButton()).not.toBeVisible();
});

test('disables Pause when live Scheduler, Run, and Sandbox state is inactive', async () => {
  mocks.probeProjectRuntimeActivity.mockResolvedValueOnce({ scheduler: false, run: false, sandbox: false, active: false });
  render(Toolbar);

  await waitFor(() => expect(mocks.probeProjectRuntimeActivity).toHaveBeenCalled());
  expect(hiddenPauseButton()).toBeDisabled();
});

test('shows the Enable busy label while preparing the project preview', async () => {
  let finishPreview!: (value: any) => void;
  const toolbarActions = await import('../lib/toolbar-actions');
  vi.mocked(toolbarActions.prepareProjectPreview).mockImplementationOnce(
    () => new Promise((resolve) => { finishPreview = resolve; }),
  );
  render(Toolbar);

  await fireEvent.click(screen.getByRole('button', { name: '启用' }));

  expect(screen.getByRole('button', { name: '启用中…' })).toBeDisabled();
  finishPreview(undefined);
  await waitFor(() => expect(screen.getByRole('button', { name: '启用' })).toBeEnabled());
});

test('allows closing the confirmation dialog by aborting an in-flight Apply request', async () => {
  const toolbarActions = await import('../lib/toolbar-actions');
  vi.mocked(toolbarActions.prepareProjectPreview).mockResolvedValueOnce({
    currentProjectId: 'p1', editorContent: 'yaml', prepared: { yamlText: 'yaml', references: [] },
    response: mocks.previewResponse, generation: 0,
    apply: (signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  } as any);
  render(Toolbar);
  await fireEvent.click(screen.getByRole('button', { name: '启用' }));
  await fireEvent.click(await screen.findByRole('button', { name: '确认启用' }));

  const applying = screen.getByRole('dialog').querySelector('.diff-footer .btn-primary') as HTMLButtonElement;
  expect(applying).toHaveAccessibleName('启用中…');
  expect(applying).toBeDisabled();
  expect(applying.querySelector('.loading-spinner')).toBeInTheDocument();
  const close = screen.getByRole('button', { name: '关闭变更记录' });
  expect(close).toBeEnabled();
  await fireEvent.click(close);

  await waitFor(() => expect(screen.queryByText('确认本次变更')).not.toBeInTheDocument());
  expect(mocks.store.addToast).not.toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error');
});

test('pauses the captured active project through Scheduler, Run, and Sandbox clients', async () => {
  render(Toolbar);

  expect(hiddenPauseButton()).toBeVisible();
  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
  await fireEvent.click(hiddenPauseButton());

  await waitFor(() => expect(mocks.softPauseProject).toHaveBeenCalledOnce());
  expect(mocks.softPauseProject).toHaveBeenCalledWith({
    projectId: 'p1',
    client: {
      listSchedulers: mocks.listSchedulers,
      getScheduler: mocks.getScheduler,
      setSchedulerEnabled: mocks.setSchedulerEnabled,
      listSchedulerRuns: mocks.listSchedulerRuns,
      stopSchedulerRun: mocks.stopSchedulerRun,
      listRuns: mocks.listRuns,
      stopRun: mocks.stopRun,
      listSandboxes: mocks.listSandboxes,
      stopSandbox: mocks.stopSandbox,
    },
  });
});

test('disables all mutating controls while Pause is active', async () => {
  let finishPause!: (value: any) => void;
  mocks.softPauseProject.mockImplementationOnce(() => new Promise((resolve) => { finishPause = resolve; }));
  render(Toolbar);

  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
  await fireEvent.click(hiddenPauseButton());

  expect(screen.getByRole('button', { name: '启用' })).toBeDisabled();
  expect(hiddenRunButton()).toBeDisabled();
  expect(hiddenPauseButton('暂停中...')).toBeDisabled();
  expect(hiddenStopAllButton()).toBeDisabled();
  finishPause({
    schedulers: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    runs: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    sandboxes: { attempted: 0, succeeded: 0, failed: 0, errors: [] },
    failed: 0,
  });
  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
});

test('reports successful Pause and refreshes runtime and projects', async () => {
  const refreshProjects = vi.fn().mockResolvedValue(undefined);
  (window as any).__refreshProjects = refreshProjects;
  render(Toolbar);

  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
  await fireEvent.click(hiddenPauseButton());

  await waitFor(() => expect(mocks.store.addToast).toHaveBeenCalledWith('项目已暂停', 'success'));
  expect(mocks.store.triggerRuntimeRefresh).toHaveBeenCalledOnce();
  expect(refreshProjects).toHaveBeenCalledOnce();
});

test('cannot pause repeatedly after refreshed live state is inactive', async () => {
  mocks.probeProjectRuntimeActivity
    .mockResolvedValueOnce({ scheduler: true, run: false, sandbox: false, active: true })
    .mockResolvedValue({ scheduler: false, run: false, sandbox: false, active: false });
  render(Toolbar);

  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
  await fireEvent.click(hiddenPauseButton());
  await waitFor(() => expect(hiddenPauseButton()).toBeDisabled());
  await fireEvent.click(hiddenPauseButton());

  expect(mocks.softPauseProject).toHaveBeenCalledTimes(1);
});

test('reports per-stage counts when Pause is only partially successful', async () => {
  mocks.softPauseProject.mockResolvedValueOnce({
    schedulers: { attempted: 3, succeeded: 2, failed: 1, errors: ['scheduler failed'] },
    schedulerRuns: { attempted: 2, succeeded: 1, failed: 1, errors: ['scheduler run failed'] },
    runs: { attempted: 4, succeeded: 3, failed: 1, errors: [] },
    sandboxes: { attempted: 2, succeeded: 0, failed: 2, errors: ['sandbox failed'] },
    failed: 4,
  });
  render(Toolbar);

  await waitFor(() => expect(hiddenPauseButton()).toBeEnabled());
  await fireEvent.click(hiddenPauseButton());

  await waitFor(() => expect(mocks.store.addToast).toHaveBeenCalledWith(
    expect.stringMatching(/Scheduler 2 成功\/1 失败.*Scheduler Run 1 成功\/1 失败.*Agent Run 3 成功\/1 失败.*Sandbox 0 成功\/2 失败/),
    'error',
  ));
});

test('keeps Stop All scoped to Run orchestration only', async () => {
  render(Toolbar);

  await fireEvent.click(hiddenStopAllButton());

  await waitFor(() => expect(mocks.stopProjectRuns).toHaveBeenCalledWith({ projectId: 'p1', client: expect.anything() }));
  expect(mocks.softPauseProject).not.toHaveBeenCalled();
  expect(mocks.listSchedulers).not.toHaveBeenCalled();
  expect(mocks.listSandboxes).not.toHaveBeenCalled();
});
