<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { t } from '$lib/i18n.svelte';

  let {
    query,
    content,
    lineCount,
    onQuery,
    onDownload,
  }: {
    query: string;
    content: string;
    lineCount: number;
    onQuery: (value: string) => void;
    onDownload: () => void;
  } = $props();

  let logNode = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);

  const visibleLineCount = $derived(content ? content.split('\n').length : 0);

  $effect(() => {
    const updateKey = content.length;
    if (updateKey && followsLatest) void scrollToLatest();
  });

  function trackScroll(): void {
    if (!logNode) return;
    followsLatest = logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 72;
  }

  async function scrollToLatest(force = false): Promise<void> {
    await tick();
    if (force) followsLatest = true;
    logNode?.scrollTo({ top: logNode.scrollHeight });
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
    <span class="text-xs text-muted-foreground"
      >{query.trim() ? `${visibleLineCount} / ${lineCount}` : lineCount} {t('行')}</span
    >
    <Button variant="outline" onclick={onDownload}>{t('下载原始日志')}</Button>
  </div>
  {#if !followsLatest}<Button
      class="absolute bottom-4 right-4 z-10 shadow"
      size="sm"
      variant="outline"
      onclick={() => void scrollToLatest(true)}>{t('回到最新')}</Button
    >{/if}
  <pre
    bind:this={logNode}
    data-scroll-surface
    onscroll={trackScroll}
    class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-[#0b1018] p-4 font-mono text-xs leading-5 text-[#cdd6e3]">{content ||
      t('暂无日志')}</pre>
</div>
