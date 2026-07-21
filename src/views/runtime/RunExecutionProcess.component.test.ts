import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import RunExecutionProcess from './RunExecutionProcess.svelte';
import { ExecStreamEventType, ExecStreamResponse, ListSandboxHistoryResponse, ListSandboxRunEventsResponse, RunDetail, RunStatus, RunSummary, StdioStream } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  runService: { getRun: vi.fn(), listRunEvents: vi.fn(), listSandboxRunEvents: vi.fn(), followRunLogs: vi.fn() },
  projectService: { listSchedulerEvents: vi.fn() },
  sandboxService: { listSandboxHistory: vi.fn(), getSandbox: vi.fn(), resumeSandbox: vi.fn() },
  execService: { execStream: vi.fn() },
}));

vi.mock('../../lib/rpc', () => ({
  runService: mocks.runService,
  projectService: mocks.projectService,
  sandboxService: mocks.sandboxService,
  execService: mocks.execService,
}));

async function* emptyLogs() {}
async function* artifactStream(path: string) {
  yield new ExecStreamResponse({
    eventType: ExecStreamEventType.OUTPUT,
    stream: StdioStream.STDOUT,
    chunk: `1784604700\t${path}\0`,
  });
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function detail(runId: string, agentName: string) {
  return new RunDetail({ summary: new RunSummary({ runId, agentName, status: RunStatus.SUCCEEDED }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runService.getRun.mockResolvedValue({ run: detail('run-1', 'writer') });
  mocks.runService.listRunEvents.mockResolvedValue({ events: [], nextCursor: '', historyAvailable: false });
  mocks.runService.listSandboxRunEvents.mockResolvedValue(new ListSandboxRunEventsResponse());
  mocks.runService.followRunLogs.mockReturnValue(emptyLogs());
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [], nextCursor: '' });
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse());
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: { status: 'RUNNING' } });
  mocks.execService.execStream.mockReturnValue(emptyLogs());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('renders only the execution process', async () => {
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });

  expect(await screen.findByText('执行过程')).toBeTruthy();
  expect(screen.getByRole('button', { name: '全部' })).toBeTruthy();
  expect(screen.queryByText('Run ID')).toBeNull();
});

test('opens a discovered Workspace artifact in the Sandbox files tab', async () => {
  const navigate = vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?view=run');
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-1', agentName: 'writer', sandboxId: 'sandbox-1', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }),
    artifactsDir: '/existing/artifacts',
  }) });
  mocks.execService.execStream.mockReturnValue(artifactStream('/workspace/2026-07-21/report.md'));
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });

  await fireEvent.click(await screen.findByRole('button', { name: '打开 Workspace 文件 /workspace/2026-07-21/report.md' }));
  expect(navigate).toHaveBeenCalledWith('sandbox-detail', { sandboxId: 'sandbox-1' });
  expect(new URLSearchParams(location.search).get('sandboxTab')).toBe('files');
  expect(new URLSearchParams(location.search).get('sandboxPath')).toBe('/workspace/2026-07-21/report.md');
  expect(new URLSearchParams(location.search).get('sandboxPathSandboxId')).toBe('sandbox-1');
});

test('keeps existing artifacts and does not exec or resume a stopped Sandbox', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-1', agentName: 'writer', sandboxId: 'sandbox-1', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }),
    artifactsDir: '/existing/artifacts',
  }) });
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: { status: 'STOPPED' } });
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });

  expect(await screen.findByText('Sandbox 已停止，请先手动恢复后刷新产物')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '产物' }));
  expect(await screen.findByText('/existing/artifacts')).toBeTruthy();
  expect(mocks.execService.execStream).not.toHaveBeenCalled();
  expect(mocks.sandboxService.resumeSandbox).not.toHaveBeenCalled();
});

test('keeps existing artifacts when the Sandbox was removed', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-1', agentName: 'writer', sandboxId: 'sandbox-1', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }),
    artifactsDir: '/existing/artifacts',
  }) });
  mocks.sandboxService.getSandbox.mockRejectedValueOnce(new ConnectError('gone', Code.NotFound));
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });
  expect(await screen.findByText('产物所在 Sandbox 已删除，无法读取 Workspace 文件')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '产物' }));
  expect(await screen.findByText('/existing/artifacts')).toBeTruthy();
});

