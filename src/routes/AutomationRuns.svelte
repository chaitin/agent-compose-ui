<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import CollectionPage from '$lib/components/collection-page.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { getAutomationTask, listAutomationRuns, type AutomationRun, type AutomationTaskDetail } from '../api/loaders';
  import { compactIdentifier } from '../model/identifiers';
  import { triggerKindLabel } from '../model/presentation';

  const PAGE_SIZE = 50;
  const statuses = ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'SKIPPED'] as const;
  const loaderId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  const initial = new URLSearchParams(location.search);

  let task = $state<AutomationTaskDetail | null>(null);
  let runs = $state<AutomationRun[]>([]);
  let status = $state(initial.get('status') ?? '');
  let triggerId = $state(initial.get('triggerId') ?? '');
  let offset = $state(Number(initial.get('offset') ?? 0) || 0);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let loadVersion = 0;

  onMount(() => {
    const onPop = () => syncFromLocation();
    window.addEventListener('popstate', onPop);
    void load();
    return () => window.removeEventListener('popstate', onPop);
  });

  async function load(background = false): Promise<void> {
    const version = ++loadVersion;
    if (background) refreshing = true;
    else loading = true;
    error = '';
    try {
      const [nextTask, page] = await Promise.all([
        task ? Promise.resolve(task) : getAutomationTask(loaderId),
        listAutomationRuns(loaderId, { offset, limit: PAGE_SIZE, status, triggerId }),
      ]);
      if (version !== loadVersion) return;
      task = nextTask;
      runs = page.runs;
      total = page.total;
      syncURL();
    } catch (cause) {
      if (version === loadVersion) error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      if (version === loadVersion) {
        loading = false;
        refreshing = false;
      }
    }
  }

  function syncFromLocation(): void {
    const query = new URLSearchParams(location.search);
    status = query.get('status') ?? '';
    triggerId = query.get('triggerId') ?? '';
    offset = Number(query.get('offset') ?? 0) || 0;
    void load();
  }

  function applyFilters(): void {
    offset = 0;
    void load();
  }

  function syncURL(): void {
    const query = new SvelteURLSearchParams();
    if (status) query.set('status', status);
    if (triggerId) query.set('triggerId', triggerId);
    if (offset) query.set('offset', String(offset));
    const value = query.toString();
    router.replace(`/automations/${encodeURIComponent(loaderId)}/runs${value ? `?${value}` : ''}`);
  }

  function previous(): void {
    if (!offset) return;
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  }

  function next(): void {
    if (offset + runs.length >= total) return;
    offset += PAGE_SIZE;
    void load();
  }

  function statusLabel(value: string): string {
    return t(
      value === 'RUNNING'
        ? '运行中'
        : value === 'SUCCEEDED'
          ? '成功'
          : value === 'FAILED'
            ? '失败'
            : value === 'CANCELED'
              ? '已取消'
              : value === 'SKIPPED'
                ? '跳过'
                : value,
    );
  }

  function duration(value: number): string {
    if (value <= 0) return '—';
    const seconds = Math.round(value / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  }

  function triggerName(run: AutomationRun): string {
    const trigger = task?.triggers.find((item) => item.triggerId === run.triggerId);
    return trigger?.name || triggerKindLabel(run.triggerKind) || compactIdentifier(run.triggerId);
  }
</script>

<CollectionPage
  title={task?.name || t('自动化执行')}
  description={t('查看自动化触发、结果与关联执行环境')}
  compactHeader
>
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => navigate('/automations')}>{t('返回自动化')}</Button>
    <select
      bind:value={status}
      aria-label={t('按状态筛选')}
      class="h-8 min-w-28 rounded-md border border-input bg-background px-2 text-sm"
      onchange={applyFilters}
    >
      <option value="">{t('全部状态')}</option>
      {#each statuses as value (value)}<option {value}>{statusLabel(value)}</option>{/each}
    </select>
    <select
      bind:value={triggerId}
      aria-label={t('按触发方式筛选')}
      class="h-8 min-w-36 rounded-md border border-input bg-background px-2 text-sm"
      onchange={applyFilters}
    >
      <option value="">{t('全部触发条件')}</option>
      {#each task?.triggers ?? [] as trigger (trigger.triggerId)}
        <option value={trigger.triggerId}>{trigger.name || triggerKindLabel(trigger.kind)}</option>
      {/each}
    </select>
    <Button variant="outline" size="sm" disabled={refreshing} onclick={() => void load(true)}
      >{t(refreshing ? '刷新中…' : '刷新')}</Button
    >
  {/snippet}

  {#if error}<div data-page-error class="mb-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>{/if}

  <div data-scroll-pane class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 md:hidden">
    {#each runs as run (run.id)}
      <button
        type="button"
        class="w-full rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/40"
        onclick={() =>
          navigate(`/automation-runs/${encodeURIComponent(run.id)}?loaderId=${encodeURIComponent(loaderId)}`)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{triggerName(run)}</div>
            <div class="mt-1 text-xs text-muted-foreground">
              {run.triggerSource || triggerKindLabel(run.triggerKind)}
            </div>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <Timestamp value={run.startedAt} />
          <span>{duration(run.durationMs)} · {run.sandboxIds.length} {t('个执行环境')}</span>
        </div>
        <div class="mt-2">
          <CopyableText
            value={run.id}
            display={compactIdentifier(run.id)}
            label={t('自动化运行 ID')}
            class="font-mono text-xs"
          />
        </div>
      </button>
    {:else}<p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载运行…' : '暂无自动化执行')}
      </p>{/each}
  </div>

  <div data-scroll-pane class="hidden min-h-0 flex-1 overflow-auto rounded-lg border border-border md:block">
    <table class="w-full min-w-[58rem] text-sm">
      <thead class="sticky top-0 z-10 bg-muted/95 text-xs backdrop-blur">
        <tr>
          <th class="p-3 text-left font-medium">{t('状态')}</th>
          <th class="p-3 text-left font-medium">{t('触发条件')}</th>
          <th class="p-3 text-left font-medium">{t('触发来源')}</th>
          <th class="p-3 text-left font-medium">{t('开始时间')}</th>
          <th class="p-3 text-left font-medium">{t('耗时')}</th>
          <th class="p-3 text-left font-medium">{t('执行环境')}</th>
          <th class="p-3 text-left font-medium">{t('执行 ID')}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each runs as run (run.id)}
          <tr
            class="cursor-pointer hover:bg-accent/50"
            onclick={() =>
              navigate(`/automation-runs/${encodeURIComponent(run.id)}?loaderId=${encodeURIComponent(loaderId)}`)}
          >
            <td class="p-3"><StatusBadge status={run.status} /></td>
            <td class="p-3">
              <div class="font-medium">{triggerName(run)}</div>
              <div class="mt-0.5 font-mono text-[11px] text-muted-foreground">{compactIdentifier(run.triggerId)}</div>
            </td>
            <td class="p-3 text-muted-foreground">{run.triggerSource || triggerKindLabel(run.triggerKind)}</td>
            <td class="p-3"><Timestamp value={run.startedAt} /></td>
            <td class="p-3">{duration(run.durationMs)}</td>
            <td class="p-3">{run.sandboxIds.length || '—'}</td>
            <td class="p-3">
              <CopyableText
                value={run.id}
                display={compactIdentifier(run.id)}
                label={t('自动化运行 ID')}
                class="font-mono text-xs"
              />
            </td>
          </tr>
        {:else}<tr
            ><td colspan="7" class="p-10 text-center text-muted-foreground"
              >{t(loading ? '正在加载运行…' : '暂无自动化执行')}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-between border-t border-border pt-3">
      <span class="text-xs text-muted-foreground"
        >{total ? `${offset + 1}–${offset + runs.length} / ${total}` : '0'}</span
      >
      <div class="flex gap-2">
        <Button variant="outline" size="sm" disabled={!offset || loading} onclick={previous}>{t('上一页')}</Button>
        <Button variant="outline" size="sm" disabled={offset + runs.length >= total || loading} onclick={next}
          >{t('下一页')}</Button
        >
      </div>
    </div>
  {/snippet}
</CollectionPage>
