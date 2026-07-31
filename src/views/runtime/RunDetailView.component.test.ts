import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import RunDetailView from './RunDetailView.svelte';
import { ExecStreamEventType, ExecStreamResponse, GetSchedulerRunResponse, ListSandboxHistoryResponse, ListSandboxRunEventsResponse, RunDetail, RunEvent, RunEventKind, RunSource, RunStatus, RunSummary, SandboxHistoryCell, SchedulerEvent, SchedulerRun, StdioStream } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';
import { stableProjectRunId } from '../../lib/run-scheduler-evidence';

const mocks = vi.hoisted(() => ({
  runService: { getRun: vi.fn(), listRunEvents: vi.fn(), listSandboxRunEvents: vi.fn(), followRunLogs: vi.fn(), stopRun: vi.fn() },
  projectService: { getSchedulerRun: vi.fn(), listSchedulerEvents: vi.fn() },
  sandboxService: { listSandboxHistory: vi.fn(), getSandbox: vi.fn() },
  execService: { execStream: vi.fn() },
}));
vi.mock('../../lib/rpc', () => ({ runService: mocks.runService, projectService: mocks.projectService, sandboxService: mocks.sandboxService, execService: mocks.execService }));

async function* emptyLogs() {}
function failedRunDetail() {
  return new RunDetail({
    summary: new RunSummary({
      runId: 'run-1', agentName: 'worker', status: RunStatus.FAILED,
      startedAt: '2026-07-15T01:00:00Z', completedAt: '2026-07-15T01:01:00Z',
    }),
  });
}

function relatedRunDetail() {
  return new RunDetail({
    summary: new RunSummary({
      runId: 'run-1',
      agentName: 'worker',
      source: RunSource.SCHEDULER,
      schedulerId: 'scheduler-1',
      triggerId: 'nightly',
      sandboxId: 'sandbox-1',
      status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-15T01:00:00Z',
    }),
    driver: 'docker',
    imageRef: 'guest:latest',
  });
}

function logChunk(data: string, offset: number) {
  return { data, offset: BigInt(offset), createdAt: '2026-07-15T01:00:30Z', isFinal: false };
}

async function* streamOf(...chunks: any[]) {
  for (const chunk of chunks) yield chunk;
  yield { data: '', offset: chunks.at(-1)?.offset ?? 0n, createdAt: '', isFinal: true };
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function responseStream() {
  const values: any[] = [];
  let waiter: ((value: IteratorResult<any>) => void) | undefined;
  return {
    push(value: any) { if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value, done: false }); } else values.push(value); },
    [Symbol.asyncIterator]() { return { next: () => values.length ? Promise.resolve({ value: values.shift(), done: false }) : new Promise<IteratorResult<any>>(resolve => { waiter = resolve; }) }; },
  };
}

function controlledStream() {
  const values: any[] = [];
  let waiter: ((value: IteratorResult<any>) => void) | undefined;
  let closed = false;
  return {
    close() { closed = true; if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() { return { next: () => {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<any>>(resolve => { waiter = resolve; });
    } }; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'project-1';
  store.runtimeView = { level: 'run-detail', agentName: 'worker', runId: 'run-1', sessionId: '' };
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  mocks.runService.followRunLogs.mockReturnValue(emptyLogs());
  mocks.runService.listRunEvents.mockResolvedValue({ events: [], nextCursor: '', historyAvailable: false });
  mocks.runService.listSandboxRunEvents.mockResolvedValue(new ListSandboxRunEventsResponse());
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [], nextCursor: '' });
  mocks.projectService.getSchedulerRun.mockResolvedValue(new GetSchedulerRunResponse());
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse());
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: { status: 'RUNNING' } });
  mocks.execService.execStream.mockReturnValue(emptyLogs());
});
afterEach(() => cleanup());