test('shows a non-blocking exec failure while keeping existing artifacts', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-1', agentName: 'writer', sandboxId: 'sandbox-1', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }), artifactsDir: '/existing/artifacts',
  }) });
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: { status: 'RUNNING' } });
  mocks.execService.execStream.mockImplementation(() => { throw new Error('find unavailable'); });
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });
  expect(await screen.findByText(/Workspace 产物加载失败：.*find unavailable/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '产物' }));
  expect(await screen.findByText('/existing/artifacts')).toBeTruthy();
});

test('ignores Workspace artifacts returned after the run identity changes', async () => {
  const runAExec = deferred<void>();
  const runACompleted = deferred<void>();
  mocks.runService.getRun
    .mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'writer', sandboxId: 'sandbox-a', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }) }) })
    .mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-2', agentName: 'reviewer', sandboxId: 'sandbox-b', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z' }) }) });
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: { status: 'RUNNING' } });
  mocks.execService.execStream.mockImplementation((request: any) => {
    const sandboxId = request.target.value;
    return (async function* () {
      if (sandboxId === 'sandbox-a') await runAExec.promise;
      yield new ExecStreamResponse({
        eventType: ExecStreamEventType.OUTPUT,
        stream: StdioStream.STDOUT,
        chunk: `1784604700\t/workspace/${sandboxId === 'sandbox-a' ? 'run-a' : 'run-b'}.md\0`,
      });
      if (sandboxId === 'sandbox-a') runACompleted.resolve();
    })();
  });
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });
  await waitFor(() => expect(mocks.execService.execStream).toHaveBeenCalledTimes(1));
  await view.rerender({ projectId: 'p1', agentName: 'reviewer', runId: 'run-2' });
  expect(await screen.findByRole('button', { name: '打开 Workspace 文件 /workspace/run-b.md' })).toBeTruthy();

  runAExec.resolve();
  await runACompleted.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole('button', { name: '打开 Workspace 文件 /workspace/run-b.md' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开 Workspace 文件 /workspace/run-a.md' })).toBeNull();
});

test('ignores a late detail response after the run identity changes', async () => {
  const old = deferred<any>();
  mocks.runService.getRun
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ run: detail('run-2', 'reviewer') });
  const onDetail = vi.fn();
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1', onDetail });
  await waitFor(() => expect(mocks.runService.getRun).toHaveBeenCalledTimes(1));

  await view.rerender({ projectId: 'p1', agentName: 'reviewer', runId: 'run-2', onDetail });
  await waitFor(() => expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ runId: 'run-2' }) })));

  old.resolve({ run: detail('run-1', 'writer') });
  await old.promise;
  await Promise.resolve();
  expect(onDetail).not.toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ runId: 'run-1' }) }));
});

test('clears the emitted detail immediately when the run identity changes', async () => {
  const next = deferred<any>();
  mocks.runService.getRun
    .mockResolvedValueOnce({ run: detail('run-1', 'writer') })
    .mockReturnValueOnce(next.promise);
  const onDetail = vi.fn();
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1', onDetail });
  await waitFor(() => expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ runId: 'run-1' }) })));
  onDetail.mockClear();

  await view.rerender({ projectId: 'p1', agentName: 'reviewer', runId: 'run-2', onDetail });

  await waitFor(() => expect(onDetail).toHaveBeenCalledWith(null));
  expect(mocks.runService.getRun).toHaveBeenCalledTimes(2);
});

test('marks the heading and timeline panel for embedded presentation', async () => {
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1', embedded: true });

  expect(await screen.findByText('执行过程')).toBeTruthy();
  expect(view.container.querySelector('.section-heading.embedded')).toBeTruthy();
  expect(view.container.querySelector('.timeline-panel.embedded')).toBeTruthy();
});

