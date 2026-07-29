<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { navigate } from '$lib/router.svelte';
  import CopyableText from './copyable-text.svelte';
  import StatusBadge from './status-badge.svelte';
  import Timestamp from './timestamp.svelte';
  import type { EventSessionTrace } from '../../model/event-detail';
  import { failureDetails, failureSummary } from '../../model/errors';
  import { t } from '$lib/i18n.svelte';
  import { jupyterEntryHref } from '../../model/jupyter';

  let {
    traces,
    drafts,
    pendingPrompts,
    streamOutput,
    streamState,
    streamFailed,
    sendingSessionId,
    sessionAction,
    isRunning,
    onDraft,
    onSend,
    onStop,
    onResume,
  }: {
    traces: EventSessionTrace[];
    drafts: Record<string, string>;
    pendingPrompts: Record<string, string>;
    streamOutput: Record<string, string>;
    streamState: Record<string, string>;
    streamFailed: Record<string, boolean>;
    sendingSessionId: string;
    sessionAction: string;
    isRunning: (trace: EventSessionTrace) => boolean;
    onDraft: (sessionId: string, value: string) => void;
    onSend: (trace: EventSessionTrace) => void;
    onStop: (trace: EventSessionTrace) => void;
    onResume: (trace: EventSessionTrace) => void;
  } = $props();

  let selectedSessionId = $state('');
  let conversationNode = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);
  const selected = $derived(traces.find((trace) => trace.link.sessionId === selectedSessionId) ?? traces[0]);
  const notebookHref = $derived(jupyterEntryHref(selected?.session));

  $effect(() => {
    const ids = traces.map((trace) => trace.link.sessionId);
    if (!selectedSessionId || !ids.includes(selectedSessionId)) selectedSessionId = ids[0] ?? '';
  });

  $effect(() => {
    const sessionId = selected?.link.sessionId ?? '';
    const updateKey = `${sessionId}:${selected?.cells.length ?? 0}:${streamOutput[sessionId] ?? ''}`;
    if (updateKey && followsLatest) void scrollToLatest();
  });

  function selectSession(sessionId: string): void {
    selectedSessionId = sessionId;
    followsLatest = true;
    void scrollToLatest(true);
  }

  function trackScroll(): void {
    if (!conversationNode) return;
    followsLatest = conversationNode.scrollHeight - conversationNode.scrollTop - conversationNode.clientHeight < 72;
  }

  async function scrollToLatest(force = false): Promise<void> {
    await tick();
    if (conversationNode && (force || followsLatest)) conversationNode.scrollTo({ top: conversationNode.scrollHeight });
  }

  function sendSelected(): void {
    if (!selected) return;
    followsLatest = true;
    onSend(selected);
    void scrollToLatest(true);
  }
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
  <div class="shrink-0 border-b border-border px-4 py-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-sm font-medium">{t('关联对话')}</h2>
        <p class="text-xs text-muted-foreground">
          {traces.length}
          {t('个对话上下文，消息继续发送到所选 Sandbox')}
        </p>
      </div>
      {#if !followsLatest}
        <Button size="sm" variant="outline" onclick={() => void scrollToLatest(true)}>{t('回到最新')}</Button>
      {/if}
    </div>
    {#if traces.length > 1}
      <div data-scroll-surface class="mt-3 flex gap-2 overflow-x-auto pb-1">
        {#each traces as trace (trace.link.sessionId)}
          <Button
            size="sm"
            variant={trace.link.sessionId === selected?.link.sessionId ? 'default' : 'outline'}
            onclick={() => selectSession(trace.link.sessionId)}
            >{trace.session?.title || trace.link.sessionId.slice(0, 12)}</Button
          >
        {/each}
      </div>
    {/if}
  </div>

  {#if selected}
    {@const sessionId = selected.link.sessionId}
    <div class="shrink-0 border-b border-border px-4 py-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="break-words font-medium">{selected.session?.title || sessionId}</h3>
          <CopyableText
            value={sessionId}
            label="Sandbox ID"
            class="max-w-full font-mono text-[11px] text-muted-foreground"
          />
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={selected.session?.status || 'pending'} />
            <span>{selected.link.relation} · trigger {selected.link.triggerId || '—'}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onclick={() => navigate(`/runs?sandboxId=${encodeURIComponent(sessionId)}`)}>{t('关联运行')}</Button
          >
          {#if isRunning(selected)}
            <Button size="sm" variant="outline" disabled={sessionAction === sessionId} onclick={() => onStop(selected)}
              >{t('停止')}</Button
            >
          {:else}
            <Button
              size="sm"
              variant="outline"
              disabled={sessionAction === sessionId}
              onclick={() => onResume(selected)}>{t('恢复')}</Button
            >
          {/if}
          <Button
            size="sm"
            variant="outline"
            href={notebookHref || undefined}
            target="_blank"
            rel="noopener noreferrer"
            disabled={!notebookHref}>Jupyter</Button
          >
        </div>
      </div>
    </div>

    <div
      bind:this={conversationNode}
      data-scroll-pane
      class="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4"
      onscroll={trackScroll}
    >
      {#each selected.cells as cell (cell.id)}
        {#if cell.source}
          <div class="ml-auto max-w-[90%] rounded-lg bg-primary/10 p-3">
            <div class="text-[11px] font-medium text-muted-foreground">{t('用户')}</div>
            <pre class="mt-1 whitespace-pre-wrap break-words text-sm">{cell.source}</pre>
          </div>
        {/if}
        {#if cell.output}
          {@const errorDetail = cell.stopReason ? failureDetails(cell.output, cell.stopReason) : ''}
          {@const errorSummary = cell.stopReason ? failureSummary(cell.output, cell.stopReason) : ''}
          <div
            class="mr-auto max-w-[90%] rounded-lg border bg-card p-3 {cell.stopReason
              ? 'border-destructive/40'
              : 'border-border'}"
          >
            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{cell.agent || t('智能体')}</span><span class="flex items-center gap-2"
                >{#if cell.stopReason}<span class="text-destructive">{t('失败')}</span>{/if}<Timestamp
                  value={cell.createdAt}
                /></span
              >
            </div>
            {#if cell.stopReason}<p class="mt-1 whitespace-pre-wrap break-words text-sm text-destructive">
                {errorSummary}
              </p>{:else}<pre class="mt-1 whitespace-pre-wrap break-words text-sm">{cell.output}</pre>{/if}
            {#if cell.stopReason && errorDetail !== errorSummary}<details class="mt-2 text-xs text-destructive/90">
                <summary class="cursor-pointer select-none">{t('错误详情')}</summary>
                <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{errorDetail}</pre>
              </details>{/if}
          </div>
        {/if}
      {:else}
        <p class="py-6 text-center text-sm text-muted-foreground">{t('暂无对话输出')}</p>
      {/each}
      {#if pendingPrompts[sessionId]}
        <div class="ml-auto max-w-[90%] rounded-lg bg-primary/10 p-3">
          <div class="text-[11px] font-medium text-muted-foreground">{t('用户')}</div>
          <pre class="mt-1 whitespace-pre-wrap break-words text-sm">{pendingPrompts[sessionId]}</pre>
        </div>
        <div
          class="mr-auto max-w-[90%] rounded-lg border bg-card p-3 {streamFailed[sessionId]
            ? 'border-destructive/40'
            : 'border-primary/30'}"
          aria-live="polite"
        >
          <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="font-medium text-muted-foreground">{t('智能体')}</span>
            <span class="flex items-center gap-1.5 {streamFailed[sessionId] ? 'text-destructive' : 'text-primary'}"
              ><span
                class="size-1.5 rounded-full {streamFailed[sessionId] ? 'bg-destructive' : 'animate-pulse bg-primary'}"
              ></span>{streamState[sessionId] || t('回复中…')}</span
            >
          </div>
          {#if streamOutput[sessionId]}<pre
              class="mt-1 whitespace-pre-wrap break-words text-sm {streamFailed[sessionId]
                ? 'text-destructive'
                : ''}">{streamOutput[sessionId]}</pre>{/if}
        </div>
      {/if}
    </div>

    <div data-composer class="flex shrink-0 flex-col gap-2 border-t border-border bg-card p-3 sm:flex-row">
      <Input
        value={drafts[sessionId] || ''}
        oninput={(event) => onDraft(sessionId, event.currentTarget.value)}
        placeholder={t(selected.target && isRunning(selected) ? '输入消息' : 'Sandbox 已停止')}
        disabled={!selected.target || !isRunning(selected)}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) sendSelected();
        }}
      />
      <Button
        class="sm:shrink-0"
        disabled={!selected.target || !isRunning(selected) || sendingSessionId === sessionId}
        onclick={sendSelected}>{t(sendingSessionId === sessionId ? '发送中…' : '发送')}</Button
      >
    </div>
  {:else}
    <div class="flex min-h-48 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      {t('这个事件没有产生或绑定对话 Sandbox。')}
    </div>
  {/if}
</section>
