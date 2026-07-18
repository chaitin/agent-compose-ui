import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import SandboxDetailView from './SandboxDetailView.svelte';
import {
  MetricStatus, MetricValue, RunAgentRequest, RunDetail, RunEvent, RunEventKind, RunSandboxCleanupPolicy, RunSource, RunStatus, RunSummary, Sandbox, SandboxHistoryCell, SandboxHistoryEvent, SandboxStats,
} from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';

const mocks = vi.hoisted(() => ({
  runService: { listRuns: vi.fn(), listSandboxRunEvents: vi.fn(), startRun: vi.fn(), runAgent: vi.fn() },
  execService: { exec: vi.fn(), execStream: vi.fn(), execAttach: vi.fn() },
  sandboxService: {
    getSandbox: vi.fn(), listSandboxHistory: vi.fn(), watchSandbox: vi.fn(), getSandboxStats: vi.fn(),
    stopSandbox: vi.fn(), resumeSandbox: vi.fn(), removeSandbox: vi.fn(),
  },
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

vi.mock('../../lib/rpc', () => mocks);
vi.mock('@xterm/xterm', () => ({ Terminal: class { rows = 24; cols = 80; loadAddon() {} open() {} write() {} writeln() {} dispose() {} onData() { return { dispose() {} }; } attachCustomKeyEventHandler() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'project-1';
  store.runtimeView = { level: 'sandbox-detail', sandboxId: 'sandbox-1', agentName: '', runId: '', sessionId: '' };
  store.sandboxReturnView = null;
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  vi.spyOn(store, 'navigateTo').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 })));
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-1', projectId: 'project-1', agentName: 'reviewer', status: 'RUNNING', driver: 'docker', title: 'Research',
  }) });
  mocks.sandboxService.listSandboxHistory.mockResolvedValue({
    cells: [
      new SandboxHistoryCell({ id: 'agent-1', type: 'agent', agent: 'reviewer', agentThreadId: 'thread-1', output: 'agent response', success: true }),
      new SandboxHistoryCell({ id: 'python-1', type: 'python', source: 'print(42)', stdout: 'python output', success: true }),
    ],
    events: [new SandboxHistoryEvent({ id: 'history-1', type: 'ready', level: 'info', message: 'sandbox ready' })],
    legacyHistory: false,
  });
  mocks.runService.listSandboxRunEvents.mockResolvedValue({ events: [new RunEvent({ id: 'event-1', runId: 'run-1', kind: RunEventKind.AGENT_MESSAGE, text: 'structured response' })] });
  mocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({ runId: 'run-1', sandboxId: 'sandbox-1', agentName: 'reviewer', status: RunStatus.SUCCEEDED })] });
  mocks.runService.runAgent.mockResolvedValue({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-agent-2', status: RunStatus.SUCCEEDED }), output: 'Agent final answer',
  }) });
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({ sandboxId: 'sandbox-1', driver: 'docker' }) });
  mocks.sandboxService.watchSandbox.mockImplementation(async function* () {});
  mocks.sandboxService.stopSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'sandbox-1', status: 'STOPPED' }) });
  mocks.sandboxService.resumeSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'sandbox-1', status: 'RUNNING' }) });
  mocks.sandboxService.removeSandbox.mockResolvedValue({ removed: true });
  mocks.execService.execStream.mockImplementation(async function* () {});
  mocks.execService.execAttach.mockImplementation(async function* () {});
  history.replaceState(null, '', '/#/project/project-1/sandbox/sandbox-1');
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
});

test('loads authoritative direct detail, history, and structured run events', async () => {
  render(SandboxDetailView);

  expect(await screen.findByText(/agent response/)).toBeTruthy();
  expect(screen.getByText(/python output/)).toBeTruthy();
  expect(screen.getByText(/thread-1/)).toBeTruthy();
  expect(screen.getByText('sandbox ready')).toBeTruthy();
  expect(screen.getByText(/structured response/)).toBeTruthy();
  expect(screen.getByText('全量加载完成 · 已展示 4 / 4 条')).toBeTruthy();
  expect(screen.getByRole('button', { name: '刷新' })).toHaveTextContent('↻');
  expect(mocks.sandboxService.getSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-1' }));
  expect(mocks.sandboxService.listSandboxHistory).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-1' }));
  expect(mocks.runService.listSandboxRunEvents).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-1' }));
});

test('does not load or render the removed related Event section', async () => {
  render(SandboxDetailView);

  await screen.findByText(/agent response/);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByText('关联 Event')).toBeNull();
  expect(screen.queryByText(/关联 Event 加载失败|暂无关联 Event/)).toBeNull();
});

