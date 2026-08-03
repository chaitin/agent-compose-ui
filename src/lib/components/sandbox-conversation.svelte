<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import ConversationSearch from '$lib/components/conversation-search.svelte';
  import SearchableText from '$lib/components/searchable-text.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { AgentStreamState } from '$lib/run-stream.svelte';
  import { runStatusName } from '../../api/runs';
  import { RunEventKind, type RunEvent, type RunSummary } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import type { ConversationTurn } from '../../model/conversation';
  import { compactIdentifier } from '../../model/identifiers';
  import { timestampToISOString } from '../../model/timestamps';
  import { textMatchOffsets } from '../../model/text-search';

  let {
    runs,
    events,
    turns,
    activeStream,
  }: { runs: RunSummary[]; events: RunEvent[]; turns: ConversationTurn[]; activeStream?: AgentStreamState } = $props();

  let transcriptNode = $state<HTMLElement | null>(null);
  let followsLatest = $state(true);
  let searchQuery = $state('');
  let activeMatch = $state(0);

  const chronologicalRuns = $derived([...runs].reverse());
  const searchableEntries = $derived.by(() => {
    const entries: { key: string; text: string }[] = [];
    for (const run of chronologicalRuns) {
      const runTurn = turn(run.runId);
      if (runTurn?.prompt) entries.push({ key: `${run.runId}:prompt`, text: runTurn.prompt });
      else for (const event of prompts(run.runId)) entries.push({ key: event.id, text: event.text });
      if (runTurn?.output) entries.push({ key: `${run.runId}:output`, text: runTurn.output });
      else for (const event of replies(run.runId)) entries.push({ key: event.id, text: event.text });
      if (activeStream?.runId === run.runId && activeStream.output)
        entries.push({ key: `${run.runId}:active`, text: activeStream.output });
      if (run.error) entries.push({ key: `${run.runId}:error`, text: run.error });
    }
    if (activeStream && !runs.some((run) => run.runId === activeStream.runId)) {
      entries.push({ key: `${activeStream.operationId}:prompt`, text: activeStream.prompt });
      if (activeStream.output) entries.push({ key: `${activeStream.operationId}:output`, text: activeStream.output });
    }
    return entries;
  });
  const matchOffsets = $derived(textMatchOffsets(searchableEntries, searchQuery));

  $effect(() => {
    const key = `${events.length}:${activeStream?.output.length ?? 0}:${activeStream?.transcript.length ?? 0}`;
    if (key && followsLatest)
      requestAnimationFrame(() => transcriptNode?.scrollTo({ top: transcriptNode.scrollHeight }));
  });

  function runEvents(runId: string): RunEvent[] {
    return events.filter((event) => event.runId === runId);
  }

  function prompts(runId: string): RunEvent[] {
    return runEvents(runId).filter((event) => event.kind === RunEventKind.USER_MESSAGE);
  }

  function turn(runId: string): ConversationTurn | undefined {
    return turns.find((item) => item.runId === runId);
  }

  function replies(runId: string): RunEvent[] {
    return runEvents(runId).filter((event) => event.kind === RunEventKind.AGENT_MESSAGE);
  }

  function trackScroll(): void {
    if (!transcriptNode) return;
    followsLatest = transcriptNode.scrollHeight - transcriptNode.scrollTop - transcriptNode.clientHeight < 72;
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
    transcriptNode?.querySelector<HTMLElement>('[data-search-active="true"]')?.scrollIntoView({ block: 'center' });
  }
</script>

<div
  class="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[#293244] bg-[#111722] text-[#d8dee9]"
