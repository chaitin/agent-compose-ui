import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { tick } from 'svelte';
import { Project, ProjectAgent, RunStatus, RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';
import LatestRunView from './LatestRunView.svelte';

const mocks = vi.hoisted(() => ({
  projectService: { getProject: vi.fn() },
  runService: { listRuns: vi.fn() },
  batches: { peek: vi.fn() },
}));
vi.mock('../../lib/rpc', () => ({ projectService: mocks.projectService, runService: mocks.runService }));
vi.mock('../../lib/yaml-run-batch.svelte', () => ({ yamlRunBatches: mocks.batches }));
vi.mock('./RunExecutionProcess.svelte', async () => ({ default: (await import('../../../test/fixtures/RunExecutionProcessStub.svelte')).default }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const project = (...agentNames: string[]) => ({
  project: new Project({ agents: agentNames.map(agentName => new ProjectAgent({ agentName })) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'p1';
  vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
});
afterEach(() => cleanup());

test('loads and renders every Agent latest Run through the shared execution process', async () => {
  mocks.projectService.getProject.mockResolvedValue(project('writer', 'reviewer'));
  mocks.runService.listRuns.mockImplementation((request: { agentName: string }) => Promise.resolve({
    runs: [new RunSummary({ runId: request.agentName === 'writer' ? 'run-w' : 'run-r' })],
  }));

  render(LatestRunView);

  expect((await screen.findAllByTestId('execution-process')).map(node => node.textContent)).toEqual(['writer:run-w', 'reviewer:run-r']);
  expect(mocks.projectService.getProject).toHaveBeenCalledWith(expect.objectContaining({ project: expect.objectContaining({ projectId: 'p1' }) }), expect.anything());
  expect(mocks.runService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', agentName: 'writer', limit: 1 }), expect.anything());
  expect(mocks.runService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', agentName: 'reviewer', limit: 1 }), expect.anything());
  expect(mocks.batches.peek).not.toHaveBeenCalled();
  expect(screen.getByText('最近运行结果')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '返回 Agent 列表' }));
  expect(store.navigateTo).toHaveBeenCalledWith('agents');
});

test('keeps project Agent order when latest Run responses complete in reverse order', async () => {
  const writer = deferred<{ runs: RunSummary[] }>();
  const reviewer = deferred<{ runs: RunSummary[] }>();
  mocks.projectService.getProject.mockResolvedValue(project('writer', 'reviewer'));
  mocks.runService.listRuns.mockImplementation((request: { agentName: string }) => request.agentName === 'writer' ? writer.promise : reviewer.promise);
  render(LatestRunView);
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(2));
  expect([...document.querySelectorAll('[data-agent]')].map(node => node.getAttribute('data-agent'))).toEqual(['writer', 'reviewer']);
  reviewer.resolve({ runs: [new RunSummary({ runId: 'run-r' })] });
  expect(await screen.findByText('reviewer:run-r')).toBeTruthy();
  writer.resolve({ runs: [new RunSummary({ runId: 'run-w' })] });
  await waitFor(() => expect(screen.getAllByTestId('execution-process').map(node => node.textContent)).toEqual(['writer:run-w', 'reviewer:run-r']));
});

test('shows an Agent-local empty state when no Run exists', async () => {
  mocks.projectService.getProject.mockResolvedValue(project('writer'));
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  render(LatestRunView);
  expect(await screen.findByText('暂无运行记录')).toBeTruthy();
});

test('isolates one Agent query error and retries it without disturbing its sibling', async () => {
  mocks.projectService.getProject.mockResolvedValue(project('writer', 'reviewer'));
  mocks.runService.listRuns.mockImplementation((request: { agentName: string }) => {
    if (request.agentName === 'writer' && mocks.runService.listRuns.mock.calls.filter(call => call[0].agentName === 'writer').length === 1) {
      return Promise.reject(new Error('writer unavailable'));
    }
    return Promise.resolve({ runs: [new RunSummary({ runId: request.agentName === 'writer' ? 'run-w' : 'run-r' })] });
  });
  render(LatestRunView);
  expect(await screen.findByText('writer unavailable')).toBeTruthy();
  expect(screen.getByText('reviewer:run-r')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('writer:run-w')).toBeTruthy();
  expect(screen.getByText('reviewer:run-r')).toBeTruthy();
  expect(mocks.runService.listRuns).toHaveBeenCalledTimes(3);
});

test('never mixes a new active project ID with an old entry Run during project switches', async () => {
  const nextProject = deferred<ReturnType<typeof project>>();
  mocks.projectService.getProject.mockImplementation((request: { project?: { projectId?: string } }) => request.project?.projectId === 'p1'
    ? Promise.resolve(project('writer'))
    : nextProject.promise);
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({ runId: 'run-w' })] });
  render(LatestRunView);
  const process = await screen.findByTestId('execution-process');
  expect(process.dataset.projectId).toBe('p1');
  const observedProjectIds: string[] = [];
  const observer = new MutationObserver(() => {
    const current = screen.queryByTestId('execution-process');
    if (current) observedProjectIds.push(current.dataset.projectId ?? '');
  });
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });

  store.activeProjectId = 'p2';
  await waitFor(() => expect(screen.queryByTestId('execution-process')).toBeNull());
  observer.disconnect();

  expect(observedProjectIds).not.toContain('p2');
});

