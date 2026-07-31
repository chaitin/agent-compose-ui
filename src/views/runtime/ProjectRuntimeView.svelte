<script lang="ts">
  import { ListRunsRequest, RunSource, RunStatus, type RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb';
  import { runService } from '../../lib/rpc';
  import { store } from '../../lib/stores.svelte';
  import RuntimeBreadcrumb from './RuntimeBreadcrumb.svelte';
  import { buildRunDateRange, consumeRunWindow } from '../../lib/run-history';

  let runs: RunSummary[] = $state([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let hasMore = $state(false);
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

  $effect(() => {
    void store.runtimeRefreshVersion;
    void queryVersion;
    const projectId = store.activeProjectId;
    const filters = applied;
    const generation = ++requestGeneration;
    if (!projectId) { runs = []; loading = false; hasMore = false; return; }
    loading = true;
    loadingMore = false;
    runs = [];
    serverOffset = 0;
    (async () => {
      try {
        const response = await runService.listRuns(buildRequest(projectId, filters, 0, PAGE_SIZE + 1));
        if (generation === requestGeneration) {
          const window = consumeRunWindow(response.runs, PAGE_SIZE);
          runs = window.runs; serverOffset = window.serverOffset; hasMore = window.hasMore;
        }
      } catch (error: any) {
        if (generation === requestGeneration) store.addToast(error?.message || '加载项目运行记录失败', 'error');
      } finally {
        if (generation === requestGeneration) loading = false;
      }
    })();
  });

  function buildRequest(projectId: string, filters: typeof applied, offset: number, limit: number) {
    const range = buildRunDateRange(filters.startedFrom, filters.startedTo);
    return new ListRunsRequest({ projectId, status: filters.status, source: filters.source,
      ...range, sandboxId: filters.sandboxId.trim(), offset, limit });
  }

  function applyFilters() {
    requestGeneration++;
    applied = { status: Number(status), source: Number(source), startedFrom, startedTo, sandboxId };
    queryVersion++;
  }

  function openDatePicker(event: MouseEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (typeof input.showPicker === 'function') input.showPicker();
  }

  async function loadMore() {
    const projectId = store.activeProjectId;
    if (!projectId || loadingMore || !hasMore) return;
    const generation = requestGeneration;
    const target = serverOffset + PAGE_SIZE;
    loadingMore = true;
    try {
      const response = await runService.listRuns(buildRequest(projectId, applied, 0, target + 1));
      if (generation === requestGeneration) {
        const window = consumeRunWindow(response.runs, target);
        runs = window.runs; serverOffset = window.serverOffset; hasMore = window.hasMore;
      }
    } catch (error: any) {
      if (generation === requestGeneration) store.addToast(error?.message || '加载更多运行记录失败', 'error');
    } finally { if (generation === requestGeneration) loadingMore = false; }
  }

  function statusLabel(status: RunStatus) {
    return ({ [RunStatus.PENDING]: '等待中', [RunStatus.RUNNING]: '运行中', [RunStatus.SUCCEEDED]: '成功', [RunStatus.FAILED]: '失败', [RunStatus.CANCELED]: '已取消' } as Record<number, string>)[status] || '未知';
  }
</script>

<div class="root">
  <div class="breadcrumb-wrap"><RuntimeBreadcrumb eyebrow="项目运行时" title="v2 Run 记录" onBack={() => store.navigateBack()} actions={[{ label: '刷新', onclick: () => store.triggerRuntimeRefresh(), variant: 'primary' }]} /></div>
  <form class="filters" onsubmit={(event) => { event.preventDefault(); applyFilters(); }}>
    <label>状态<select aria-label="状态" value={status} onchange={(event) => status = Number(event.currentTarget.value)}><option value={RunStatus.UNSPECIFIED}>全部</option><option value={RunStatus.PENDING}>等待中</option><option value={RunStatus.RUNNING}>运行中</option><option value={RunStatus.SUCCEEDED}>成功</option><option value={RunStatus.FAILED}>失败</option><option value={RunStatus.CANCELED}>已取消</option></select></label>
    <label>来源<select aria-label="来源" value={source} onchange={(event) => source = Number(event.currentTarget.value)}><option value={RunSource.UNSPECIFIED}>全部</option><option value={RunSource.MANUAL}>手动</option><option value={RunSource.SCHEDULER}>调度器</option><option value={RunSource.API}>API</option></select></label>
    <label>开始日期<input aria-label="开始日期" type="date" bind:value={startedFrom} onclick={openDatePicker} /></label>
    <label>结束日期<input aria-label="结束日期" type="date" bind:value={startedTo} onclick={openDatePicker} /></label>
    <button type="submit">应用筛选</button>
  </form>
  {#if loading}<div class="state">加载中...</div>
  {:else if runs.length === 0}<div class="state">暂无 v2 Run 记录</div>
  {:else}<div class="runs">{#each runs as run (run.runId)}<button class="run" onclick={() => store.navigateTo('run-detail', { agentName: run.agentName, runId: run.runId })}><span>{statusLabel(run.status)}</span><strong>{run.agentName || '-'}</strong><code>{run.runId}</code><time>{run.updatedAt || run.createdAt || '-'}</time><i>→</i></button>{/each}</div>{#if hasMore}<button class="load-more" disabled={loadingMore} onclick={loadMore}>{loadingMore ? '加载中…' : '加载更多'}</button>{/if}{/if}
</div>

<style>.root{height:100%;overflow:auto;padding:0 14px 14px}.breadcrumb-wrap{margin:0 -14px 12px}button,select,input{border:1px solid var(--border-color);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);padding:6px 9px}.filters input[type="date"]{cursor:pointer}.filters{display:flex;flex-wrap:nowrap;align-items:center;gap:12px;margin-bottom:12px;overflow-x:auto;padding-bottom:2px}.filters label{display:flex;flex:0 0 auto;align-items:center;gap:6px;color:var(--text-muted);font-size:var(--font-size-xs);white-space:nowrap}.filters button{flex:0 0 auto}.state{padding:30px;text-align:center;color:var(--text-muted)}.runs{display:grid;gap:6px}.run{display:grid;grid-template-columns:70px 120px minmax(0,1fr) 180px 18px;gap:8px;text-align:left;align-items:center}.run:hover{border-color:var(--accent-blue)}code,time{overflow:hidden;text-overflow:ellipsis;color:var(--text-muted);font-size:var(--font-size-xs)}i{font-style:normal}.load-more{width:100%;margin-top:8px}</style>