test('loads an explicit sandbox without rendering the project breadcrumb', async () => {
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-explicit', projectId: 'project-explicit', agentName: 'reviewer', status: 'RUNNING', driver: 'docker', title: 'Explicit sandbox',
  }) });

  render(SandboxDetailView, { props: { projectId: 'project-explicit', sandboxId: 'sandbox-explicit', showBreadcrumb: false } });

  expect(await screen.findByRole('tab', { name: '运行详情' })).toBeTruthy();
  expect(screen.getAllByRole('tab').map(tab => tab.textContent?.trim())).toEqual(['运行详情', '快速执行', 'Terminal', 'Files']);
  expect(screen.queryByRole('button', { name: '返回' })).toBeNull();
  expect(screen.queryByText(/Sandbox 详情 · sandbox-explicit/)).toBeNull();
  expect(mocks.sandboxService.getSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-explicit' }));
  expect(mocks.sandboxService.listSandboxHistory).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-explicit' }));
  expect(mocks.runService.listSandboxRunEvents).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-explicit' }));
  expect(mocks.runService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-explicit', sandboxId: 'sandbox-explicit' }));
});

test('shows four accessible tabs and defaults to run details', async () => {
  render(SandboxDetailView);

  await screen.findByText(/agent response/);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent?.trim())).toEqual([
    '运行详情', '快速执行', 'Terminal', 'Files',
  ]);
  expect(screen.getByRole('tab', { name: '运行详情' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel', { name: '运行详情' })).toHaveTextContent('执行详情');
  expect(screen.queryByRole('navigation', { name: 'Sandbox 工具' })).toBeNull();
  expect(screen.getByLabelText('Sandbox 状态与操作')).toHaveTextContent(/Driver\s*docker/);
});

test('shows metric loading state then real CPU, memory, and uptime values', async () => {
  const pending = deferred<{ stats: SandboxStats }>();
  mocks.sandboxService.getSandboxStats.mockReturnValueOnce(pending.promise);
  render(SandboxDetailView);

  const strip = await screen.findByRole('region', { name: 'Sandbox 状态与操作' });
  expect(strip).toHaveTextContent(/CPU\s*加载中/);
  expect(strip).toHaveTextContent(/内存\s*加载中/);
  expect(strip).toHaveTextContent(/Uptime\s*加载中/);

  pending.resolve({ stats: new SandboxStats({
    sandboxId: 'sandbox-1', driver: 'docker',
    cpuPercent: new MetricValue({ value: 12.5, unit: 'percent', status: MetricStatus.OK }),
    memoryUsageBytes: new MetricValue({ value: 1024, unit: 'bytes', status: MetricStatus.OK }),
    uptimeSeconds: new MetricValue({ value: 65, unit: 'seconds', status: MetricStatus.OK }),
  }) });

  await waitFor(() => expect(strip).toHaveTextContent(/CPU\s*12.5%/));
  expect(strip).toHaveTextContent(/内存\s*1.0 KB/);
  expect(strip).toHaveTextContent(/Uptime\s*1m 5s/);
});

test('keeps backend metric reasons visible and puts metrics and actions on one line', async () => {
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({
    sandboxId: 'sandbox-1', driver: 'docker',
    cpuPercent: new MetricValue({ unit: 'percent', status: MetricStatus.UNKNOWN, message: 'docker stats unavailable' }),
  }) });
  render(SandboxDetailView);

  const strip = await screen.findByRole('region', { name: 'Sandbox 状态与操作' });
  await waitFor(() => expect(strip.querySelector('[title="docker stats unavailable"]')).toBeTruthy());
  expect(Array.from(strip.querySelectorAll('.primary-metrics > span')).map(element => element.textContent?.trim())).toEqual([
    expect.stringMatching(/^CPU/), expect.stringMatching(/^内存/), expect.stringMatching(/^Driver/), expect.stringMatching(/^Uptime/),
  ]);
  expect(Array.from(strip.querySelectorAll('button')).map(button => button.textContent?.trim())).toEqual(['↻', '停止', '强制删除']);
});

