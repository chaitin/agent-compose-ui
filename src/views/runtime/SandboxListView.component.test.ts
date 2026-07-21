import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import SandboxListView from './SandboxListView.svelte';
import { MetricStatus, MetricValue, Sandbox, SandboxStats } from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  runService: { listRuns: vi.fn(), startRun: vi.fn() },
  execService: { exec: vi.fn(), execStream: vi.fn(), execAttach: vi.fn() },
  sandboxService: { listSandboxes: vi.fn(), getSandboxStats: vi.fn(), stopSandbox: vi.fn(), resumeSandbox: vi.fn(), removeSandbox: vi.fn() },
  attachFrames: [] as any[],
  terminals: [] as Array<{ disposed: boolean }>,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
vi.mock('../../lib/rpc', () => mocks);
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  rows = 24;
  cols = 80;
  disposed = false;
  constructor() { mocks.terminals.push(this); }
  loadAddon() {}
  open() {}
  write() {}
  writeln() {}
  dispose() { this.disposed = true; }
  onData() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sandboxService.getSandboxStats.mockReset();
  mocks.attachFrames = [];
  mocks.terminals = [];
  store.activeProjectId = 'project-1';
  store.runtimeView = { level: 'agent-sandboxes', agentName: 'reviewer', runId: '', sessionId: '' };
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  vi.spyOn(store, 'navigateBack').mockImplementation(() => {});
  history.replaceState(null, '', '/#/project/project-1/agent/reviewer/sandboxes');
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [new Sandbox({ sandboxId: 'sandbox-1', projectId: 'project-1', agentName: 'reviewer', status: 'running' })], nextCursor: '' });
  mocks.execService.execStream.mockImplementation(async function* () {});
  mocks.execService.execAttach.mockImplementation(async function* (requests: AsyncIterable<any>) {
    for await (const frame of requests) mocks.attachFrames.push(frame);
  });
  mocks.runService.startRun.mockResolvedValue({});
  mocks.sandboxService.stopSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'live', status: 'stopped' }) });
  mocks.sandboxService.resumeSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'sandbox/a b', status: 'running' }) });
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({ sandboxId: 'sandbox-1', driver: 'docker' }) });
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
});

test('loads authoritative sandbox inventory and renders direct metadata', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [new Sandbox({
    sandboxId: 'sandbox-direct', projectId: 'project-1', agentName: 'reviewer', status: 'running',
    title: 'Review workspace', driver: 'docker', image: 'reviewer:latest', workspacePath: 'workspace/path',
    triggerSource: 'run', proxyPath: '/proxy/sandbox-direct', cellCount: 3, eventCount: 7,
  })], nextCursor: '' });

  render(SandboxListView);

  expect(await screen.findByText('workspace/path')).toBeInTheDocument();
  expect(screen.getByText('3 cells')).toBeInTheDocument();
  expect(mocks.sandboxService.listSandboxes).toHaveBeenCalled();
  expect(mocks.runService.listRuns).not.toHaveBeenCalled();
  expect(mocks.sandboxService.getSandboxStats).not.toHaveBeenCalled();
});

test('scopes inventory to the Agent and gates actions by backend lifecycle', async () => {
  store.runtimeView = { level: 'agent-sandboxes', agentName: 'reviewer', runId: '', sessionId: '' };
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [
    new Sandbox({ sandboxId: 'live', projectId: 'project-1', agentName: 'reviewer', status: 'running' }),
    new Sandbox({ sandboxId: 'stopped', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' }),
    new Sandbox({ sandboxId: 'gone', projectId: 'project-1', agentName: 'reviewer', status: 'destroyed' }),
    new Sandbox({ sandboxId: 'unknown', projectId: 'project-1', agentName: 'reviewer', status: 'pending' }),
  ], nextCursor: '' });
  render(SandboxListView);

  await waitFor(() => expect(mocks.sandboxService.listSandboxes).toHaveBeenCalled());
  const live = (await screen.findByText('live')).closest('article')!;
  await waitFor(() => expect(within(live).getByText('运行中')).toBeTruthy());
  expect(within(live).getByRole('button', { name: 'Terminal' })).toBeTruthy();
  expect(within(live).getByRole('button', { name: '强制删除' })).toBeTruthy();

  const stopped = screen.getByText('stopped').closest('article')!;
  expect(await within(stopped).findByText('已停止 · 可恢复')).toBeTruthy();
  expect(within(stopped).getByRole('button', { name: '恢复' })).toBeTruthy();
  expect(within(stopped).getByRole('button', { name: '删除 Sandbox' })).toBeTruthy();
  expect(within(stopped).queryByRole('button', { name: 'Terminal' })).toBeNull();

  const gone = screen.getByText('gone').closest('article')!;
  expect(await within(gone).findByText('已销毁')).toBeTruthy();
  expect(within(gone).queryByRole('button', { name: '恢复' })).toBeNull();

  const unknown = screen.getByText('unknown').closest('article')!;
  expect(await within(unknown).findByText('状态未知')).toBeTruthy();
  expect(within(unknown).getByRole('button', { name: '重新检测' })).toBeTruthy();
});

