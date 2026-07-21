import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import SchedulerListView from './SchedulerListView.svelte';
import { Timestamp } from '@bufbuild/protobuf';
import { AgentSpec, Project, ProjectScheduler, ProjectSpec, ResolvedTrigger, RunAgentRequest, RunDetail, RunSummary, SchedulerEvent, SchedulerSpec, TriggerSpec, RunSandboxCleanupPolicy } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  projectService: { getProject: vi.fn(), getScheduler: vi.fn(), listSchedulerEvents: vi.fn(), setSchedulerEnabled: vi.fn(), setSchedulerTriggerEnabled: vi.fn() }, runService: { runAgent: vi.fn(), startRun: vi.fn(), listRuns: vi.fn() },
}));
vi.mock('../../lib/rpc', () => ({ projectService: mocks.projectService, runtimeProjectService: mocks.projectService, runService: mocks.runService }));

function project(projectId = 'project-1') {
  return { project: new Project({
    schedulers: [new ProjectScheduler({ projectId, agentName: 'worker', schedulerId: 'scheduler-1', enabled: true, triggerCount: 1 })],
    spec: new ProjectSpec({ agents: [new AgentSpec({ name: 'worker', scheduler: new SchedulerSpec({ enabled: true, triggers: [new TriggerSpec({ name: 'nightly', kind: 'cron', cron: '0 1 * * *', prompt: 'scheduled prompt' })] }) })] }),
  }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'project-1';
  vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  mocks.projectService.getProject.mockResolvedValue(project());
  mocks.projectService.getScheduler.mockResolvedValue({ triggers: [new ResolvedTrigger({ spec: new TriggerSpec({ name: 'nightly', kind: 'cron', cron: '0 1 * * *', prompt: 'scheduled prompt' }), triggerId: 'nightly', enabled: true })] });
  mocks.runService.runAgent.mockResolvedValue({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-new' }) }) });
  mocks.runService.startRun.mockResolvedValue({ run: new RunSummary({ runId: 'run-detached' }) });
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({ runId: 'run-old', sandboxId: 'sandbox-existing' })] });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [new SchedulerEvent({ id: 'event-1', type: 'trigger-fired', level: 'info', message: 'nightly completed', triggerId: 'nightly', createdAt: Timestamp.fromDate(new Date('2026-07-15T01:02:03Z')) })] });
  mocks.projectService.setSchedulerEnabled.mockResolvedValue({ scheduler: new ProjectScheduler({ projectId: 'project-1', agentName: 'worker', schedulerId: 'scheduler-1', enabled: false, triggerCount: 1 }) });
  mocks.projectService.setSchedulerTriggerEnabled.mockResolvedValue({ trigger: new ResolvedTrigger({ triggerId: 'nightly', enabled: false }) });
});

test('uses the authoritative resolved trigger id and initially disabled state', async () => {
  mocks.projectService.getScheduler.mockResolvedValueOnce({ triggers: [new ResolvedTrigger({
    spec: new TriggerSpec({ name: 'nightly', kind: 'cron', cron: '0 1 * * *' }),
    triggerId: 'resolved-trigger-42', enabled: false,
  })] });
  render(SchedulerListView);
  const toggle = await screen.findByRole('button', { name: '启用 Trigger nightly' });
  await fireEvent.click(toggle);
  expect(mocks.projectService.setSchedulerTriggerEnabled).toHaveBeenCalledWith(expect.objectContaining({
    triggerId: 'resolved-trigger-42', enabled: true,
  }));
});

test('does not request Scheduler details for an Agent without Scheduler YAML', async () => {
  const value = project();
  value.project!.spec!.agents.push(new AgentSpec({ name: 'build-workspace-agent' }));
  value.project!.schedulers.push(new ProjectScheduler({
    projectId: 'project-1', agentName: 'build-workspace-agent', schedulerId: 'scheduler-build',
  }));
  mocks.projectService.getProject.mockResolvedValueOnce(value);

  render(SchedulerListView);
  await screen.findByText('nightly');

  expect(mocks.projectService.getScheduler).toHaveBeenCalledTimes(1);
  expect(mocks.projectService.getScheduler).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'worker' }));
  expect(mocks.projectService.getScheduler).not.toHaveBeenCalledWith(expect.objectContaining({ agentName: 'build-workspace-agent' }));
  expect(screen.queryByText('build-workspace-agent')).not.toBeInTheDocument();
});