test('keeps the newest result when repeated retries for one Agent finish out of order', async () => {
  const olderRetry = deferred<{ runs: RunSummary[] }>();
  const newerRetry = deferred<{ runs: RunSummary[] }>();
  mocks.projectService.getProject.mockResolvedValue(project('writer'));
  mocks.runService.listRuns
    .mockRejectedValueOnce(new Error('writer unavailable'))
    .mockReturnValueOnce(olderRetry.promise)
    .mockReturnValueOnce(newerRetry.promise);
  render(LatestRunView);
  const retry = await screen.findByRole('button', { name: '重试' });
  retry.click();
  retry.click();
  expect(mocks.runService.listRuns).toHaveBeenCalledTimes(3);

  newerRetry.resolve({ runs: [new RunSummary({ runId: 'newer-run' })] });
  expect(await screen.findByText('writer:newer-run')).toBeTruthy();
  olderRetry.resolve({ runs: [new RunSummary({ runId: 'older-run' })] });
  await olderRetry.promise;
  await tick();
  expect(screen.getByTestId('execution-process').textContent).toBe('writer:newer-run');
});

test('ignores stale project and Run responses after the active project changes', async () => {
  const oldProject = deferred<ReturnType<typeof project>>();
  const oldRun = deferred<{ runs: RunSummary[] }>();
  mocks.projectService.getProject.mockImplementation((request: { project?: { projectId?: string } }) => {
    return request.project?.projectId === 'p1' ? oldProject.promise : Promise.resolve(project('new-agent'));
  });
  mocks.runService.listRuns.mockImplementation((request: { agentName: string }) => request.agentName === 'old-agent'
    ? oldRun.promise
    : Promise.resolve({ runs: [new RunSummary({ runId: 'new-run' })] }));
  render(LatestRunView);
  store.activeProjectId = 'p2';
  expect(await screen.findByText('new-agent:new-run')).toBeTruthy();
  oldProject.resolve(project('old-agent'));
  await oldProject.promise;
  await Promise.resolve();
  expect(screen.queryByText('old-agent')).toBeNull();

  store.activeProjectId = 'p1';
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'old-agent' }), expect.anything()));
  store.activeProjectId = 'p2';
  oldRun.resolve({ runs: [new RunSummary({ runId: 'old-run' })] });
  await oldRun.promise;
  expect(await screen.findByText('new-agent:new-run')).toBeTruthy();
  expect(screen.queryByText('old-agent:old-run')).toBeNull();
});

test('ignores a late response after unmount and aborts its request', async () => {
  const late = deferred<{ runs: RunSummary[] }>();
  mocks.projectService.getProject.mockResolvedValue(project('writer'));
  mocks.runService.listRuns.mockReturnValue(late.promise);
  const view = render(LatestRunView);
  await waitFor(() => expect(mocks.runService.listRuns).toHaveBeenCalledTimes(1));
  const signal = mocks.runService.listRuns.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  late.resolve({ runs: [new RunSummary({ runId: 'late-run' })] });
  await late.promise;
});

test('shows each latest Run status in Chinese and synchronizes running to settled detail status', async () => {
  mocks.projectService.getProject.mockResolvedValue(project('writer', 'reviewer'));
  mocks.runService.listRuns.mockImplementation((request: { agentName: string }) => Promise.resolve({
    runs: [new RunSummary({
      runId: `run-${request.agentName}`,
      status: request.agentName === 'writer' ? RunStatus.PENDING : RunStatus.FAILED,
    })],
  }));
  render(LatestRunView);

  const writer = await screen.findByRole('heading', { name: /writer/ });
  const reviewer = screen.getByRole('heading', { name: /reviewer/ });
  expect(writer.parentElement).toHaveTextContent('等待执行');
  expect(reviewer.parentElement).toHaveTextContent('失败');
  await screen.getByTestId('emit-running-writer').click();
  expect(writer.parentElement).toHaveTextContent('运行中');
  await screen.getByTestId('emit-succeeded-writer').click();
  expect(writer.parentElement).toHaveTextContent('成功');
  expect(reviewer.parentElement).toHaveTextContent('失败');
});