test('merges only confirmed Scheduler, Cell, and Sandbox Run evidence and filters artifacts', async () => {
  const projectRunId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-run-1:agent:1');
  store.runtimeView = { level: 'run-detail', agentName: 'worker', runId: projectRunId, sessionId: '' };
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({
      runId: projectRunId, agentName: 'worker', source: RunSource.SCHEDULER, triggerId: 'trigger-1',
      sandboxId: 'sandbox-1', status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z',
    }),
    resultJson: '{"cellId":"cell-1"}', logsPath: '/logs/output.txt', artifactsDir: '/data/sessions/sandbox-1/state/cells/cell-1',
  }) });
  mocks.runService.listRunEvents.mockResolvedValue({ events: [], nextCursor: '', historyAvailable: true });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'scheduler-match', runId: 'loader-run-1', triggerId: 'trigger-1', type: 'loader.run.started', message: 'confirmed scheduler start' }),
    new SchedulerEvent({ id: 'scheduler-other', runId: 'loader-run-2', triggerId: 'trigger-1', message: 'unrelated scheduler event' }),
  ], nextCursor: '' });
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse({ cells: [
    new SandboxHistoryCell({ id: 'cell-1', source: 'prompt', output: 'confirmed cell answer', success: true }),
    new SandboxHistoryCell({ id: 'cell-other', output: 'unrelated cell answer', success: true }),
  ] }));
  mocks.runService.listSandboxRunEvents.mockResolvedValue(new ListSandboxRunEventsResponse({ events: [
    new RunEvent({ id: 'sandbox-current', runId: projectRunId, kind: RunEventKind.AGENT_MESSAGE, text: 'confirmed sandbox response' }),
    new RunEvent({ id: 'sandbox-other', runId: 'other-run', text: 'unrelated sandbox response' }),
  ] }));
  mocks.execService.execStream.mockReturnValue(streamOf(new ExecStreamResponse({
    eventType: ExecStreamEventType.OUTPUT,
    stream: StdioStream.STDOUT,
    chunk: '1784604700\t/workspace/2026-07-21/report.md\0',
  })));

  render(RunDetailView);

  expect(await screen.findByText('confirmed scheduler start')).toBeTruthy();
  const schedulerEntry = screen.getByText('confirmed scheduler start').closest('article');
  expect(schedulerEntry?.querySelectorAll('.entry-body header > span')).toHaveLength(1);
  expect(schedulerEntry?.querySelector('.entry-body header > strong')).toHaveTextContent('SCHEDULER');
  expect(schedulerEntry?.querySelector('.entry-body header > span')).toHaveTextContent('调度器');
  expect(await screen.findByText(/confirmed cell answer/)).toBeTruthy();
  expect(screen.getByText('confirmed sandbox response')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看 Sandbox 运行详情' })).toBeNull();
  expect(screen.getByText(/全量加载完成 · 已展示 \d+ \/ \d+ 条/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '刷新' })).toHaveTextContent('↻');
  expect(screen.queryByText(/unrelated scheduler event|unrelated cell answer|unrelated sandbox response/)).toBeNull();

  await fireEvent.click(screen.getByRole('button', { name: '产物' }));
  expect(screen.getByText(/confirmed cell answer/)).toBeTruthy();
  expect(screen.getByText('/logs/output.txt')).toBeTruthy();
  expect(screen.getByText('/data/sessions/sandbox-1/state/cells/cell-1')).toBeTruthy();
  expect(await screen.findByRole('button', { name: '打开 Workspace 文件 /workspace/2026-07-21/report.md' })).toBeTruthy();
  expect(screen.queryByText('confirmed scheduler start')).toBeNull();
});

test('shows the parent Scheduler Event ID below Trigger ID and links to Event detail', async () => {
  const projectRunId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-run-1:agent:1');
  store.runtimeView = { level: 'run-detail', agentName: 'worker', runId: projectRunId, sessionId: '' };
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({
      runId: projectRunId, agentName: 'worker', source: RunSource.SCHEDULER,
      schedulerId: 'scheduler-1', triggerId: 'siem-alert-handler', status: RunStatus.SUCCEEDED,
    }),
  }) });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'loader-start', runId: 'loader-run-1', triggerId: 'siem-alert-handler', type: 'loader.run.started' }),
  ], nextCursor: '' });
  mocks.projectService.getSchedulerRun.mockResolvedValue(new GetSchedulerRunResponse({
    run: new SchedulerRun({ payloadJson: '{"payload":{"eventId":"evt/siem-1"}}' }),
  }));

  const { container } = render(RunDetailView);

  const link = await screen.findByRole('link', { name: 'evt/siem-1' });
  expect(link).toHaveAttribute('href', '/agent-compose/events/evt%2Fsiem-1');
  expect(Array.from(container.querySelectorAll('.identifier-list dt')).map(node => node.textContent))
    .toEqual(['Run ID', 'Scheduler ID', 'Trigger ID', 'Event ID']);
});