test('renders unknown trigger state without mutation when resolved triggers are unavailable', async () => {
  mocks.projectService.getScheduler.mockRejectedValueOnce(new Error('scheduler detail unavailable'));
  render(SchedulerListView);
  const toggle = await screen.findByRole('button', { name: 'Trigger nightly 状态未知' });
  expect(toggle).toBeDisabled();
  await fireEvent.click(toggle);
  expect(mocks.projectService.setSchedulerTriggerEnabled).not.toHaveBeenCalled();
});

test('lists scheduler events and renders backend timestamp, status, and message', async () => {
  render(SchedulerListView);
  expect(await screen.findByText('nightly completed')).toBeInTheDocument();
  expect(screen.getByText('trigger-fired · info')).toBeInTheDocument();
  expect(screen.getByText(new Date('2026-07-15T01:02:03Z').toLocaleString())).toBeInTheDocument();
  expect(mocks.projectService.listSchedulerEvents).toHaveBeenCalledWith(expect.objectContaining({
    project: expect.objectContaining({ projectId: 'project-1' }), agentName: 'worker', limit: 100,
  }));
});

test('loads more scheduler events in server order and stops on a repeated cursor', async () => {
  mocks.projectService.listSchedulerEvents
    .mockResolvedValueOnce({ events: [new SchedulerEvent({ id: 'event-1', message: 'first page' })], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ events: [new SchedulerEvent({ id: 'event-2', message: 'second page' })], nextCursor: 'page-2' });
  render(SchedulerListView);
  await screen.findByText('first page');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多 worker Scheduler 事件' }));
  await screen.findByText('second page');
  expect(screen.getAllByText(/page$/).map((node) => node.textContent)).toEqual(['first page', 'second page']);
  expect(mocks.projectService.listSchedulerEvents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'page-2' }));
  expect(screen.queryByRole('button', { name: '加载更多 worker Scheduler 事件' })).not.toBeInTheDocument();
  expect(mocks.projectService.listSchedulerEvents).toHaveBeenCalledTimes(2);
});

test('suppresses a stale load-more page after the active project changes', async () => {
  const nextPage = deferred<{ events: SchedulerEvent[]; nextCursor: string }>();
  mocks.projectService.listSchedulerEvents
    .mockResolvedValueOnce({ events: [new SchedulerEvent({ id: 'event-1', message: 'current page' })], nextCursor: 'page-2' })
    .mockReturnValueOnce(nextPage.promise)
    .mockResolvedValue({ events: [], nextCursor: '' });
  mocks.projectService.getProject.mockImplementation((request) => Promise.resolve(project(request.project?.projectId)));
  render(SchedulerListView);
  await screen.findByText('current page');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多 worker Scheduler 事件' }));
  store.activeProjectId = 'project-2';
  await waitFor(() => expect(mocks.projectService.getProject).toHaveBeenCalledWith(
    expect.objectContaining({ project: expect.objectContaining({ projectId: 'project-2' }) }),
    expect.objectContaining({ timeoutMs: 30_000 }),
  ));
  nextPage.resolve({ events: [new SchedulerEvent({ id: 'old-page', message: 'stale next page' })], nextCursor: '' });
  await nextPage.promise; await Promise.resolve();
  expect(screen.queryByText('stale next page')).not.toBeInTheDocument();
});

test('uses direct scheduler and trigger controls without running an agent', async () => {
  render(SchedulerListView);
  const schedulerToggle = await screen.findByRole('button', { name: '禁用 Scheduler worker' });
  await fireEvent.click(schedulerToggle);
  expect(mocks.projectService.setSchedulerEnabled).toHaveBeenCalledWith(expect.objectContaining({
    project: expect.objectContaining({ projectId: 'project-1' }), agentName: 'worker', enabled: false,
  }));
  expect(await screen.findByRole('button', { name: '启用 Scheduler worker' })).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: '禁用 Trigger nightly' }));
  expect(mocks.projectService.setSchedulerTriggerEnabled).toHaveBeenCalledWith(expect.objectContaining({
    project: expect.objectContaining({ projectId: 'project-1' }), agentName: 'worker', triggerId: 'nightly', enabled: false,
  }));
  expect(await screen.findByRole('button', { name: '启用 Trigger nightly' })).toBeInTheDocument();
  expect(mocks.runService.runAgent).not.toHaveBeenCalled();
  expect(mocks.runService.startRun).not.toHaveBeenCalled();
});