test('shows only high-value supplemental resource metrics in the top status strip', async () => {
  mocks.sandboxService.getSandboxStats.mockResolvedValue({ stats: new SandboxStats({
    sandboxId: 'sandbox-1', driver: 'docker', sampledAt: '2026-07-15T12:44:36Z',
    memoryLimitBytes: new MetricValue({ value: 4096, unit: 'bytes', status: MetricStatus.OK }),
    memoryPercent: new MetricValue({ value: 25.5, unit: 'percent', status: MetricStatus.OK }),
    networkRxBytes: new MetricValue({ value: 796, unit: 'bytes', status: MetricStatus.OK }),
    networkTxBytes: new MetricValue({ value: 126, unit: 'bytes', status: MetricStatus.OK }),
    blockReadBytes: new MetricValue({ value: 1048576, unit: 'bytes', status: MetricStatus.OK }),
    blockWriteBytes: new MetricValue({ value: 2048, unit: 'bytes', status: MetricStatus.OK }),
  }) });
  render(SandboxDetailView);

  const strip = await screen.findByRole('region', { name: 'Sandbox 状态与操作' });
  await waitFor(() => expect(strip).toHaveTextContent(/采样/));
  expect(strip.querySelector('[title="2026-07-15T12:44:36Z"]')).toBeTruthy();
  expect(strip).not.toHaveTextContent('上限');
  expect(strip).not.toHaveTextContent('内存占用');
  expect(strip).not.toHaveTextContent('接收');
  expect(strip).not.toHaveTextContent('发送');
  expect(strip).not.toHaveTextContent('磁盘读取');
  expect(strip).not.toHaveTextContent('磁盘写入');
  expect(screen.queryByRole('region', { name: '资源指标' })).toBeNull();
});

test('selects panels through sandboxTab and restores a valid URL selection', async () => {
  history.replaceState(null, '', '/?sandboxTab=exec#/project/project-1/sandbox/sandbox-1');
  render(SandboxDetailView);

  expect(await screen.findByRole('tabpanel', { name: '快速执行' })).toBeTruthy();
  await fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
  expect(new URLSearchParams(location.search).get('sandboxTab')).toBe('terminal');
  expect(screen.getByRole('tabpanel', { name: 'Terminal' })).toBeTruthy();
});

test('falls back to run details for an invalid sandboxTab', async () => {
  history.replaceState(null, '', '/?sandboxTab=unknown#/project/project-1/sandbox/sandbox-1');
  render(SandboxDetailView);

  expect(await screen.findByRole('tab', { name: '运行详情' })).toHaveAttribute('aria-selected', 'true');
});

test('hides implementation metadata and legacy-history notices', async () => {
  mocks.sandboxService.listSandboxHistory.mockResolvedValue({ cells: [], events: [], legacyHistory: true });
  render(SandboxDetailView);

  await screen.findByRole('heading', { name: 'Research' });
  expect(screen.queryByRole('region', { name: 'Sandbox 元数据' })).toBeNull();
  expect(screen.queryByText('此 Sandbox 使用旧版历史记录格式。')).toBeNull();
});

test('renders Terminal and Files inline instead of in dialogs', async () => {
  render(SandboxDetailView);
  await screen.findByText(/agent response/);

  await fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
  expect(screen.getByLabelText('Sandbox command terminal')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
  expect(screen.getByRole('tabpanel', { name: 'Files' })).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('hides Jupyter while keeping stop and force delete actions', async () => {
  render(SandboxDetailView);
  await screen.findByRole('heading', { name: 'Research' });

  const actions = screen.getByRole('region', { name: 'Sandbox 状态与操作' });
  expect(Array.from(actions.querySelectorAll('button')).map(button => button.textContent?.trim())).toEqual([
    '↻', '停止', '强制删除',
  ]);
  expect(screen.queryByRole('button', { name: '打开 Jupyter' })).toBeNull();
});

test('does not expose Jupyter or mount live tools for a stopped sandbox', async () => {
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-1', projectId: 'project-1', status: 'STOPPED', title: 'Stopped sandbox',
  }) });
  history.replaceState(null, '', '/?sandboxTab=terminal#/project/project-1/sandbox/sandbox-1');
  render(SandboxDetailView);

  expect(await screen.findByText('Sandbox 未运行，Terminal 不可用。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '打开 Jupyter' })).toBeNull();
  expect(mocks.sandboxService.resumeSandbox).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Sandbox command terminal')).toBeNull();
});

test('restores the selected tab on browser history navigation', async () => {
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: 'Files' }));

  history.replaceState(null, '', '/?sandboxTab=exec#/project/project-1/sandbox/sandbox-1');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(await screen.findByRole('tabpanel', { name: '快速执行' })).toBeTruthy();
});

