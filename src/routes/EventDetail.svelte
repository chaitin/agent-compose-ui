<script lang="ts">
  import SandboxWorkbench from '$lib/components/sandbox-workbench.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import EventTraceTree from '$lib/components/events/event-trace-tree.svelte';
  import EventExecutionPanel from '$lib/components/events/event-execution-panel.svelte';
  import { Button } from '$lib/components/ui/button';
  import { navigate, router } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
  import { getTopicEventTrace, listTopicEvents, type TopicEvent } from '../api/loaders';
  import { listEventTasks } from '../api/tasks';
  import type { TaskLink } from '../model/task-list';
  import { dispatchStatus, eventSourceLabel } from '../model/event-status';
  import {
    buildTraceTree,
    defaultSelection,
    findTraceNode,
    sandboxContextEntries,
    traceBranches,
    traceSummary,
    traceTimeline,
    type TraceNode,
  } from '../model/event-trace';

  const eventId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  let event = $state<TopicEvent | null>(null);
  let nodes = $state<TraceNode[]>([]);
  let traceTruncated = $state(false);
  let selectedId = $state('');
  let folded = $state(true);
  /** 左侧事件栏收起后，右侧的日志占满宽度。 */
  let traceCollapsed = $state(false);
  // 左栏宽度占整行的百分比，拖动分隔线调整，记在浏览器里。
  // 改默认宽度时换一个 key，让旧的记忆值失效。
  const TRACE_WIDTH_KEY = 'agent-compose:event-trace-width:v3';
  const TRACE_WIDTH_DEFAULT = 28;
  const TRACE_WIDTH_MIN = 20;
  const TRACE_WIDTH_MAX = 70;
  let traceWidth = $state(clampTraceWidth(Number(localStorage.getItem(TRACE_WIDTH_KEY)) || TRACE_WIDTH_DEFAULT));
  let resizing = $state(false);
  let layout = $state<HTMLElement | null>(null);
  let error = $state('');
  let loading = $state(true);
  let loadedEventId = '';

  const eventStatus = $derived(event ? dispatchStatus(event.dispatchStatus) : null);
  /** 这个任务（关联 ID）下的事件，用来按「事件 → 扇出」分组，包括没有触发执行的事件。 */
  let taskEvents = $state<TopicEvent[]>([]);
  const branches = $derived(traceBranches(nodes, taskEvents.length ? taskEvents : event ? [event] : []));
  // 时间轴从这个任务收到的第一个事件开始。
  const startAt = $derived(branches[0]?.receivedAt ?? event?.createdAt ?? '');
  const timeline = $derived(traceTimeline(startAt, nodes));
  const selected = $derived(findTraceNode(nodes, selectedId));
  const selectedBranch = $derived(
    branches.find((branch) => branch.eventId === (selectedExecution ?? selected)?.triggerEventId),
  );
  // 选中 sandbox 时，它所属的那次执行。
  const selectedExecution = $derived(
    selected?.kind === 'sandbox' ? nodes.find((node) => node.children.includes(selected)) : selected,
  );
  // 标题圆点表达「这个事件引发的事情结果如何」：任一执行失败即为失败，否则沿用投递状态。
  const outcome = $derived(
    nodes.some((node) => node.status === 'failed')
      ? 'failed'
      : nodes.some((node) => node.status === 'running')
        ? 'running'
        : (eventStatus?.semantic ?? 'pending'),
  );
  const outcomeLabel = $derived(outcome === 'failed' ? '有执行失败' : (eventStatus?.label ?? ''));
  const summary = $derived(traceSummary(nodes));
  let correlationEvents = $state(0);
  /** 这串事件所属的任务；这套部署没配置任务字段、或事件不带任务时为 null。 */
  let task = $state<TaskLink | null>(null);

  $effect(() => {
    const target = eventId;
    if (target && target !== loadedEventId) {
      loadedEventId = target;
      void load(target);
    }
  });

  async function load(targetEventId = eventId): Promise<void> {
    loading = true;
    error = '';
    try {
      const trace = await getTopicEventTrace(targetEventId);
      event = trace.event;
      nodes = buildTraceTree(trace);
      traceTruncated = trace.descendantsTruncated;
      folded = nodes.some((node) => node.status !== 'success');
      correlationEvents = 0;
      taskEvents = [];
      task = null;
      void loadTask(trace.event.eventId, [trace.event.eventId]);
      // 同一个关联 ID 下的事件（重试的任务会有很多），1 个请求取回，用来画出每次事件扇出了哪些执行。
      if (trace.event.correlationId)
        void listTopicEvents({ correlationId: trace.event.correlationId, limit: 100 })
          .then((page) => {
            if (event?.eventId !== trace.event.eventId) return;
            correlationEvents = page.total;
            taskEvents = page.items;
            // 打开的可能是控制类事件，本身不带任务；任务在这串事件里最早的那几个上。
            const earliest = [...page.items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
            void loadTask(
              trace.event.eventId,
              earliest.slice(0, 3).map((item) => item.eventId),
            );
          })
          .catch(() => (correlationEvents = 0));
      if (!findTraceNode(nodes, selectedId)) selectedId = defaultSelection(nodes);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('请求失败');
    } finally {
      loading = false;
    }
  }

  async function loadTask(forEventId: string, candidates: string[]): Promise<void> {
    if (task) return;
    try {
      const found = await listEventTasks(candidates);
      if (event?.eventId !== forEventId || task) return;
      task = candidates.map((id) => found.get(id)).find((item) => item !== undefined) ?? null;
    } catch {
      // 任务标题只是辅助信息，取不到时标题退回事件主题。
    }
  }

  function clampTraceWidth(value: number): number {
    return Math.min(TRACE_WIDTH_MAX, Math.max(TRACE_WIDTH_MIN, Math.round(value * 10) / 10));
  }

  function setTraceWidth(value: number): void {
    traceWidth = clampTraceWidth(value);
    localStorage.setItem(TRACE_WIDTH_KEY, String(traceWidth));
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    resizing = true;
  }

  function resize(event: PointerEvent): void {
    if (!resizing || !layout) return;
    const bounds = layout.getBoundingClientRect();
    setTraceWidth(((event.clientX - bounds.left) / bounds.width) * 100);
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setTraceWidth(traceWidth + (event.key === 'ArrowLeft' ? -2 : 2));
  }

  function select(node: TraceNode): void {
    selectedId = node.id;
  }

  function openAutomationRun(node: TraceNode): void {
    const schedulerId = node.trace?.delivery.schedulerId ?? '';
    navigate(`/automation-runs/${encodeURIComponent(node.schedulerRunId)}?loaderId=${encodeURIComponent(schedulerId)}`);
  }
</script>

<div data-page-layout="workbench" class="flex h-full min-h-0 flex-col overflow-hidden">
  <header data-page-header class="shrink-0 border-b border-border px-4 py-3.5 sm:px-5 xl:px-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight">
          {#if eventStatus}<StatusBadge status={outcome} label={outcomeLabel} dotOnly />{/if}
          {#if task}
            <span class="truncate">{task.title}</span>
            {#if task.url}<a
                href={task.url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('打开任务页面')}
                aria-label={t('打开任务页面')}
                class="shrink-0 text-faint transition-colors hover:text-foreground"><ExternalLink class="size-4" /></a
              >{/if}
          {:else}
            <span class="truncate font-mono text-[15px] font-medium">{event?.topic || t('Webhook 事件详情')}</span>
          {/if}
        </h1>
        {#if event && eventStatus}
          <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {#if task}<span class="font-mono text-[11px]">{event.topic}</span>{/if}
            <span>{t(eventSourceLabel(event.source))}{event.provider ? ` · ${event.provider}` : ''}</span>
            <span>{t('收到于')} <Timestamp class="text-foreground/80" value={event.createdAt} mode="full" /></span>
            <span>{t(eventStatus.label)}</span>
            {#if correlationEvents > 1}<span>{t('这个任务共收到 {count} 次事件', { count: correlationEvents })}</span
              >{/if}
            <span
              >{t('触发 {executions} 次执行', { executions: summary.executions })}{#if summary.failed}<span
                  class="text-destructive">{t('，失败 {count} 次', { count: summary.failed })}</span
                >{/if}</span
            >
            {#if summary.last && summary.executions > 1}<span
                >{t('最后一次')}
                <span class={summary.last.status === 'failed' ? 'text-destructive' : 'text-foreground/80'}
                  >{t(summary.last.statusLabel)}</span
                ></span
              >{/if}
            {#if event.correlationId}<span class="truncate font-mono text-[11px] text-faint" title={t('关联 ID')}
                >{event.correlationId}</span
              >{/if}
          </div>
        {/if}
      </div>
      <div class="flex shrink-0 gap-1.5">
        <CopyLinkButton />
        <Button variant="outline" size="sm" onclick={() => void load()} disabled={loading}
          >{t(loading ? '刷新中…' : '刷新')}</Button
        >
      </div>
    </div>
  </header>

  {#if error}<div data-page-error class="shrink-0 bg-destructive/8 px-4 py-2 text-xs text-destructive sm:px-5 xl:px-6">
      {error}
    </div>{/if}
  {#if traceTruncated}<div class="shrink-0 bg-warning/10 px-4 py-2 text-xs text-warning-foreground sm:px-5 xl:px-6">
      {t('事件因果链过长，当前只显示前 1000 个关联事件的追踪结果')}
    </div>{/if}

  {#if loading && !event}
    <p class="p-6 text-sm text-muted-foreground">{t('正在加载事件详情…')}</p>
  {:else if event}
    <div
      bind:this={layout}
      style="--trace-width: {traceWidth}%"
      class="grid min-h-0 flex-1 {resizing ? 'cursor-col-resize select-none' : ''} {traceCollapsed
        ? 'lg:grid-cols-[2.25rem_minmax(0,1fr)]'
        : 'lg:grid-cols-[minmax(0,var(--trace-width))_minmax(0,1fr)]'}"
    >
      {#if traceCollapsed}
        <div class="hidden border-r border-border pt-2.5 lg:flex lg:justify-center">
          <button
            type="button"
            onclick={() => (traceCollapsed = false)}
            title={t('展开事件列表')}
            aria-label={t('展开事件列表')}
            class="h-fit text-faint transition-colors hover:text-foreground"><PanelLeftOpen class="size-4" /></button
          >
        </div>
      {/if}
      <div
        class="relative min-h-0 min-w-0 flex-col border-border lg:border-r {traceCollapsed ? 'flex lg:hidden' : 'flex'}"
      >
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          data-trace-resizer
          role="separator"
          aria-orientation="vertical"
          aria-label={t('调整事件列表宽度')}
          aria-valuemin={TRACE_WIDTH_MIN}
          aria-valuemax={TRACE_WIDTH_MAX}
          aria-valuenow={traceWidth}
          tabindex="0"
          title={t('拖动调整宽度，双击恢复默认')}
          class="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize transition-colors outline-none hover:bg-ring/30 focus-visible:bg-ring/40 lg:block {resizing
            ? 'bg-ring/40'
            : ''}"
          onpointerdown={startResize}
          onpointermove={resize}
          onpointerup={() => (resizing = false)}
          onpointercancel={() => (resizing = false)}
          ondblclick={() => setTraceWidth(TRACE_WIDTH_DEFAULT)}
          onkeydown={resizeWithKeyboard}
        ></div>
        <EventTraceTree
          {branches}
          {startAt}
          {timeline}
          {selectedId}
          {folded}
          onSelect={select}
          onToggleFold={(value) => (folded = value)}
          onCollapse={() => (traceCollapsed = true)}
        />
      </div>
      <div class="min-h-0 min-w-0 bg-card">
        {#if selected?.kind === 'sandbox'}
          {#key selected.id}
            <div class="flex h-full min-h-0 flex-col p-3">
              <div
                data-trace-selection
                class="mb-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted px-3 py-1.5 text-xs"
              >
                <StatusBadge status={selected.status} label={selected.statusLabel} dotOnly />
                <span class="font-medium">{selectedExecution?.name}</span>
                {#if branches.length > 1 && selectedBranch}<span class="text-muted-foreground"
                    >{t('由第 {order} 个事件触发', { order: selectedBranch.order })}</span
                  >{/if}
                <span class="text-faint">·</span><Timestamp value={selected.startedAt} mode="full" />
                <span class="text-faint">·</span><span>{t(selected.statusLabel)}</span>
                <span class="ml-auto truncate text-muted-foreground">Sandbox · {selected.detail || selected.name}</span>
                {#if selected.sharedBy > 1}<span class="w-full text-warning-foreground dark:text-warning"
                    >{t('这个 Sandbox 还被本任务的另外 {count} 次执行使用，下方日志包含它们全部的内容', {
                      count: selected.sharedBy - 1,
                    })}</span
                  >{/if}
              </div>
              <div class="min-h-0 flex-1">
                <SandboxWorkbench
                  sandboxId={selected.sandboxId}
                  contextLogEntries={sandboxContextEntries(nodes, selected.sandboxId)}
                  embedded
                />
              </div>
            </div>
          {/key}
        {:else if selected}
          <EventExecutionPanel node={selected} onOpenRun={() => openAutomationRun(selected)} onSelectSandbox={select} />
        {:else}
          <p class="p-6 text-sm text-muted-foreground">{t('暂无自动化执行')}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