test('keeps Scheduler evidence usable when optional Event metadata is unavailable', async () => {
  const projectRunId = await stableProjectRunId('project-1', 'worker', 'scheduler', 'loader-run-1:agent:1');
  store.runtimeView = { level: 'run-detail', agentName: 'worker', runId: projectRunId, sessionId: '' };
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: projectRunId, agentName: 'worker', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED }),
  }) });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'loader-start', runId: 'loader-run-1', type: 'loader.run.started', message: 'confirmed scheduler start' }),
  ], nextCursor: '' });
  mocks.projectService.getSchedulerRun.mockRejectedValue(new Error('metadata unavailable'));

  render(RunDetailView);

  expect(await screen.findByText('confirmed scheduler start')).toBeInTheDocument();
  expect(screen.queryByText('Event ID')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('merges parent Scheduler logs for a manually triggered child Agent Run without Scheduler fields', async () => {
  const projectRunId = await stableProjectRunId('project-1', 'script-agent', 'scheduler', 'loader-manual-1:agent:1');
  store.runtimeView = { level: 'run-detail', agentName: 'script-agent', runId: projectRunId, sessionId: '' };
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({
      runId: projectRunId, agentName: 'script-agent', source: RunSource.MANUAL,
      status: RunStatus.SUCCEEDED, completedAt: '2026-07-15T01:01:00Z',
    }),
  }) });
  mocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
    new SchedulerEvent({ id: 'loader-start', runId: 'loader-manual-1', type: 'loader.run.started', message: 'Loader started' }),
    new SchedulerEvent({ id: 'scheduler-log', runId: 'loader-manual-1', type: 'loader.log', message: 'yaml scheduler script interval executed' }),
  ], nextCursor: '' });

  render(RunDetailView);

  expect(await screen.findByText('Loader started')).toBeInTheDocument();
  expect(screen.getByText('yaml scheduler script interval executed')).toBeInTheDocument();
  expect(mocks.projectService.listSchedulerEvents).toHaveBeenCalledWith(expect.objectContaining({
    project: expect.objectContaining({ projectId: 'project-1' }), agentName: 'script-agent',
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test('pages structured events and renders them instead of inferred log evidence', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.listRunEvents
    .mockResolvedValueOnce({
      events: [new RunEvent({ id: 'event-2', seq: 2n, kind: RunEventKind.STATUS, success: false, exitCode: 9, stopReason: 'timeout' })],
      nextCursor: 'next', historyAvailable: true,
    })
    .mockResolvedValueOnce({
      events: [new RunEvent({ id: 'event-1', seq: 1n, kind: RunEventKind.AGENT_MESSAGE, agent: 'worker', text: 'structured answer' })],
      nextCursor: '', historyAvailable: true,
    });
  mocks.runService.followRunLogs.mockReturnValue(streamOf(logChunk('$ inferred command', 10)));

  render(RunDetailView);

  expect(await screen.findByText('structured answer')).toBeTruthy();
  expect(screen.getByText('智能体消息 · worker')).toBeTruthy();
  expect(screen.getByText(/失败 · 退出码 9/)).toBeTruthy();
  expect(screen.getByText(/停止原因：timeout/)).toBeTruthy();
  expect(screen.queryByText(/inferred command/)).toBeNull();
  expect(mocks.runService.listRunEvents.mock.calls.map(([request]) => request.cursor)).toEqual(['', 'next']);
  expect(mocks.runService.followRunLogs).not.toHaveBeenCalled();
});

test('ignores deferred structured history after the run identity changes', async () => {
  const old = deferred<any>();
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.listRunEvents
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ events: [new RunEvent({ id: 'new', seq: 1n, text: 'new evidence' })], historyAvailable: true });

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.listRunEvents).toHaveBeenCalledTimes(1));
  store.runtimeView = { level: 'run-detail', agentName: 'next', runId: 'run-2', sessionId: '' };
  expect(await screen.findByText('new evidence')).toBeTruthy();
  old.resolve({ events: [new RunEvent({ id: 'old', seq: 1n, text: 'old evidence' })], historyAvailable: true });
  await old.promise;
  await Promise.resolve();
  expect(screen.queryByText('old evidence')).toBeNull();
});

