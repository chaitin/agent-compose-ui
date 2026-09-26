<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';

  const LINE_HEIGHT = 20;
  const OVERSCAN = 12;

  let {
    query,
    lines,
    loadedLineCount,
    hasEarlier = false,
    loadingEarlier = false,
    downloading = false,
    preserveLine = 0,
    onQuery,
    onDownload,
    onLoadEarlier,
  }: {
    query: string;
    lines: string[];
    loadedLineCount: number;
    hasEarlier?: boolean;
    loadingEarlier?: boolean;
    downloading?: boolean;
    /** Keep this rendered line under the viewport when earlier lines are prepended. */
    preserveLine?: number;
    onQuery: (value: string) => void;
    onDownload: () => void;
    onLoadEarlier?: () => void;
  } = $props();

  let viewport = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);
  let scrollTop = $state(0);
  let viewportHeight = $state(480);
  let activeMatch = $state(0);
  let anchoredLine = $state(0);
  let anchoredOffset = $state(0);

  const normalizedQuery = $derived(query.trim().toLowerCase());
  const matchIndexes = $derived(
    normalizedQuery
      ? lines.flatMap((line, index) => (line.toLowerCase().includes(normalizedQuery) ? [index] : []))
      : [],
  );
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN));
  const visibleCount = $derived(Math.ceil(viewportHeight / LINE_HEIGHT) + OVERSCAN * 2);
  const visibleLines = $derived(lines.slice(startIndex, startIndex + visibleCount));
  const totalHeight = $derived(Math.max(lines.length, 1) * LINE_HEIGHT);

  $effect(() => {
    if (lines.length && viewportHeight > 0 && followsLatest && !normalizedQuery) void scrollToLatest();
  });

  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      viewportHeight = viewport?.clientHeight || viewportHeight;
    });
    observer.observe(viewport);
    viewportHeight = viewport.clientHeight;
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!normalizedQuery) {
      activeMatch = 0;
      return;
    }
    activeMatch = 0;
    void revealMatch(0);
  });

  $effect(() => {
    const line = preserveLine;
    const node = viewport;
    if (!node || line <= anchoredLine) {
      anchoredLine = line;
      return;
    }
    const added = line - anchoredLine;
    anchoredLine = line;
    followsLatest = false;
    node.scrollTop = anchoredOffset + added * LINE_HEIGHT;
    scrollTop = node.scrollTop;
  });

  function trackScroll(): void {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    anchoredOffset = viewport.scrollTop;
    followsLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72;
  }

  async function scrollToLatest(force = false): Promise<void> {
    await tick();
    if (force) followsLatest = true;
    viewport?.scrollTo({ top: viewport.scrollHeight });
  }

  async function revealMatch(index: number): Promise<void> {
    const lineIndex = matchIndexes[index];
    if (lineIndex == null || !viewport) return;
    followsLatest = false;
    activeMatch = index;
    viewport.scrollTo({ top: Math.max(0, lineIndex * LINE_HEIGHT - viewport.clientHeight / 3) });
    await tick();
    viewport.querySelector('[data-log-match="active"]')?.scrollIntoView({ block: 'nearest' });
  }

  function stepMatch(delta: number): void {
    if (!matchIndexes.length) return;
    const next = (activeMatch + delta + matchIndexes.length) % matchIndexes.length;
    void revealMatch(next);
  }
</script>

<div class="relative flex h-full min-h-0 flex-col overflow-hidden">
  <div class="mb-2 flex shrink-0 flex-wrap items-center gap-2">
    <Input
      value={query}
      oninput={(event) => onQuery(event.currentTarget.value)}
      class="min-w-[14rem] flex-1 sm:max-w-sm"
      placeholder={t('筛选日志')}
    />
    <span class="text-xs text-muted-foreground">
      {#if normalizedQuery}
        {matchIndexes.length ? activeMatch + 1 : 0} / {matchIndexes.length}
      {:else if hasEarlier}
        {t('{loaded} 行已加载', { loaded: loadedLineCount })}
      {:else}
        {loadedLineCount} {t('行')}
      {/if}
    </span>
    {#if normalizedQuery}
      <Button variant="outline" size="sm" disabled={!matchIndexes.length} onclick={() => stepMatch(-1)}
        >{t('上一处')}</Button
      >
      <Button variant="outline" size="sm" disabled={!matchIndexes.length} onclick={() => stepMatch(1)}
        >{t('下一处')}</Button
      >
    {/if}
    <Button variant="outline" onclick={onDownload} disabled={downloading}
      >{t(downloading ? '正在下载原始日志…' : '下载原始日志')}</Button
    >
  </div>
  {#if hasEarlier}
    <Button
      variant="outline"
      size="sm"
      class="mb-2 shrink-0 self-start"
      disabled={loadingEarlier}
      onclick={onLoadEarlier}>{t(loadingEarlier ? '正在加载更早日志…' : '加载更早日志')}</Button
    >
  {/if}
  {#if !followsLatest && !normalizedQuery}<Button
      class="absolute bottom-4 right-4 z-10 shadow"
      size="sm"
      variant="outline"
      onclick={() => void scrollToLatest(true)}>{t('回到最新')}</Button
    >{/if}
  <!-- Virtual rows: mounting every loaded line reintroduces the large-log jank. -->
  <div
    bind:this={viewport}
    data-scroll-surface
    data-log-viewport
    onscroll={trackScroll}
    class="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-700 bg-[#0b1018] font-mono text-xs leading-5 text-[#cdd6e3]"
  >
    {#if lines.length}
      <div class="w-max min-w-full" style:height="{totalHeight}px">
        <div style:transform="translateY({startIndex * LINE_HEIGHT}px)">
          {#each visibleLines as line, offset (startIndex + offset)}
            {@const index = startIndex + offset}
            <div
              data-log-line
              data-log-match={normalizedQuery && line.toLowerCase().includes(normalizedQuery)
                ? matchIndexes[activeMatch] === index
                  ? 'active'
                  : 'true'
                : undefined}
              class="h-5 w-max min-w-full px-4 whitespace-pre data-[log-match=true]:bg-amber-300/25 data-[log-match=active]:bg-orange-500/40"
              style:height="{LINE_HEIGHT}px"
              style:line-height="{LINE_HEIGHT}px"
            >
              {line || ' '}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <p class="p-4">{t('暂无日志')}</p>
    {/if}
  </div>
</div>
