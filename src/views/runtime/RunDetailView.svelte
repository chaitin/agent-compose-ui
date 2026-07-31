<script lang="ts">
  import { runService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import { buildStopRunRequest } from '../../lib/run-controls';
  import { RunSource, RunStatus, type RunDetail } from '../../gen/agentcompose/v2/agentcompose_pb';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import RunExecutionProcess from './RunExecutionProcess.svelte';

  let {
    projectId: providedProjectId = '', agentName: providedAgentName = '', runId: providedRunId = '', embedded = false,
    onSettled = () => {},
  }: { projectId?: string; agentName?: string; runId?: string; embedded?: boolean; onSettled?: (status: RunStatus, completedAt: string) => void } = $props();
  let projectId = $derived(providedProjectId || store.activeProjectId);
  let runId = $derived(providedRunId || store.runtimeView.runId);
  let agentName = $derived(providedAgentName || store.runtimeView.agentName);
  let projectName = $derived(store.projects.find(p => p.summary.projectId === projectId)?.summary.name ?? projectId);
  let runDetail: RunDetail | null = $state(null);
  let eventId = $state('');
  let stopping = $state(false);
  let localRefresh = $state(0);

  function refresh() { localRefresh += 1; }
  function openSandboxDetail(sandboxId: string) { store.navigateTo('sandbox-detail', { sandboxId }); }
  function canStopRun(status: RunStatus) { return status === RunStatus.PENDING || status === RunStatus.RUNNING; }
  function isTerminalStatus(status: RunStatus) { return status === RunStatus.SUCCEEDED || status === RunStatus.FAILED || status === RunStatus.CANCELED; }
  function statusLabel(status: RunStatus) {
    if (status === RunStatus.PENDING) return '等待执行'; if (status === RunStatus.RUNNING) return '运行中';
    if (status === RunStatus.SUCCEEDED) return '成功'; if (status === RunStatus.FAILED) return '失败';
    if (status === RunStatus.CANCELED) return '已取消'; return '未知';
  }
  function statusClass(status: RunStatus) {
    if (status === RunStatus.SUCCEEDED) return 'success'; if (status === RunStatus.RUNNING) return 'running';
    if (status === RunStatus.PENDING) return 'pending'; if (status === RunStatus.FAILED) return 'failed';
    if (status === RunStatus.CANCELED) return 'canceled'; return 'unknown';
  }
  function runTitle(status: RunStatus) { return status === RunStatus.PENDING ? '等待执行' : status === RunStatus.RUNNING ? '运行中' : isTerminalStatus(status) ? '运行完成' : '运行状态未知'; }
  function sourceLabel(source: RunSource) { return source === RunSource.MANUAL ? '手动' : source === RunSource.SCHEDULER ? '调度器' : source === RunSource.API ? 'API' : '-'; }
  function formatDuration(ms: bigint) { const value = Number(ms); return value < 1000 ? `${value}ms` : value < 60000 ? `${(value / 1000).toFixed(1)}s` : `${(value / 60000).toFixed(1)}m`; }
  function shortId(value: string) { const id = value.startsWith('sha256:') ? value.slice(7) : value; return id.length > 10 ? `${id.slice(0, 10)}...` : id; }
  async function stopRun() {
    if (!runId || stopping) return;
    stopping = true;
    try { await runService.stopRun(buildStopRunRequest(runId)); store.addToast('已请求停止运行', 'success'); store.triggerRuntimeRefresh(); localRefresh += 1; }
    catch (error: any) { store.addToast(error?.message || '停止运行失败', 'error'); }
    finally { stopping = false; }
  }
</script>

<div class="root" class:embedded>
  {#if !embedded}<RuntimeBreadcrumb eyebrow={`${projectName} / ${agentName} / Agent 执行详情 · ${shortId(runId)}`} title={agentName} onBack={() => store.navigateBack()} actions={[{ label: '↻', ariaLabel: '刷新', title: '刷新', onclick: refresh }]} />{/if}
  <div class="detail-scroll" class:embedded-scroll={embedded}>
    {#if runDetail}
      <section class="flow-summary">
        <div class="summary-copy">
          <div class="summary-title-row">
            <span class="status-pill {statusClass(runDetail.summary?.status ?? RunStatus.UNSPECIFIED)}"><i aria-hidden="true"></i>{statusLabel(runDetail.summary?.status ?? RunStatus.UNSPECIFIED)}</span>
            <h1>{runDetail.summary?.agentName || agentName} {runTitle(runDetail.summary?.status ?? RunStatus.UNSPECIFIED)}</h1>
            <div class="summary-meta"><span>{sourceLabel(runDetail.summary?.source ?? RunSource.UNSPECIFIED)}运行</span></div>
          </div>
          <dl class="identifier-list">
            {#if runDetail.summary?.runId}<div><dt>Run ID</dt><dd>{runDetail.summary.runId}</dd></div>{/if}
            {#if runDetail.summary?.schedulerId}<div><dt>Scheduler ID</dt><dd>{runDetail.summary.schedulerId}</dd></div>{/if}
            {#if runDetail.summary?.triggerId}<div><dt>Trigger ID</dt><dd>{runDetail.summary.triggerId}</dd></div>{/if}
            {#if eventId}<div><dt>Event ID</dt><dd><a class="event-link" href={`/agent-compose/events/${encodeURIComponent(eventId)}`}>{eventId}</a></dd></div>{/if}
            {#if runDetail.summary?.sandboxId}<div><dt>Sandbox ID</dt><dd><button class="sandbox-link" aria-label={runDetail.summary.sandboxId} onclick={() => openSandboxDetail(runDetail?.summary?.sandboxId || '')}>{runDetail.summary.sandboxId}</button></dd></div>{/if}
          </dl>
        </div>
        <div class="summary-actions">
          {#if canStopRun(runDetail.summary?.status ?? RunStatus.UNSPECIFIED)}<button class="stop-run" disabled={stopping} onclick={stopRun}>{stopping ? '停止中…' : '停止运行'}</button>{/if}
          <div class="summary-metrics">
            <div class="metric"><span>耗时</span><strong>{runDetail.summary?.durationMs != null ? formatDuration(runDetail.summary.durationMs) : '-'}</strong></div>
            <div class="metric"><span>退出码</span><strong class:good={isTerminalStatus(runDetail.summary?.status ?? RunStatus.UNSPECIFIED) && runDetail.summary?.exitCode === 0} class:bad={isTerminalStatus(runDetail.summary?.status ?? RunStatus.UNSPECIFIED) && runDetail.summary?.exitCode !== undefined && runDetail.summary.exitCode !== 0}>{isTerminalStatus(runDetail.summary?.status ?? RunStatus.UNSPECIFIED) ? (runDetail.summary?.exitCode ?? '-') : '-'}</strong></div>
          </div>
        </div>
      </section>
    {/if}
    <RunExecutionProcess {projectId} {agentName} {runId} {embedded} refreshVersion={localRefresh + (embedded ? 0 : store.runtimeRefreshVersion)} onDetail={(detail) => runDetail = detail} onEventId={(value) => eventId = value} {onSettled} />
  </div>
</div>

<style>
  .root { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; background:var(--bg-primary); } button { cursor:pointer; }
  .detail-scroll { flex:1; min-height:0; padding:12px; overflow-y:auto; }.root.embedded { height:auto; overflow:visible; background:transparent; }.detail-scroll.embedded-scroll { flex:none; padding:0; overflow:visible; }
  .root.embedded .flow-summary { border:0; border-bottom:1px solid var(--border-color); border-radius:0; background:transparent; }
  .flow-summary { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; padding:13px 14px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-secondary); }
  .summary-title-row,.summary-actions { display:flex; align-items:center; gap:8px; }.summary-title-row h1 { margin:0; color:var(--text-primary); font-size:var(--font-size-lg); }
  .status-pill { display:inline-flex; align-items:center; gap:5px; padding:2px 6px; border:1px solid var(--border-color); border-radius:9px; color:var(--text-muted); font-size:var(--font-size-xs); font-weight:700; }.status-pill i { width:5px; height:5px; border-radius:50%; background:currentColor; }.status-pill.success { color:var(--accent-green); }.status-pill.running { color:var(--accent-blue); }.status-pill.failed { color:var(--accent-red); }.status-pill.pending { color:var(--accent-yellow); }
  .summary-meta { color:var(--text-muted); font-family:var(--font-mono); font-size:var(--font-size-xs); white-space:nowrap; }.identifier-list { display:grid; gap:3px; margin:9px 0 0; font-family:var(--font-mono); font-size:var(--font-size-xs); }.identifier-list div { display:grid; grid-template-columns:86px minmax(0,1fr); }.identifier-list dt { color:var(--text-muted); }.identifier-list dd { margin:0; overflow-wrap:anywhere; color:var(--text-secondary); }
  .summary-metrics { display:flex; border:1px solid var(--border-color); border-radius:5px; overflow:hidden; }.metric { min-width:68px; padding:7px 10px; border-right:1px solid var(--border-color); background:var(--bg-primary); }.metric:last-child { border-right:0; }.metric span { display:block; color:var(--text-muted); font-size:var(--font-size-xs); }.metric strong { color:var(--text-primary); font-family:var(--font-mono); font-size:var(--font-size-xs); }.metric strong.good { color:var(--accent-green); }.metric strong.bad { color:var(--accent-red); }
  .stop-run { padding:5px 9px; border:1px solid var(--accent-red); border-radius:4px; background:transparent; color:var(--accent-red); font-size:var(--font-size-xs); }.sandbox-link,.event-link { padding:0; border:0; background:none; color:var(--accent-blue); font:var(--font-size-xs) var(--font-mono); text-decoration:underline; text-underline-offset:2px; }.sandbox-link:hover,.event-link:hover { color:var(--text-primary); }.sandbox-link:focus-visible,.event-link:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
  @media (max-width:760px) { .flow-summary { grid-template-columns:1fr; } }
</style>