test('loads every structured run-event cursor page in server order and stops on a repeated cursor', async () => {
  mocks.runService.listSandboxRunEvents
    .mockResolvedValueOnce({ events: [new RunEvent({ id: 'page-1', text: 'first page' })], nextCursor: 'cursor-2' })
    .mockResolvedValueOnce({ events: [new RunEvent({ id: 'page-2', text: 'second page' })], nextCursor: 'cursor-2' });

  render(SandboxDetailView);

  expect(await screen.findByText('first page')).toBeTruthy();
  expect(screen.getByText('second page')).toBeTruthy();
  expect(mocks.runService.listSandboxRunEvents).toHaveBeenCalledTimes(2);
  expect(mocks.runService.listSandboxRunEvents.mock.calls[0][0]).toMatchObject({ sandboxId: 'sandbox-1', limit: 500, cursor: '' });
  expect(mocks.runService.listSandboxRunEvents.mock.calls[1][0]).toMatchObject({ sandboxId: 'sandbox-1', limit: 500, cursor: 'cursor-2' });
});

test('renders one chronological table and keeps associated runs in its final row', async () => {
  render(SandboxDetailView);

  const timeline = await screen.findByRole('region', { name: 'Sandbox 执行时间线' });
  const rows = timeline.querySelectorAll(':scope > article');
  expect(rows.length).toBeGreaterThan(2);
  expect(rows[rows.length - 1]).toHaveClass('related-runs-row');
  expect(rows[rows.length - 1]).toHaveTextContent('关联 Run 历史');
  expect(rows[rows.length - 1]).toHaveTextContent('run-1');
  expect(screen.queryByRole('region', { name: 'Sandbox 单元历史' })).toBeNull();
  expect(screen.queryByRole('region', { name: '结构化 Run 事件' })).toBeNull();
});

test('collapses sandbox timeline details only when content exceeds twenty lines', async () => {
  const twentyLines = Array.from({ length: 20 }, (_, index) => `short-${index + 1}`).join('\n');
  const twentyOneLines = Array.from({ length: 21 }, (_, index) => `long-${index + 1}`).join('\n');
  mocks.sandboxService.listSandboxHistory.mockResolvedValue({ cells: [], events: [], legacyHistory: false });
  mocks.runService.listSandboxRunEvents.mockResolvedValue({ events: [
    new RunEvent({ id: 'twenty', runId: 'run-1', text: twentyLines, success: true }),
    new RunEvent({ id: 'twenty-one', runId: 'run-1', text: twentyOneLines, success: true }),
  ] });
  render(SandboxDetailView);

  const timeline = await screen.findByRole('region', { name: 'Sandbox 执行时间线' });
  const contents = timeline.querySelectorAll('.entry-content');
  expect(contents).toHaveLength(2);
  expect(contents[0]).not.toHaveClass('collapsed');
  expect(contents[1]).toHaveClass('collapsed');

  const toggle = screen.getByRole('button', { name: '展示全部' });
  await fireEvent.click(toggle);
  expect(contents[1]).not.toHaveClass('collapsed');
  expect(toggle).toHaveAccessibleName('收起');
});

test('expands long cell input and result independently after twenty lines', async () => {
  const input = Array.from({ length: 21 }, (_, index) => `input-${index + 1}`).join('\n');
  const result = Array.from({ length: 21 }, (_, index) => `result-${index + 1}`).join('\n');
  mocks.sandboxService.listSandboxHistory.mockResolvedValue({
    cells: [new SandboxHistoryCell({ id: 'long-cell', source: input, output: result, success: true })],
    events: [], legacyHistory: false,
  });
  mocks.runService.listSandboxRunEvents.mockResolvedValue({ events: [] });
  render(SandboxDetailView);

  const expandInput = await screen.findByRole('button', { name: '展开输入' });
  const expandResult = screen.getByRole('button', { name: '展开结果' });
  expect(expandInput).toHaveAttribute('aria-expanded', 'false');
  expect(expandResult).toHaveAttribute('aria-expanded', 'false');

  await fireEvent.click(expandInput);
  expect(expandInput).toHaveAccessibleName('收起输入');
  expect(expandInput).toHaveAttribute('aria-expanded', 'true');
  expect(expandResult).toHaveAccessibleName('展开结果');
  expect(expandResult).toHaveAttribute('aria-expanded', 'false');
});

