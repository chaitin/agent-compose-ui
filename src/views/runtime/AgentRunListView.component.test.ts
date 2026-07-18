import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import AgentRunListView from './AgentRunListView.svelte';
import { AgentSpec, Project, ProjectSpec, RunSource, RunStatus, RunSummary, SchedulerEvent, SchedulerSpec } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';
import { stableProjectRunId } from '../../lib/run-scheduler-evidence';

const mocks = vi.hoisted(() => ({ runService: { listRuns: vi.fn() }, projectService: { getProject: vi.fn(), listSchedulerEvents: vi.fn() }, sandboxService: { listSandboxes: vi.fn() } }));
vi.mock('../../lib/rpc', () => ({ runService: mocks.runService, projectService: mocks.projectService, sandboxService: mocks.sandboxService }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'project-1';
  store.runtimeView = { level: 'agent-detail', agentName: 'old-agent', runId: '', sessionId: '' };
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  mocks.projectService.getProject.mockResolvedValue({ project: new Project({
    spec: new ProjectSpec({ agents: [new AgentSpec({ name: 'old-agent', systemPrompt: 'configured prompt', scheduler: new SchedulerSpec({ enabled: true }) })] }),
  }) });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [], nextCursor: '' });
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [], nextCursor: '' });
});

test('opens manual run form with the selected Agent configuration', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  render(AgentRunListView);

  const manualRun = await screen.findByRole('button', { name: '手动运行' });
  expect(manualRun).toHaveClass('compact');
  await fireEvent.click(manualRun);

  expect(screen.getByRole('dialog', { name: '手动运行 old-agent' })).toBeInTheDocument();
  expect((screen.getByLabelText('运行内容') as HTMLTextAreaElement).value).toContain('configured prompt');
});

test('does not request Scheduler history for an Agent without Scheduler YAML', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({ runId: 'plain-run', agentName: 'old-agent' })] });
  mocks.projectService.getProject.mockResolvedValueOnce({ project: new Project({
    spec: new ProjectSpec({ agents: [new AgentSpec({ name: 'old-agent' })] }),
  }) });

  render(AgentRunListView);

  expect(await screen.findByText('plain-run')).toBeInTheDocument();
  expect(mocks.projectService.listSchedulerEvents).not.toHaveBeenCalled();
  expect(store.addToast).not.toHaveBeenCalledWith(expect.stringContaining('scheduler'), 'error');
});

test('shows a pure Scheduler command execution and opens its Scheduler detail', async () => {
  const navigate = vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'done', runId: 'loader-1', triggerId: 'cron', type: 'loader.run.completed', createdAt: { seconds: 2n } }),
    new SchedulerEvent({ id: 'command', runId: 'loader-1', triggerId: 'cron', type: 'loader.command.completed', message: '22 items', createdAt: { seconds: 1n } }),
    new SchedulerEvent({ id: 'start', runId: 'loader-1', triggerId: 'cron', type: 'loader.run.started', createdAt: { seconds: 0n } }),
  ], nextCursor: '' });

  render(AgentRunListView);

  expect(await screen.findByText('调度任务')).toBeTruthy();
  const row = screen.getByRole('button', { name: /调度任务.*成功/ });
  await fireEvent.click(row);
  expect(navigate).toHaveBeenCalledWith('scheduler-run-detail', { agentName: 'old-agent', runId: 'loader-1' });
});

test('renders task type and trigger source together without Scheduler capability badges', async () => {
  const linkedSchedulerRunId = 'scheduler-linked';
  const linkedProjectRunId = await stableProjectRunId('project-1', 'old-agent', 'scheduler', `${linkedSchedulerRunId}:agent:1`);
  mocks.runService.listRuns.mockResolvedValue({ runs: [
    new RunSummary({ runId: 'manual-run', source: RunSource.MANUAL, status: RunStatus.SUCCEEDED, startedAt: '2026-07-15T05:00:00Z' }),
    new RunSummary({ runId: 'api-run', source: RunSource.API, status: RunStatus.SUCCEEDED, startedAt: '2026-07-15T04:00:00Z' }),
    new RunSummary({ runId: linkedProjectRunId, source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED, startedAt: '2026-07-15T03:00:00Z' }),
    new RunSummary({ runId: 'unknown-run', source: RunSource.UNSPECIFIED, status: RunStatus.SUCCEEDED, startedAt: '2026-07-15T01:00:00Z' }),
  ] });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'linked-start', runId: linkedSchedulerRunId, type: 'loader.run.started', createdAt: { seconds: 3n } }),
    new SchedulerEvent({ id: 'linked-agent', runId: linkedSchedulerRunId, type: 'loader.agent.completed', createdAt: { seconds: 3n, nanos: 1 } }),
    new SchedulerEvent({ id: 'linked-done', runId: linkedSchedulerRunId, type: 'loader.run.completed', createdAt: { seconds: 4n } }),
    new SchedulerEvent({ id: 'pure-start', runId: 'scheduler-pure', type: 'loader.run.started', createdAt: { seconds: 1n } }),
    new SchedulerEvent({ id: 'pure-command', runId: 'scheduler-pure', type: 'loader.command.completed', createdAt: { seconds: 2n } }),
    new SchedulerEvent({ id: 'pure-sandbox', runId: 'scheduler-pure', type: 'loader.sandbox.created', createdAt: { seconds: 2n, nanos: 1 } }),
    new SchedulerEvent({ id: 'pure-done', runId: 'scheduler-pure', type: 'loader.run.completed', createdAt: { seconds: 3n } }),
  ], nextCursor: '' });

  render(AgentRunListView);

  expect(await screen.findByText('API 运行')).toBeTruthy();
  expect(screen.getAllByText('调度器运行')).toHaveLength(2);
  expect(screen.getByText('来源未知')).toBeTruthy();
  expect(Array.from(document.querySelectorAll('.run-source'), (source) => source.textContent)).toContain('手动运行');
  const apiSource = screen.getByText('API 运行');
  const apiHeading = apiSource.closest('.run-heading');
  const schedulerSource = screen.getAllByText('调度器运行')[1];
  const schedulerRow = schedulerSource.closest('.run');
  expect(apiHeading?.querySelector('.execution-type')?.textContent).toBe('Agent Run');
  expect(screen.getByRole('button', { name: /调度器 → Agent.*成功/ })).toBeTruthy();
  expect(schedulerSource.closest('.run-heading')?.querySelector('.execution-type')?.textContent).toBe('调度任务');
  expect(schedulerRow?.querySelector('.execution-capabilities')).toBeNull();
  expect(screen.queryByText('命令 / Sandbox')).toBeNull();
  expect(schedulerRow?.getAttribute('aria-label')).toBe('调度任务 调度器运行 成功');
});