test('ignores a deferred old detail after the run identity changes', async () => {
  const old = deferred<any>();
  mocks.runService.getRun.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-2', agentName: 'new-agent', status: RunStatus.SUCCEEDED }) }) });
  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.getRun).toHaveBeenCalledTimes(1));
  store.runtimeView = { level: 'run-detail', agentName: 'new-agent', runId: 'run-2', sessionId: '' };
  expect(await screen.findByText('new-agent 运行完成')).toBeTruthy();
  old.resolve({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'old-agent', status: RunStatus.RUNNING }) }) });
  await old.promise;
  await Promise.resolve();
  expect(screen.queryByText('old-agent 运行中')).toBeNull();
});

test('aborts the underlying pending log RPC when run identity changes', async () => {
  mocks.runService.getRun.mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }) })
    .mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-2', agentName: 'next', status: RunStatus.SUCCEEDED }) }) });
  const signals: AbortSignal[] = [];
  mocks.runService.followRunLogs.mockImplementation((_request, options) => { signals.push(options.signal); return responseStream(); });
  render(RunDetailView);
  await waitFor(() => expect(signals).toHaveLength(1));
  store.activeProjectId = 'project-2';
  store.runtimeView = { level: 'run-detail', agentName: 'next', runId: 'run-2', sessionId: '' };
  expect(await screen.findByText('next 运行完成')).toBeTruthy();
  expect(signals[0].aborted).toBe(true);
});

test('restarts the initial log request in live mode after a RUNNING detail loads', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }),
  });
  mocks.runService.followRunLogs.mockReturnValue(emptyLogs());

  render(RunDetailView);

  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow === true)).toBe(true));
  expect(mocks.runService.followRunLogs.mock.calls.at(-1)?.[0].follow).toBe(true);
});

test('resets live mode when switching from a RUNNING run to a terminal run', async () => {
  mocks.runService.getRun
    .mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }) })
    .mockResolvedValueOnce({ run: new RunDetail({ summary: new RunSummary({ runId: 'run-2', agentName: 'next', status: RunStatus.SUCCEEDED }) }) });
  mocks.runService.followRunLogs.mockImplementation((request) => request.follow ? responseStream() : emptyLogs());

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow === true)).toBe(true));
  store.runtimeView = { level: 'run-detail', agentName: 'next', runId: 'run-2', sessionId: '' };

  expect(await screen.findByText('next 运行完成')).toBeTruthy();
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.at(-1)?.[0].runId).toBe('run-2'));
  expect(mocks.runService.followRunLogs.mock.calls.at(-1)?.[0].follow).toBe(false);
  expect(await screen.findByRole('button', { name: '加载更多（显示最近 500 行）' })).toBeEnabled();
});

test('loads 100 lines first, then 500, then all', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.followRunLogs
    .mockReturnValueOnce(streamOf(logChunk('tail-100', 100)))
    .mockReturnValueOnce(streamOf(logChunk('tail-500', 500)))
    .mockReturnValueOnce(streamOf(logChunk('all', 0)));

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls[0][0].tailLines).toBe(100));
  await fireEvent.click(await screen.findByRole('button', { name: '加载更多（显示最近 500 行）' }));
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls[1][0].tailLines).toBe(500));
  await fireEvent.click(await screen.findByRole('button', { name: '加载全部日志' }));
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls[2][0].tailLines).toBe(0));
  expect(await screen.findByText('已加载全部日志')).toBeTruthy();
});

test('completes the initial RUNNING snapshot before starting persistent follow', async () => {
  const initial = controlledStream();
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }),
  });
  mocks.runService.followRunLogs.mockImplementation((request) => request.follow ? responseStream() : initial);

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs).toHaveBeenCalledTimes(1));
  expect(mocks.runService.followRunLogs.mock.calls[0][0]).toMatchObject({ follow: false, tailLines: 100 });
  expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow)).toBe(false);
  initial.close();
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls[1][0]).toMatchObject({ follow: true, tailLines: 100 }));
});

