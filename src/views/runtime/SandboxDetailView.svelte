<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Code, ConnectError } from '@connectrpc/connect';
  import {
    ExecCommand, ExecRequest, GetSandboxRequest, GetSandboxStatsRequest, ListRunsRequest,
    ListSandboxHistoryRequest, ListSandboxHistoryResponse, ListSandboxRunEventsRequest, ListSandboxRunEventsResponse, MetricStatus, RemoveSandboxRequest,
    ResumeSandboxRequest, RunAgentRequest, RunSandboxCleanupPolicy, RunSource, RunStatus, StopSandboxRequest, WatchSandboxRequest,
    type MetricValue, type RunSummary, type SandboxStats,
  } from '../../gen/agentcompose/v2/agentcompose_pb';
  import SessionTerminal from '../../pages/session/SessionTerminal.svelte';
  import FileBrowser from '../../pages/session/FileBrowser.svelte';
  import { buildSandboxDetailSnapshot, buildSandboxTimeline, type SandboxDetailSnapshot } from '../../lib/sandbox-detail';
  import { mergeSandboxWatchEvent } from '../../lib/sandbox-watch';
  import { formatMetric } from '../../lib/sandboxes';
  import { sandboxResumeErrorMessage } from '../../lib/sandbox-resume-error';
  import { execService, runService, sandboxService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import TimelineEntry from './TimelineEntry.svelte';

  let {
    projectId: explicitProjectId = '',
    sandboxId: explicitSandboxId = '',
    showBreadcrumb = true,
  }: { projectId?: string; sandboxId?: string; showBreadcrumb?: boolean } = $props();

  let loading = $state(true);
  let loadError = $state('');
  let removed = $state(false);
  let snapshot: SandboxDetailSnapshot | undefined = $state();
  let runs: RunSummary[] = $state([]);
  let runsError = $state('');
  let historyError = $state('');
  let runEventsError = $state('');
  let stats: SandboxStats | undefined = $state();
  let statsLoading = $state(false);
  let statsError = $state('');
  let busy = $state(false);
  let agentReplying = $state(false);
  let command = $state('');
  let output = $state('');
  let generation = 0;
  let destroyed = false;
  let watchController: AbortController | undefined;
  type SandboxTab = 'details' | 'exec' | 'terminal' | 'files';
  const sandboxTabs: readonly SandboxTab[] = ['details', 'exec', 'terminal', 'files'];
  const tabOptions: readonly { id: SandboxTab; label: string }[] = [
    { id: 'details', label: '运行详情' },
    { id: 'exec', label: '快速执行' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'files', label: 'Files' },
  ];
  let activeTab: SandboxTab = $state('details');
  let targetProjectId = $derived(explicitProjectId || store.activeProjectId);
  let targetSandboxId = $derived(explicitSandboxId || store.runtimeView.sandboxId || '');
  const timelinePageSize = 30;
  type SandboxTimelineFilter = 'all' | 'cell' | 'sandbox' | 'run' | 'problem';
  const sandboxTimelineFilterLabels: Record<SandboxTimelineFilter, string> = { all: '全部', cell: 'CELL', sandbox: 'SANDBOX', run: 'RUN', problem: '问题' };
  const sandboxTimelineFilters = Object.keys(sandboxTimelineFilterLabels) as SandboxTimelineFilter[];
  let activeTimelineFilter = $state<SandboxTimelineFilter>('all');
  let visibleTimelineCount = $state(timelinePageSize);
  let associatedAgentName = $derived(
    snapshot?.sandbox.agentName.trim() ||
    runs.find(run => run.agentName.trim())?.agentName.trim() ||
    store.runtimeView.agentName.trim() ||
    '',
  );
  let timelineEntries = $derived(snapshot ? buildSandboxTimeline(snapshot) : []);
  let filteredTimelineEntries = $derived(timelineEntries.filter(entry => activeTimelineFilter === 'all' || (activeTimelineFilter === 'problem' ? entry.level === 'error' : entry.kind === activeTimelineFilter)));
  let visibleTimelineEntries = $derived(filteredTimelineEntries.slice(0, visibleTimelineCount));

  const metricStatusLabels: Record<MetricStatus, string> = {
    [MetricStatus.UNSPECIFIED]: '未指定', [MetricStatus.OK]: '可用',
    [MetricStatus.UNKNOWN]: '未知', [MetricStatus.UNAVAILABLE]: '不可用',
  };
  function metricText(metric?: MetricValue) {
    const status = metricStatusLabels[metric?.status ?? MetricStatus.UNSPECIFIED];
    const evidence = `原状态：${status}${metric?.message ? `：${metric.message}` : ''}`;
    if (metric?.status === MetricStatus.OK && metric.value != null) return `${formatMetric(metric)}（${evidence}）`;
    return `${status}（${evidence}）`;
  }
  function summaryMetric(metric?: MetricValue) {
    if (statsLoading && !stats) return { text: '加载中…', message: '' };
    if (statsError && !stats) return { text: '加载失败', message: statsError };
    if (metric?.status === MetricStatus.OK && metric.value != null) return { text: formatMetric(metric), message: '' };
    return {
      text: metricStatusLabels[metric?.status ?? MetricStatus.UNSPECIFIED],
      message: metric?.message || '',
    };
  }
  let cpuSummary = $derived(summaryMetric(stats?.cpuPercent));
  let memorySummary = $derived(summaryMetric(stats?.memoryUsageBytes));
  let uptimeSummary = $derived(summaryMetric(stats?.uptimeSeconds));
  function sampledAtText(value = '') {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
  function runStatusLabel(status?: RunStatus) {
    return ({ [RunStatus.PENDING]: '等待中', [RunStatus.RUNNING]: '运行中', [RunStatus.SUCCEEDED]: '成功', [RunStatus.FAILED]: '失败', [RunStatus.CANCELED]: '已取消' } as Record<number, string>)[status ?? 0] || '未知';
  }
  function lifecycle(status = snapshot?.sandbox.status || '') {
    const normalized = status.toUpperCase();
    if (normalized === 'RUNNING') return 'running';
    if (normalized === 'STOPPED') return 'stopped';
    if (normalized === 'REMOVED' || normalized === 'DESTROYED') return 'destroyed';
    return 'unknown';
  }
  function lifecycleLabel() {
    return ({ running: '运行中', stopped: '已停止 · 可恢复', destroyed: '已销毁', unknown: snapshot?.sandbox.status || '状态未知' })[lifecycle()];
  }
  function targetIsCurrent(projectId: string, sandboxId: string, current: number) {
    if (destroyed) return false;
    return current === generation && projectId === targetProjectId && sandboxId === targetSandboxId;
  }
  function errorMessage(error: any, fallback: string) { return error?.message || fallback; }

  async function loadRuns(projectId: string, sandboxId: string, current: number) {
    try {
      const found: RunSummary[] = [];
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const response = await runService.listRuns(new ListRunsRequest({ projectId, sandboxId, offset, limit }));
        if (!targetIsCurrent(projectId, sandboxId, current)) return;
        found.push(...response.runs);
        if (response.runs.length < limit) break;
      }
      runs = found;
    } catch (error: any) {
      if (targetIsCurrent(projectId, sandboxId, current)) runsError = errorMessage(error, '关联 Run 加载失败');
    }
  }

  async function loadRunEvents(sandboxId: string) {
    const events = [];
    const seenCursors = new Set<string>();
    let cursor = '';
    while (true) {
      const page = await runService.listSandboxRunEvents(new ListSandboxRunEventsRequest({ sandboxId, limit: 500, cursor }));
      events.push(...page.events);
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return new ListSandboxRunEventsResponse({ events });
  }

  async function load() {
    const projectId = targetProjectId;
    const sandboxId = targetSandboxId;
    const current = ++generation;
    stopWatch();
    loading = true; loadError = ''; removed = false; snapshot = undefined; runs = []; runsError = ''; historyError = ''; runEventsError = ''; busy = false; agentReplying = false;
    visibleTimelineCount = timelinePageSize;
    stats = undefined; statsError = ''; output = '';
    if (!projectId || !sandboxId) { loading = false; return; }
    try {
      const [detail, historyResult, runHistoryResult] = await Promise.all([
        sandboxService.getSandbox(new GetSandboxRequest({ sandboxId })),
        sandboxService.listSandboxHistory(new ListSandboxHistoryRequest({ sandboxId }))
          .then(value => ({ value, error: '' }))
          .catch(error => ({ value: new ListSandboxHistoryResponse(), error: errorMessage(error, 'Sandbox 单元历史加载失败') })),
        loadRunEvents(sandboxId)
          .then(value => ({ value, error: '' }))
          .catch(error => ({ value: new ListSandboxRunEventsResponse(), error: errorMessage(error, '结构化 Run 事件加载失败') })),
      ]);
      if (!targetIsCurrent(projectId, sandboxId, current)) return;
      if (!detail.sandbox) throw new Error('Sandbox 详情响应为空');
      historyError = historyResult.error;
      runEventsError = runHistoryResult.error;
      snapshot = buildSandboxDetailSnapshot(detail.sandbox, historyResult.value, runHistoryResult.value);
      loading = false;
      syncTabFromUrl();
      void loadRuns(projectId, sandboxId, current);
      if (lifecycle() === 'running') void probe(current, projectId, sandboxId);
      startWatch(current, projectId, sandboxId);
    } catch (error: any) {
      if (targetIsCurrent(projectId, sandboxId, current)) {
        if (ConnectError.from(error).code === Code.NotFound) removed = true;
        else loadError = errorMessage(error, '加载 Sandbox 详情失败');
        loading = false;
      }
    }
  }

  function stopWatch() {
    watchController?.abort();
    watchController = undefined;
  }

  function startWatch(current: number, projectId: string, sandboxId: string) {
    if (document.visibilityState !== 'visible' || destroyed || !targetIsCurrent(projectId, sandboxId, current)) return;
    if (watchController && !watchController.signal.aborted) return;
    const controller = new AbortController();
    watchController = controller;
    void (async () => {
      try {
        for await (const event of sandboxService.watchSandbox(new WatchSandboxRequest({ sandboxId }), { signal: controller.signal })) {
          if (controller.signal.aborted || !targetIsCurrent(projectId, sandboxId, current) || !snapshot) return;
          snapshot = mergeSandboxWatchEvent(snapshot, event);
        }
      } catch {}
      if (watchController === controller) watchController = undefined;
      if (controller.signal.aborted || document.visibilityState !== 'visible' || !targetIsCurrent(projectId, sandboxId, current)) return;
      window.setTimeout(() => {
        if (!controller.signal.aborted && document.visibilityState === 'visible' && targetIsCurrent(projectId, sandboxId, current)) startWatch(current, projectId, sandboxId);
      }, 1000);
    })();
  }

  function syncWatchVisibility() {
    if (document.visibilityState !== 'visible') {
      stopWatch();
      return;
    }
    const sandboxId = snapshot?.sandbox.sandboxId || '';
    if (sandboxId) startWatch(generation, targetProjectId, sandboxId);
  }

  async function probe(current = generation, projectId = targetProjectId, sandboxId = snapshot?.sandbox.sandboxId || '') {
    if (!sandboxId || !targetIsCurrent(projectId, sandboxId, current)) return;
    statsLoading = true; statsError = '';
    try {
      const response = await sandboxService.getSandboxStats(new GetSandboxStatsRequest({ sandboxId }));
      if (targetIsCurrent(projectId, sandboxId, current)) stats = response.stats;
    } catch (error: any) {
      if (targetIsCurrent(projectId, sandboxId, current)) statsError = errorMessage(error, '读取 Sandbox 指标失败');
    } finally {
      if (targetIsCurrent(projectId, sandboxId, current)) statsLoading = false;
    }
  }

  function tabFromUrl(): SandboxTab {
    const value = new URLSearchParams(window.location.search).get('sandboxTab');
    return sandboxTabs.includes(value as SandboxTab) ? value as SandboxTab : 'details';
  }
  function sandboxPathFromUrl() {
    const url = new URL(window.location.href);
    const path = url.searchParams.get('sandboxPath') || '';
    if (!path) return '';
    if (url.searchParams.get('sandboxPathSandboxId') === targetSandboxId) return path;
    url.searchParams.delete('sandboxPath');
    url.searchParams.delete('sandboxPathSandboxId');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return '';
  }
  function syncTabFromUrl() { activeTab = tabFromUrl(); }
  function selectTab(tab: SandboxTab) {
    activeTab = tab;
    const url = new URL(window.location.href);
    if (tab === 'details') url.searchParams.delete('sandboxTab');
    else url.searchParams.set('sandboxTab', tab);
    window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  onMount(() => {
    window.addEventListener('popstate', syncTabFromUrl);
    document.addEventListener('visibilitychange', syncWatchVisibility);
    return () => {
      window.removeEventListener('popstate', syncTabFromUrl);
      document.removeEventListener('visibilitychange', syncWatchVisibility);
    };
  });
  onDestroy(() => {
    destroyed = true;
    generation++;
    stopWatch();
  });

  async function execute(runtime: 'javascript' | 'python') {
    const sandboxId = snapshot?.sandbox.sandboxId || '';
    const source = command.trim();
    if (!source || lifecycle() !== 'running') return;
    const current = generation;
    const commands = {
      javascript: new ExecCommand({ command: 'node', args: ['-e', source] }),
      python: new ExecCommand({ command: 'python3', args: ['-c', source] }),
    };
    busy = true;
    try {
      const response = await execService.exec(new ExecRequest({ target: { case: 'sandboxId', value: sandboxId }, command: commands[runtime] }));
      if (current === generation && sandboxId === snapshot?.sandbox.sandboxId) output = response.result?.output || response.result?.stdout || response.result?.stderr || response.result?.error || '命令已完成（无输出）';
    } catch (error: any) {
      if (current === generation) output = errorMessage(error, '执行失败');
    } finally { if (current === generation) busy = false; }
  }

  async function executeAgent() {
    const projectId = targetProjectId;
    const sandboxId = snapshot?.sandbox.sandboxId || '';
    const agentName = associatedAgentName;
    const prompt = command.trim();
    if (!projectId || !sandboxId || !agentName || !prompt || lifecycle() !== 'running') return;
    const current = generation;
    busy = true;
    agentReplying = true;
    try {
      const response = await runService.runAgent(new RunAgentRequest({
        projectId, agentName, sandboxId, prompt,
        source: RunSource.MANUAL,
        cleanupPolicy: RunSandboxCleanupPolicy.KEEP_RUNNING,
      }));
      if (!targetIsCurrent(projectId, sandboxId, current)) return;
      output = response.run?.output || response.run?.resultJson || response.run?.summary?.error || 'Agent 已完成（无输出）';
      await loadRuns(projectId, sandboxId, current);
    } catch (error: any) {
      if (targetIsCurrent(projectId, sandboxId, current)) output = errorMessage(error, 'Agent 执行失败');
    } finally {
      if (targetIsCurrent(projectId, sandboxId, current)) { busy = false; agentReplying = false; }
    }
  }

  async function resume() {
    if (!snapshot || lifecycle() !== 'stopped' || !window.confirm(`恢复 Sandbox ${snapshot.sandbox.sandboxId}？`)) return false;
    const projectId = targetProjectId;
    const sandboxId = snapshot.sandbox.sandboxId;
    const current = generation;
    busy = true;
    try {
      const response = await sandboxService.resumeSandbox(new ResumeSandboxRequest({ sandboxId }));
      if (!targetIsCurrent(projectId, sandboxId, current)) return false;
      if (response.sandbox) snapshot = { ...snapshot, sandbox: response.sandbox };
      store.addToast('Sandbox 已恢复', 'success');
      return true;
    } catch (error: unknown) { if (targetIsCurrent(projectId, sandboxId, current)) store.addToast(sandboxResumeErrorMessage(error), 'error'); return false; }
    finally { if (targetIsCurrent(projectId, sandboxId, current)) busy = false; }
  }
  async function stop() {
    if (!snapshot || lifecycle() !== 'running' || !window.confirm(`停止 Sandbox ${snapshot.sandbox.sandboxId}？`)) return;
    const projectId = targetProjectId;
    const sandboxId = snapshot.sandbox.sandboxId;
    const current = generation;
    busy = true;
    try {
      const response = await sandboxService.stopSandbox(new StopSandboxRequest({ sandboxId }));
      if (!targetIsCurrent(projectId, sandboxId, current)) return;
      if (response.sandbox) snapshot = { ...snapshot, sandbox: response.sandbox };
      store.addToast('Sandbox 已停止', 'success');
    } catch (error: any) { if (targetIsCurrent(projectId, sandboxId, current)) store.addToast(errorMessage(error, '停止 Sandbox 失败'), 'error'); }
    finally { if (targetIsCurrent(projectId, sandboxId, current)) busy = false; }
  }
  async function remove() {
    if (!snapshot || !['running', 'stopped'].includes(lifecycle())) return;
    const force = lifecycle() === 'running';
    if (!window.confirm(`${force ? '强制删除' : '删除'} Sandbox ${snapshot.sandbox.sandboxId}？此操作不可撤销。`)) return;
    busy = true;
    try { await sandboxService.removeSandbox(new RemoveSandboxRequest({ sandboxId: snapshot.sandbox.sandboxId, force })); store.addToast('Sandbox 已移除', 'success'); await load(); }
    catch (error: any) { store.addToast(errorMessage(error, '移除 Sandbox 失败'), 'error'); }
    finally { busy = false; }
  }
  function navigateBack() {
    if (store.sandboxReturnView) store.navigateBack();
    else if (snapshot?.sandbox.agentName) store.navigateTo('agent-sandboxes', { agentName: snapshot.sandbox.agentName });
    else store.navigateTo('agents');
  }
  function formatTime(value: string) {
    if (!value) return '时间未提供';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
  function loadMoreTimeline(event: Event) {
    const element = event.currentTarget as HTMLElement;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 180) {
      visibleTimelineCount = Math.min(filteredTimelineEntries.length, visibleTimelineCount + timelinePageSize);
    }
  }
  function selectTimelineFilter(filter: SandboxTimelineFilter) {
    activeTimelineFilter = filter;
    visibleTimelineCount = timelinePageSize;
  }
  $effect(() => { void store.runtimeRefreshVersion; void targetProjectId; void targetSandboxId; void load(); });
</script>

<div class="root">
  {#if loading}<div class="state">加载 Sandbox 详情中...</div>
  {:else if removed}
    {#if showBreadcrumb}<RuntimeBreadcrumb
        eyebrow={`Sandbox 详情 · ${targetSandboxId}`}
        title="该 Sandbox 已被删除"
        onBack={navigateBack}
        status="已销毁"
        statusTone="danger"
      />{/if}
    <div class="state removed">
      <p class="state-heading">该 Sandbox 已被删除</p>
      <p class="state-detail">此运行环境已被移除，Terminal、Files、Jupyter 和实时指标不再可用。请返回列表查看其他 Sandbox。</p>
    </div>
  {:else if loadError}
    {#if showBreadcrumb}<RuntimeBreadcrumb
        eyebrow={`Sandbox 详情 · ${targetSandboxId}`}
        title="加载失败"
        onBack={navigateBack}
        status="加载失败"
        statusTone="warning"
      />{/if}
    <div class="state error">加载失败：{loadError}<button onclick={load}>重试</button></div>
  {:else if !snapshot}
    {#if showBreadcrumb}<RuntimeBreadcrumb eyebrow="Sandbox 详情" title="未找到 Sandbox" onBack={navigateBack} />{/if}
    <div class="state">未找到 Sandbox</div>
  {:else}
    {#if showBreadcrumb}<RuntimeBreadcrumb
        eyebrow={`Sandbox 详情 · ${snapshot.sandbox.sandboxId}`}
        title={snapshot.sandbox.title || snapshot.sandbox.sandboxId}
        onBack={navigateBack}
        status={lifecycleLabel()}
        statusTone={lifecycle() === 'running' ? 'success' : lifecycle() === 'stopped' ? 'warning' : lifecycle() === 'destroyed' ? 'danger' : 'default'}
        actions={[{ label: '↻', ariaLabel: '刷新', title: '刷新', onclick: load, variant: 'primary' }]}
      />{/if}
    <main class="console-content">
        <span class="metadata" hidden><span></span></span>
        <section class="status-actions" aria-label="Sandbox 状态与操作">
          <div class="primary-metrics"><span>CPU <strong title={cpuSummary.message}>{cpuSummary.text}</strong></span><span>内存 <strong title={memorySummary.message}>{memorySummary.text}</strong></span><span>Driver <strong>{stats?.driver || snapshot.sandbox.driver || '-'}</strong></span><span>Uptime <strong title={uptimeSummary.message}>{uptimeSummary.text}</strong></span></div>
          {#if lifecycle() === 'running'}<button class="refresh-metrics" aria-label="刷新指标" title="刷新指标" onclick={() => probe()} disabled={statsLoading}>↻</button>{/if}
          <div class="sandbox-actions">{#if lifecycle() === 'running'}<button onclick={stop} disabled={busy}>停止</button><button class="danger" onclick={remove} disabled={busy}>强制删除</button>
          {:else if lifecycle() === 'stopped'}<button onclick={resume} disabled={busy}>恢复</button><button class="danger" onclick={remove} disabled={busy}>删除 Sandbox</button>{/if}</div>
          {#if stats?.sampledAt}<div class="supplemental-metrics">
            {#if stats?.sampledAt}<span>采样 <strong title={stats.sampledAt}>{sampledAtText(stats.sampledAt)}</strong></span>{/if}
          </div>{/if}
        </section>
        <div class="tabs" role="tablist" aria-label="Sandbox 详情">
          {#each tabOptions as tab}
            <button id={`sandbox-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`sandbox-panel-${tab.id}`} onclick={() => selectTab(tab.id)}>{tab.label}</button>
          {/each}
        </div>

        {#if activeTab === 'details'}
          <div id="sandbox-panel-details" class="tab-panel" role="tabpanel" aria-label="运行详情" aria-labelledby="sandbox-tab-details" onscroll={loadMoreTimeline}>
            {#if lifecycle() === 'destroyed'}<div class="notice">运行环境已销毁；实时 Terminal、Files、Jupyter、Stats 和 Exec 不再可用。</div>{/if}
            {#if statsError}<div class="notice error">指标加载失败：{statsError}</div>{/if}
            {#if historyError}<div class="notice error">Sandbox 单元历史加载失败：{historyError}</div>{/if}
            {#if runEventsError}<div class="notice error">结构化 Run 事件加载失败：{runEventsError}</div>{/if}
            <section class="sandbox-timeline" aria-label="Sandbox 执行时间线">
              <div class="timeline-toolbar" aria-label="Sandbox 时间线筛选">{#each sandboxTimelineFilters as filter}<button class:active={activeTimelineFilter === filter} aria-pressed={activeTimelineFilter === filter} onclick={() => selectTimelineFilter(filter)}>{sandboxTimelineFilterLabels[filter]}</button>{/each}<span>{!historyError && !runEventsError ? '全量加载完成 · ' : ''}已展示 {visibleTimelineEntries.length} / {filteredTimelineEntries.length} 条</span></div>
              <header><span>时间</span><span>执行详情</span></header>
              {#if !filteredTimelineEntries.length}<div class="notice">当前筛选下暂无执行历史</div>{/if}
              {#each visibleTimelineEntries as entry (entry.id)}
                <article class:error={entry.level === 'error'}>
                  <time title={entry.timestamp}>{formatTime(entry.timestamp)}</time>
                  <TimelineEntry {entry} collapseAfterLines={20} />
                </article>
              {/each}
              {#if visibleTimelineCount < filteredTimelineEntries.length}<div class="timeline-loading">继续向下滚动加载 · {visibleTimelineCount} / {filteredTimelineEntries.length}</div>{:else}
                <article id="runs" class="related-runs-row">
                  <time>关联 Run 历史</time>
                  <div><header><strong>RUN</strong><code>{runs.length} 条</code></header>
                    {#if runsError}<div class="notice error">关联 Run 加载失败：{runsError}</div>{:else if !runs.length}<p>暂无关联 Run</p>{:else}<div class="related-run-list">{#each runs as run (run.runId)}<button aria-label={`${run.runId} ${run.agentName}`} onclick={() => store.navigateTo('run-detail', { agentName: run.agentName, runId: run.runId })}><code>{run.runId}</code><span>{run.agentName || '-'}</span><span>{runStatusLabel(run.status)}</span><time>{run.updatedAt || run.createdAt || '-'}</time></button>{/each}</div>{/if}
                  </div>
                </article>
              {/if}
            </section>
          </div>
        {:else if activeTab === 'exec'}
          <div id="sandbox-panel-exec" class="tab-panel" role="tabpanel" aria-label="快速执行" aria-labelledby="sandbox-tab-exec">
            {#if lifecycle() === 'running'}<section class="quick-exec" aria-label="快速执行命令"><h3>快速执行</h3><label><span>执行代码</span><input aria-label="执行代码" bind:value={command} placeholder="输入 Agent 提示词、JavaScript 或 Python" /></label><div><button onclick={executeAgent} disabled={busy || !command.trim() || !associatedAgentName}>Agent</button><button onclick={() => execute('javascript')} disabled={busy || !command.trim()}>JavaScript</button><button onclick={() => execute('python')} disabled={busy || !command.trim()}>Python</button></div>{#if !associatedAgentName}<div class="notice">该 Sandbox 未关联 Agent</div>{/if}{#if agentReplying}<div class="agent-replying" role="status"><span aria-hidden="true"></span>回复中…</div>{/if}{#if output}<pre>{output}</pre>{/if}</section>
            {:else}<div class="notice">Sandbox 未运行，快速执行不可用。</div>{/if}
          </div>
        {:else if activeTab === 'terminal'}
          <div id="sandbox-panel-terminal" class="tab-panel tool-panel" role="tabpanel" aria-label="Terminal" aria-labelledby="sandbox-tab-terminal">
            {#if lifecycle() === 'running'}{#key `${targetProjectId}:${snapshot.sandbox.sandboxId}:terminal`}<SessionTerminal sandboxId={snapshot.sandbox.sandboxId} autoConnect />{/key}
            {:else}<div class="notice">Sandbox 未运行，Terminal 不可用。</div>{/if}
          </div>
        {:else}
          <div id="sandbox-panel-files" class="tab-panel tool-panel" role="tabpanel" aria-label="Files" aria-labelledby="sandbox-tab-files">
            {#if lifecycle() === 'running'}{#key `${targetProjectId}:${snapshot.sandbox.sandboxId}:files:${sandboxPathFromUrl()}`}<FileBrowser sandboxId={snapshot.sandbox.sandboxId} initialFilePath={sandboxPathFromUrl()} />{/key}
            {:else}<div class="notice">Sandbox 未运行，Files 不可用。</div>{/if}
          </div>
        {/if}
    </main>
  {/if}
</div>

<style>
  .root{height:100%;overflow:hidden;display:flex;flex-direction:column}.state{padding:30px;text-align:center;color:var(--text-muted)}.state.removed{padding:48px 24px;display:flex;flex-direction:column;align-items:center;gap:10px}.state.removed .state-heading{margin:0;color:var(--text-primary);font-size:var(--font-size-lg);font-weight:600}.state.removed .state-detail{margin:0;max-width:440px;color:var(--text-muted);font-size:var(--font-size-sm);line-height:1.6}.error{color:var(--accent-red)}h3{font-size:var(--font-size-md)}span,time{color:var(--text-muted);font-size:var(--font-size-xs)}button,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);padding:6px 8px}.danger{color:var(--accent-red)}.console-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:12px 14px}.metadata{display:flex;gap:8px 16px;flex-wrap:wrap;padding-bottom:9px}.metadata span{font-size:var(--font-size-xs)}.tabs{display:flex;flex:0 0 auto;overflow-x:auto;margin-top:10px;border-bottom:1px solid var(--border-color)}.tabs button{flex:0 0 auto;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--text-muted)}.tabs button:hover{color:var(--text-primary);background:var(--bg-secondary)}.tabs button[aria-selected="true"]{border-bottom-color:var(--accent-blue);color:var(--text-primary)}.tabs button:focus-visible{outline:2px solid var(--accent-blue);outline-offset:-2px}.tab-panel{flex:1;min-height:0;overflow:auto;padding-top:12px}.tab-panel.tool-panel{display:flex;flex-direction:column;overflow:hidden}.tab-panel.tool-panel>:global(*){min-height:0}.notice{margin-top:8px;padding:8px;background:var(--bg-secondary);font-size:var(--font-size-xs);color:var(--text-muted)}pre{max-height:220px;overflow:auto;padding:8px;background:var(--bg-secondary);white-space:pre-wrap}.quick-exec{margin-top:14px;padding-bottom:10px;border:1px solid var(--border-color);background:var(--bg-primary)}.quick-exec h3{margin:0;padding:9px 10px;border-bottom:1px solid var(--border-color);background:var(--bg-secondary)}.quick-exec label{display:grid;gap:4px;padding:10px 10px 6px}.quick-exec input{width:100%;background:var(--bg-primary)}.quick-exec>div{display:flex;justify-content:flex-end;gap:6px;padding:0 10px}.quick-exec>.agent-replying{justify-content:flex-start;align-items:center;margin:10px 10px 0;padding:9px 10px;border-left:2px solid var(--accent-blue);background:var(--bg-secondary);color:var(--text-secondary);font-size:var(--font-size-sm)}.agent-replying span{width:6px;height:6px;border-radius:50%;background:var(--accent-blue);animation:reply-pulse 1.1s ease-in-out infinite}.quick-exec>pre{margin:10px}@keyframes reply-pulse{50%{opacity:.25;transform:scale(.75)}}@media(max-width:760px){.console-content{padding:10px}}
  .status-actions{display:grid;grid-template-columns:minmax(0,auto) auto minmax(0,1fr);align-items:center;overflow:hidden;margin-top:0;border:1px solid var(--border-color);border-radius:5px;background:var(--bg-secondary)}
  .primary-metrics,.supplemental-metrics{display:flex;min-width:0;align-items:center}
  .primary-metrics{overflow-x:auto}.primary-metrics>span{flex:0 0 auto;padding:7px 10px;border-right:1px solid var(--border-color);font-size:var(--font-size-xs)}
  .status-actions strong{margin-left:4px;color:var(--text-primary);font-family:var(--font-mono);font-weight:500;white-space:nowrap}
  .status-actions .refresh-metrics{margin-left:6px;padding:4px 7px;color:var(--accent-blue);font-size:14px;line-height:1}
  .sandbox-actions{display:flex;justify-content:flex-end;gap:6px;padding:4px 6px}
  .supplemental-metrics{grid-column:1/-1;gap:16px;overflow-x:auto;padding:5px 10px;border-top:1px solid var(--border-color);background:var(--bg-primary)}
  .supplemental-metrics>span{flex:0 0 auto;color:var(--text-muted);font-size:var(--font-size-xs)}.supplemental-metrics strong{font-size:var(--font-size-xs)}
  .sandbox-timeline{margin-top:14px;overflow:hidden;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary)}
  .timeline-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:8px;border-bottom:1px solid var(--border-color);background:var(--bg-secondary)}
  .timeline-toolbar button{padding:3px 7px;border:1px solid var(--border-color);border-radius:3px;background:var(--bg-tertiary);color:var(--text-muted);font-size:var(--font-size-xs)}.timeline-toolbar button.active{border-color:var(--accent-blue);color:var(--accent-blue)}.timeline-toolbar>span{margin-left:auto;font:var(--font-size-xs) var(--font-mono)}
  .sandbox-timeline>header{display:grid;grid-template-columns:150px minmax(0,1fr);border-bottom:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-muted);font-size:var(--font-size-xs);font-weight:700}
  .sandbox-timeline>header span{padding:8px 10px}.sandbox-timeline>header span+span{border-left:1px solid var(--border-color)}
  .sandbox-timeline>article{display:grid;grid-template-columns:150px minmax(0,1fr);border-bottom:1px solid var(--border-color);animation:timeline-row-in 160ms ease-out both}.sandbox-timeline>article:last-child{border-bottom:0}
  .sandbox-timeline>article>time{padding:10px;color:var(--text-muted);font:var(--font-size-xs)/1.5 var(--font-mono)}
  .sandbox-timeline>article>div{min-width:0;padding:9px 10px;border-left:1px solid var(--border-color)}
  .timeline-loading{padding:12px;text-align:center;color:var(--text-muted);font-size:var(--font-size-xs)}
  .related-run-list{display:grid;margin-top:8px;border-top:1px solid var(--border-color)}
  .related-run-list>button{display:grid;grid-template-columns:minmax(150px,1fr) 110px 70px minmax(120px,160px);gap:10px;width:100%;padding:8px 0;border:0;border-bottom:1px solid var(--border-color);border-radius:0;background:transparent;text-align:left}.related-run-list>button:last-child{border-bottom:0}.related-run-list code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.related-runs-row p{margin:8px 0;color:var(--text-muted);font-size:var(--font-size-xs)}
  @keyframes timeline-row-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
  @media(max-width:760px){.status-actions{grid-template-columns:minmax(0,1fr) auto}.sandbox-actions{grid-row:3;grid-column:1/-1;border-top:1px solid var(--border-color)}.supplemental-metrics{grid-row:2;grid-column:1/-1}.sandbox-timeline>header,.sandbox-timeline>article{grid-template-columns:100px minmax(0,1fr)}.related-run-list>button{grid-template-columns:1fr 70px}.related-run-list>button time{grid-column:1/-1}}
  @media(prefers-reduced-motion:reduce){.sandbox-timeline>article,.agent-replying span{animation:none}}
  .root{position:relative}
</style>