test('loads every Sandbox cursor page', async () => {
  store.runtimeView = { level: 'agent-sandboxes', agentName: 'reviewer', runId: '', sessionId: '' };
  mocks.sandboxService.listSandboxes
    .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'sandbox-0', projectId: 'project-1', agentName: 'reviewer', status: 'running' })], nextCursor: 'next' })
    .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'sandbox-100', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' })], nextCursor: '' });
  render(SandboxListView);

  expect(await screen.findByText('sandbox-100')).toBeTruthy();
  expect(mocks.sandboxService.listSandboxes.mock.calls.map(([request]) => request.cursor)).toEqual(['', 'next']);
});

test('ignores a deferred inventory rejection after the project changes', async () => {
  const stale = deferred<any>();
  mocks.sandboxService.listSandboxes
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'sandbox-project-2', projectId: 'project-2', agentName: 'reviewer', status: 'running' })], nextCursor: '' });
  render(SandboxListView);
  await waitFor(() => expect(mocks.sandboxService.listSandboxes).toHaveBeenCalledTimes(1));

  store.activeProjectId = 'project-2';
  expect(await screen.findByText('sandbox-project-2')).toBeTruthy();
  stale.reject(new Error('stale project-1 failure'));

  await waitFor(() => expect(mocks.sandboxService.listSandboxes).toHaveBeenCalledTimes(2));
  expect(screen.getByText('sandbox-project-2')).toBeTruthy();
  expect(screen.queryByText(/stale project-1 failure/)).toBeNull();
  expect(store.addToast).not.toHaveBeenCalledWith('stale project-1 failure', 'error');
});

test('opens a project-level detail from the Sandbox summary', async () => {
  const navigate = vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  render(SandboxListView);

  await fireEvent.click(await screen.findByRole('button', { name: '查看 sandbox-1 详情' }));
  expect(navigate).toHaveBeenCalledWith('sandbox-detail', { sandboxId: 'sandbox-1' });
});

test('renders destroyed Sandbox without live actions', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [new Sandbox({ sandboxId: 'gone', projectId: 'project-1', agentName: 'reviewer', status: 'destroyed' })], nextCursor: '' });
  render(SandboxListView);

  const gone = (await screen.findByText('gone')).closest('article')!;
  expect(within(gone).getByText('已销毁')).toBeTruthy();
  expect(within(gone).queryByRole('button', { name: 'Terminal' })).toBeNull();
});

test('uses lifecycle-specific remove force values', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [
    new Sandbox({ sandboxId: 'live', projectId: 'project-1', agentName: 'reviewer', status: 'running' }),
    new Sandbox({ sandboxId: 'stopped', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' }),
  ], nextCursor: '' });
  mocks.sandboxService.removeSandbox.mockResolvedValue({ removed: true });
  render(SandboxListView);

  await fireEvent.click(await screen.findByRole('button', { name: '强制删除' }));
  await fireEvent.click(await screen.findByRole('button', { name: '删除 Sandbox' }));
  expect(mocks.sandboxService.removeSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'live', force: true }));
  expect(mocks.sandboxService.removeSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'stopped', force: false }));
});

