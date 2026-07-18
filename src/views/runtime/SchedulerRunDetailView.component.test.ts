import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  GetRunResponse, GetSandboxResponse, GetSchedulerRunResponse, ListRunEventsResponse, ListSandboxHistoryResponse,
  ListSandboxRunEventsResponse, ListSchedulerEventsResponse, RunDetail, RunEvent, RunLogChunk, RunSummary,
  Sandbox, SandboxHistoryCell, SchedulerEvent, SchedulerRun,
} from '../../gen/agentcompose/v2/agentcompose_pb';
import { store } from '../../lib/stores.svelte';
import SchedulerRunDetailView from './SchedulerRunDetailView.svelte';

const mocks = vi.hoisted(() => ({
  projectService: { getSchedulerRun: vi.fn(), listSchedulerEvents: vi.fn() },
  sandboxService: { getSandbox: vi.fn(), listSandboxHistory: vi.fn() },
  runService: { getRun: vi.fn(), listRunEvents: vi.fn(), listSandboxRunEvents: vi.fn(), followRunLogs: vi.fn() },
}));
vi.mock('../../lib/rpc', () => mocks);
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

async function* chunks(...values: RunLogChunk[]) { yield* values; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function schedulerResponse(runId: string, timelineCount: number, options: { payloadJson?: string; failed?: boolean; subsequentType?: string } = {}) {
  const schedulerCount = Math.max(1, timelineCount - 1); // aggregation contributes one source-status entry
  return new ListSchedulerEventsResponse({ events: Array.from({ length: schedulerCount }, (_, index) => new SchedulerEvent({
    id: `${runId}-event-${index}`, runId, type: index === 0 ? 'loader.run.started' : options.failed && index === 1 ? 'loader.run.failed' : options.subsequentType ?? 'loader.command.completed',
    message: index === 1 ? 'needle content' : `full content ${index}`, payloadJson: index === 0 ? options.payloadJson ?? '' : '',
    createdAt: { seconds: BigInt(index + 1) },
  })) });
}
function multilineResponse(runId: string, lines: number[]) {
  return new ListSchedulerEventsResponse({ events: lines.map((lineCount, index) => new SchedulerEvent({
    id: `${runId}-event-${index}`,
    runId,
    type: index === 0 ? 'loader.run.started' : 'loader.command.completed',
    message: Array.from({ length: lineCount }, (_, line) => `entry ${index} line ${line + 1}`).join('\n') + '\n',
    createdAt: { seconds: BigInt(index + 1) },
  })) });
}
function mockTimelineLayout() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList?.contains('entry-content') ? 352 : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      const text = this.textContent ?? '';
      const logicalLines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
      return this.classList?.contains('entry-content') && (logicalLines > 20 || text.length > 1000) ? 704 : this.clientHeight;
    },
  });
}
function totalRpcCalls() {
  return Object.values(mocks).flatMap(service => Object.values(service)).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.activeProjectId = 'project-1';
  store.runtimeView = { level: 'scheduler-run-detail', agentName: 'collector', runId: 'loader-1', sessionId: '' };
  vi.spyOn(store, 'addToast').mockImplementation(() => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 2));
  mocks.projectService.getSchedulerRun.mockResolvedValue(new GetSchedulerRunResponse());
  mocks.sandboxService.getSandbox.mockResolvedValue(new GetSandboxResponse());
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse());
  mocks.runService.listSandboxRunEvents.mockResolvedValue(new ListSandboxRunEventsResponse());
  mocks.runService.getRun.mockResolvedValue(new GetRunResponse());
  mocks.runService.listRunEvents.mockResolvedValue(new ListRunEventsResponse({ historyAvailable: true }));
  mocks.runService.followRunLogs.mockImplementation(() => chunks(new RunLogChunk({ isFinal: true })));
});
afterEach(() => {
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  cleanup();
});