test('shows optimistic busy state but waits for the scheduler response before changing enabled state', async () => {
  const pending = deferred<{ scheduler: ProjectScheduler }>();
  mocks.projectService.setSchedulerEnabled.mockReturnValueOnce(pending.promise);
  render(SchedulerListView);
  const toggle = await screen.findByRole('button', { name: '禁用 Scheduler worker' });
  await fireEvent.click(toggle);
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveTextContent('保存中...');
  expect(screen.queryByRole('button', { name: '启用 Scheduler worker' })).not.toBeInTheDocument();
  pending.resolve({ scheduler: new ProjectScheduler({ projectId: 'project-1', agentName: 'worker', schedulerId: 'scheduler-1', enabled: false }) });
  expect(await screen.findByRole('button', { name: '启用 Scheduler worker' })).toBeInTheDocument();
});

test('displays direct-control errors', async () => {
  mocks.projectService.setSchedulerTriggerEnabled.mockRejectedValueOnce(new Error('trigger update failed'));
  render(SchedulerListView);
  await fireEvent.click(await screen.findByRole('button', { name: '禁用 Trigger nightly' }));
  expect(await screen.findByText('trigger update failed')).toBeInTheDocument();
  expect(store.addToast).toHaveBeenCalledWith('trigger update failed', 'error');
});

test('suppresses stale event and control responses after the active project changes', async () => {
  const events = deferred<{ events: SchedulerEvent[] }>();
  const control = deferred<{ scheduler: ProjectScheduler }>();
  mocks.projectService.listSchedulerEvents.mockReturnValueOnce(events.promise);
  mocks.projectService.setSchedulerEnabled.mockReturnValueOnce(control.promise);
  mocks.projectService.getProject.mockImplementation((request) => Promise.resolve(project(request.project?.projectId)));
  render(SchedulerListView);
  await fireEvent.click(await screen.findByRole('button', { name: '禁用 Scheduler worker' }));
  store.activeProjectId = 'project-2';
  await waitFor(() => expect(mocks.projectService.getProject).toHaveBeenCalledWith(
    expect.objectContaining({ project: expect.objectContaining({ projectId: 'project-2' }) }),
    expect.objectContaining({ timeoutMs: 30_000 }),
  ));
  events.resolve({ events: [new SchedulerEvent({ id: 'old-event', message: 'old project event' })] });
  control.resolve({ scheduler: new ProjectScheduler({ projectId: 'project-1', agentName: 'worker', schedulerId: 'scheduler-1', enabled: false }) });
  await Promise.all([events.promise, control.promise]); await Promise.resolve();
  expect(screen.queryByText('old project event')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '禁用 Scheduler worker' })).toBeInTheDocument();
});

test('uses the same RunAgentRequest snapshot for streaming wait and detached start', async () => {
  render(SchedulerListView);
  await screen.findByText('nightly');
  await fireEvent.input(screen.getByLabelText('nightly Payload JSON'), { target: { value: '{"same":true}' } });
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  const waited = mocks.runService.runAgent.mock.calls[0][0] as RunAgentRequest;
  await screen.findByLabelText('nightly Payload JSON');

  await fireEvent.click(screen.getByLabelText('nightly 一次性 Run 高级选项'));
  const execution = screen.getByLabelText('nightly 执行方式') as HTMLSelectElement;
  execution.value = 'detached'; await fireEvent.change(execution);
  await fireEvent.input(screen.getByLabelText('nightly Payload JSON'), { target: { value: '{"same":true}' } });
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  const detached = mocks.runService.startRun.mock.calls[0][0].run as RunAgentRequest;
  expect(RunAgentRequest.equals(waited, detached)).toBe(true);
  expect(mocks.runService.runAgent).toHaveBeenCalledTimes(1);
  expect(mocks.runService.startRun).toHaveBeenCalledTimes(1);
  expect(store.navigateTo).toHaveBeenLastCalledWith('run-detail', { agentName: 'worker', runId: 'run-detached' });
});

test('ignores a detached response after switching projects', async () => {
  const pending = deferred<{ run: RunSummary }>();
  mocks.runService.startRun.mockReturnValueOnce(pending.promise);
  mocks.projectService.getProject.mockImplementation((request) => Promise.resolve(project(request.project?.projectId)));
  render(SchedulerListView);
  await screen.findByText('nightly');
  await fireEvent.click(screen.getByLabelText('nightly 一次性 Run 高级选项'));
  const execution = screen.getByLabelText('nightly 执行方式') as HTMLSelectElement;
  execution.value = 'detached'; await fireEvent.change(execution);
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  store.activeProjectId = 'project-2';
  await waitFor(() => expect(mocks.projectService.getProject).toHaveBeenCalledWith(
    expect.objectContaining({ project: expect.objectContaining({ projectId: 'project-2' }) }),
    expect.objectContaining({ timeoutMs: 30_000 }),
  ));
  pending.resolve({ run: new RunSummary({ runId: 'old-detached' }) });
  await pending.promise; await Promise.resolve();
  expect(store.navigateTo).not.toHaveBeenCalled();
});

