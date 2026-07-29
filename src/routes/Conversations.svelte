<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import RunConversation from '$lib/components/run-conversation.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import { runStreams, type AgentStreamState } from '$lib/run-stream.svelte';
  import {
    getSandboxContext,
    getSandboxRunTarget,
    listSandboxContexts,
    listSandboxHistoryCells,
    listSandboxHistoryEvents,
    refreshSandboxHistoryCells,
    resumeSandboxContext,
    stopSandboxContext,
    type SandboxContext,
    type SandboxContextDetail,
    type SandboxHistoryEvent,
    type SandboxRunTarget,
  } from '../api/sessions';
  import {
    conversationSummary,
    conversationTurns,
    withFailedConversationTurn,
    type ConversationSummary,
    type ConversationTurn,
  } from '../model/conversation';
  import Download from '@lucide/svelte/icons/download';
  import Search from '@lucide/svelte/icons/search';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import { t } from '$lib/i18n.svelte';

  let contexts = $state<SandboxContext[]>([]);
  let detail = $state<SandboxContextDetail | null>(null);
  let turns = $state<ConversationTurn[]>([]);
  let events = $state<SandboxHistoryEvent[]>([]);
  let target = $state<SandboxRunTarget | undefined>();
  let query = $state('');
  let messageQuery = $state('');
  let message = $state('');
  let loading = $state(true);
  let detailLoading = $state(false);
  let action = $state('');
  let error = $state('');
  let submitting = $state(false);
  let submittingPrompt = $state('');
  let loadedSandboxId = '';
  let finalizedOperationId = '';

  const routeSandboxId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  const summaries = $derived(contexts.map(conversationSummary));
  const filtered = $derived(filterSummaries(summaries, query));
  const selectedSummary = $derived(summaries.find((item) => item.sandboxId === routeSandboxId));
  const activeStream = $derived(routeSandboxId ? runStreams.forSandbox(routeSandboxId) : undefined);
  const visibleTurns = $derived(filterTurns(turns, messageQuery));

  onMount(() => void load());

  $effect(() => {
    const sandboxId = routeSandboxId;
    if (sandboxId && sandboxId !== loadedSandboxId) {
      loadedSandboxId = sandboxId;
      void loadDetail(sandboxId);
    }
  });

  $effect(() => {
    const stream = activeStream;
    if (stream && !stream.running && stream.operationId !== finalizedOperationId) {
      finalizedOperationId = stream.operationId;
      void finalizeStream(stream);
    }
  });

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const response = await listSandboxContexts(200, 0);
      contexts = response.sessions.filter((item) => item.cellCount > 0);
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function loadDetail(sandboxId: string): Promise<void> {
    detailLoading = true;
    error = '';
    try {
      const [nextDetail, cells, nextEvents, nextTarget] = await Promise.all([
        getSandboxContext(sandboxId),
        listSandboxHistoryCells(sandboxId),
        listSandboxHistoryEvents(sandboxId),
        getSandboxRunTarget(sandboxId),
      ]);
      if (routeSandboxId !== sandboxId) return;
      detail = nextDetail;
      turns = conversationTurns(cells);
      events = nextEvents;
      target = nextTarget;
    } catch (cause) {
      error = errorMessage(cause);
      detail = null;
      turns = [];
      events = [];
      target = undefined;
    } finally {
      detailLoading = false;
    }
  }

  async function sendMessage(): Promise<void> {
    const text = message.trim();
    if (!detail) {
      error = t('请先选择一条对话记录');
      return;
    }
    if (!target) {
      error = t('当前对话缺少关联智能体，无法继续发送消息');
      return;
    }
    if (!text) {
      error = t('请输入要发送的消息');
      return;
    }
    if (submitting || activeStream?.running) {
      error = t('上一条消息仍在处理中，请稍候');
      return;
    }
    message = '';
    error = '';
    submitting = true;
    submittingPrompt = text;
    try {
      await runStreams.start({
        projectId: target.projectId,
        agentName: target.agentName,
        prompt: text,
        sandboxId: detail.id,
      });
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      submitting = false;
      submittingPrompt = '';
    }
  }

  async function finalizeStream(stream: AgentStreamState): Promise<void> {
    try {
      const [cells, nextEvents, nextDetail] = await Promise.all([
        refreshSandboxHistoryCells(stream.sandboxId),
        listSandboxHistoryEvents(stream.sandboxId),
        getSandboxContext(stream.sandboxId),
      ]);
      const nextTurns = conversationTurns(cells);
      turns = stream.phase === 'failed' ? withFailedConversationTurn(nextTurns, streamFailure(stream)) : nextTurns;
      events = nextEvents;
      detail = nextDetail;
      error = '';
      runStreams.dismiss(stream);
    } catch (cause) {
      if (stream.phase === 'failed') {
        turns = withFailedConversationTurn(turns, streamFailure(stream));
        error = '';
        runStreams.dismiss(stream);
      } else {
        error = `本轮执行已完成，但刷新对话失败：${errorMessage(cause)}`;
      }
    }
  }

  function streamFailure(stream: AgentStreamState) {
    return {
      id: stream.operationId,
      runId: stream.runId,
      prompt: stream.prompt,
      output: stream.output,
      error: stream.error,
      createdAt: stream.completedAt || new Date().toISOString(),
    };
  }

  async function stop(): Promise<void> {
    if (!detail || action) return;
    action = 'stop';
    try {
      detail = { ...detail, ...(await stopSandboxContext(detail.id)) };
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      action = '';
    }
  }

  async function resume(): Promise<void> {
    if (!detail || action) return;
    action = 'resume';
    try {
      detail = { ...detail, ...(await resumeSandboxContext(detail.id)) };
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      action = '';
    }
  }

  function download(format: 'markdown' | 'json'): void {
    if (!detail) return;
    const content =
      format === 'json'
        ? JSON.stringify({ sandboxId: detail.id, agentName: target?.agentName, turns }, null, 2)
        : turns
            .flatMap((turn) => [
              `## ${t('用户')} · ${turn.createdAt || t('未知时间')}`,
              turn.prompt || '—',
              `## ${turn.agent || target?.agentName || t('智能体')} · Run ${turn.runId || '—'}`,
              turn.output || '—',
            ])
            .join('\n\n');
    const url = URL.createObjectURL(
      new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `conversation-${detail.id}.${format === 'json' ? 'json' : 'md'}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function filterSummaries(items: ConversationSummary[], value: string): ConversationSummary[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) =>
      `${item.title} ${item.agentName} ${item.sandboxId}`.toLowerCase().includes(normalized),
    );
  }

  function filterTurns(items: ConversationTurn[], value: string): ConversationTurn[] {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) =>
      `${item.prompt} ${item.output} ${item.runId} ${item.agent}`.toLowerCase().includes(normalized),
    );
  }

  const isRunning = (value: string): boolean => value.trim().toLowerCase() === 'running';
  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div data-page-layout="master-detail" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="对话记录" description="按 Sandbox 聚合消息与关联运行">
    {#snippet actions()}{#if detail}<CopyLinkButton /><Button
          variant="outline"
          size="sm"
          onclick={() => download('markdown')}><Download class="size-3.5" />Markdown</Button
        ><Button variant="outline" size="sm" onclick={() => download('json')}>JSON</Button>{/if}{/snippet}
  </PageHeader>
  {#if error}<div
      data-page-error
      class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive sm:mx-5 xl:mx-6"
    >
      {error}
    </div>{/if}

  <div
    class="grid min-h-0 flex-1 lg:grid-cols-[20rem_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[24rem_minmax(0,1fr)]"
  >
    <aside class="min-h-0 flex-col border-r border-border bg-card/30 lg:flex {routeSandboxId ? 'hidden' : 'flex'}">
      <div class="shrink-0 border-b border-border p-3">
        <div class="relative">
          <Search class="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <Input bind:value={query} class="pl-8" placeholder={t('搜索智能体或 Sandbox ID')} />
        </div>
      </div>
      <div data-scroll-pane class="min-h-0 flex-1 overflow-y-auto p-2">
        {#each filtered as item (item.sandboxId)}
          <button
            class="mb-1 w-full rounded-md p-3 text-left {item.sandboxId === routeSandboxId
              ? 'bg-accent'
              : 'hover:bg-accent/60'}"
            onclick={() => navigate(`/conversations/${encodeURIComponent(item.sandboxId)}`)}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{item.agentName}</span>
              <StatusBadge status={item.status} />
            </div>
            <div class="mt-1 truncate text-xs text-muted-foreground">{item.title}</div>
            <div class="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
              <span>{item.sandboxId.slice(0, 12)}</span><Timestamp value={item.updatedAt} />
            </div>
          </button>
        {:else}
          <p class="p-6 text-sm text-muted-foreground">{t(loading ? '正在加载对话记录…' : '没有匹配的对话记录')}</p>
        {/each}
      </div>
    </aside>

    <section
      class="min-h-0 min-w-0 flex-col overflow-hidden p-3 sm:p-5 lg:flex xl:p-6 {routeSandboxId ? 'flex' : 'hidden'}"
    >
      {#if detail && selectedSummary}
        <div class="mb-4 flex shrink-0 flex-wrap items-start justify-between gap-3">
          <div class="flex min-w-0 items-start gap-2">
            <Button
              variant="ghost"
              size="icon"
              class="shrink-0 lg:hidden"
              onclick={() => navigate('/conversations')}
              aria-label={t('返回')}><ArrowLeft class="size-4" /></Button
            >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="font-semibold">{selectedSummary.agentName}</h2>
                <StatusBadge status={detail.status} />
              </div>
            </div>
            <div class="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Sandbox</span><CopyableText value={detail.id} label="Sandbox ID" class="max-w-72 font-mono" />
              <span>{t('更新于')}</span><Timestamp value={detail.updatedAt} />
            </div>
          </div>
          <div class="flex w-full gap-2 sm:w-auto">
            <Input bind:value={messageQuery} class="min-w-0 flex-1 sm:w-52" placeholder={t('搜索当前对话')} />
            {#if isRunning(detail.status)}<Button variant="outline" size="sm" disabled={Boolean(action)} onclick={stop}
                >{t('停止 Sandbox')}</Button
              >{:else}<Button variant="outline" size="sm" disabled={Boolean(action)} onclick={resume}
                >{t('恢复 Sandbox')}</Button
              >{/if}
          </div>
        </div>

        <Tabs.Root value="conversation" class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Tabs.List class="shrink-0">
            <Tabs.Trigger value="conversation">{t('对话')}</Tabs.Trigger>
            <Tabs.Trigger value="runs">{t('执行记录')}</Tabs.Trigger>
            <Tabs.Trigger value="events">{t('执行动态')}</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="conversation" class="mt-4 min-h-0 flex-1 overflow-hidden">
            <RunConversation
              turns={visibleTurns}
              continuationRunId=""
              pendingPrompt={activeStream?.prompt || submittingPrompt}
              pendingOutput={activeStream?.output || ''}
              pendingRunId={activeStream?.runId || ''}
              pendingStreamState={activeStream?.statusText || (submitting ? t('正在发送…') : '')}
              sandboxId={isRunning(detail.status) && target ? detail.id : ''}
              {message}
              sending={submitting || Boolean(activeStream?.running)}
              onMessage={(value) => (message = value)}
              onSend={() => void sendMessage()}
            />
          </Tabs.Content>
          <Tabs.Content data-scroll-pane value="runs" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div class="space-y-2">
              {#each turns.filter((turn) => turn.runId) as turn (turn.runId)}
                <article class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div class="min-w-0">
                    <CopyableText value={turn.runId} label="Run ID" class="max-w-full font-mono text-xs" />
                    <div class="mt-1 text-xs text-muted-foreground">
                      <Timestamp value={turn.createdAt} mode="full" /> · {turn.success
                        ? t('完成')
                        : turn.stopReason || t('失败')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={() => navigate(`/runs/${encodeURIComponent(turn.runId)}`)}>{t('查看运行详情')}</Button
                  >
                </article>
              {:else}<p class="py-8 text-center text-sm text-muted-foreground">{t('没有可关联的 Run 记录')}</p>{/each}
            </div>
          </Tabs.Content>
          <Tabs.Content data-scroll-pane value="events" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div class="space-y-3">
              {#each events as event (event.id)}
                <article class="border-l-2 border-border pl-3">
                  <Timestamp value={event.createdAt} mode="full" class="text-xs" />
                  <div class="mt-1 text-sm font-medium">{event.type}</div>
                  {#if event.message}<pre
                      class="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{event.message}</pre>{/if}
                </article>
              {:else}<p class="py-8 text-center text-sm text-muted-foreground">{t('没有执行动态')}</p>{/each}
            </div>
          </Tabs.Content>
        </Tabs.Root>
      {:else}
        <div class="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground">
          {t(detailLoading ? '正在加载对话…' : '选择一条对话记录查看详情')}
        </div>
      {/if}
    </section>
  </div>
</div>