>
  <ConversationSearch
    query={searchQuery}
    count={matchOffsets.total}
    active={Math.min(activeMatch, Math.max(matchOffsets.total - 1, 0))}
    onQuery={setSearch}
    onPrevious={() => moveMatch(-1)}
    onNext={() => moveMatch(1)}
  />
  {#if !followsLatest}<Button
      class="absolute bottom-4 right-4 z-10"
      size="sm"
      variant="outline"
      onclick={() => transcriptNode?.scrollTo({ top: transcriptNode.scrollHeight })}>{t('回到最新')}</Button
    >{/if}
  <div
    bind:this={transcriptNode}
    data-conversation-transcript
    data-scroll-pane
    class="min-h-0 flex-1 space-y-8 overflow-y-auto p-4 sm:p-5"
    onscroll={trackScroll}
  >
    {#each chronologicalRuns as run (run.runId)}
      {@const runTurn = turn(run.runId)}
      <article data-conversation-run data-status={runStatusName(run.status)} class="min-w-0">
        <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-white/10 pb-2 text-[11px] text-white/45">
          <StatusBadge status={runStatusName(run.status)} /><CopyableText
            value={run.runId}
            display={run.runShortId || compactIdentifier(run.runId)}
            label="运行 ID"
            class="font-mono"
          /><Timestamp value={timestampToISOString(run.startedAt || run.createdAt)} />
        </div>

        {#if runTurn?.prompt}<div
            data-message-role="user"
            data-message-content
            class="ml-auto w-fit max-w-[88%] rounded-lg bg-blue-500/20 px-4 py-3 font-mono text-sm text-blue-50"
          >
            <pre class="whitespace-pre-wrap break-words">› <SearchableText
                text={runTurn.prompt}
                query={searchQuery}
                matchOffset={matchOffsets.offsets.get(`${run.runId}:prompt`) ?? 0}
                {activeMatch}
              /></pre>
          </div>{:else}{#each prompts(run.runId) as event (event.id)}<div
              data-message-role="user"
              data-message-content
              class="ml-auto w-fit max-w-[88%] rounded-lg bg-blue-500/20 px-4 py-3 font-mono text-sm text-blue-50"
            >
              <pre class="whitespace-pre-wrap break-words">› <SearchableText
                  text={event.text}
                  query={searchQuery}
                  matchOffset={matchOffsets.offsets.get(event.id) ?? 0}
                  {activeMatch}
                /></pre>
            </div>{/each}{/if}

        {#if runTurn?.output}<div
            data-message-role="assistant"
            data-message-content
            class="mr-auto mt-3 max-w-full border-l-2 border-emerald-300/50 pl-4"
          >
            <div class="mb-1 text-[11px] text-emerald-200/70">{t('智能体输出')}</div>
            <pre class="whitespace-pre-wrap break-words text-sm leading-6 text-white"><SearchableText
                text={runTurn.output}
                query={searchQuery}
                matchOffset={matchOffsets.offsets.get(`${run.runId}:output`) ?? 0}
                {activeMatch}
              /></pre>
          </div>{:else}{#each replies(run.runId) as event (event.id)}
            <div
              data-message-role="assistant"
              data-message-content
              class="mr-auto mt-3 max-w-full border-l-2 border-emerald-300/50 pl-4"
            >
              <div class="mb-1 text-[11px] text-emerald-200/70">{t('智能体输出')}</div>
              <pre class="whitespace-pre-wrap break-words text-sm leading-6 text-white"><SearchableText
                  text={event.text}
                  query={searchQuery}
                  matchOffset={matchOffsets.offsets.get(event.id) ?? 0}
                  {activeMatch}
                /></pre>
            </div>
          {/each}{/if}
        {#if activeStream?.runId === run.runId && activeStream.running && activeStream.output}<div
            data-message-role="assistant"
            data-message-content
            class="mr-auto mt-3 max-w-full border-l-2 border-emerald-300/50 pl-4"
          >
            <div class="mb-1 text-[11px] text-emerald-200/70">{t('智能体输出')}</div>
            <pre class="whitespace-pre-wrap break-words text-sm leading-6 text-white"><SearchableText
                text={activeStream.output}
                query={searchQuery}
                matchOffset={matchOffsets.offsets.get(`${run.runId}:active`) ?? 0}
                {activeMatch}
              /></pre>
          </div>{/if}

        {#if run.error}<div
            role="alert"
            class="mt-3 whitespace-pre-wrap rounded-md border border-red-300/20 bg-red-500/10 px-3 py-2 text-sm text-red-100"
          >
            <SearchableText
              text={run.error}
              query={searchQuery}
              matchOffset={matchOffsets.offsets.get(`${run.runId}:error`) ?? 0}
              {activeMatch}
            />
          </div>{/if}
        {#if activeStream?.runId === run.runId && activeStream.phase === 'failed' && activeStream.error !== run.error}<div
            role="alert"
            class="mt-3 whitespace-pre-wrap rounded-md border border-red-300/20 bg-red-500/10 px-3 py-2 text-sm text-red-100"
          >
            {activeStream.error || t('回复失败')}
          </div>{/if}
      </article>
    {:else}<p class="py-10 text-center text-sm text-white/45">{t('暂无对话输出')}</p>{/each}

    {#if activeStream && !runs.some((run) => run.runId === activeStream.runId)}
      <article data-conversation-run data-status={activeStream.phase} aria-live="polite" class="space-y-3">
        <div
          data-message-role="user"
          data-message-content
          class="ml-auto w-fit max-w-[88%] rounded-lg bg-blue-500/20 px-4 py-3 font-mono text-sm text-blue-50"
        >
          › <SearchableText
            text={activeStream.prompt}
            query={searchQuery}
            matchOffset={matchOffsets.offsets.get(`${activeStream.operationId}:prompt`) ?? 0}
            {activeMatch}
          />
        </div>
        <div
          class:border-red-300={activeStream.phase === 'failed'}
          class:text-red-100={activeStream.phase === 'failed'}
          role={activeStream.phase === 'failed' ? 'alert' : undefined}
          class="border-l border-cyan-300/30 pl-3 font-mono text-xs text-white/65"
        >
          {activeStream.statusText}
        </div>
        {#if activeStream.output}<div
            data-message-role="assistant"
            data-message-content
            class="border-l-2 border-emerald-300/50 pl-4"
          >
            <div class="mb-1 text-[11px] text-emerald-200/70">{t('智能体输出')}</div>
            <pre class="whitespace-pre-wrap break-words text-sm leading-6 text-white"><SearchableText
                text={activeStream.output}
                query={searchQuery}
                matchOffset={matchOffsets.offsets.get(`${activeStream.operationId}:output`) ?? 0}
                {activeMatch}
              /></pre>
          </div>{/if}
      </article>
    {/if}
  </div>
</div>