test('reports a detached start response without a Run ID as an error', async () => {
  mocks.runService.startRun.mockResolvedValueOnce({ run: new RunSummary() });
  render(SchedulerListView);
  await screen.findByText('nightly');
  await fireEvent.click(screen.getByLabelText('nightly 一次性 Run 高级选项'));
  const execution = screen.getByLabelText('nightly 执行方式') as HTMLSelectElement;
  execution.value = 'detached'; await fireEvent.change(execution);
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  await waitFor(() => expect(store.addToast).toHaveBeenCalledWith('运行完成，但后端未返回 Run ID', 'error'));
  expect(store.navigateTo).not.toHaveBeenCalled();
});

test('submits collapsed one-off Run overrides without changing scheduler YAML', async () => {
  render(SchedulerListView);
  await screen.findByText('nightly');
  expect(screen.queryByLabelText('nightly Driver')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByLabelText('nightly 一次性 Run 高级选项'));
  const sandbox = screen.getByLabelText('nightly Sandbox') as HTMLSelectElement;
  sandbox.value = 'sandbox-existing'; await fireEvent.change(sandbox);
  await fireEvent.input(screen.getByLabelText('nightly Driver'), { target: { value: 'docker' } });
  await fireEvent.input(screen.getByLabelText('nightly Prompt'), { target: { value: 'override prompt' } });
  const cleanup = screen.getByLabelText('nightly Cleanup policy') as HTMLSelectElement;
  cleanup.value = String(RunSandboxCleanupPolicy.KEEP_RUNNING); await fireEvent.change(cleanup);
  await fireEvent.click(screen.getByLabelText('nightly Jupyter enabled'));
  await fireEvent.click(screen.getByLabelText('nightly Jupyter expose'));
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  expect(mocks.runService.runAgent.mock.calls[0][0]).toMatchObject({
    sandboxId: 'sandbox-existing', driver: 'docker', prompt: 'override prompt',
    cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING,
    jupyter: { enabled: true, expose: true },
  });
  expect(mocks.projectService.getProject).toHaveBeenCalledTimes(1);
});

test('reads scheduler definitions and manually runs scheduler context then observes the ordinary run', async () => {
  render(SchedulerListView);
  await screen.findByText('nightly');
  expect(mocks.projectService.getProject).toHaveBeenCalledWith(
    expect.objectContaining({ includeSpec: true }),
    expect.objectContaining({ timeoutMs: 30_000 }),
  );
  await fireEvent.input(screen.getByLabelText('nightly Payload JSON'), { target: { value: '{"date":"2026-07-14"}' } });
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  const request = mocks.runService.runAgent.mock.calls[0][0];
  expect(request).toMatchObject({ projectId: 'project-1', agentName: 'worker', schedulerId: 'scheduler-1', triggerId: 'nightly', payloadJson: '{"date":"2026-07-14"}', prompt: 'scheduled prompt' });
  await waitFor(() => expect(store.navigateTo).toHaveBeenCalledWith('run-detail', { agentName: 'worker', runId: 'run-new' }));
});

test('binds a pending manual run to its loaded project and ignores its response after a project switch', async () => {
  const pending = deferred<{ run: RunDetail }>();
  mocks.runService.runAgent.mockReturnValueOnce(pending.promise);
  mocks.projectService.getProject.mockImplementation((request) => Promise.resolve(project(request.project?.projectId)));
  render(SchedulerListView);
  await screen.findByText('nightly');
  await fireEvent.input(screen.getByLabelText('nightly Payload JSON'), { target: { value: '{"project":1}' } });
  await fireEvent.click(screen.getByRole('button', { name: '手动运行 nightly' }));
  expect(mocks.runService.runAgent.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', payloadJson: '{"project":1}' });

  store.activeProjectId = 'project-2';
  await waitFor(() => expect(mocks.projectService.getProject).toHaveBeenCalledWith(
    expect.objectContaining({ project: expect.objectContaining({ projectId: 'project-2' }) }),
    expect.objectContaining({ timeoutMs: 30_000 }),
  ));
  expect(await screen.findByLabelText('nightly Payload JSON')).toHaveValue('');
  expect(screen.getByRole('button', { name: '手动运行 nightly' })).toBeEnabled();

  pending.resolve({ run: new RunDetail({ summary: new RunSummary({ runId: 'old-project-run' }) }) });
  await pending.promise;
  await Promise.resolve();
  expect(store.navigateTo).not.toHaveBeenCalled();
});
