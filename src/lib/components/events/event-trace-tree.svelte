<script lang="ts">
  import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
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
  import { compactIdentifier } from '../../../model/identifiers';
  import { formatBeijingTime } from '../../../time';

  // 固定两层：事件是分组标题，它触发的自动化执行平铺在下面，执行开的 sandbox 并在执行那一行里。
  // 链式触发（一次执行又发出事件）不往右缩进：新事件是下一个并列分组，用「由 … 发出」标明来历。
  // 没有触发执行的事件（无订阅方）也列出来。
  let {
    branches,
    startAt,
    timeline,
    selectedId,
    folded,
    onSelect,
    onToggleFold,
    onCollapse,
  }: {
    branches: TraceBranch[];
    startAt: string;
    timeline: TraceTimeline;
    selectedId: string;
    folded: boolean;
    onSelect: (node: TraceNode) => void;
    onToggleFold: (folded: boolean) => void;
    /** 把整栏收起，给右侧的日志让出宽度。 */
    onCollapse: () => void;
  } = $props();

  const executions = $derived(branches.flatMap((branch) => branch.executions));
  const failedCount = $derived(executions.filter((node) => node.status === 'failed').length);
  const succeededCount = $derived(executions.filter((node) => node.status === 'success').length);
  const tone: Record<string, string> = { failed: 'bg-destructive/80', running: 'bg-info/60', success: 'bg-success/50' };
  const grid = 'grid-cols-[minmax(0,1fr)_3.25rem_7rem_3.75rem]';

  function shown(branch: TraceBranch): TraceNode[] {
    return folded ? branch.executions.filter((node) => node.status !== 'success') : branch.executions;
  }

  function selectedWithin(node: TraceNode): boolean {
    return selectedId === node.id || node.children.some((child) => child.id === selectedId);
  }
</script>

<div class="flex min-h-0 min-w-0 flex-col overflow-hidden">
  <div class="flex shrink-0 items-center gap-3 whitespace-nowrap border-b border-border px-4 py-2.5 text-xs sm:px-5">
    <button
      type="button"
      onclick={onCollapse}
      title={t('收起事件列表')}
      aria-label={t('收起事件列表')}
      class="-ml-1 hidden shrink-0 text-faint transition-colors hover:text-foreground lg:block"
      ><PanelLeftClose class="size-4" /></button
    >
    <span class={failedCount ? 'text-destructive' : 'text-muted-foreground'}>{failedCount} {t('失败')}</span>
    <span class="text-faint">·</span>
    <span class="text-muted-foreground">{succeededCount} {t('成功')}</span>
    <label
      class="ml-auto flex min-w-0 cursor-pointer items-center gap-1.5 text-muted-foreground"
      title={t('折叠成功的执行')}
    >
      <input
        type="checkbox"
        checked={folded}
        onchange={(event) => onToggleFold(event.currentTarget.checked)}
        class="shrink-0 accent-foreground"
      />
      <span class="truncate">{t('折叠成功的执行')}</span>
    </label>
  </div>
  <div data-scroll-surface class="min-h-0 flex-1 overflow-y-auto pb-4">
    {#each branches as branch (branch.eventId)}
      {@const visible = shown(branch)}
      {@const hidden = branch.executions.length - visible.length}
      {@const delivery = branch.dispatchStatus ? dispatchStatus(branch.dispatchStatus) : null}
      <section data-trace-event class="border-b border-border">
        <header class="bg-muted/40 px-4 py-2 sm:px-5">
          <div class="flex min-w-0 items-baseline gap-2">
            <span class="truncate font-mono text-[12.5px] font-medium" title={branch.eventId}
              >{branch.topic || t('事件')}</span
            >
            <span class="ml-auto shrink-0 font-mono text-[11px] text-faint" title={formatBeijingTime(branch.receivedAt)}
              >{offsetLabel(branch.receivedAt, startAt)}</span
            >
          </div>
          <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            {#if delivery}<StatusBadge status={delivery.semantic} label={delivery.label} class="text-[11px]" /><span
                class="text-faint">·</span
              >{/if}
            <span
              >{branch.executions.length
                ? t('触发 {count} 个执行', { count: branch.executions.length })
                : t('没有触发执行')}</span
            >
            {#if branch.publishedBy}<span class="text-faint">·</span><span
                >↳ {t('由 {name} 发出', { name: branch.publishedBy })}</span
              >{/if}
          </div>
        </header>
        {#each visible as node (node.id)}
          {@const position = barPosition(node, timeline)}
          <div
            data-trace-execution
            class="border-t border-border transition-colors {selectedWithin(node)
              ? 'bg-selected'
              : 'hover:bg-accent/60'}"
          >
            <button
              type="button"
              onclick={() => onSelect(node)}
              aria-current={selectedId === node.id}
              class="grid h-8 w-full {grid} items-center gap-2 pr-4 pl-7 text-left text-[13px] sm:pr-5 sm:pl-8"
            >
              <span class="flex min-w-0 items-center gap-2">
                <StatusBadge status={node.status} label={node.statusLabel} dotOnly />
                <span class="truncate font-medium">{node.name}</span>
              </span>
              <span class="text-right font-mono text-[11px] text-faint">{offsetLabel(node.startedAt, startAt)}</span>
              <span class="relative h-2 rounded-sm bg-muted"
                >{#if position}<i
                    class="absolute inset-y-0 rounded-sm {tone[node.status] ?? 'bg-faint/50'}"
                    style="left:{position.left}%;width:{position.width}%"
                  ></i>{/if}</span
              >
              <span class="text-right text-xs tabular-nums text-muted-foreground"
                >{spanLabel(node.startedAt, node.endedAt)}</span
              >
            </button>
            {#if node.status === 'failed' && node.error}
              <p
                class="truncate pr-4 pb-1.5 pl-[2.9rem] font-mono text-[11.5px] text-destructive sm:pl-[3.15rem]"
                title={node.error}
              >
                {node.error}
              </p>
            {/if}
            {#if node.children.length}
              <div class="flex flex-wrap gap-1.5 pr-4 pb-2 pl-[2.9rem] sm:pl-[3.15rem]">
                {#each node.children as child (child.id)}
                  <button
                    type="button"
                    onclick={() => onSelect(child)}
                    aria-current={selectedId === child.id}
                    title={child.detail || child.name}
                    class="flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors {selectedId ===
                    child.id
                      ? 'border-ring bg-card text-foreground'
                      : 'border-border bg-card/60 text-muted-foreground hover:text-foreground'}"
                  >
                    <span>Sandbox</span>
                    <span class="font-mono text-faint">{compactIdentifier(child.sandboxId)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
        {#if hidden}
          <button
            type="button"
            onclick={() => onToggleFold(false)}
            class="flex h-8 w-full items-center gap-2 border-t border-border pr-4 pl-7 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 sm:pl-8"
          >
            <StatusBadge status="success" dotOnly />
            {t('{count} 个成功的执行', { count: hidden })}
          </button>
        {/if}
      </section>
    {/each}
    {#if !branches.length}
      <p class="px-5 py-10 text-center text-sm text-muted-foreground">{t('暂无自动化执行')}</p>
    {/if}
  </div>
</div>