test('commits RUNNING tail-500 only after its finite snapshot completes', async () => {
  const tail500 = controlledStream();
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }),
  });
  mocks.runService.followRunLogs.mockImplementation((request) => {
    if (!request.follow && request.tailLines === 500) return tail500;
    return request.follow ? responseStream() : emptyLogs();
  });

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 100)).toBe(true));
  await fireEvent.click(await screen.findByRole('button', { name: '加载更多（显示最近 500 行）' }));
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => !request.follow && request.tailLines === 500)).toBe(true));
  expect(screen.getByText(/显示最近 100 行 · 已展示 \d+ \/ \d+ 条/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '加载更多（显示最近 500 行）' })).toBeDisabled();
  expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 500)).toBe(false);
  tail500.close();
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 500)).toBe(true));
  expect(screen.getByText(/显示最近 500 行 · 已展示 \d+ \/ \d+ 条/)).toBeTruthy();
});

test('commits RUNNING all only after its finite snapshot completes', async () => {
  const all = controlledStream();
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }),
  });
  mocks.runService.followRunLogs.mockImplementation((request) => {
    if (!request.follow && request.tailLines === 0) return all;
    return request.follow ? responseStream() : emptyLogs();
  });

  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 100)).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: '加载更多（显示最近 500 行）' }));
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 500)).toBe(true));
  await fireEvent.click(await screen.findByRole('button', { name: '加载全部日志' }));
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => !request.follow && request.tailLines === 0)).toBe(true));
  expect(screen.queryByText('已加载全部日志')).toBeNull();
  expect(screen.getByRole('button', { name: '加载全部日志' })).toBeDisabled();
  all.close();
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 0)).toBe(true));
  expect(await screen.findByText('已加载全部日志')).toBeTruthy();
});

test('does not skip to all while the RUNNING tail-500 snapshot is pending', async () => {
  const tail500 = controlledStream();
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING }) }),
  });
  mocks.runService.followRunLogs.mockImplementation((request) => {
    if (!request.follow && request.tailLines === 500) return tail500;
    return request.follow ? responseStream() : emptyLogs();
  });
  render(RunDetailView);
  await waitFor(() => expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.follow && request.tailLines === 100)).toBe(true));
  const button = screen.getByRole('button', { name: '加载更多（显示最近 500 行）' });
  await fireEvent.click(button);
  await fireEvent.click(button);
  expect(mocks.runService.followRunLogs.mock.calls.some(([request]) => request.tailLines === 0)).toBe(false);
});

test('shows a distinct successful zero-line log result', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.followRunLogs.mockReturnValue(emptyLogs());
  render(RunDetailView);
  expect(await screen.findByText('日志接口返回 0 行')).toBeTruthy();
});

test('keeps loaded logs and exposes the complete error when loading a wider window fails', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.followRunLogs
    .mockReturnValueOnce(streamOf(logChunk('existing line', 10)))
    .mockImplementationOnce(() => { throw new Error('rpc failed\ntransport detail'); });

  render(RunDetailView);
  expect(await screen.findByText('existing line')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '加载更多（显示最近 500 行）' }));
  expect(await screen.findByText(/rpc failed\s+transport detail/)).toBeTruthy();
  expect(screen.getByText('existing line')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重试日志加载' })).toBeTruthy();
});

test('retries the same tail-100 scope after the initial log request fails', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: failedRunDetail() });
  mocks.runService.followRunLogs
    .mockImplementationOnce(() => { throw new Error('initial failed'); })
    .mockReturnValueOnce(streamOf(logChunk('retry line', 10)));

  render(RunDetailView);
  await fireEvent.click(await screen.findByRole('button', { name: '重试日志加载' }));

  await waitFor(() => expect(mocks.runService.followRunLogs).toHaveBeenCalledTimes(2));
  expect(mocks.runService.followRunLogs.mock.calls[1][0].tailLines).toBe(100);
  expect(await screen.findByText('retry line')).toBeTruthy();
});

test('shows every failure field when a failed run has no output', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({
      summary: new RunSummary({ status: RunStatus.FAILED, exitCode: 9, error: 'agent stack' }),
      output: '', cleanupError: 'cleanup stack', warnings: ['warning detail'],
    }),
  });
  render(RunDetailView);
  expect(await screen.findByText('agent stack')).toBeTruthy();
  expect(screen.getByText('cleanup stack')).toBeTruthy();
  expect(screen.getByText('warning detail')).toBeTruthy();
  expect(screen.getByText('退出码 9')).toBeTruthy();
});