test('filters sandbox timeline rows through the compact tag bar', async () => {
  render(SandboxDetailView);
  const timeline = await screen.findByRole('region', { name: 'Sandbox 执行时间线' });
  const filters = screen.getByLabelText('Sandbox 时间线筛选');
  expect(Array.from(filters.querySelectorAll('button')).map(button => button.textContent)).toEqual(['全部', 'CELL', 'SANDBOX', 'RUN', '问题']);

  await fireEvent.click(screen.getByRole('button', { name: 'CELL' }));
  expect(screen.getByRole('button', { name: 'CELL' })).toHaveAttribute('aria-pressed', 'true');
  expect(timeline.querySelectorAll(':scope > article:not(.related-runs-row)')).toHaveLength(2);

  await fireEvent.click(screen.getByRole('button', { name: 'SANDBOX' }));
  expect(timeline.querySelectorAll(':scope > article:not(.related-runs-row)')).toHaveLength(1);
  expect(timeline).toHaveTextContent('sandbox ready');
  expect(timeline.querySelector(':scope > article:last-child')).toHaveClass('related-runs-row');
});

test('reveals sandbox timeline rows in pages while scrolling', async () => {
  mocks.runService.listSandboxRunEvents.mockResolvedValue({
    events: Array.from({ length: 35 }, (_, index) => new RunEvent({ id: `event-${index}`, runId: 'run-1', text: `event text ${index}` })),
  });
  render(SandboxDetailView);

  const panel = await screen.findByRole('tabpanel', { name: '运行详情' });
  expect(screen.getByText(/继续向下滚动加载/)).toHaveTextContent('30 / 38');
  Object.defineProperties(panel, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 500 },
    scrollTop: { configurable: true, value: 400 },
  });
  await fireEvent.scroll(panel);

  expect(screen.queryByText(/继续向下滚动加载/)).toBeNull();
  const rows = screen.getByRole('region', { name: 'Sandbox 执行时间线' }).querySelectorAll(':scope > article');
  expect(rows[rows.length - 1]).toHaveClass('related-runs-row');
});

