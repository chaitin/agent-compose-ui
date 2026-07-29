<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { navigate } from '$lib/router.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import type { ConversationTurn } from '../../model/conversation';
  import { failureDetails, failureSummary } from '../../model/errors';
  import { t } from '$lib/i18n.svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';

  let {
    turns,
    continuationRunId,
    pendingPrompt,
    pendingOutput,
    pendingRunId,
    pendingStreamState,
    sandboxId,
    message,
    sending,
    onMessage,
    onSend,
  }: {
    turns: ConversationTurn[];
    continuationRunId: string;
    pendingPrompt: string;
    pendingOutput: string;
    pendingRunId: string;
    pendingStreamState: string;
    sandboxId: string;
    message: string;
    sending: boolean;
    onMessage: (value: string) => void;
    onSend: () => void;
  } = $props();

  let conversationNode = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);

  $effect(() => {
    const updateKey = `${turns.length}:${continuationRunId}:${pendingOutput}`;
    if (updateKey && followsLatest) void scrollToLatest();
  });

  function trackScroll(): void {
    if (!conversationNode) return;
    followsLatest = conversationNode.scrollHeight - conversationNode.scrollTop - conversationNode.clientHeight < 72;
  }

  async function scrollToLatest(force = false): Promise<void> {
    await tick();
    if (conversationNode && (force || followsLatest)) conversationNode.scrollTo({ top: conversationNode.scrollHeight });
  }

  function sendAndFollow(): void {
    followsLatest = true;
    onSend();
    void scrollToLatest(true);
  }
</script>

<div class="relative flex h-full min-h-0 flex-col overflow-hidden">
  {#if !followsLatest}
    <Button
      class="absolute bottom-16 right-4 z-10 shadow"
      size="sm"
      variant="outline"
      onclick={() => void scrollToLatest(true)}>{t('回到最新')}</Button
    >
  {/if}

  <div
    bind:this={conversationNode}
    data-scroll-pane
    class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
    onscroll={trackScroll}
  >
    {#each turns as turn (turn.id)}
      {@const failed = Boolean(turn.stopReason)}
      {@const errorDetail = failed ? failureDetails(turn.output, turn.stopReason) : ''}
      {@const errorSummary = failed ? failureSummary(turn.output, turn.stopReason) : ''}
      <article
        data-conversation-turn
        data-status={failed ? 'failed' : 'completed'}
        class="min-w-0 space-y-3 rounded-lg border bg-card p-4 {failed ? 'border-destructive/40' : 'border-border'}"
      >
        <div>
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('用户输入')}</span>
            <span class="flex flex-wrap items-center gap-2 font-normal">
              {#if turn.createdAt}<Timestamp value={turn.createdAt} />{/if}
              {#if turn.runId}<CopyableText
                  value={turn.runId}
                  display={turn.runId.slice(0, 12)}
                  label="Run ID"
                  class="font-mono"
                />{/if}
            </span>
          </div>
          <pre class="mt-2 whitespace-pre-wrap break-words text-sm">{turn.prompt || '—'}</pre>
        </div>
        <div class="border-t border-border pt-3">
          <div class="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('智能体输出')}</span>
            {#if failed}<span class="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{t('失败')}</span
              >{/if}
          </div>
          {#if failed}<p class="mt-2 whitespace-pre-wrap break-words text-sm text-destructive">
              {errorSummary}
            </p>{:else if turn.output}<pre
              class="mt-2 whitespace-pre-wrap break-words text-sm">{turn.output}</pre>{:else}<p
              class="mt-2 text-sm text-muted-foreground"
            >
              {t('暂无输出')}
            </p>{/if}
          {#if failed && errorDetail !== errorSummary}<details class="mt-2 text-xs text-destructive/90">
              <summary class="cursor-pointer select-none">{t('错误详情')}</summary>
              <pre
                class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/5 p-2">{errorDetail}</pre>
            </details>{/if}
        </div>
      </article>
    {/each}
    {#if continuationRunId}
      <div class="flex justify-end">
        <Button variant="ghost" size="sm" onclick={() => navigate(`/runs/${encodeURIComponent(continuationRunId)}`)}
          >{t('查看运行')} {continuationRunId.slice(0, 12)} <ArrowUpRight class="size-3.5" /></Button
        >
      </div>
    {/if}
    {#if pendingPrompt}
      <article class="min-w-0 space-y-3 rounded-lg border border-primary/30 bg-card p-4" aria-live="polite">
        <div>
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('用户输入')}</span>
            {#if pendingRunId}<CopyableText
                value={pendingRunId}
                display={pendingRunId.slice(0, 12)}
                label="Run ID"
                class="font-mono font-normal"
              />{/if}
          </div>
          <p class="mt-2 whitespace-pre-wrap break-words text-sm">{pendingPrompt}</p>
        </div>
        <div class="border-t border-border pt-3">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('智能体输出')}</span>
            <span class="flex items-center gap-1.5 font-normal text-primary">
              <span class="size-1.5 animate-pulse rounded-full bg-primary"></span>
              {pendingStreamState || t('回复中…')}
            </span>
          </div>
          {#if pendingOutput}<pre class="mt-2 whitespace-pre-wrap break-words text-sm">{pendingOutput}</pre>{/if}
        </div>
      </article>
    {/if}
  </div>

  {#if sandboxId}
    <div data-composer class="mt-3 flex shrink-0 flex-col gap-2 border-t border-border pt-3 sm:flex-row">
      <Input
        value={message}
        oninput={(event) => onMessage(event.currentTarget.value)}
        placeholder={t('输入消息')}
        onkeydown={(event) => event.key === 'Enter' && !event.shiftKey && sendAndFollow()}
      />
      <Button class="sm:shrink-0" disabled={sending} onclick={sendAndFollow}>{t(sending ? '回复中…' : '发送')}</Button>
    </div>
  {/if}
</div>
