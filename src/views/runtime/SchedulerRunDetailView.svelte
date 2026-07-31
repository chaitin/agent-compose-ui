<script lang="ts">
  import { untrack } from 'svelte';
  import { GetSchedulerRunRequest } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { projectService, runService, sandboxService } from '../../lib/rpc';
  import { schedulerRunEventId } from '../../lib/scheduler-run-event';
  import { store } from '../../lib/stores.svelte';
  import {
    loadFullSchedulerExecution, type AggregationPhase, type FullExecutionDependencies,
    type FullSchedulerExecutionResult, type SourceCompleteness,
  } from '../../lib/scheduler-full-execution';
  import type { RuntimeTimelineFilterTag } from '../../lib/runtime-timeline';
  import TimelineEntry from './TimelineEntry.svelte';
  import { copyText as writeClipboardText } from '../../lib/clipboard';

  type Filter = 'all' | RuntimeTimelineFilterTag;
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: '全部' }, { id: 'message', label: '消息' }, { id: 'activity', label: '活动' },
    { id: 'run', label: '运行' }, { id: 'artifact', label: '产物' }, { id: 'problem', label: '问题' },
  ];
  const phaseLabels: Record<AggregationPhase, string> = {
    scheduler: '正在读取 Scheduler 事件', discovering: '正在发现关联资源', sandbox: '正在读取 Sandbox 数据',
    run: '正在读取 Run 数据', merging: '正在合并完整时间线',
  };
  const dependencies: FullExecutionDependencies = {
    listSchedulerEvents: (request, options) => projectService.listSchedulerEvents(request, options),
    getSandbox: (request, options) => sandboxService.getSandbox(request, options),
    listSandboxHistory: (request, options) => sandboxService.listSandboxHistory(request, options),
    listSandboxRunEvents: (request, options) => runService.listSandboxRunEvents(request, options),
    getRun: (request, options) => runService.getRun(request, options),
    listRunEvents: (request, options) => runService.listRunEvents(request, options),
    followRunLogs: (request, options) => runService.followRunLogs(request, options),
  };

  let activeFilter = $state<Filter>('all');
  let visibleLimit = $state<100 | 500 | 'all'>(100);
  let phase = $state<AggregationPhase>('scheduler');
  let result = $state<FullSchedulerExecutionResult>();
  let eventId = $state('');
  let error = $state('');
  let retryToken = $state(0);
  let generation = 0;
  let previousRunKey = '';
  let projectId = $derived(store.activeProjectId);
  let agentName = $derived(store.runtimeView.agentName);
  let runId = $derived(store.runtimeView.runId);
  let execution = $derived(result?.execution);
  let failedSources = $derived(result?.sourceStatuses.filter(status => status.state === 'failed' || status.state === 'unavailable') ?? []);
  let filteredEntries = $derived(result?.entries.filter(entry => activeFilter === 'all' || entry.filterTags?.includes(activeFilter)) ?? []);
  let visibleEntries = $derived(visibleLimit === 'all' ? filteredEntries : filteredEntries.slice(0, visibleLimit));

  $effect(() => {
    const requestedProject = projectId;
    const requestedAgent = agentName;
    const requestedRun = runId;
    retryToken;
    const runKey = `${requestedProject}\0${requestedAgent}\0${requestedRun}`;
    if (runKey !== previousRunKey) {
      activeFilter = 'all';
      visibleLimit = 100;
      previousRunKey = runKey;
    }
    const current = ++generation;
    const controller = new AbortController();
    result = undefined; eventId = ''; error = ''; phase = 'scheduler';
    if (!requestedProject || !requestedAgent || !requestedRun) return () => controller.abort();
    untrack(() => {
      void load(current, controller, requestedProject, requestedAgent, requestedRun);
      void loadEventId(current, controller, requestedProject, requestedRun);
    });
    return () => controller.abort();
  });

  async function load(current: number, controller: AbortController, requestedProject: string, requestedAgent: string, requestedRun: string) {
    try {
      const loaded = await loadFullSchedulerExecution({ projectId: requestedProject, agentName: requestedAgent, schedulerRunId: requestedRun, signal: controller.signal }, dependencies, next => {
        if (current === generation) phase = next;
      });
      if (current !== generation || controller.signal.aborted) return;
      result = loaded;
    } catch (cause: unknown) {
      if (current !== generation || controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
      error = cause instanceof Error ? cause.message : '加载调度执行详情失败';
      store.addToast(error, 'error');
    }
  }

  async function loadEventId(current: number, controller: AbortController, requestedProject: string, requestedRun: string) {
    try {
      const response = await projectService.getSchedulerRun(new GetSchedulerRunRequest({
        project: { projectId: requestedProject },
        runId: requestedRun,
      }), { signal: controller.signal });
      if (current === generation && !controller.signal.aborted) eventId = schedulerRunEventId(response.run?.payloadJson ?? '');
    } catch {
      // Event metadata is optional enrichment and must not block the execution timeline.
    }
  }

  function retry() { retryToken += 1; }
  function openSandboxDetail(sandboxId: string) { store.navigateTo('sandbox-detail', { sandboxId }); }
  function statusLabel(status = execution?.status) {
    return ({ running: '运行中', succeeded: '成功', failed: '失败', skipped: '已跳过', unknown: '未知' } as Record<string, string>)[status || 'unknown'];
  }
  function statusClass(status = execution?.status) {
    return ({ running: 'running', succeeded: 'success', failed: 'failed', skipped: 'pending', unknown: 'unknown' } as Record<string, string>)[status || 'unknown'];
  }
  function formatTime(value = '') { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'; }
  function formatTimelineTime(value = '') { return value ? formatTime(value) : '时间未知'; }
  function formatDuration(value = 0) { return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`; }
  async function copyText(value: string, success: string) {
    try { await writeClipboardText(value); store.addToast(success, 'success'); }
    catch { store.addToast('复制失败', 'error'); }
  }
  function copyFailure(status: SourceCompleteness) { return copyText([status.source, status.resourceId, status.state, status.error].filter(Boolean).join('\n'), '已复制来源错误'); }
</script>

<div class="root">
  <header class="page-header"><button onclick={() => store.navigateBack()}>← 返回</button><div><p>{agentName}</p><h1>调度执行详情</h1></div>{#if !result}<button class="refresh-button" aria-label="刷新" title="刷新" onclick={retry}>↻</button>{/if}</header>
  {#if !result && !error}<div class="state">{phaseLabels[phase]}</div>
  {:else if error}<div class="state error"><p>{error}</p></div>
  {:else if !execution}<div class="state"><p>未找到调度执行记录</p></div>
  {:else if result}
    <section class="flow-summary">
      <div class="summary-copy">
        <div class="summary-title-row">
          <span class="status-pill {statusClass()}"><i aria-hidden="true"></i>{statusLabel()}</span>
          <h1>{agentName} 调度运行{execution.status === 'running' ? '中' : '完成'}</h1>
          <div class="summary-meta"><span>调度器运行</span></div>
        </div>
        <dl class="identifier-list">
          <div><dt>Scheduler Run ID</dt><dd>{execution.schedulerRunId}</dd></div>
          <div><dt>Trigger ID</dt><dd>{execution.triggerId || '—'}</dd></div>
          {#if eventId}<div><dt>Event ID</dt><dd><a class="event-link" href={`/agent-compose/events/${encodeURIComponent(eventId)}`}>{eventId}</a></dd></div>{/if}
          <div><dt>快照时间</dt><dd>{formatTime(result.snapshotAt)}</dd></div>
          <div><dt>Sandbox ID</dt><dd class="sandbox-identifiers">{#if result.sandboxIds.length}{#each result.sandboxIds as sandboxId}<button class="sandbox-link" aria-label={sandboxId} onclick={() => openSandboxDetail(sandboxId)}>{sandboxId}</button>{/each}{:else}—{/if}</dd></div>
        </dl>
      </div>
      <div class="summary-actions">
        <div class="summary-metrics"><div class="metric"><span>耗时</span><strong>{formatDuration(execution.durationMs)}</strong></div></div>
      </div>
    </section>
    {#if !result.complete}<section class="completeness partial">
      <strong>已加载后端当前可取得的信息，但全量性无法确认</strong>
      {#if failedSources.length}<ul>{#each failedSources as status}<li><code>{status.source} · {status.resourceId} · {status.state}</code><span>{status.error}</span><button onclick={() => copyFailure(status)}>复制错误</button></li>{/each}</ul>{/if}
    </section>{/if}
    <div class="section-heading"><span>执行过程</span><span class="heading-time">{formatTime(execution.startedAt)} → {formatTime(execution.completedAt)}</span></div>
    <section class="timeline-panel">
      <header class="toolbar" aria-label="调度执行时间线筛选">{#each filters as filter}<button class="timeline-filter" class:active={activeFilter === filter.id} aria-pressed={activeFilter === filter.id} onclick={() => activeFilter = filter.id}>{filter.label}</button>{/each}<span class="timeline-count">{result.complete ? '全量加载完成 · ' : ''}已展示 {visibleEntries.length} / {filteredEntries.length} 条</span><button class="refresh-button" aria-label="刷新" title="刷新" onclick={retry}>↻</button></header>
      <div class="timeline">
        {#each visibleEntries as entry (entry.id)}<article class:error={entry.level === 'error'} class:warning={entry.level === 'warning'}>
          <time title={entry.timestamp}>{formatTimelineTime(entry.timestamp)}</time><TimelineEntry {entry} />
        </article>{/each}
        {#if filteredEntries.length === 0}<div class="state">当前筛选没有记录</div>{/if}
      </div>
      {#if visibleLimit === 100 && filteredEntries.length > 100}<footer><button onclick={() => visibleLimit = 500}>展示到 500 条</button></footer>
      {:else if visibleLimit === 500 && filteredEntries.length > 500}<footer><button onclick={() => visibleLimit = 'all'}>展示全部</button></footer>{/if}
    </section>
  {/if}
</div>

<style>
  .root{height:100%;overflow:auto;padding:14px;background:var(--bg-primary);color:var(--text-primary)}button{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-secondary);padding:5px 8px}.page-header{display:flex;align-items:center;box-sizing:border-box;height:41px;gap:12px;margin:-14px -14px 14px;padding:5px 14px;border-bottom:1px solid var(--border-color)}.page-header>.refresh-button{margin-left:auto}p,h1{margin:0}p{color:var(--text-muted);font-size:var(--font-size-xs)}h1{font-size:var(--font-size-xl)}.flow-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;margin-bottom:12px;padding:13px 14px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-secondary)}.summary-title-row,.summary-actions{display:flex;align-items:center;gap:8px}.summary-title-row h1{margin:0;color:var(--text-primary);font-size:var(--font-size-lg)}.status-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 6px;border:1px solid var(--border-color);border-radius:9px;color:var(--text-muted);font-size:var(--font-size-xs);font-weight:700}.status-pill i{width:5px;height:5px;border-radius:50%;background:currentColor}.status-pill.success{color:var(--accent-green)}.status-pill.running{color:var(--accent-blue)}.status-pill.failed{color:var(--accent-red)}.status-pill.pending{color:var(--accent-yellow)}.summary-meta{color:var(--text-muted);font:var(--font-size-xs) var(--font-mono);white-space:nowrap}.identifier-list{display:grid;gap:3px;margin:9px 0 0;font:var(--font-size-xs) var(--font-mono)}.identifier-list div{display:grid;grid-template-columns:110px minmax(0,1fr)}.identifier-list dt{color:var(--text-muted)}.identifier-list dd{margin:0;overflow-wrap:anywhere;color:var(--text-secondary)}.sandbox-identifiers{display:flex;flex-wrap:wrap;gap:4px}.sandbox-link,.event-link{padding:0;border:0;background:transparent;color:var(--accent-blue);font:inherit;text-align:left}.event-link{text-decoration:none}.sandbox-link:hover,.event-link:hover{text-decoration:underline}.summary-metrics{display:flex;border:1px solid var(--border-color);border-radius:5px;overflow:hidden}.metric{min-width:68px;padding:7px 10px;background:var(--bg-primary)}.metric span{display:block;color:var(--text-muted);font-size:var(--font-size-xs)}.metric strong{color:var(--text-primary);font:var(--font-size-xs) var(--font-mono)}.section-heading{display:flex;align-items:center;margin:13px 1px 7px;color:var(--text-secondary);font-size:var(--font-size-xs);font-weight:700}.heading-time{margin-left:auto;color:var(--text-muted);font-family:var(--font-mono);font-weight:400}.completeness{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px;border:1px solid var(--accent-green);color:var(--accent-green)}.completeness.partial{display:block;border-color:var(--accent-yellow);color:var(--accent-yellow)}.completeness ul{padding-left:18px}.completeness li{display:flex;align-items:center;gap:8px;margin-top:6px}.completeness li span{color:var(--text-secondary)}.refresh-button{display:inline-grid;width:28px;height:28px;place-items:center;padding:0;font-size:15px;line-height:1}.timeline-panel{border:1px solid var(--border-color);border-radius:6px;overflow:hidden;background:var(--bg-secondary)}.toolbar{display:flex;gap:5px;align-items:center;padding:8px;border-bottom:1px solid var(--border-color)}.toolbar button.active{border-color:var(--accent-blue);color:var(--accent-blue)}.toolbar .timeline-filter{font-size:var(--font-size-xs)}.toolbar .timeline-count{margin-left:auto;color:var(--text-muted);font-size:var(--font-size-sm)}.timeline article{display:grid;grid-template-columns:155px minmax(0,1fr);border-bottom:1px solid var(--border-color)}.timeline article>time{padding:10px;color:var(--text-muted);font:var(--font-size-xs) var(--font-mono)}footer{padding:10px;text-align:center;border-top:1px solid var(--border-color)}.state{padding:24px;text-align:center;color:var(--text-muted)}.state.error{color:var(--accent-red)}@media(max-width:760px){.page-header{height:auto}.flow-summary{grid-template-columns:1fr}.identifier-list div{grid-template-columns:86px minmax(0,1fr)}.timeline article{grid-template-columns:100px minmax(0,1fr)}.heading-time{display:none}}
</style>