test('keeps the desktop page header at 41px and lets it grow on narrow screens', () => {
  const source = readFileSync('src/views/runtime/SchedulerRunDetailView.svelte', 'utf8');

  expect(source).toMatch(/\.page-header\s*\{[^}]*height:\s*41px/);
  expect(source).toMatch(/\.page-header\s*\{[^}]*box-sizing:\s*border-box/);
  expect(source).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*\.page-header\s*\{[^}]*height:\s*auto/);
});

test('matches the agent run summary layout and keeps execution times in the timeline heading', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 3, { subsequentType: 'loader.run.completed' }));
  const { container } = render(SchedulerRunDetailView);

  await screen.findByText(/全量加载完成 · 已展示 \d+ \/ \d+ 条/);
  expect(screen.getByRole('button', { name: '刷新' })).toHaveTextContent('↻');
  const summary = container.querySelector('.flow-summary');
  expect(summary).toBeTruthy();
  expect(container.querySelector('.summary')).toBeNull();
  expect(summary?.querySelector('.status-pill.success')?.textContent).toContain('成功');
  expect(summary?.querySelector('h1')?.textContent).toBe('collector 调度运行完成');
  expect(summary?.querySelector('.summary-meta')?.textContent).toContain('调度器运行');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('Scheduler Run ID');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('loader-1');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('Trigger ID');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('快照时间');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('Sandbox ID');
  expect(summary?.querySelector('.identifier-list')?.textContent).toContain('—');
  expect(summary?.querySelector('.summary-metrics')?.textContent).toContain('耗时');
  expect(summary?.textContent).not.toContain('开始');
  expect(summary?.textContent).not.toContain('结束');

  const sectionHeading = container.querySelector('.section-heading');
  expect(sectionHeading?.querySelector(':scope > span:first-child')?.textContent).toBe('执行过程');
  expect(sectionHeading?.querySelector('.heading-time')?.textContent).toContain(' → ');
});

test('shows Event ID below Trigger ID and links to the standalone Event detail', async () => {
  mocks.projectService.getSchedulerRun.mockResolvedValue(new GetSchedulerRunResponse({
    run: new SchedulerRun({ payloadJson: '{"payload":{"eventId":"evt/a"}}' }),
  }));
  const { container } = render(SchedulerRunDetailView);

  const link = await screen.findByRole('link', { name: 'evt/a' });
  expect(link).toHaveAttribute('href', '/agent-compose/events/evt%2Fa');
  const labels = Array.from(container.querySelectorAll('.identifier-list dt')).map(node => node.textContent);
  expect(labels).toEqual(['Scheduler Run ID', 'Trigger ID', 'Event ID', '快照时间', 'Sandbox ID']);
});

test('omits Event ID when Scheduler Run metadata is unavailable', async () => {
  mocks.projectService.getSchedulerRun.mockRejectedValue(new Error('metadata unavailable'));
  render(SchedulerRunDetailView);

  await screen.findByText(/全量加载完成/);
  expect(screen.queryByText('Event ID')).toBeNull();
});

test('shows every Scheduler Sandbox ID and opens its project detail', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 2, {
    payloadJson: '{"sandboxId":"sandbox-1"}',
  }));
  const navigate = vi.spyOn(store, 'navigateTo');
  render(SchedulerRunDetailView);

  const sandbox = await screen.findByRole('button', { name: 'sandbox-1' });
  await fireEvent.click(sandbox);

  expect(navigate).toHaveBeenCalledWith('sandbox-detail', { sandboxId: 'sandbox-1' });
});

test('shows a Sandbox ID discovered only from an associated Run detail', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 2, {
    payloadJson: '{"runId":"run-1"}',
  }));
  mocks.runService.getRun.mockResolvedValue(new GetRunResponse({ run: new RunDetail({
    summary: new RunSummary({ runId: 'run-1', sandboxId: 'sandbox-from-run' }),
  }) }));
  render(SchedulerRunDetailView);

  expect(await screen.findByRole('button', { name: 'sandbox-from-run' })).toBeInTheDocument();
});