test('keeps Scheduler history when Project Run loading fails', async () => {
  mocks.runService.listRuns.mockRejectedValue(new Error('project runs unavailable'));
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'started', runId: 'loader-only', type: 'loader.run.started', createdAt: { seconds: 1n } }),
  ], nextCursor: '' });

  render(AgentRunListView);

  expect(await screen.findByText('调度任务')).toBeTruthy();
  expect(store.addToast).toHaveBeenCalledWith('project runs unavailable', 'error');
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

test('isolates late list responses when the Agent changes', async () => {
  const old = deferred<{ runs: RunSummary[] }>();
  mocks.runService.listRuns.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ runs: [new RunSummary({ runId: 'new-run', agentName: 'new-agent' })] });
  render(AgentRunListView);
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'old-agent', offset: 0, limit: 51 })));
  store.runtimeView = { level: 'agent-detail', agentName: 'new-agent', runId: '', sessionId: '' };
  expect(await screen.findByText('new-run')).toBeTruthy();
  old.resolve({ runs: [new RunSummary({ runId: 'old-run' })] });
  await old.promise;
  await Promise.resolve();
  expect(screen.queryByText('old-run')).toBeNull();
});

test('retains the Sandbox history action in hidden DOM state', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  render(AgentRunListView);

  await screen.findByRole('navigation', { name: '页面路径' });
  const sandbox = screen.getAllByRole('button', { hidden: true })
    .find((button) => button.getAttribute('aria-label') === 'Sandbox 清单');
  expect(sandbox).toBeInTheDocument();
  expect(sandbox).not.toBeVisible();
});

test('shows completed run diagnostics and navigates with the full run ID', async () => {
  const navigate = vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  const runId = '7225ac53d21bfdc9b6dac5a18b7df32da0b41e40be7b43a91047705e697e5c98';
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({
    runId,
    runShortId: '7225ac53d21b',
    status: RunStatus.SUCCEEDED,
    startedAt: '2026-07-15T02:03:09.736Z',
    completedAt: '2026-07-15T02:03:11.236Z',
    durationMs: 1500n,
    exitCode: 0,
    warnings: ['cache fallback'],
  })] });

  render(AgentRunListView);

  const row = await screen.findByRole('button', { name: /成功/ });
  const grid = row.querySelector('.diagnostic-grid');
  expect(Array.from(grid?.children ?? [], (item) => item.getAttribute('data-field'))).toEqual([
    'started-at', 'run-id', 'exit-code', 'completed-at', 'duration', 'warnings',
  ]);
  expect(row.querySelector('.status')?.nextElementSibling).toHaveClass('arrow');
  expect(row.getAttribute('title')).toContain(runId);
  expect(screen.getByText('7225ac53d21b')).toBeTruthy();
  expect(screen.getByText('1.5s')).toBeTruthy();
  expect(screen.getByText('退出码 0')).toBeTruthy();
  expect(screen.getByText('告警 1')).toBeTruthy();
  expect(screen.getByTitle('2026-07-15T02:03:11.236Z').tagName).toBe('TIME');

  await fireEvent.click(row);
  expect(navigate).toHaveBeenCalledWith('run-detail', { agentName: 'old-agent', runId });
});

test('shows a failed run error summary and safe fallbacks', async () => {
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({
    runId: 'failed-run-identifier',
    status: RunStatus.FAILED,
    error: 'container exited before producing a result',
    warnings: [],
  })] });

  render(AgentRunListView);

  expect(await screen.findByText('failed-run-i')).toBeTruthy();
  const error = screen.getByText('container exited before producing a result');
  expect(error.getAttribute('title')).toBe('container exited before producing a result');
  expect(screen.getByText('退出码 0')).toBeTruthy();
  expect(screen.getByText('告警 0')).toBeTruthy();
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
});

test('computes running duration and omits an exit code', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-15T02:03:12.736Z'));
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({
    runId: 'running-run',
    status: RunStatus.RUNNING,
    startedAt: '2026-07-15T02:03:09.736Z',
  })] });

  render(AgentRunListView);
  await vi.advanceTimersByTimeAsync(0);

  expect(screen.getByText('3.0s')).toBeTruthy();
  expect(screen.getByText('退出码 —')).toBeTruthy();
});