test('keeps metadata and run events when sandbox history fails', async () => {
  mocks.sandboxService.listSandboxHistory.mockRejectedValue(new Error('history offline'));
  render(SandboxDetailView);

  expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
  expect(screen.getByText(/structured response/)).toBeTruthy();
  expect(screen.getByText(/Sandbox 单元历史加载失败.*history offline/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
});

test('keeps metadata and sandbox history when structured run events fail', async () => {
  mocks.runService.listSandboxRunEvents.mockRejectedValue(new Error('events offline'));
  render(SandboxDetailView);

  expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
  expect(screen.getByText(/agent response/)).toBeTruthy();
  expect(screen.getByText(/结构化 Run 事件加载失败.*events offline/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
});

test('uses direct lifecycle RPCs and never creates control runs', async () => {
  const view = render(SandboxDetailView);
  await fireEvent.click(await screen.findByRole('button', { name: '停止' }));
  expect(mocks.sandboxService.stopSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-1' }));
  expect(mocks.runService.startRun).not.toHaveBeenCalled();

  view.unmount();
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'sandbox-1', projectId: 'project-1', status: 'STOPPED' }) });
  render(SandboxDetailView);
  await fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
  expect(mocks.sandboxService.resumeSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-1' }));
  expect(mocks.runService.startRun).not.toHaveBeenCalled();
});

test('ignores a lifecycle response after navigating to another sandbox', async () => {
  const pending = deferred<{ sandbox: Sandbox }>();
  mocks.sandboxService.stopSandbox.mockReturnValue(pending.promise);
  render(SandboxDetailView);
  await fireEvent.click(await screen.findByRole('button', { name: '停止' }));

  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-2', projectId: 'project-1', status: 'RUNNING', title: 'Second sandbox',
  }) });
  store.runtimeView = { ...store.runtimeView, sandboxId: 'sandbox-2' };
  await screen.findByRole('heading', { name: 'Second sandbox' });

  pending.resolve({ sandbox: new Sandbox({ sandboxId: 'sandbox-1', status: 'STOPPED', title: 'Stale sandbox' }) });
  await Promise.resolve();
  await Promise.resolve();

  expect(screen.getByRole('heading', { name: 'Second sandbox' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Stale sandbox' })).toBeNull();
  expect(store.addToast).not.toHaveBeenCalledWith('Sandbox 已停止', 'success');
  expect(screen.getByRole('button', { name: '停止' })).not.toBeDisabled();
});

test('keeps direct detail usable when secondary run navigation fails', async () => {
  mocks.runService.listRuns.mockRejectedValue(new Error('runs offline'));
  render(SandboxDetailView);
  expect(await screen.findByRole('heading', { name: 'Research' })).toBeTruthy();
  expect(screen.getByText(/关联 Run 加载失败/)).toBeTruthy();
});

test('runs Agent in the current sandbox and refreshes associated runs', async () => {
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: ' investigate this ' } });

  expect(screen.getAllByRole('button').map(button => button.textContent?.trim())).not.toContain('Exec');
  await fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
  expect(mocks.runService.runAgent).toHaveBeenCalledWith(expect.objectContaining<Partial<RunAgentRequest>>({
    projectId: 'project-1', agentName: 'reviewer', sandboxId: 'sandbox-1', prompt: 'investigate this',
    source: RunSource.MANUAL, cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING,
  }));
  expect(await screen.findByText('Agent final answer')).toBeTruthy();
  expect(mocks.runService.listRuns).toHaveBeenCalledTimes(2);
  expect(mocks.execService.exec).not.toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ command: '/bin/sh' }) }));
});

test('shows a replying state while waiting for the Agent response', async () => {
  const pending = deferred<{ run: RunDetail }>();
  mocks.runService.runAgent.mockReturnValueOnce(pending.promise);
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'slow task' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Agent' }));

  expect(screen.getByRole('status')).toHaveTextContent('回复中…');

  pending.resolve({ run: new RunDetail({ output: 'Agent reply' }) });
  expect(await screen.findByText('Agent reply')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

test('keeps JavaScript and Python execution through ExecService', async () => {
  mocks.execService.exec.mockResolvedValue({ result: { stdout: 'done' } });
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'print(42)' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Python' }));
  expect(mocks.execService.exec).toHaveBeenCalledWith(expect.objectContaining({
    target: { case: 'sandboxId', value: 'sandbox-1' }, command: expect.objectContaining({ command: 'python3' }),
  }));
  await fireEvent.click(screen.getByRole('button', { name: 'JavaScript' }));
  expect(mocks.execService.exec).toHaveBeenCalledWith(expect.objectContaining({ command: expect.objectContaining({ command: 'node' }) }));
});

test('disables Agent execution when the sandbox has no associated agent', async () => {
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-1', projectId: 'project-1', agentName: '', status: 'RUNNING', title: 'Unassigned',
  }) });
  mocks.runService.listRuns.mockResolvedValue({ runs: [] });
  render(SandboxDetailView);
  await screen.findByRole('heading', { name: 'Unassigned' });
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'hello' } });

  expect(screen.getByRole('button', { name: 'Agent' })).toBeDisabled();
  expect(screen.getByText('该 Sandbox 未关联 Agent')).toBeTruthy();
  expect(mocks.runService.runAgent).not.toHaveBeenCalled();
});

test('recovers the Agent association from Sandbox runs when direct metadata is empty', async () => {
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-1', projectId: '', agentName: '', status: 'RUNNING', title: 'Run-associated',
  }) });
  mocks.runService.listRuns.mockResolvedValue({ runs: [
    new RunSummary({ runId: 'run-1', sandboxId: 'sandbox-1', agentName: 'script-agent', status: RunStatus.SUCCEEDED }),
  ] });
  render(SandboxDetailView);
  await screen.findByRole('heading', { name: 'Run-associated' });
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'continue this conversation' } });

  const agentButton = screen.getByRole('button', { name: 'Agent' });
  await waitFor(() => expect(agentButton).toBeEnabled());
  expect(screen.queryByText('该 Sandbox 未关联 Agent')).toBeNull();
  await fireEvent.click(agentButton);
  expect(mocks.runService.runAgent).toHaveBeenCalledWith(expect.objectContaining<Partial<RunAgentRequest>>({
    projectId: 'project-1', agentName: 'script-agent', sandboxId: 'sandbox-1', prompt: 'continue this conversation',
  }));
});

