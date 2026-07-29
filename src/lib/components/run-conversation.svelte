<script lang="ts">
  import { tick } from 'svelte';
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import ConversationSearch from '$lib/components/conversation-search.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import SearchableText from '$lib/components/searchable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate } from '$lib/router.svelte';
  import { t } from '$lib/i18n.svelte';
  import { conversationResponseState, isActiveConversationTurn, type ConversationTurn } from '../../model/conversation';
  import { failureDetails, failureSummary } from '../../model/errors';
  import { textMatchOffsets } from '../../model/text-search';

  let {
    turns,
    currentRunId,
    currentRunStatus,
    currentRunError,
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
    onCancel,
  }: {
    turns: ConversationTurn[];
    currentRunId: string;
    currentRunStatus: string;
    currentRunError: string;
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
    onCancel: () => void;
  } = $props();

  let conversationNode = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);
  let searchQuery = $state('');
  let activeMatch = $state(0);
  const hasMergedPendingTurn = $derived(turns.some((turn) => isPendingTurn(turn)));

  const searchableEntries = $derived.by(() => {
    const entries: Array<{ key: string; text: string }> = [];
    for (const turn of turns) {
      const prompt = presentedPrompt(turn);
      if (prompt) entries.push({ key: `${turn.id}:prompt`, text: prompt });
      const output = isPendingTurn(turn) ? pendingOutput || turn.output : presentedOutput(turn);
      if (output) entries.push({ key: `${turn.id}:output`, text: output });
    }
    if (pendingPrompt && !hasMergedPendingTurn) entries.push({ key: 'pending:prompt', text: pendingPrompt });
    if (pendingOutput && !hasMergedPendingTurn) entries.push({ key: 'pending:output', text: pendingOutput });
    return entries;
  });
  const matchOffsets = $derived(textMatchOffsets(searchableEntries, searchQuery));

  $effect(() => {
    const updateKey = `${turns.length}:${continuationRunId}:${pendingOutput}`;
    if (updateKey && followsLatest) void scrollToLatest();
  });

  function presentedOutput(turn: ConversationTurn): string {
    const error = turnError(turn);
    return error ? failureSummary(turn.output, error) : turn.output;
  }

  function presentedPrompt(turn: ConversationTurn): string {
    return isPendingTurn(turn) ? turn.prompt || pendingPrompt : turn.prompt;
  }

  function isPendingTurn(turn: ConversationTurn): boolean {
    return isActiveConversationTurn(turn, pendingRunId, currentRunId, pendingPrompt);
  }

  function turnStatus(turn: ConversationTurn, active: boolean, failed: boolean): string {
    if (active) return 'running';
    if (failed) return 'failed';
    return turn.runId === currentRunId ? currentRunStatus : 'success';
  }

  function turnError(turn: ConversationTurn): string {
    if (turn.stopReason) return turn.stopReason;
    if (turn.runId === currentRunId && currentRunStatus === 'failed') return currentRunError || t('执行失败');
    return '';
  }

  function trackScroll(): void {
    if (!conversationNode) return;
    followsLatest = conversationNode.scrollHeight - conversationNode.scrollTop - conversationNode.clientHeight < 72;
  }

  async function scrollToLatest(force = false): Promise<void> {
    await tick();
    if (force) followsLatest = true;
    if (conversationNode && followsLatest) conversationNode.scrollTo({ top: conversationNode.scrollHeight });
  }

  function setSearch(value: string): void {
    searchQuery = value;
    activeMatch = 0;
    void scrollToMatch();
  }

  function moveMatch(delta: number): void {
    if (!matchOffsets.total) return;
    activeMatch = (activeMatch + delta + matchOffsets.total) % matchOffsets.total;
    void scrollToMatch();
  }

  async function scrollToMatch(): Promise<void> {
    await tick();
    conversationNode?.querySelector<HTMLElement>('[data-search-active="true"]')?.scrollIntoView({ block: 'center' });
  }

  function sendAndFollow(): void {
    followsLatest = true;
    onSend();
    void scrollToLatest(true);
  }

  function submitOrCancel(): void {
    if (sending) {
      onCancel();
      return;
    }
    sendAndFollow();
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (message.trim() || sending) submitOrCancel();
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <div
    class="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#293244] bg-[#111722] text-[#d8dee9]"
  >
    <ConversationSearch
      query={searchQuery}
      count={matchOffsets.total}
      active={Math.min(activeMatch, Math.max(matchOffsets.total - 1, 0))}
      onQuery={setSearch}
      onPrevious={() => moveMatch(-1)}
      onNext={() => moveMatch(1)}
    />
    {#if !followsLatest}
      <Button
        class="absolute bottom-4 right-4 z-10"
        size="sm"
        variant="outline"
        onclick={() => void scrollToLatest(true)}>{t('回到最新')}</Button
      >
    {/if}

    <div
      bind:this={conversationNode}
      data-conversation-transcript
      data-scroll-pane
      class="min-h-0 flex-1 space-y-8 overflow-y-auto p-4 sm:p-5"
      onscroll={trackScroll}
    >
      {#each turns as turn (turn.id)}
        {@const error = turnError(turn)}
        {@const failed = Boolean(error)}
        {@const active = isPendingTurn(turn)}
        {@const prompt = presentedPrompt(turn)}
        {@const status = turnStatus(turn, active, failed)}
        {@const errorDetail = failed ? failureDetails(turn.output, error) : ''}
        {@const output = active ? pendingOutput || turn.output : presentedOutput(turn)}
        {@const responseState = conversationResponseState(status, output, error)}
        <article data-conversation-turn data-status={status} class="min-w-0">
          <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-white/10 pb-2 text-[11px] text-white/45">
            <StatusBadge {status} />
            {#if turn.runId}<CopyableText
                value={turn.runId}
                display={turn.runId.slice(0, 12)}
                label="Run ID"
                class="font-mono"
              />{/if}
            {#if turn.createdAt}<Timestamp value={turn.createdAt} />{/if}
            {#if turn.runId === currentRunId}<span class="font-medium text-cyan-200/80">{t('本次运行')}</span>{/if}
            {#if turn.runId && turn.runId !== currentRunId}<button
                type="button"
                class="ml-auto inline-flex items-center gap-1 text-white/50 hover:text-white"
                onclick={() => navigate(`/runs/${encodeURIComponent(turn.runId)}`)}
                >{t('查看运行')} <ArrowUpRight class="size-3" /></button
              >{/if}
          </div>

          {#if prompt}<div
              data-message-role="user"
              data-message-content
              class="ml-auto w-fit max-w-[88%] rounded-lg bg-blue-500/20 px-4 py-3 font-mono text-sm text-blue-50"
            >
              <pre class="whitespace-pre-wrap break-words">› <SearchableText
                  text={prompt}
                  query={searchQuery}
                  matchOffset={matchOffsets.offsets.get(`${turn.id}:prompt`) ?? 0}
                  {activeMatch}
                /></pre>
            </div>{/if}

          {#if active}<div class="mt-3 border-l border-cyan-300/30 pl-3 font-mono text-xs text-white/65">
              {pendingStreamState || t('回复中…')}
            </div>{/if}
          {#if responseState !== 'streaming' && responseState !== 'none'}<div
              data-message-role="assistant"
              data-message-content
              class="mr-auto mt-3 max-w-full border-l-2 pl-4 {responseState === 'error'
                ? 'border-red-300/50 text-red-100'
                : 'border-emerald-300/50'}"
            >
              <div class="mb-1 text-[11px] {responseState === 'error' ? 'text-red-200/70' : 'text-emerald-200/70'}">
                {t(responseState === 'error' ? '回复失败' : '智能体输出')}
              </div>
              {#if output}<pre class="whitespace-pre-wrap break-words text-sm leading-6"><SearchableText
                    text={output}
                    query={searchQuery}
                    matchOffset={matchOffsets.offsets.get(`${turn.id}:output`) ?? 0}
                    {activeMatch}
                  /></pre>{:else}<p class="text-sm text-white/45">{t('未产生输出')}</p>{/if}
              {#if responseState === 'error' && errorDetail !== output}<details class="mt-2 text-xs text-red-100/80">
                  <summary class="cursor-pointer select-none">{t('错误详情')}</summary>
                  <pre
                    class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-red-500/10 p-2">{errorDetail}</pre>
                </details>{/if}
            </div>{/if}
        </article>
      {/each}

      {#if continuationRunId}<div class="flex justify-end">
          <Button variant="outline" size="sm" onclick={() => navigate(`/runs/${encodeURIComponent(continuationRunId)}`)}
            >{t('查看运行')} {continuationRunId.slice(0, 12)} <ArrowUpRight class="size-3.5" /></Button
          >
        </div>{/if}

      {#if pendingPrompt && !hasMergedPendingTurn}<article
          data-conversation-turn
          data-status="running"
          aria-live="polite"
          class="min-w-0"
        >
          <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-white/10 pb-2 text-[11px] text-white/45">
            <StatusBadge status="running" />
            {#if pendingRunId}<CopyableText
                value={pendingRunId}
                display={pendingRunId.slice(0, 12)}
                label="Run ID"
                class="font-mono"
              />{/if}
            <span class="font-medium text-cyan-200/80">{t('本次运行')}</span>
          </div>
          <div
            data-message-role="user"
            data-message-content
            class="ml-auto w-fit max-w-[88%] rounded-lg bg-blue-500/20 px-4 py-3 font-mono text-sm text-blue-50"
          >
            <pre class="whitespace-pre-wrap break-words">› <SearchableText
                text={pendingPrompt}
                query={searchQuery}
                matchOffset={matchOffsets.offsets.get('pending:prompt') ?? 0}
                {activeMatch}
              /></pre>
          </div>
          <div class="mt-3 border-l border-cyan-300/30 pl-3 font-mono text-xs text-white/65">
            {pendingStreamState || t('回复中…')}
          </div>
          {#if pendingOutput}<div
              data-message-role="assistant"
              data-message-content
              class="mt-3 border-l-2 border-emerald-300/50 pl-4"
            >
              <div class="mb-1 text-[11px] text-emerald-200/70">{t('智能体输出')}</div>
              <pre class="whitespace-pre-wrap break-words text-sm leading-6"><SearchableText
                  text={pendingOutput}
                  query={searchQuery}
                  matchOffset={matchOffsets.offsets.get('pending:output') ?? 0}
                  {activeMatch}
                /></pre>
            </div>{/if}
        </article>{/if}
    </div>
  </div>

  {#if sandboxId}<div data-composer class="mt-3 flex shrink-0 items-end gap-2">
      <Textarea
        value={message}
        oninput={(event) => onMessage(event.currentTarget.value)}
        class="max-h-40 min-h-10 resize-none py-2"
        rows={1}
        placeholder={t('输入消息，Shift + Enter 换行')}
        onkeydown={handleComposerKeydown}
      />
      <Button class="shrink-0" variant={sending ? 'outline' : 'default'} onclick={submitOrCancel}
        >{t(sending ? '取消本轮' : '发送')}</Button
      >
    </div>{/if}
</div>