test('stops a running Sandbox through the direct lifecycle RPC', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [
    new Sandbox({ sandboxId: 'live', projectId: 'project-1', agentName: 'reviewer', status: 'running' }),
    new Sandbox({ sandboxId: 'stopped', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' }),
  ], nextCursor: '' });
  render(SandboxListView);

  const live = (await screen.findByText('live')).closest('article')!;
  const stopped = screen.getByText('stopped').closest('article')!;
  await waitFor(() => expect(within(live).getByRole('button', { name: '停止' })).toBeTruthy());
  expect(within(stopped).queryByRole('button', { name: '停止' })).toBeNull();

  await fireEvent.click(within(live).getByRole('button', { name: '停止' }));
  expect(mocks.sandboxService.stopSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'live' }));
  expect(mocks.runService.startRun).not.toHaveBeenCalled();
});

test('does not stop a running Sandbox when confirmation is canceled', async () => {
  (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false);
  render(SandboxListView);
  const row = (await screen.findByText('sandbox-1')).closest('article')!;
  await fireEvent.click(await within(row).findByRole('button', { name: '停止' }));
  expect(mocks.sandboxService.stopSandbox).not.toHaveBeenCalled();
  expect(mocks.runService.startRun).not.toHaveBeenCalled();
});

test('restores through the direct lifecycle RPC and opens the same-origin Jupyter proxy', async () => {
  mocks.sandboxService.listSandboxes
    .mockResolvedValueOnce({ sandboxes: [new Sandbox({ sandboxId: 'sandbox/a b', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' })], nextCursor: '' })
    .mockResolvedValue({ sandboxes: [new Sandbox({ sandboxId: 'sandbox/a b', projectId: 'project-1', agentName: 'reviewer', status: 'running' })], nextCursor: '' });
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(SandboxListView);
  await screen.findByText('sandbox/a b');

  await fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
  expect(mocks.sandboxService.resumeSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox/a b' }));
  expect(mocks.runService.startRun).not.toHaveBeenCalled();

  await fireEvent.click(await screen.findByRole('button', { name: 'Jupyter' }));
  expect(open).toHaveBeenCalledWith('/jupyter/sandbox%2Fa%20b', '_blank', 'noopener,noreferrer');
});

test('shows a clear message when a deleted Sandbox cannot be resumed', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({
    sandboxes: [new Sandbox({ sandboxId: 'deleted-sandbox', projectId: 'project-1', agentName: 'reviewer', status: 'stopped' })],
    nextCursor: '',
  });
  mocks.sandboxService.resumeSandbox.mockRejectedValue(new Error(
    'docker runtime state for stopped sandbox deleted-sandbox is missing; refusing to recreate it during resume: only canonical legacy UUID sandboxes may be reconstructed',
  ));
  render(SandboxListView);

  await fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
  await waitFor(() => expect(store.addToast).toHaveBeenCalledWith('该 Sandbox 已被删除，无法恢复', 'error'));
  expect(store.addToast).not.toHaveBeenCalledWith(expect.stringContaining('canonical legacy UUID'), 'error');
});

test('closes and disposes a terminal when the active project changes', async () => {
  mocks.sandboxService.listSandboxes.mockImplementation(() => Promise.resolve({ sandboxes: [new Sandbox({ sandboxId: `sandbox-${store.activeProjectId}`, projectId: store.activeProjectId, agentName: 'reviewer', status: 'running' })], nextCursor: '' }));
  render(SandboxListView);
  await screen.findByText('sandbox-project-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  const projectOneTerminal = mocks.terminals[0];

  store.activeProjectId = 'project-2';
  await waitFor(() => expect(screen.queryByRole('button', { name: '关闭' })).toBeNull());
  expect(location.search).toBe('');
  await waitFor(() => expect(projectOneTerminal.disposed).toBe(true));

  history.pushState(null, '', '/?sandboxTool=terminal&sandboxId=sandbox-project-1#/project/project-2/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '关闭' })).toBeNull());
});

test('mounts a fresh terminal instead of carrying one into another project', async () => {
  mocks.sandboxService.listSandboxes.mockImplementation(() => Promise.resolve({ sandboxes: [new Sandbox({ sandboxId: `sandbox-${store.activeProjectId}`, projectId: store.activeProjectId, agentName: 'reviewer', status: 'running' })], nextCursor: '' }));
  render(SandboxListView);
  await screen.findByText('sandbox-project-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  const projectOneTerminal = mocks.terminals[0];

  store.activeProjectId = 'project-2';
  await screen.findByText('sandbox-project-2');
  await waitFor(() => expect(projectOneTerminal.disposed).toBe(true));
  await fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  await waitFor(() => expect(mocks.terminals).toHaveLength(2));
  expect(mocks.terminals[1].disposed).toBe(false);
});

test('synchronizes files target and closes it across browser history navigation', async () => {
  render(SandboxListView);
  await waitFor(() => expect(screen.getByText('sandbox-1')).toBeTruthy());

  history.pushState(null, '', '/?sandboxTool=files&sandboxId=sandbox-1#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(await screen.findByRole('button', { name: '关闭' })).toBeTruthy();
  expect(screen.getAllByText('sandbox-1').length).toBeGreaterThan(1);

  history.pushState(null, '', '/#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '关闭' })).toBeNull());
});

test('opens a valid initial tool query only after current-project inventory confirms it', async () => {
  history.replaceState(null, '', '/?sandboxTool=files&sandboxId=sandbox-1#/project/project-1/sandboxes');
  render(SandboxListView);
  expect(await screen.findByRole('button', { name: '关闭' })).toBeTruthy();
  expect(location.search).toContain('sandboxId=sandbox-1');
});

test('tears down terminal A before mounting terminal B from same-project popstate', async () => {
  mocks.sandboxService.listSandboxes.mockResolvedValue({ sandboxes: [
    new Sandbox({ sandboxId: 'sandbox-a', projectId: 'project-1', agentName: 'reviewer', status: 'running' }),
    new Sandbox({ sandboxId: 'sandbox-b', projectId: 'project-1', agentName: 'reviewer', status: 'running' }),
  ], nextCursor: '' });
  render(SandboxListView);
  await screen.findByText('sandbox-a');
  history.pushState(null, '', '/?sandboxTool=terminal&sandboxId=sandbox-a#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  const terminalA = mocks.terminals[0];

  history.pushState(null, '', '/?sandboxTool=terminal&sandboxId=sandbox-b#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(mocks.terminals).toHaveLength(2));
  expect(terminalA.disposed).toBe(true);
  expect(mocks.terminals[1].disposed).toBe(false);
  expect(screen.getAllByText('sandbox-b').length).toBeGreaterThan(1);
});

test('recreates tool content when switching files and terminal on one sandbox', async () => {
  render(SandboxListView);
  await screen.findByText('sandbox-1');
  history.pushState(null, '', '/?sandboxTool=terminal&sandboxId=sandbox-1#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(mocks.terminals).toHaveLength(1));
  const firstTerminal = mocks.terminals[0];

  history.pushState(null, '', '/?sandboxTool=files&sandboxId=sandbox-1#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(firstTerminal.disposed).toBe(true));
  history.pushState(null, '', '/?sandboxTool=terminal&sandboxId=sandbox-1#/project/project-1/sandboxes');
  window.dispatchEvent(new PopStateEvent('popstate'));
  await waitFor(() => expect(mocks.terminals).toHaveLength(2));
  expect(mocks.terminals[1].disposed).toBe(false);
});

test('renders every v2 sandbox metric and unavailable status messages without inventing zeroes', async () => {
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({
    sandboxId: 'sandbox-1', driver: 'docker', sampledAt: '2026-07-15T12:00:00Z',
    cpuPercent: new MetricValue({ value: 12.5, unit: '%', status: MetricStatus.OK }),
    memoryUsageBytes: new MetricValue({ value: 1024, unit: 'B', status: MetricStatus.OK }),
    memoryLimitBytes: new MetricValue({ value: 2048, unit: 'B', status: MetricStatus.OK }),
    memoryPercent: new MetricValue({ value: 50, unit: '%', status: MetricStatus.OK }),
    networkRxBytes: new MetricValue({ value: 300, unit: 'B', status: MetricStatus.OK }),
    networkTxBytes: new MetricValue({ status: MetricStatus.UNAVAILABLE, message: 'driver 不提供发送统计' }),
    blockReadBytes: new MetricValue({ value: 400, unit: 'B', status: MetricStatus.OK }),
    blockWriteBytes: new MetricValue({ status: MetricStatus.UNKNOWN, message: '块写入尚未采样' }),
    uptimeSeconds: new MetricValue({ value: 65, unit: 's', status: MetricStatus.OK }),
  }) });
  render(SandboxListView);
  await screen.findByText('sandbox-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Stats' }));

  for (const value of [/CPU 12\.5%.*可用/, /内存使用 1\.0 KB.*可用/, /内存上限 2\.0 KB.*可用/, /内存占比 50\.0%.*可用/, /网络接收 300\.0 B.*可用/, /块读取 400\.0 B.*可用/, /运行时间 1m 5s.*可用/]) {
    expect(await screen.findByText(value)).toBeInTheDocument();
  }
  expect(screen.getByText(/网络发送.*不可用.*driver 不提供发送统计/)).toBeInTheDocument();
  expect(screen.getByText(/块写入.*未知.*块写入尚未采样/)).toBeInTheDocument();
  expect(screen.queryByText('网络发送 0.0B')).not.toBeInTheDocument();
  expect(screen.getByText(/采样时间.*2026-07-15T12:00:00Z/)).toBeInTheDocument();
});

test('drops deferred stats when the project changes even if inventory has the same sandbox id', async () => {
  const oldStats = deferred<any>();
  mocks.sandboxService.getSandboxStats.mockReturnValueOnce(oldStats.promise);
  mocks.sandboxService.listSandboxes.mockImplementation(() => Promise.resolve({
    sandboxes: [new Sandbox({ sandboxId: 'shared-sandbox', projectId: store.activeProjectId, agentName: 'reviewer', status: 'running', title: store.activeProjectId })], nextCursor: '',
  }));
  render(SandboxListView);
  await screen.findByText('project-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Stats' }));

  store.activeProjectId = 'project-2';
  await screen.findByText('project-2');
  oldStats.resolve({ stats: new SandboxStats({
    sandboxId: 'shared-sandbox', driver: 'old-project-driver',
    cpuPercent: new MetricValue({ value: 99, unit: '%', status: MetricStatus.OK }),
  }) });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stats' })).not.toBeDisabled());

  expect(screen.queryByText(/old-project-driver/)).not.toBeInTheDocument();
  expect(screen.queryByText(/CPU 99\.0%/)).not.toBeInTheDocument();
});

test('treats OK metrics without optional values as invalid while preserving status evidence and real zeroes', async () => {
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({
    sandboxId: 'sandbox-1',
    cpuPercent: new MetricValue({ status: MetricStatus.OK, message: '采样器未返回值' }),
    memoryUsageBytes: new MetricValue({ value: 0, unit: 'B', status: MetricStatus.OK }),
  }) });
  render(SandboxListView);
  await screen.findByText('sandbox-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Stats' }));

  expect(await screen.findByText(/CPU.*无有效值.*原状态：可用.*采样器未返回值/)).toBeInTheDocument();
  expect(screen.queryByText(/CPU.*不可用（可用/)).not.toBeInTheDocument();
  expect(screen.getByText(/内存使用 0\.0 B.*可用/)).toBeInTheDocument();
});

test('marks an old sample stale and shows a per-sandbox error when stats refresh fails', async () => {
  mocks.sandboxService.getSandboxStats
    .mockResolvedValueOnce({ stats: new SandboxStats({
      sandboxId: 'sandbox-1', sampledAt: 'first-sample',
      cpuPercent: new MetricValue({ value: 8, unit: '%', status: MetricStatus.OK }),
    }) })
    .mockRejectedValueOnce(new Error('stats refresh failed'));
  render(SandboxListView);
  await screen.findByText('sandbox-1');
  await fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
  expect(await screen.findByText(/CPU 8\.0%/)).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
  expect(await screen.findByText(/指标加载失败.*stats refresh failed.*旧样本/)).toBeInTheDocument();
  expect(screen.getByText(/CPU 8\.0%/)).toBeInTheDocument();
});
