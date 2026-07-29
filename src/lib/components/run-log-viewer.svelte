<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  let {
    query,
    content,
    lineCount,
    following,
    wrap,
    onQuery,
    onToggleFollow,
    onFollowingChange,
    onToggleWrap,
    onDownload,
  }: {
    query: string;
    content: string;
    lineCount: number;
    following: boolean;
    wrap: boolean;
    onQuery: (value: string) => void;
    onToggleFollow: () => void;
    onFollowingChange: (value: boolean) => void;
    onToggleWrap: () => void;
    onDownload: () => void;
  } = $props();

  let logNode = $state<HTMLElement | null>(null);

  $effect(() => {
    const updateKey = `${following}:${content.length}`;
    if (updateKey && following) void scrollToLatest();
  });

  function trackScroll(): void {
    if (!logNode || !following) return;
    if (logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight >= 72) onFollowingChange(false);
  }

  async function scrollToLatest(): Promise<void> {
    await tick();
    logNode?.scrollTo({ top: logNode.scrollHeight });
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <div class="mb-2 flex shrink-0 flex-wrap items-center gap-2">
    <Input
      value={query}
      oninput={(event) => onQuery(event.currentTarget.value)}
      class="min-w-[14rem] flex-1 sm:max-w-sm"
      placeholder="搜索原始日志"
    />
    <span class="text-xs text-muted-foreground">{lineCount} 行</span>
    <Button variant="outline" onclick={onToggleFollow}>{following ? '暂停跟随' : '恢复跟随'}</Button>
    <Button variant="outline" onclick={onToggleWrap}>{wrap ? '关闭换行' : '自动换行'}</Button>
    <Button variant="outline" onclick={onDownload}>下载原始日志</Button>
  </div>
  <pre
    bind:this={logNode}
    data-scroll-surface
    onscroll={trackScroll}
    class="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-700 bg-[#0b1018] p-4 font-mono text-xs leading-5 text-[#cdd6e3]"
    class:whitespace-pre-wrap={wrap}
    class:whitespace-pre={!wrap}>{content || '暂无日志'}</pre>
</div>
