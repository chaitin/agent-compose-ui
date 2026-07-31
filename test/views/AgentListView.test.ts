import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import AgentListView from '../../src/views/runtime/AgentListView.svelte';
import { store } from '../../src/lib/stores.svelte';
import { RunSource, RunStatus, RunSummary, SchedulerEvent } from '../../src/gen/agentcompose/v2/agentcompose_pb';
import { stableProjectRunId } from '../../src/lib/run-scheduler-evidence';

// vi.mock 的 factory 被 hoist，用 vi.hoisted 提升mock对象。
const rpcMocks = vi.hoisted(() => ({
  projectService: {
    getProject: vi.fn(),
    getScheduler: vi.fn(),
    listSchedulerEvents: vi.fn(),
  },
  runService: {
    listRuns: vi.fn(),
  },
}));

vi.mock('../../src/lib/rpc', () => ({
  projectService: rpcMocks.projectService,
  runtimeProjectService: rpcMocks.projectService,
  runService: rpcMocks.runService,
  execService: {},
  sandboxService: {},
  sessionService: {},
  kernelService: {},
  agentService: {},
  loaderService: {},
  dashboardService: {},
  configService: {},
}));

function makeProjectEntry(id: string, name: string) {
  return {
    summary: {
      projectId: id,
      name,
      sourcePath: `/${id}.yml`,
      currentRevision: 0n,
      specHash: '',
      agentCount: 1,
      schedulerCount: 0,
      runningRunCount: 0,
      latestRunId: '',
      createdAt: '',
      updatedAt: '',
    },
    source: { composePath: `/${id}.yml`, projectDir: `/${id}` },
    yamlContent: '',
    dirty: false,
  };
}

beforeEach(() => {
  rpcMocks.projectService.getProject.mockReset();
  rpcMocks.projectService.getScheduler.mockReset();
  rpcMocks.projectService.listSchedulerEvents.mockReset();
  rpcMocks.runService.listRuns.mockReset();
  rpcMocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [], nextCursor: '' });
  store.projects = [];
  store.currentPage = 'dashboard';
  store.activeProjectId = '';
  store.runtimeView = { level: 'agents', agentName: '', runId: '', sessionId: '' };
  localStorage.clear();
  window.location.hash = '';
});

