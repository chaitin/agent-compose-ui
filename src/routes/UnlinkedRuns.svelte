<script lang="ts">
  import { onMount } from 'svelte';
  import CollectionPage from '$lib/components/collection-page.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { durationName, listUnlinkedRuns, runStatusName, sourceName } from '../api/runs';
  import type { RunSummary } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { compactIdentifier } from '../model/identifiers';
  import { timestampToISOString } from '../model/timestamps';

  let runs = $state<RunSummary[]>([]);
  let cursor = $state(0);
  let hasMore = $state(false);
  let loading = $state(true);
  let error = $state('');

  onMount(() => void load());

  async function load(append = false): Promise<void> {
    loading = true;
    error = '';
    try {
      const page = await listUnlinkedRuns(append ? cursor : 0);
      runs = append ? [...runs, ...page.runs] : page.runs;
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
    }
  }
</script>

<CollectionPage title="运行异常" description="未能创建执行环境的运行">
  {#snippet actions()}<Button variant="outline" size="sm" onclick={() => navigate('/sandboxes')}
      >{t('返回运行记录')}</Button
    >{/snippet}
  {#snippet toolbar()}{#if error}<div data-page-error class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>{/if}{/snippet}
  <div data-scroll-pane class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 md:hidden">
    {#each runs as run (run.runId)}
      <button
        class="w-full rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/40"
        onclick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-medium">{run.agentName || t('未命名智能体')}</div>
            <div class="mt-0.5 truncate text-xs text-muted-foreground">{run.projectName || t('未关联项目')}</div>
          </div>
          <StatusBadge status={runStatusName(run.status)} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{sourceName(run.source)} · {durationName(run.durationMs)}</span>
          <Timestamp value={timestampToISOString(run.startedAt || run.createdAt)} />
        </div>
        <div class="mt-2">
          <CopyableText
            value={run.runId}
            display={run.runShortId || compactIdentifier(run.runId)}
            label="运行 ID"
            class="font-mono text-xs"
          />
        </div>
      </button>
    {:else}<p class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {t(loading ? '正在加载运行…' : '没有运行异常')}
      </p>{/each}
  </div>
  <div data-scroll-pane class="hidden min-h-0 flex-1 overflow-auto rounded-lg border border-border md:block">
    <table class="w-full min-w-[52rem] text-sm">
      <thead class="sticky top-0 z-10 bg-muted/95 text-xs"
        ><tr
          ><th class="p-3 text-left font-medium">{t('智能体 / 项目')}</th><th class="p-3 text-left font-medium"
            >{t('状态')}</th
          ><th class="p-3 text-left font-medium">{t('来源')}</th><th class="p-3 text-left font-medium"
            >{t('开始时间')}</th
          ><th class="p-3 text-left font-medium">{t('耗时')}</th><th class="p-3 text-left font-medium"
            >{t('运行 ID')}</th
          ></tr
        ></thead
      >
      <tbody class="divide-y divide-border">
        {#each runs as run (run.runId)}<tr
            class="cursor-pointer hover:bg-accent/50"
            onclick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
            ><td class="p-3"
              ><div class="font-medium">{run.agentName || t('未命名智能体')}</div>
              <div class="text-xs text-muted-foreground">{run.projectName || t('未关联项目')}</div></td
            ><td class="p-3"><StatusBadge status={runStatusName(run.status)} /></td><td class="p-3"
              >{sourceName(run.source)}</td
            ><td class="p-3"><Timestamp value={timestampToISOString(run.startedAt || run.createdAt)} /></td><td
              class="p-3">{durationName(run.durationMs)}</td
            ><td class="p-3"
              ><CopyableText
                value={run.runId}
                display={run.runShortId || compactIdentifier(run.runId)}
                label="运行 ID"
                class="font-mono text-xs"
              /></td
            ></tr
          >{:else}<tr
            ><td colspan="6" class="p-10 text-center text-muted-foreground"
              >{t(loading ? '正在加载运行…' : '没有运行异常')}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>
  {#snippet footer()}{#if hasMore}<div class="flex justify-center border-t border-border pt-3">
        <Button variant="outline" disabled={loading} onclick={() => void load(true)}
          >{t(loading ? '加载中…' : '加载更多')}</Button
        >
      </div>{/if}{/snippet}
</CollectionPage>