test('hides protobuf-default exit code for RUNNING and shows elapsed timeline time', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({
      runId: 'run-1', agentName: 'worker', status: RunStatus.RUNNING,
      startedAt: '2026-07-15T01:00:00Z',
    }) }),
  });
  mocks.runService.followRunLogs.mockImplementation((request) => request.follow
    ? streamOf(logChunk('timed line', 10))
    : emptyLogs());
  render(RunDetailView);
  expect(await screen.findByText('timed line')).toBeTruthy();
  expect(screen.queryByText('退出码 0')).toBeNull();
  expect(screen.getByText('+30.0s')).toBeTruthy();
});

test('keeps execution evidence in one view instead of replacing it with related metadata', async () => {
  mocks.runService.getRun.mockResolvedValue({ run: relatedRunDetail() });
  mocks.runService.followRunLogs.mockReturnValue(streamOf(logChunk('certain line', 10)));
  render(RunDetailView);

  expect(await screen.findByText('certain line')).toBeTruthy();
  expect(screen.getAllByText('scheduler-1').length).toBeGreaterThan(0);
  expect(screen.getAllByText('nightly').length).toBeGreaterThan(0);
  expect(screen.getAllByText('sandbox-1').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: '关联日志' })).toBeNull();
  expect(screen.queryByText('docker')).toBeNull();
  expect(screen.queryByText('guest:latest')).toBeNull();
});

test('opens the project-level Sandbox detail from the clickable Sandbox ID', async () => {
  const navigate = vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  mocks.runService.getRun.mockResolvedValue({ run: relatedRunDetail() });
  render(RunDetailView);

  await fireEvent.click(await screen.findByRole('button', { name: 'sandbox-1' }));
  expect(screen.queryByRole('button', { name: '查看 Sandbox 详情' })).toBeNull();
  expect(navigate).toHaveBeenCalledWith('sandbox-detail', { sandboxId: 'sandbox-1' });
});

test('preserves loaded run logs without a related-resource empty state', async () => {
  mocks.runService.getRun.mockResolvedValue({
    run: new RunDetail({ summary: new RunSummary({ runId: 'run-1', status: RunStatus.SUCCEEDED }) }),
  });
  mocks.runService.followRunLogs.mockReturnValue(streamOf(logChunk('kept line', 10)));
  render(RunDetailView);

  expect(await screen.findByText('kept line')).toBeTruthy();
  expect(screen.queryByText('本次 Run 没有 Scheduler/Trigger 关联')).toBeNull();
  expect(screen.queryByText('本次 Run 没有 Sandbox 关联')).toBeNull();
  expect(screen.getByText(/显示最近 100 行 · 已展示 \d+ \/ \d+ 条/)).toBeTruthy();
});

test('does not toast when sandbox history is gone for a canceled run', async () => {
  // run 取消后 sandbox 被清理，metadata.json 不存在，listSandboxHistory 返回 NotFound，不应弹 toast。
  mocks.runService.getRun.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({
      runId: 'run-1', agentName: 'worker', source: RunSource.MANUAL,
      sandboxId: 'sandbox-gone', status: RunStatus.CANCELED,
      completedAt: '2026-07-15T01:01:00Z',
    }),
    prompt: 'Sandbox 删除后仍保留的提问',
    output: 'Sandbox 删除后仍保留的回答',
    resultJson: '{"cellId":"cell-1"}',
  }) });
  mocks.sandboxService.listSandboxHistory.mockRejectedValue(
    new ConnectError('read session metadata sandbox-gone: no such file or directory', Code.NotFound),
  );

  render(RunDetailView);

  await waitFor(() => expect(mocks.sandboxService.listSandboxHistory).toHaveBeenCalledTimes(1));
  // reject 之后的 catch 在微任务中执行，flush 后再断言 toast 未被触发。
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(screen.getByText('Sandbox 删除后仍保留的提问')).toBeTruthy();
  expect(screen.getAllByText('Sandbox 删除后仍保留的回答').length).toBeGreaterThan(0);
  expect(store.addToast).not.toHaveBeenCalled();
});