function setupProjectWithAgent() {
  store.activeProjectId = 'p1';
  store.projects = [makeProjectEntry('p1', '项目一')];
  rpcMocks.projectService.getProject.mockResolvedValue({
    project: {
      agents: [{ agentName: 'a1', provider: 'openai', model: 'gpt-4' }],
      spec: { agents: [] },
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AgentListView', () => {
  it('keeps the current project agents when an older project request finishes later', async () => {
    const oldProject = deferred<any>();
    store.activeProjectId = 'p1';
    store.projects = [makeProjectEntry('p1', '项目一'), makeProjectEntry('p2', '项目二')];
    rpcMocks.projectService.getProject.mockImplementation((request: any) => (
      request.project.projectId === 'p1'
        ? oldProject.promise
        : Promise.resolve({ project: { agents: [{ agentName: 'current-agent' }], spec: { agents: [] } } })
    ));
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });

    render(AgentListView);
    await waitFor(() => expect(rpcMocks.projectService.getProject).toHaveBeenCalledTimes(1));
    store.activeProjectId = 'p2';
    expect(await screen.findByText('current-agent')).toBeInTheDocument();

    oldProject.resolve({ project: { agents: [], spec: { agents: [] } } });
    await oldProject.promise;
    await Promise.resolve();
    await tick();

    expect(screen.getByText('current-agent')).toBeInTheDocument();
    expect(screen.queryByText('暂无智能体。请启用一个项目来查看。')).not.toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
  });

  it('aborts the project request when the view is destroyed', async () => {
    const pending = deferred<any>();
    store.activeProjectId = 'p1';
    rpcMocks.projectService.getProject.mockReturnValue(pending.promise);

    const view = render(AgentListView);
    await waitFor(() => expect(rpcMocks.projectService.getProject).toHaveBeenCalled());
    const options = rpcMocks.projectService.getProject.mock.calls[0][1];

    expect(options?.signal).toBeInstanceOf(AbortSignal);
    view.unmount();
    expect(options.signal.aborted).toBe(true);
  });

  // 回归：listRuns 失败不应被静默吞掉后误显示为"就绪"，应显示"加载失败"。
  it('listRuns 失败时显示"加载失败"而非"就绪"', async () => {
    setupProjectWithAgent();
    rpcMocks.runService.listRuns.mockRejectedValue(new Error('network down'));

    render(AgentListView);
    await waitFor(() => expect(screen.getByText('加载失败')).toBeInTheDocument());
    expect(screen.queryByText('就绪')).not.toBeInTheDocument();
    expect(screen.getByText('加载失败')).toHaveClass('status-err');
  });

  it('listRuns 成功但无运行记录时显示空闲和 0 次', async () => {
    setupProjectWithAgent();
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });

    render(AgentListView);
    await waitFor(() => expect(screen.getByText('空闲')).toHaveClass('status-idle'));
    expect(await screen.findByText('0 次')).toBeInTheDocument();
    expect(screen.queryByText('加载失败')).not.toBeInTheDocument();
  });

  it('hides the former runtime-monitor entry button', async () => {
    setupProjectWithAgent();
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });
    render(AgentListView);

    // “最近运行结果”入口已从智能体详情面包屑隐藏；latest-run 仍可从工具栏进入。
    await screen.findByText('智能体列表');
    expect(screen.queryByRole('button', { name: /最近运行结果/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /运行时监控/ })).toBeNull();
  });

  it('uses 启用 in the empty Agent guidance', async () => {
    rpcMocks.projectService.getProject.mockResolvedValue({ project: { spec: { name: 'demo', agents: [] } } });
    render(AgentListView);
    expect(await screen.findByText('暂无智能体。请启用一个项目来查看。')).toBeInTheDocument();
  });

  it('reports inconsistent runtime agents instead of treating configured Agents as empty', async () => {
    store.activeProjectId = 'p1';
    store.projects = [makeProjectEntry('p1', '项目一')];
    rpcMocks.projectService.getProject.mockResolvedValue({
      project: { agents: [], spec: { agents: [{ name: 'configured-agent' }] } },
    });

    render(AgentListView);

    expect(await screen.findByRole('alert')).toHaveTextContent('项目运行态 Agent 数据异常');
    expect(screen.queryByText('暂无智能体。请启用一个项目来查看。')).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('renders one operational card without repeating YAML configuration', async () => {
    store.activeProjectId = 'p1';
    store.projects = [makeProjectEntry('p1', '项目一')];
    rpcMocks.projectService.getProject.mockResolvedValue({
      project: {
        agents: [{
          agentName: 'research-agent',
          provider: 'openai',
          model: 'gpt-5',
          schedulerEnabled: false,
          currentRun: { runningRunCount: 1 },
        }],
        spec: { agents: [] },
      },
    });
    rpcMocks.runService.listRuns.mockResolvedValue({
      runs: [
        new RunSummary({ status: RunStatus.SUCCEEDED, startedAt: '2026-07-17T06:32:08Z' }),
        new RunSummary({ status: RunStatus.FAILED, startedAt: '2026-07-16T06:32:08Z' }),
      ],
    });

    render(AgentListView);

    const card = await screen.findByRole('button', { name: /research-agent/ });
    expect(card).toHaveTextContent('运行中');
    expect(card).toHaveTextContent('最近执行结果');
    expect(card).toHaveTextContent('最近执行时间');
    expect(card).toHaveTextContent('下一次执行时间');
    expect(card).toHaveTextContent('累计运行');
    await waitFor(() => expect(card).toHaveTextContent('2 次'));
    expect(card).toHaveTextContent('未设置');
    expect(card).not.toHaveTextContent('openai');
    expect(card).not.toHaveTextContent('gpt-5');
  });

  it('shows the earliest enabled scheduler trigger as the next execution time', async () => {
    store.activeProjectId = 'p1';
    store.projects = [makeProjectEntry('p1', '项目一')];
    rpcMocks.projectService.getProject.mockResolvedValue({
      project: { agents: [{ agentName: 'scheduled-agent', schedulerEnabled: true }], spec: { agents: [] } },
    });
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });
    rpcMocks.projectService.getScheduler.mockResolvedValue({
      triggers: [
        { enabled: true, nextFireAt: new Date(2026, 6, 18, 10, 0, 0) },
        { enabled: true, nextFireAt: new Date(2026, 6, 18, 9, 0, 0) },
      ],
    });

    render(AgentListView);

    const card = await screen.findByRole('button', { name: /scheduled-agent/ });
    await waitFor(() => expect(card).toHaveTextContent('2026-07-18 09:00:00'));
    expect(rpcMocks.projectService.getScheduler).toHaveBeenCalledTimes(1);
  });

  it('includes Scheduler-only executions in the latest result, time, and total', async () => {
    setupProjectWithAgent();
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });
    rpcMocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
      new SchedulerEvent({ id: 'start', runId: 'scheduler-1', type: 'loader.run.started', createdAt: { seconds: 1_752_729_600n } }),
      new SchedulerEvent({ id: 'done', runId: 'scheduler-1', type: 'loader.run.completed', createdAt: { seconds: 1_752_729_660n } }),
    ], nextCursor: '' });

    render(AgentListView);

    const card = await screen.findByRole('button', { name: /a1/ });
    await waitFor(() => expect(card).toHaveTextContent('1 次'));
    expect(card).toHaveTextContent('成功');
    expect(card).toHaveTextContent('2025-07-17 13:20:00');
  });

  it('counts an exactly linked Project Run and Scheduler execution once', async () => {
    setupProjectWithAgent();
    const runId = await stableProjectRunId('p1', 'a1', 'scheduler', 'scheduler-linked:agent:1');
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [new RunSummary({
      runId, agentName: 'a1', source: RunSource.SCHEDULER, status: RunStatus.SUCCEEDED,
      startedAt: '2026-07-17T06:32:08Z',
    })] });
    rpcMocks.projectService.listSchedulerEvents.mockResolvedValue({ events: [
      new SchedulerEvent({ id: 'start', runId: 'scheduler-linked', type: 'loader.run.started', createdAt: { seconds: 1_752_731_528n } }),
      new SchedulerEvent({ id: 'agent', runId: 'scheduler-linked', type: 'loader.agent.completed', createdAt: { seconds: 1_752_731_558n } }),
      new SchedulerEvent({ id: 'done', runId: 'scheduler-linked', type: 'loader.run.completed', createdAt: { seconds: 1_752_731_588n } }),
    ], nextCursor: '' });

    render(AgentListView);

    const card = await screen.findByRole('button', { name: /a1/ });
    await waitFor(() => expect(card).toHaveTextContent('1 次'));
  });

  it('shows loading failure when Scheduler execution history fails', async () => {
    setupProjectWithAgent();
    rpcMocks.runService.listRuns.mockResolvedValue({ runs: [] });
    rpcMocks.projectService.listSchedulerEvents.mockRejectedValue(new Error('scheduler unavailable'));

    render(AgentListView);

    expect(await screen.findByText('加载失败')).toHaveClass('status-err');
    expect(screen.queryByText('0 次')).not.toBeInTheDocument();
  });
});
