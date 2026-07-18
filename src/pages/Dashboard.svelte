<script lang="ts">
  import { onMount } from 'svelte';
  import { GetDashboardOverviewRequest, WatchDashboardOverviewRequest, type DashboardOverview } from '../gen/agentcompose/v2/agentcompose_pb';
  import { dashboardService } from '../lib/rpc';

  let overview = $state<DashboardOverview>();
  let loading = $state(true);
  let error = $state('');
  let controller: AbortController | undefined;

  function errorMessage(value: unknown) {
    return value instanceof Error ? value.message : String(value || '总览加载失败');
  }

  function updatedAt() {
    if (!overview?.updatedAt) return '未提供';
    return overview.updatedAt.toDate().toLocaleString('zh-CN');
  }

  function load() {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    error = '';
    loading = !overview;
    void (async () => {
      try {
        const response = await dashboardService.getDashboardOverview(new GetDashboardOverviewRequest(), { signal: current.signal });
        if (current.signal.aborted) return;
        if (!response.overview) throw new Error('总览响应为空');
        overview = response.overview;
        loading = false;

        for await (const event of dashboardService.watchDashboardOverview(new WatchDashboardOverviewRequest(), { signal: current.signal })) {
          if (current.signal.aborted) return;
          if (event.overview) overview = event.overview;
        }
      } catch (value) {
        if (!current.signal.aborted) error = errorMessage(value);
      } finally {
        if (!current.signal.aborted) loading = false;
      }
    })();
  }

  onMount(() => {
    load();
    return () => controller?.abort();
  });
</script>

<main class="dashboard">
  <header>
    <div>
      <p class="eyebrow">V2 runtime</p>
      <h2>总览</h2>
    </div>
    {#if overview}<time>更新于 {updatedAt()}</time>{/if}
  </header>

  {#if loading}
    <section class="state">正在加载总览…</section>
  {/if}

  {#if overview}
    <section class="cards" aria-label="运行概览">
      <article><span>当前运行</span><strong>{overview.runs?.runningCount ?? 0}</strong></article>
      <article><span>最近运行</span><strong>{overview.runs?.recentCount ?? 0}</strong></article>
      <article><span>需要关注</span><strong>{overview.runs?.attentionCount ?? 0}</strong></article>
    </section>
  {/if}

  {#if error}
    <section class="state error" role="alert">
      <span>总览连接失败：{error}</span>
      <button onclick={load}>重试</button>
    </section>
  {/if}
</main>

<style>
  .dashboard { display: grid; gap: 1.2rem; padding: 1.5rem; color: var(--text, #e8edf5); }
  header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; }
  h2, p { margin: 0; }
  h2 { font-size: 1.55rem; }
  .eyebrow { margin-bottom: .35rem; color: var(--accent, #7dd3fc); font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  time { color: var(--muted, #94a3b8); font-size: .82rem; }
  .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .9rem; }
  article { display: grid; gap: .65rem; min-height: 7rem; padding: 1rem; border: 1px solid var(--border, #293548); border-radius: .75rem; background: var(--panel, #111827); }
  article span { color: var(--muted, #94a3b8); font-size: .85rem; }
  article strong { align-self: end; font-size: 2rem; line-height: 1; }
  .state { padding: 1rem; border: 1px solid var(--border, #293548); border-radius: .65rem; color: var(--muted, #94a3b8); }
  .error { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-color: #7f1d1d; color: #fecaca; }
  button { padding: .45rem .8rem; border: 1px solid currentColor; border-radius: .45rem; background: transparent; color: inherit; cursor: pointer; }
  @media (max-width: 640px) { header { align-items: start; flex-direction: column; } .cards { grid-template-columns: 1fr; } }
</style>