test('places refresh after the enlarged timeline count', async () => {
  const { container } = render(SchedulerRunDetailView);

  const timelineCount = await screen.findByText(/全量加载完成 · 已展示 \d+ \/ \d+ 条/);
  const refresh = screen.getByRole('button', { name: '刷新' });
  const toolbar = container.querySelector('.toolbar');
  expect(timelineCount.parentElement).toBe(toolbar);
  expect(refresh.parentElement).toBe(toolbar);
  expect(timelineCount.nextElementSibling).toBe(refresh);
  expect(timelineCount).toHaveClass('timeline-count');
});

test('scopes compact typography to timeline filters', async () => {
  const { container } = render(SchedulerRunDetailView);

  await screen.findByText(/全量加载完成 · 已展示 \d+ \/ \d+ 条/);
  const filters = Array.from(container.querySelectorAll('.toolbar button[aria-pressed]'));
  expect(filters).toHaveLength(6);
  expect(filters.every(button => button.classList.contains('timeline-filter'))).toBe(true);
  expect(screen.getByRole('button', { name: '刷新' })).not.toHaveClass('timeline-filter');
});

test('loads all data before rendering 100 then reveals 500 and all without new RPCs', async () => {
  const pendingRunEvents = deferred<ListRunEventsResponse>();
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 609, { payloadJson: '{"sandboxId":"box","cellId":"cell","runId":"run"}' }));
  mocks.sandboxService.getSandbox.mockResolvedValue(new GetSandboxResponse({ sandbox: new Sandbox({ sandboxId: 'box' }) }));
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse({ cells: [new SandboxHistoryCell({ id: 'cell' })] }));
  mocks.runService.listSandboxRunEvents.mockResolvedValue(new ListSandboxRunEventsResponse({ events: [new RunEvent({ id: 'shared-event', runId: 'run' })], historyAvailableRunIds: ['run'] }));
  mocks.runService.getRun.mockResolvedValue(new GetRunResponse({ run: new RunDetail() }));
  mocks.runService.listRunEvents.mockReturnValue(pendingRunEvents.promise);
  mocks.runService.followRunLogs.mockImplementation(() => chunks(new RunLogChunk({ data: 'final log', isFinal: true })));
  render(SchedulerRunDetailView);
  expect(screen.getByText('正在读取 Scheduler 事件')).toBeTruthy();
  await waitFor(() => expect(mocks.runService.listRunEvents).toHaveBeenCalledTimes(1));
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  pendingRunEvents.resolve(new ListRunEventsResponse({ events: [new RunEvent({ id: 'shared-event', runId: 'run' })], historyAvailable: true }));
  expect(await screen.findAllByRole('article')).toHaveLength(100);
  expect(screen.queryByText('全量加载完成，共 620 条')).toBeNull();
  expect(mocks.sandboxService.getSandbox).toHaveBeenCalledTimes(1);
  expect(mocks.sandboxService.listSandboxHistory).toHaveBeenCalledTimes(1);
  expect(mocks.runService.listSandboxRunEvents).toHaveBeenCalledTimes(1);
  expect(mocks.runService.getRun).toHaveBeenCalledTimes(1);
  expect(mocks.runService.listRunEvents).toHaveBeenCalledTimes(1);
  expect(mocks.runService.followRunLogs).toHaveBeenCalledTimes(1);
  expect(screen.getByText('全量加载完成 · 已展示 100 / 620 条')).toBeTruthy();
  const callsAfterAggregation = totalRpcCalls();
  await fireEvent.click(screen.getByRole('button', { name: '展示到 500 条' }));
  expect(screen.getAllByRole('article')).toHaveLength(500);
  await fireEvent.click(screen.getByRole('button', { name: '展示全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(620);
  expect(totalRpcCalls()).toBe(callsAfterAggregation);
});

test('keeps 展示全部 unbounded when switching from a 501+ entry filter', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 620, { subsequentType: 'command.completed' }));
  render(SchedulerRunDetailView);
  await screen.findAllByRole('article');
  await fireEvent.click(screen.getByRole('button', { name: '活动' }));
  await fireEvent.click(screen.getByRole('button', { name: '展示到 500 条' }));
  await fireEvent.click(screen.getByRole('button', { name: '展示全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(618);
  await fireEvent.click(screen.getByRole('button', { name: '全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(620);
});

test('filters before slicing and omits useless reveal buttons below thresholds', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 150, { failed: true }));
  render(SchedulerRunDetailView);
  expect(await screen.findAllByRole('article')).toHaveLength(100);
  await fireEvent.click(screen.getByRole('button', { name: '问题' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('全量加载完成 · 已展示 1 / 1 条')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /展示到|展示全部/ })).toBeNull();
});

test('shows no entry toggle for content with exactly 20 visible lines', async () => {
  mockTimelineLayout();
  mocks.projectService.listSchedulerEvents.mockResolvedValue(multilineResponse('loader-1', [20]));
  render(SchedulerRunDetailView);

  const article = (await screen.findAllByRole('article'))[0];
  expect(article.querySelector('.entry-content')?.textContent).toContain('entry 0 line 20');
  expect(article.querySelector('.entry-toggle')).toBeNull();
});

test('expands and collapses long entries independently before raw data details', async () => {
  mockTimelineLayout();
  mocks.projectService.listSchedulerEvents.mockResolvedValue(multilineResponse('loader-1', [21, 22]));
  render(SchedulerRunDetailView);

  const articles = await screen.findAllByRole('article');
  const firstContent = () => articles[0].querySelector('.entry-content');
  const secondContent = () => articles[1].querySelector('.entry-content');
  expect(firstContent()).toHaveTextContent('entry 0 line 21');
  expect(firstContent()).toHaveClass('collapsed');
  expect(secondContent()).toHaveClass('collapsed');
  await waitFor(() => expect(articles[0].querySelector('.entry-toggle')).toHaveTextContent('展示全部'));
  const firstToggle = articles[0].querySelector('.entry-toggle') as HTMLButtonElement;
  expect(firstToggle).toHaveAccessibleName('展示全部');
  expect(firstToggle.querySelector('.entry-toggle-icon')).toHaveTextContent('↓');
  expect(firstToggle.querySelector('.entry-toggle-icon')).toHaveAttribute('aria-hidden', 'true');
  expect(firstToggle.compareDocumentPosition(articles[0].querySelector('details')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '复制全文：scheduler-event:loader-1-event-0' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('entry 0 line 21'));

  await fireEvent.click(firstToggle);
  expect(firstContent()).not.toHaveClass('collapsed');
  expect(secondContent()).toHaveClass('collapsed');
  expect(firstToggle).toHaveAccessibleName('收起');
  expect(firstToggle.querySelector('.entry-toggle-icon')).toHaveTextContent('↑');

  await fireEvent.click(articles[0].querySelector('.entry-toggle') as HTMLButtonElement);
  expect(firstContent()).toHaveClass('collapsed');
});

test('collapses a long single-line JSON value when browser wrapping exceeds 20 rendered lines', async () => {
  mockTimelineLayout();
  mocks.projectService.listSchedulerEvents.mockResolvedValue(new ListSchedulerEventsResponse({ events: [new SchedulerEvent({
    id: 'loader-1-event-0', runId: 'loader-1', type: 'loader.command.completed',
    message: JSON.stringify({ generated_at: '2026-07-16T05:10:14.4823Z', payload: 'x'.repeat(2000) }),
    createdAt: { seconds: 1n },
  })] }));
  render(SchedulerRunDetailView);

  const article = (await screen.findAllByRole('article'))[0];
  await waitFor(() => expect(article.querySelector('.entry-toggle')).toHaveTextContent('展示全部'));
  expect(article.querySelector('.entry-content')).toHaveClass('collapsed');
});

test('exposes raw JSON without a duplicate copy action and keeps copy full text', async () => {
  render(SchedulerRunDetailView);
  const articles = await screen.findAllByRole('article');
  expect(articles[0].textContent).toContain('full content 0');
  await fireEvent.click(screen.getByRole('button', { name: '复制全文：scheduler-event:loader-1-event-0' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('full content 0');
  await fireEvent.click(screen.getAllByText('查看完整原始数据')[0]);
  expect(screen.queryByRole('button', { name: /复制原始数据/ })).toBeNull();
  expect(articles[0].querySelector('pre.raw')).toHaveTextContent('loader-1-event-0');
});

test('shows exact unknown-time text and every full parent association ID', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 2, {
    payloadJson: '{"sandboxId":"sandbox-full-id","cellId":"cell-full-id"}',
  }));
  mocks.sandboxService.getSandbox.mockResolvedValue(new GetSandboxResponse({ sandbox: new Sandbox({ sandboxId: 'sandbox-full-id' }) }));
  mocks.sandboxService.listSandboxHistory.mockResolvedValue(new ListSandboxHistoryResponse({
    cells: [new SandboxHistoryCell({ id: 'cell-full-id', output: 'cell output' })],
  }));

  render(SchedulerRunDetailView);
  const cellIdentity = await screen.findByText('cell:cell-full-id');
  const article = cellIdentity.closest('article');

  expect(article?.querySelector(':scope > time')?.textContent).toBe('时间未知');
  expect(article?.textContent).toContain('sandbox:sandbox-full-id');
  expect(article?.textContent).toContain('scheduler-event:loader-1-event-0');
});

test('shows partial wording and source failure details and retry preserves filter and limit', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValue(schedulerResponse('loader-1', 620, { payloadJson: '{' }));
  render(SchedulerRunDetailView);
  await screen.findAllByRole('article');
  expect(screen.getByText('已加载后端当前可取得的信息，但全量性无法确认')).toBeTruthy();
  expect(screen.getByText(/scheduler-link · loader-1-event-0 · unavailable/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '复制错误' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('scheduler-link'));
  await fireEvent.click(screen.getByRole('button', { name: '展示到 500 条' }));
  await fireEvent.click(screen.getByRole('button', { name: '问题' }));
  await fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(mocks.projectService.listSchedulerEvents).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: '问题' }).getAttribute('aria-pressed')).toBe('true');
  await fireEvent.click(screen.getByRole('button', { name: '全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(500);
});

test('aborts stale navigation and only renders the latest scheduler run', async () => {
  const first = deferred<ListSchedulerEventsResponse>();
  let staleSignal: AbortSignal | undefined;
  mocks.projectService.listSchedulerEvents.mockImplementation((request, options) => {
    if (request.cursor === '' && request.project?.projectId === 'project-1' && mocks.projectService.listSchedulerEvents.mock.calls.length === 1) {
      staleSignal = options?.signal;
      return first.promise;
    }
    return Promise.resolve(schedulerResponse('loader-2', 3));
  });
  render(SchedulerRunDetailView);
  store.runtimeView = { ...store.runtimeView, runId: 'loader-2' };
  expect(await screen.findAllByText(/loader-2-event-0/)).not.toHaveLength(0);
  expect(staleSignal?.aborted).toBe(true);
  first.resolve(schedulerResponse('loader-1', 10));
  await Promise.resolve();
  expect(screen.queryByText(/loader-1-event-0/)).toBeNull();
});

test('shows not found and permits retry after a top-level load failure', async () => {
  mocks.projectService.listSchedulerEvents.mockResolvedValueOnce(new ListSchedulerEventsResponse()).mockRejectedValueOnce(new Error('scheduler offline')).mockResolvedValue(schedulerResponse('loader-1', 2));
  const { unmount } = render(SchedulerRunDetailView);
  expect(await screen.findByText('未找到调度执行记录')).toBeTruthy();
  unmount();
  render(SchedulerRunDetailView);
  expect(await screen.findByText('scheduler offline')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText(/全量加载完成 · 已展示 \d+ \/ \d+ 条/)).toBeTruthy();
});
