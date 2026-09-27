<script lang="ts">
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { t } from '$lib/i18n.svelte';
  import { dispatchStatus } from '../../../model/event-status';
  import {
    barPosition,
    offsetLabel,
    spanLabel,
    type TraceBranch,
    type TraceNode,
    type TraceTimeline,
  } from '../../../model/event-trace';
  import { formatBeijingTime } from '../../../time';

  // 三层：事件 → 它扇出的自动化执行 → 执行开的 sandbox。
  // 同一个任务的多次事件（重试）各占一组，没有触发执行的事件（无订阅方）也列出来。
  let {
    branches,
    startAt,
    timeline,
    selectedId,
    folded,
    onSelect,
    onToggleFold,
  }: {
    branches: TraceBranch[];
    startAt: string;
    timeline: TraceTimeline;
    selectedId: string;
    folded: boolean;
    onSelect: (node: TraceNode) => void;
    onToggleFold: (folded: boolean) => void;
  } = $props();

  const executions = $derived(branches.flatMap((branch) => branch.executions));
  const failedCount = $derived(executions.filter((node) => node.status === 'failed').length);
  const succeededCount = $derived(executions.filter((node) => node.status === 'success').length);
  const tone: Record<string, string> = { failed: 'bg-destructive/80', running: 'bg-info/60', success: 'bg-success/50' };
  const grid = 'grid-cols-[minmax(0,1fr)_3.25rem_7rem_3.75rem]';
  const row = `grid h-8 w-full ${grid} items-center gap-2 border-b border-border px-4 text-left text-[13px] transition-colors sm:px-5`;

  function shown(branch: TraceBranch): TraceNode[] {
    return folded ? branch.executions.filter((node) => node.status !== 'success') : branch.executions;
  }

  function eventMarker(at: string): number | null {
    const value = Date.parse(at);
    if (!Number.isFinite(value) || !Number.isFinite(timeline.from)) return null;
    return Math.max(0, Math.min(100, ((value - timeline.from) / (timeline.to - timeline.from)) * 100));
  }
</script>

{#snippet bar(node: TraceNode, dim = false)}
  {@const position = barPosition(node, timeline)}
  <span class="relative h-2 rounded-sm bg-muted"
    >{#if position}<i
        class="absolute inset-y-0 rounded-sm {dim ? 'opacity-70' : ''} {tone[node.status] ?? 'bg-faint/50'}"
        style="left:{position.left}%;width:{position.width}%"
      ></i>{/if}</span
  >
{/snippet}

<div class="flex min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-3 px-4 py-2.5 text-xs sm:px-5">
    <span class={failedCount ? 'text-destructive' : 'text-muted-foreground'}>{failedCount} {t('失败')}</span>
    <span class="text-faint">·</span>
    <span class="text-muted-foreground">{succeededCount} {t('成功')}</span>
    <label class="ml-auto flex cursor-pointer items-center gap-1.5 text-muted-foreground">
      <input
        type="checkbox"
        checked={folded}
        onchange={(event) => onToggleFold(event.currentTarget.checked)}
        class="accent-foreground"
      />
      {t('折叠成功的执行')}
    </label>
  </div>
  <div class="grid h-7 shrink-0 {grid} items-center gap-2 border-y border-border px-4 text-[11px] text-faint sm:px-5">
    <span>{t('事件 → 扇出的自动化执行 → Sandbox')}</span><span class="text-right">{t('开始')}</span><span
      class="flex justify-between"
      ><span>0</span><span>{spanLabel(startAt, new Date(timeline.to).toISOString())}</span></span
    ><span class="text-right">{t('耗时')}</span>
  </div>
  <div data-scroll-surface class="min-h-0 flex-1 overflow-y-auto">
    {#each branches as branch (branch.eventId)}
      {@const visible = shown(branch)}
      {@const hidden = branch.executions.length - visible.length}
      {@const marker = eventMarker(branch.receivedAt)}
      {@const delivery = branch.dispatchStatus ? dispatchStatus(branch.dispatchStatus) : null}
      <div data-trace-event class="{row} cursor-default bg-background">
        <span class="flex min-w-0 items-center gap-2">
          {#if branch.status}<StatusBadge status={branch.status} dotOnly />{:else}<span
              class="size-1.5 shrink-0 rounded-full border border-faint"
            ></span>{/if}
          <span class="truncate" title={branch.eventId}>
            {#if branches.length > 1}<span class="text-muted-foreground"
                >{t('第 {order} 个事件', { order: branch.order })}</span
              ><span class="px-1 text-faint">·</span>{/if}<span class="font-mono text-[12px]"
              >{branch.topic || t('事件')}</span
            >
            <span class="ml-1.5 text-[11px] text-faint" title={formatBeijingTime(branch.receivedAt)}
              >{#if branch.executions.length}→ {t('扇出 {count} 个执行', {
                  count: branch.executions.length,
                })}{:else}{t(delivery?.label ?? '没有触发执行')}{/if}</span
            >
          </span>
        </span>
        <span class="text-right font-mono text-[11px] text-faint">{offsetLabel(branch.receivedAt, startAt)}</span>
        <span class="relative h-2"
          >{#if marker !== null}<i
              class="absolute top-0 bottom-0 w-px bg-foreground/50"
              style="left:{marker}%"
              title={t('收到事件')}
            ></i>{/if}</span
        >
        <span></span>
      </div>
      {#each visible as node (node.id)}
        <button
          type="button"
          onclick={() => onSelect(node)}
          aria-current={selectedId === node.id}
          class="{row} {selectedId === node.id ? 'bg-selected' : 'hover:bg-accent/60'}"
        >
          <span class="flex min-w-0 items-center gap-2 pl-4">
            <StatusBadge status={node.status} label={node.statusLabel} dotOnly />
            <span class="truncate font-medium">{node.name}</span>
          </span>
          <span class="text-right font-mono text-[11px] text-faint">{offsetLabel(node.startedAt, startAt)}</span>
          {@render bar(node)}
          <span class="text-right text-xs tabular-nums text-muted-foreground"
            >{spanLabel(node.startedAt, node.endedAt)}</span
          >
        </button>
        {#each node.children as child (child.id)}
          <button
            type="button"
            onclick={() => onSelect(child)}
            aria-current={selectedId === child.id}
            class="{row} {selectedId === child.id ? 'bg-selected' : 'hover:bg-accent/60'}"
          >
            <span class="truncate pl-10 text-muted-foreground">
              <span class="mr-1 text-faint">└</span>{child.name || t('Sandbox')}
              {#if child.detail && child.detail !== child.name}<span class="text-faint"> · {child.detail}</span>{/if}
            </span>
            <span class="text-right font-mono text-[11px] text-faint">{offsetLabel(child.startedAt, startAt)}</span>
            {@render bar(child, true)}
            <span></span>
          </button>
        {/each}
      {/each}
      {#if hidden}
        <button
          type="button"
          onclick={() => onToggleFold(false)}
          class="{row} text-muted-foreground hover:bg-accent/60"
        >
          <span class="flex min-w-0 items-center gap-2 pl-4">
            <StatusBadge status="success" dotOnly />
            <span class="truncate text-xs">{t('{count} 个成功的执行', { count: hidden })}</span>
          </span>
          <span></span><span></span><span></span>
        </button>
      {/if}
    {/each}
    {#if !branches.length}
      <p class="px-5 py-10 text-center text-sm text-muted-foreground">{t('暂无自动化执行')}</p>
    {/if}
  </div>
</div>
