<script lang="ts">
  import { onDestroy } from 'svelte';
  import { projectService, runService, runtimeProjectService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import { GetProjectRequest, ListRunsRequest, ListSchedulerEventsRequest, RunSource, RunStatus, type RunSummary, type SchedulerEvent } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { buildRunDateRange, consumeRunWindow } from '../../lib/run-history';
  import { filterAgentOwnedExecutions, groupSchedulerExecutions, mergeAgentOwnedExecutions, type AgentOwnedExecution } from '../../lib/agent-owned-executions';
  import RunAgentModal from '../../modals/RunAgentModal.svelte';

  let agentName = $derived(store.runtimeView.agentName);
  let projectRuns: RunSummary[] = $state([]);
  let schedulerEvents: SchedulerEvent[] = $state([]);
  let executions: AgentOwnedExecution[] = $state([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let hasMore = $state(false);
  let schedulerCursor = $state('');
  let serverOffset = $state(0);
  const PAGE_SIZE = 50;
  let requestGeneration = 0;
  let queryVersion = $state(0);
  let status = $state(RunStatus.UNSPECIFIED);
  let source = $state(RunSource.UNSPECIFIED);
  let startedFrom = $state('');
  let startedTo = $state('');
  let sandboxId = $state('');
  let applied = $state({ status: RunStatus.UNSPECIFIED, source: RunSource.UNSPECIFIED, startedFrom: '', startedTo: '', sandboxId: '' });
  let currentTime = $state(Date.now());
  let clock: ReturnType<typeof setInterval> | undefined;
  let requestController: AbortController | undefined;
  let agentSystemPrompt = $state('');
  let manualRunOpen = $state(false);

  $effect(() => {
    void store.runtimeRefreshVersion;
    void queryVersion;
    const projectId = store.activeProjectId;
    const requestedAgent = agentName;
    const filters = applied;
    const generation = ++requestGeneration;
    requestController?.abort();
    if (!projectId || !requestedAgent) { projectRuns = []; schedulerEvents = []; executions = []; loading = false; hasMore = false; return; }
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    loadingMore = false;
    projectRuns = [];
    schedulerEvents = [];
    executions = [];
    schedulerCursor = '';
    serverOffset = 0;
    (async () => {
      const [projectResult, schedulerResult] = await Promise.allSettled([
        (async () => {
        const range = buildRunDateRange(filters.startedFrom, filters.startedTo);
        return runService.listRuns(new ListRunsRequest({
          projectId,
          agentName: requestedAgent,
          status: filters.status, source: filters.source,
          ...range, sandboxId: filters.sandboxId.trim(), offset: 0, limit: PAGE_SIZE + 1,
        }), { signal: controller.signal });
        })(),
        (async () => {
          const project = await runtimeProjectService.getProject(new GetProjectRequest({ project: { projectId }, includeSpec: true }), { signal: controller.signal, timeoutMs: 30_000 });
          const configuredAgent = project.project?.spec?.agents.find((agent) => agent.name === requestedAgent);
          if (generation === requestGeneration) agentSystemPrompt = configuredAgent?.systemPrompt ?? '';
          const hasScheduler = !!configuredAgent?.scheduler;
          return hasScheduler
            ? projectService.listSchedulerEvents(new ListSchedulerEventsRequest({ project: { projectId }, agentName: requestedAgent, limit: 500 }), { signal: controller.signal })
            : undefined;
        })(),
      ]);
      if (generation !== requestGeneration) return;
      let projectHasMore = false;
      if (projectResult.status === 'fulfilled') {
        const window = consumeRunWindow(projectResult.value.runs, PAGE_SIZE);
        projectRuns = window.runs; serverOffset = window.serverOffset; projectHasMore = window.hasMore;
      } else store.addToast(projectResult.reason?.message || '加载 Agent Run 历史失败', 'error');
      if (schedulerResult.status === 'fulfilled' && schedulerResult.value) {
        schedulerEvents = schedulerResult.value.events;
        schedulerCursor = schedulerResult.value.nextCursor;
      } else if (schedulerResult.status === 'rejected') {
        store.addToast(schedulerResult.reason?.message || '加载 Scheduler 历史失败', 'error');
      }
      executions = filterAgentOwnedExecutions(
        await mergeAgentOwnedExecutions(projectRuns, groupSchedulerExecutions(schedulerEvents), { projectId, agentName: requestedAgent }), filters,
      );
      hasMore = projectHasMore || Boolean(schedulerCursor);
      if (generation === requestGeneration) loading = false;
    })();
    return () => {
      controller.abort();
      if (requestController === controller) requestController = undefined;
    };
  });

  $effect(() => {
    const hasRunningRun = executions.some((run) => run.status === 'running');
    if (hasRunningRun && !clock) {
      currentTime = Date.now();
      clock = setInterval(() => { currentTime = Date.now(); }, 1000);
    } else if (!hasRunningRun && clock) {
      clearInterval(clock);
      clock = undefined;
    }
  });

  onDestroy(() => {
    if (clock) clearInterval(clock);
    requestGeneration++;
    requestController?.abort();
    requestController = undefined;
  });

  function applyFilters() { requestGeneration++; applied = { status: Number(status), source: Number(source), startedFrom, startedTo, sandboxId }; queryVersion++; }
  function openDatePicker(event: MouseEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (typeof input.showPicker === 'function') input.showPicker();
  }
  async function loadMore() {
    const projectId = store.activeProjectId;
    const requestedAgent = agentName;
    if (!projectId || !requestedAgent || loadingMore || !hasMore) return;
    const generation = requestGeneration;
    loadingMore = true;
    try {
      const target = serverOffset + PAGE_SIZE;
      const range = buildRunDateRange(applied.startedFrom, applied.startedTo);
      const [projectResult, schedulerResult] = await Promise.allSettled([
        runService.listRuns(new ListRunsRequest({ projectId, agentName: requestedAgent,
          status: applied.status, source: applied.source,
          ...range, sandboxId: applied.sandboxId.trim(), offset: 0, limit: target + 1 })),
        schedulerCursor
          ? projectService.listSchedulerEvents(new ListSchedulerEventsRequest({ project: { projectId }, agentName: requestedAgent, limit: 500, cursor: schedulerCursor }))
          : Promise.resolve(undefined),
      ]);
      if (generation === requestGeneration) {
        let projectHasMore = false;
        if (projectResult.status === 'fulfilled') {
          const window = consumeRunWindow(projectResult.value.runs, target); projectRuns = window.runs; serverOffset = window.serverOffset; projectHasMore = window.hasMore;
        } else store.addToast(projectResult.reason?.message || '加载更多 Agent Run 失败', 'error');
        if (schedulerResult.status === 'fulfilled' && schedulerResult.value) {
          schedulerEvents = [...schedulerEvents, ...schedulerResult.value.events];
          schedulerCursor = schedulerResult.value.nextCursor;
        } else if (schedulerResult.status === 'rejected') store.addToast(schedulerResult.reason?.message || '加载更多 Scheduler 历史失败', 'error');
        executions = filterAgentOwnedExecutions(
          await mergeAgentOwnedExecutions(projectRuns, groupSchedulerExecutions(schedulerEvents), { projectId, agentName: requestedAgent }), applied,
        );
        hasMore = projectHasMore || Boolean(schedulerCursor);
      }
    } catch (error: any) { if (generation === requestGeneration) store.addToast(error?.message || '加载更多运行历史失败', 'error'); }
    finally { if (generation === requestGeneration) loadingMore = false; }
  }

  function statusLabel(status: AgentOwnedExecution['status']): string {
    switch (status) {
      case 'running': return '运行中';
      case 'succeeded': return '成功';
      case 'failed': return '失败';
      case 'skipped': return '已跳过';
      case 'canceled': return '已取消';
      case 'pending': return '等待中';
      default: return '未知';
    }
  }

  function statusClass(status: AgentOwnedExecution['status']): string {
    if (status === 'succeeded') return 'status-succeeded';
    if (status === 'failed') return 'status-failed';
    if (status === 'running') return 'status-running';
    return '';
  }

  function shortRunId(run: AgentOwnedExecution): string {
    return run.projectRun?.runShortId || (run.projectRunId || run.schedulerRunId).slice(0, 12) || '—';
  }

  function formatTime(value: string): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function formatDuration(milliseconds: number): string {
    const value = Math.max(0, milliseconds);
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
    if (value < 3600000) return `${(value / 60000).toFixed(1)}m`;
    return `${(value / 3600000).toFixed(1)}h`;
  }

  function displayDuration(run: AgentOwnedExecution, now: number): string {
    const stored = run.durationMs;
    if (stored > 0 || run.status !== 'running') return formatDuration(stored);
    const started = new Date(run.startedAt).getTime();
    return Number.isNaN(started) ? '—' : formatDuration(now - started);
  }

  function isCompleted(status: AgentOwnedExecution['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'skipped';
  }

  function exitCodeLabel(run: AgentOwnedExecution): string {
    return isCompleted(run.status) && run.projectRun ? String(run.projectRun.exitCode) : '—';
  }

  function executionType(run: AgentOwnedExecution): string {
    if (run.schedulerRunId && run.projectRunId) return '调度器 → Agent';
    if (run.schedulerRunId) return '调度任务';
    return 'Agent Run';
  }
  function sourceLabel(run: AgentOwnedExecution): string {
    if (run.schedulerRunId || run.source === RunSource.SCHEDULER) return '调度器运行';
    if (run.source === RunSource.MANUAL) return '手动运行';
    if (run.source === RunSource.API) return 'API 运行';
    return '来源未知';
  }
  function executionAriaLabel(run: AgentOwnedExecution): string {
    return [executionType(run), sourceLabel(run), statusLabel(run.status)].join(' ');
  }
  function openExecution(run: AgentOwnedExecution) {
    if (run.projectRunId) store.navigateTo('run-detail', { agentName, runId: run.projectRunId });
    else store.navigateTo('scheduler-run-detail', { agentName, runId: run.schedulerRunId });
  }
</script>

<div class="root">
  <div class="breadcrumb-wrap"><RuntimeBreadcrumb
    eyebrow="智能体运行历史"
    title={agentName}
    onBack={() => store.navigateBack()}
    actions={[
      { label: '手动运行', ariaLabel: '手动运行', title: '使用临时 YAML 配置运行当前 Agent', onclick: () => manualRunOpen = true, variant: 'primary', compact: true },
      { label: 'Sandbox 清单', ariaLabel: 'Sandbox 清单', title: '打开当前 Agent 的 Sandbox 清单', onclick: () => store.navigateTo('agent-sandboxes', { agentName }), hidden: true },
    ]}
  /></div>
  <form class="filters" onsubmit={(event) => { event.preventDefault(); applyFilters(); }}>
    <label>状态<select aria-label="状态" value={status} onchange={(event) => status = Number(event.currentTarget.value)}><option value={RunStatus.UNSPECIFIED}>全部</option><option value={RunStatus.PENDING}>等待中</option><option value={RunStatus.RUNNING}>运行中</option><option value={RunStatus.SUCCEEDED}>成功</option><option value={RunStatus.FAILED}>失败</option><option value={RunStatus.CANCELED}>已取消</option></select></label>
    <label>来源<select aria-label="来源" value={source} onchange={(event) => source = Number(event.currentTarget.value)}><option value={RunSource.UNSPECIFIED}>全部</option><option value={RunSource.MANUAL}>手动</option><option value={RunSource.SCHEDULER}>调度器</option><option value={RunSource.API}>API</option></select></label>
    <label>开始日期<input aria-label="开始日期" type="date" bind:value={startedFrom} onclick={openDatePicker} /></label><label>结束日期<input aria-label="结束日期" type="date" bind:value={startedTo} onclick={openDatePicker} /></label><button type="submit">应用筛选</button>
  </form>
  {#if loading}
    <div class="state">加载中...</div>
  {:else if executions.length === 0}
    <div class="state">暂无该 Agent 的执行记录</div>
  {:else}
    <div class="runs">
      {#each executions as run (run.id)}
        <button class="run" aria-label={executionAriaLabel(run)} title={`Run ${run.projectRunId || run.schedulerRunId}`} onclick={() => openExecution(run)}>
          <span class="run-info">
            <span class="run-heading">
              <strong class="execution-type">{executionType(run)}</strong>
              <span class="run-source">{sourceLabel(run)}</span>
            </span>
            <span class="diagnostic-grid">
              <span class="datum" data-field="started-at"><span class="label">开始</span><time title={run.startedAt}>{formatTime(run.startedAt)}</time></span>
              <code data-field="run-id" title={run.projectRunId || run.schedulerRunId}>{shortRunId(run)}</code>
              <span data-field="exit-code">退出码 {exitCodeLabel(run)}</span>
              <span class="datum" data-field="completed-at"><span class="label">结束</span><time title={run.completedAt}>{formatTime(run.completedAt)}</time></span>
              <span class="datum" data-field="duration"><span class="label">耗时</span><strong>{displayDuration(run, currentTime)}</strong></span>
              <span data-field="warnings">告警 {run.warningCount}</span>
            </span>
            {#if run.status === 'failed' && run.error.trim()}
              <span class="error-summary" title={run.error}>{run.error}</span>
            {/if}
          </span>
          <span class={`status ${statusClass(run.status)}`}>{statusLabel(run.status)}</span>
          <span class="arrow" aria-hidden="true">→</span>
        </button>
      {/each}
    </div>
    {#if hasMore}<button class="load-more" disabled={loadingMore} onclick={loadMore}>{loadingMore ? '加载中…' : '加载更多'}</button>{/if}
  {/if}
</div>

{#if manualRunOpen}
  <RunAgentModal
    prefilledAgent={agentName}
    prefilledPrompt={agentSystemPrompt}
    onclose={() => manualRunOpen = false}
    oncreated={() => { queryVersion++; }}
  />
{/if}

<style>
  .root{height:100%;overflow:auto;padding:0 14px 14px;background:var(--bg-primary)}.breadcrumb-wrap{margin:0 -14px 14px}button,select,input{border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);padding:5px 9px;border-radius:4px}.filters input[type="date"]{cursor:pointer}.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.filters label{display:grid;gap:3px;color:var(--text-muted);font-size:var(--font-size-xs)}.state{padding:32px;text-align:center;color:var(--text-muted)}.runs{display:grid;gap:6px}.run{display:grid;grid-template-columns:minmax(0,1fr) 76px 20px;gap:12px;align-items:center;padding:11px 12px;border-radius:5px;text-align:left}.run:hover{border-color:var(--accent-blue)}.run:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}.run-info{display:grid;min-width:0;gap:6px}.run-heading{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}.run-source{flex:0 0 auto;padding:2px 6px;border:1px solid var(--border-color);border-radius:999px;color:var(--text-secondary);font-size:var(--font-size-xs)}.diagnostic-grid{display:grid;grid-template-columns:minmax(190px,1fr) minmax(140px,.7fr) minmax(90px,.35fr);gap:6px 14px;align-items:center;min-width:0;color:var(--text-muted);font-size:var(--font-size-xs)}.datum{display:flex;gap:6px;align-items:baseline;min-width:0}.label{color:var(--text-muted);font-size:var(--font-size-xs)}code,time,.error-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}code{color:var(--text-secondary)}time{color:var(--text-secondary);font-size:var(--font-size-xs)}.error-summary{display:block;padding-top:5px;border-top:1px solid var(--border-color);color:var(--accent-red);font-size:var(--font-size-xs)}.status{justify-self:end;color:var(--accent-blue)}.status-succeeded{color:var(--accent-green)}.status-failed{color:var(--accent-red)}.status-running{color:var(--accent-blue)}.arrow{color:var(--text-muted)}.load-more{width:100%;margin-top:8px}@media (max-width:700px){.run{grid-template-columns:minmax(0,1fr) 64px 16px}.diagnostic-grid{grid-template-columns:1fr;gap:4px}.datum{justify-content:space-between}}
  .filters{flex-wrap:nowrap;align-items:center;gap:12px;overflow-x:auto;padding-bottom:2px}
  .filters label{display:flex;flex:0 0 auto;align-items:center;gap:6px;white-space:nowrap}
  .filters button{flex:0 0 auto}
</style>
