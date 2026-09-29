<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import { t } from '$lib/i18n.svelte';
  import { spanLabel, type TraceNode } from '../../../model/event-trace';
  import { formatBeijingClockSeconds, formatBeijingTime } from '../../../time';

  let {
    node,
    onOpenRun,
    onSelectSandbox,
  }: {
    node: TraceNode;
    onOpenRun: () => void;
    onSelectSandbox: (child: TraceNode) => void;
  } = $props();

  const section = 'border-b border-border px-5 py-4';
  // 这次自动化执行产生的调度事件（旧版「Event timeline」的内容）。不开 sandbox 的路由、控制器脚本，只能从这里看执行过程。
  const schedulerEvents = $derived(
    [...(node.trace?.events ?? [])].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
  );
  const heading = 'mb-2.5 text-[11px] text-faint';
</script>

<div data-scroll-surface class="h-full overflow-y-auto">
  <header class="border-b border-border px-5 pt-4 pb-3.5">
    <div class="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <StatusBadge status={node.status} label={node.statusLabel} dotOnly />
      <span class="truncate">{node.name}</span>
    </div>
    <div class="mt-1 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
      <span class={node.status === 'failed' ? 'text-destructive' : 'text-foreground/80'}>{t(node.statusLabel)}</span>
      {#if spanLabel(node.startedAt, node.endedAt)}<span class="text-faint">·</span><span
          >{spanLabel(node.startedAt, node.endedAt)}</span
        >{/if}
      <span class="text-faint">·</span><Timestamp value={node.startedAt} />
    </div>
    {#if node.schedulerRunId}<div class="mt-3">
        <Button size="sm" variant="outline" onclick={onOpenRun}>{t('打开自动化执行')}</Button>
      </div>{/if}
  </header>

  {#if node.error}
    <section class={section}>
      <h3 class={heading}>{t('错误')}</h3>
      <pre
        class="max-h-72 overflow-auto rounded-r-md border-l-2 border-destructive bg-destructive/5 px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap">{node.error}</pre>
    </section>
  {/if}

  <section class={section}>
    <h3 class="{heading} flex justify-between">
      <span>{t('执行事件')}</span><span class="tabular-nums">{schedulerEvents.length}</span>
    </h3>
    <ol class="space-y-1.5">
      {#each schedulerEvents as item (item.id)}
        <li class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-xs">
          <span class="font-mono text-[11px] text-faint tabular-nums" title={formatBeijingTime(item.createdAt)}
            >{formatBeijingClockSeconds(item.createdAt)}</span
          >
          <span class="min-w-0">
            <span class="font-mono text-[11.5px] {item.level === 'error' ? 'text-destructive' : 'text-foreground/80'}"
              >{item.type}</span
            >
            {#if item.message}<span
                class="block truncate text-muted-foreground {item.level === 'error' ? 'text-destructive/80' : ''}"
                title={item.message.length > 300 ? `${item.message.slice(0, 300)}…` : item.message}>{item.message}</span
              >{/if}
          </span>
        </li>
      {:else}
        <li class="text-xs text-muted-foreground">{t('这次执行没有记录调度事件')}</li>
      {/each}
    </ol>
  </section>

  <section class={section}>
    <h3 class={heading}>{t('Sandbox')}</h3>
    {#each node.children as child (child.id)}
      <button
        type="button"
        onclick={() => onSelectSandbox(child)}
        class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent"
      >
        <span class="truncate">{child.name || t('Sandbox')}</span>
        {#if child.detail}<span class="truncate text-faint">{child.detail}</span>{/if}
        <Timestamp class="ml-auto shrink-0 text-faint" value={child.startedAt} />
      </button>
    {:else}
      <p class="text-xs text-muted-foreground">{t('这次执行没有启动 Sandbox')}</p>
    {/each}
  </section>

  <section class="px-5 py-4">
    <h3 class={heading}>{t('技术细节')}</h3>
    <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
      <dt class="text-faint">{t('自动化')}</dt>
      <dd class="truncate font-mono">{node.detail}</dd>
      {#if node.trace?.delivery.triggerId}<dt class="text-faint">{t('触发条件')}</dt>
        <dd class="truncate font-mono">{node.trace.delivery.triggerId}</dd>{/if}
      {#if node.schedulerRunId}<dt class="text-faint">Scheduler run</dt>
        <dd class="min-w-0">
          <CopyableText value={node.schedulerRunId} label="Scheduler run ID" class="font-mono" />
        </dd>{/if}
    </dl>
  </section>
</div>
