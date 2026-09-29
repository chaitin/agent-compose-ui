<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import RunFilterBar from '$lib/components/runs/run-filter-bar.svelte';
  import RunTable from '$lib/components/runs/run-table.svelte';
  import RunInspector from '$lib/components/runs/run-inspector.svelte';
  import EmptyState from '$lib/components/empty-state.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { getRun, listRunActors, listRunEventsTail, listRunsPage, stopRun, type RunActor } from '../api/runs';
  import { RunStatus, type RunDetail, type RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import {
    groupRunsByDay,
    runActivities,
    runFilterFor,
    runListQueryFromSearch,
    runListQueryToSearch,
    RUN_STATUS_FILTERS,
    type RunActivity,
    type RunListQuery,
    type RunStatusFilter,
  } from '../model/run-list';

  const PAGE_SIZE = 50;
  const REFRESH_MS = 15_000;
  /** 状态计数是 5 次 COUNT，比列表贵得多：只在打开和切换筛选时算，自动刷新时最多每分钟一次。 */
  const COUNTS_REFRESH_MS = 60_000;
  /** J/K 快速翻行时，停下来才加载检查器，翻过去的行不发请求。 */
  const INSPECTOR_DELAY_MS = 250;
  const INSPECTOR_EVENTS = 6;

  let query = $state<RunListQuery>(runListQueryFromSearch(window.location.search));
  let runs = $state<RunSummary[]>([]);
  let total = $state(0);
  let counts = $state<Partial<Record<RunStatusFilter, number>>>({});
  let actors = $state<RunActor[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state('');
  let now = $state(Date.now());

  let selectedId = $state('');
  let detail = $state<RunDetail | null>(null);
  let activities = $state<RunActivity[]>([]);
  let history = $state<RunSummary[]>([]);
  let inspectorLoading = $state(false);
  let wide = $state(true);

  let listVersion = 0;
  let inspectorVersion = 0;
  let countsAt = 0;
  let inspectorTimer = 0;
  /** 已经「加载更多」时不再整页替换列表，只探测是否有更新的运行。 */
  let newerAvailable = $state(false);

  const groups = $derived(groupRunsByDay(runs, now));
  const selected = $derived(
    runs.find((run) => run.runId === selectedId) ?? history.find((run) => run.runId === selectedId),
  );
  // 首页不预先加载项目定义：下拉选项先取自已加载的运行，第一次展开筛选时再补全。
  const optionSource = $derived<Array<Pick<RunActor, 'projectId' | 'projectName' | 'agentName'>>>([...actors, ...runs]);
  const projectOptions = $derived(
    [...new Map(optionSource.map((item) => [item.projectId, item.projectName])).entries()]
      .filter(([value]) => value)
      .map(([value, label]) => ({ value, label })),
  );
  const agentOptions = $derived(
    [
      ...new Set(
        optionSource
          .filter((item) => !query.projectId || item.projectId === query.projectId)
          .map((item) => item.agentName),
      ),
    ]
      .filter(Boolean)
      .map((name) => ({ value: name, label: name })),
  );

  onMount(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const syncWide = () => {
      const wasWide = wide;
      wide = media.matches;
      if (wide && !wasWide) select(runs.find((run) => run.runId === selectedId));
    };
    syncWide();
    media.addEventListener('change', syncWide);
    void load();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(inspectorTimer);
      media.removeEventListener('change', syncWide);
    };
  });

  let actorsRequested = false;
  function loadActors(): void {
    if (actorsRequested) return;
    actorsRequested = true;
    void listRunActors()
      .then((items) => (actors = items))
      .catch(() => (actorsRequested = false));
  }

  async function fetchCounts(target: RunListQuery, at: number): Promise<Partial<Record<RunStatusFilter, number>>> {
    const entries = await Promise.all(
      RUN_STATUS_FILTERS.map(async ({ value }) => {
        const page = await listRunsPage({ ...runFilterFor(target, at, value), limit: 1 });
        return [value, page.total] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async function load(): Promise<void> {
    const version = ++listVersion;
    const target = query;
    const at = Date.now();
    loading = true;
    error = '';
    try {
      const [page, nextCounts] = await Promise.all([
        listRunsPage({ ...runFilterFor(target, at), limit: PAGE_SIZE }),
        fetchCounts(target, at),
      ]);
      if (version !== listVersion) return;
      runs = page.runs;
      total = page.total;
      counts = nextCounts;
      countsAt = at;
      now = at;
      newerAvailable = false;
      if (!runs.some((run) => run.runId === selectedId)) select(runs[0]);
    } catch (cause) {
      if (version === listVersion) error = cause instanceof Error ? cause.message : t('运行列表加载失败');
    } finally {
      if (version === listVersion) loading = false;
    }
  }

  /**
   * 定时刷新：只重取第一页列表（1 个请求）；计数到期才重算。
   * 用户已经加载了更多页时不替换列表，否则会丢掉已加载的内容，只提示有新运行。
   */
  async function refresh(): Promise<void> {
    if (loading || loadingMore || document.hidden) return;
    const version = listVersion;
    const target = query;
    const at = Date.now();
    const paged = runs.length > PAGE_SIZE;
    const countsDue = at - countsAt >= COUNTS_REFRESH_MS;
    try {
      const [page, nextCounts] = await Promise.all([
        listRunsPage({ ...runFilterFor(target, at), limit: paged ? 1 : PAGE_SIZE }),
        countsDue ? fetchCounts(target, at) : Promise.resolve(null),
      ]);
      if (version !== listVersion) return;
      if (nextCounts) {
        counts = nextCounts;
        countsAt = at;
      }
      if (paged) {
        newerAvailable = Boolean(page.runs[0]) && page.runs[0].runId !== runs[0]?.runId;
        return;
      }
      runs = page.runs;
      total = page.total;
      now = at;
      const current = runs.find((run) => run.runId === selectedId);
      if (current?.status === RunStatus.RUNNING || current?.status === RunStatus.PENDING)
        void refreshLiveInspector(current);
    } catch {
      // 刷新失败不打断当前浏览，下次定时刷新再试。
    }
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    try {
      const page = await listRunsPage({ ...runFilterFor(query, now), offset: runs.length, limit: PAGE_SIZE });
      const seen = new Set(runs.map((run) => run.runId));
      runs = [...runs, ...page.runs.filter((run) => !seen.has(run.runId))];
      total = page.total;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('运行列表加载失败');
    } finally {
      loadingMore = false;
    }
  }

  function changeQuery(next: RunListQuery): void {
    query = next;
    router.replace(`/${runListQueryToSearch(next)}`);
    void load();
  }

  function select(run: RunSummary | undefined): void {
    selectedId = run?.runId ?? '';
    window.clearTimeout(inspectorTimer);
    inspectorVersion += 1;
    if (!run || !wide) {
      detail = null;
      activities = [];
      history = [];
      inspectorLoading = false;
      return;
    }
    inspectorLoading = true;
    inspectorTimer = window.setTimeout(() => void loadInspector(run), INSPECTOR_DELAY_MS);
  }

  async function loadInspector(run: RunSummary): Promise<void> {
    const version = ++inspectorVersion;
    inspectorLoading = true;
    if (detail?.summary?.runId !== run.runId) {
      detail = null;
      activities = [];
    }
    const [detailResult, eventsResult, historyResult] = await Promise.allSettled([
      getRun(run.runId),
      listRunEventsTail(run.runId, INSPECTOR_EVENTS),
      listRunsPage({ projectId: run.projectId, agentName: run.agentName, limit: 24 }),
    ]);
    if (version !== inspectorVersion) return;
    detail = detailResult.status === 'fulfilled' ? detailResult.value : null;
    activities = eventsResult.status === 'fulfilled' ? runActivities(eventsResult.value) : [];
    history = historyResult.status === 'fulfilled' ? historyResult.value.runs : [];
    inspectorLoading = false;
  }

  /** 选中的运行还在跑时，随定时刷新更新详情和最后的活动；最近运行点阵不变，不重取。 */
  async function refreshLiveInspector(run: RunSummary): Promise<void> {
    const version = inspectorVersion;
    const [detailResult, eventsResult] = await Promise.allSettled([
      getRun(run.runId),
      listRunEventsTail(run.runId, INSPECTOR_EVENTS),
    ]);
    if (version !== inspectorVersion) return;
    if (detailResult.status === 'fulfilled') detail = detailResult.value;
    if (eventsResult.status === 'fulfilled') activities = runActivities(eventsResult.value);
  }

  function choose(run: RunSummary): void {
    if (wide) select(run);
    else open(run);
  }

  function open(run: RunSummary): void {
    navigate(`/runs/${run.runId}`);
  }

  async function stop(run: RunSummary): Promise<void> {
    try {
      await stopRun(run.runId);
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('停止失败');
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
    const index = runs.findIndex((run) => run.runId === selectedId);
    if (event.key === 'j' || event.key === 'k') {
      const next = runs[Math.min(runs.length - 1, Math.max(0, index + (event.key === 'j' ? 1 : -1)))];
      if (!next) return;
      event.preventDefault();
      select(next);
      document.querySelector(`[data-run-id="${next.runId}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      open(selected);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div data-page-layout="runs" class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5 xl:px-6">
    <h1 class="sr-only">{t('运行')}</h1>
    <RunFilterBar
      {query}
      {counts}
      projects={projectOptions}
      agents={agentOptions}
      onChange={changeQuery}
      onOptionsNeeded={loadActors}
    />
  </div>
  {#if error}<div class="shrink-0 bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">
      {error}
    </div>{/if}
  <div class="flex min-h-0 flex-1">
    <section class="flex min-w-0 flex-1 flex-col">
      {#if newerAvailable}
        <button
          type="button"
          class="shrink-0 border-b border-border bg-selected px-4 py-1.5 text-left text-xs text-foreground hover:underline sm:px-5 xl:px-6"
          onclick={() => void load()}>{t('有新的运行，点击刷新列表')}</button
        >
      {/if}
      <div data-scroll-surface data-route-scroll="runs" class="min-h-0 flex-1 overflow-y-auto">
        {#if loading && !runs.length}
          <p class="px-6 py-10 text-center text-sm text-muted-foreground">{t('加载中…')}</p>
        {:else if !runs.length}
          <EmptyState title={t('没有符合条件的运行')} description={t('调整筛选条件或时间范围再看看')} />
        {:else}
          <RunTable {groups} {selectedId} onSelect={choose} onOpen={open} />
          {#if runs.length < total}
            <div class="flex justify-center py-4">
              <Button variant="ghost" size="sm" disabled={loadingMore} onclick={loadMore}>
                {t(loadingMore ? '加载中…' : '加载更多')}
              </Button>
            </div>
          {/if}
        {/if}
      </div>

      <footer
        class="hidden h-8 shrink-0 items-center gap-4 border-t border-border px-4 text-[11px] text-faint sm:flex sm:px-5 xl:px-6"
      >
        <span class="hidden xl:inline"
          ><kbd class="rounded border border-input px-1 font-mono">J</kbd>
          <kbd class="rounded border border-input px-1 font-mono">K</kbd>
          {t('上下切换')}</span
        >
        <span class="hidden xl:inline"
          ><kbd class="rounded border border-input px-1 font-mono">↵</kbd> {t('打开详情')}</span
        >
        <span class="ml-auto tabular-nums">{t('显示 {shown} / {total}', { shown: runs.length, total })}</span>
      </footer>
    </section>

    {#if wide && selected}
      <aside class="w-[26rem] shrink-0 border-l border-border bg-card">
        <RunInspector
          run={selected}
          {detail}
          {activities}
          {history}
          loading={inspectorLoading}
          onOpen={() => open(selected)}
          onTerminal={() => navigate(`/runs/${selected.runId}/terminal`)}
          onStop={selected.status === RunStatus.RUNNING ? () => stop(selected) : undefined}
          onSelectHistory={(run) => (runs.some((item) => item.runId === run.runId) ? select(run) : open(run))}
        />
      </aside>
    {/if}
  </div>
</div>