test('shows Agent errors in the quick execution output', async () => {
  mocks.runService.runAgent.mockRejectedValueOnce(new Error('agent unavailable'));
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'hello' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Agent' }));

  expect(await screen.findByText('agent unavailable')).toBeTruthy();
});

test('ignores an Agent result after navigating to another sandbox', async () => {
  const pending = deferred<{ run: RunDetail }>();
  mocks.runService.runAgent.mockReturnValueOnce(pending.promise);
  render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await fireEvent.click(screen.getByRole('tab', { name: '快速执行' }));
  await fireEvent.input(screen.getByLabelText('执行代码'), { target: { value: 'slow task' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Agent' }));

  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({
    sandboxId: 'sandbox-2', projectId: 'project-1', agentName: 'reviewer', status: 'RUNNING', title: 'Second sandbox',
  }) });
  store.runtimeView = { ...store.runtimeView, sandboxId: 'sandbox-2' };
  await screen.findByRole('heading', { name: 'Second sandbox' });
  pending.resolve({ run: new RunDetail({ output: 'stale Agent answer' }) });
  await Promise.resolve();
  await Promise.resolve();

  expect(screen.queryByText('stale Agent answer')).toBeNull();
});

test('starts a watch after the snapshot and ignores stale route events', async () => {
  let release!: () => void;
  mocks.sandboxService.watchSandbox.mockImplementation(async function* () {
    await new Promise<void>(resolve => { release = resolve; });
    yield { eventType: 3, cellId: 'python-1', chunk: ' stale' };
  });
  render(SandboxDetailView);
  await screen.findByText(/python output/);
  await waitFor(() => expect(mocks.sandboxService.watchSandbox).toHaveBeenCalled());
  store.runtimeView = { ...store.runtimeView, sandboxId: 'sandbox-2' };
  mocks.sandboxService.getSandbox.mockResolvedValue({ sandbox: new Sandbox({ sandboxId: 'sandbox-2', projectId: 'project-1', status: 'STOPPED' }) });
  release();
  await waitFor(() => expect(mocks.sandboxService.getSandbox).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sandbox-2' })));
  expect(screen.queryByText('python output stale')).toBeNull();
});

test('aborts the active watch when the detail view unmounts', async () => {
  let signal: AbortSignal | undefined;
  mocks.sandboxService.watchSandbox.mockImplementation((_request, options) => {
    signal = options?.signal;
    return (async function* () { await new Promise(() => {}); })();
  });
  const view = render(SandboxDetailView);
  await screen.findByText(/agent response/);
  await waitFor(() => expect(signal).toBeDefined());
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

test('shows a removed state with a back button when the sandbox no longer exists', async () => {
  mocks.sandboxService.getSandbox.mockRejectedValue(new ConnectError('session metadata missing', Code.NotFound));
  render(SandboxDetailView);

  expect(await screen.findByText(/此运行环境已被移除/)).toBeTruthy();
  expect(screen.getAllByText('该 Sandbox 已被删除').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
});

test('shows the removed state after deleting the running sandbox', async () => {
  render(SandboxDetailView);
  await screen.findByRole('heading', { name: 'Research' });

  mocks.sandboxService.getSandbox.mockRejectedValue(new ConnectError('gone', Code.NotFound));
  await fireEvent.click(screen.getByRole('button', { name: '强制删除' }));

  expect(await screen.findByText(/此运行环境已被移除/)).toBeTruthy();
  expect(store.addToast).toHaveBeenCalledWith('Sandbox 已移除', 'success');
  expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
});

test('still offers retry and back for a non-NotFound load error', async () => {
  mocks.sandboxService.getSandbox.mockRejectedValue(new Error('server exploded'));
  render(SandboxDetailView);

  expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
  expect(screen.queryByText(/此运行环境已被移除/)).toBeNull();
});