test('shows a local RPC error and retries the main detail without becoming not-found', async () => {
  mocks.runService.getRun
    .mockRejectedValueOnce(new ConnectError('detail unavailable', Code.Unavailable))
    .mockResolvedValueOnce({ run: detail('run-1', 'writer') });
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('detail unavailable');
  expect(screen.queryByText('未找到运行记录')).toBeNull();
  await screen.getByRole('button', { name: '重试运行详情' }).click();
  expect(await screen.findByText('执行过程')).toBeTruthy();
  expect(mocks.runService.getRun).toHaveBeenCalledTimes(2);
});

test('renders a real NotFound as an empty record without a retry alert', async () => {
  mocks.runService.getRun.mockRejectedValue(new ConnectError('missing', Code.NotFound));
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'missing' });

  expect(await screen.findByText('未找到运行记录')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('shows structured event failure as a local execution-process alert', async () => {
  mocks.runService.listRunEvents.mockRejectedValue(new Error('events unavailable'));
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });

  expect(await screen.findByRole('alert')).toHaveTextContent('events unavailable');
  expect(await screen.findByText('执行过程')).toBeTruthy();
});

test('passes one identity signal to every detail request and aborts it on identity change', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({
      summary: new RunSummary({
        runId: 'run-1', agentName: 'writer', status: RunStatus.SUCCEEDED,
        source: 2, sandboxId: 'sandbox-1', triggerId: 'trigger-1',
      }),
      resultJson: JSON.stringify({ cellId: 'cell-1' }),
    }),
  });
  const view = render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });
  await waitFor(() => {
    expect(mocks.runService.listSandboxRunEvents).toHaveBeenCalled();
    expect(mocks.runService.followRunLogs).toHaveBeenCalled();
  });

  const identityCalls = [
    mocks.runService.getRun.mock.calls[0],
    mocks.runService.listRunEvents.mock.calls[0],
    mocks.projectService.listSchedulerEvents.mock.calls[0],
    mocks.sandboxService.listSandboxHistory.mock.calls[0],
    mocks.runService.listSandboxRunEvents.mock.calls[0],
  ];
  const signal = identityCalls[0][1].signal as AbortSignal;
  const logSignal = mocks.runService.followRunLogs.mock.calls[0][1].signal as AbortSignal;
  expect(identityCalls.every(call => call[1].signal === signal)).toBe(true);
  expect(logSignal).not.toBe(signal);
  await view.rerender({ projectId: 'p1', agentName: 'reviewer', runId: 'run-2' });
  expect(signal.aborted).toBe(true);
  expect(logSignal.aborted).toBe(true);
});

test('cancels the active follow before loading a wider snapshot and starts one replacement follow', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({
      runId: 'run-1', agentName: 'writer', status: RunStatus.RUNNING,
    }) }),
  });
  const order: string[] = [];
  let followCount = 0;
  mocks.runService.followRunLogs.mockImplementation((request: { follow: boolean; tailLines: number }, options: { signal: AbortSignal }) => {
    if (!request.follow) {
      order.push(`snapshot-${request.tailLines}`);
      return emptyLogs();
    }
    followCount += 1;
    const current = followCount;
    order.push(`follow-${current}`);
    options.signal.addEventListener('abort', () => order.push(`abort-follow-${current}`), { once: true });
    return (async function* () {
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    })();
  });
  render(RunExecutionProcess, { projectId: 'p1', agentName: 'writer', runId: 'run-1' });
  await waitFor(() => expect(followCount).toBe(1));

  await screen.getByRole('button', { name: '加载更多（显示最近 500 行）' }).click();
  await waitFor(() => expect(followCount).toBe(2));

  expect(order).toEqual([
    'snapshot-100', 'follow-1', 'abort-follow-1', 'snapshot-500', 'follow-2',
  ]);
  expect(mocks.runService.followRunLogs.mock.calls.filter(call => call[0].follow)).toHaveLength(2);
  expect((mocks.runService.followRunLogs.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
  expect((mocks.runService.followRunLogs.mock.calls[3][1].signal as AbortSignal).aborted).toBe(false);
});
