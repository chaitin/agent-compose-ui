<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import EventExecutionOverview from '$lib/components/event-execution-overview.svelte';
  import EventDetailSidebar from '$lib/components/event-detail-sidebar.svelte';
  import SandboxWorkbench from '$lib/components/sandbox-workbench.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { router } from '$lib/router.svelte';
  import { getTopicEventTrace, type TopicEvent, type TopicEventTraceSandbox } from '../api/loaders';
  import type { EventRunTrace as RunTrace } from '../model/event-detail';
  import { dispatchStatus } from '../model/event-status';
  import { compactIdentifier } from '../model/identifiers';
  import { t } from '$lib/i18n.svelte';

  let { canWrite = true }: { canWrite?: boolean } = $props();

  const eventId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  let event = $state<TopicEvent | null>(null);
  let runTraces = $state<RunTrace[]>([]);
  let linkedSandboxes = $state<TopicEventTraceSandbox[]>([]);
  let traceTruncated = $state(false);
  let selectedSandboxId = $state('');
  let error = $state('');
  let loading = $state(true);
  let loadedEventId = '';
  const eventStatus = $derived(event ? dispatchStatus(event.dispatchStatus) : null);

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
    traceTruncated = false;
    try {
      const trace = await getTopicEventTrace(targetEventId);
      event = trace.event;
      runTraces = trace.runs;
      linkedSandboxes = uniqueSandboxes(trace.sandboxes);
      traceTruncated = trace.descendantsTruncated;
      if (!linkedSandboxes.some((item) => item.link.sandboxId === selectedSandboxId))
        selectedSandboxId = linkedSandboxes[0]?.link.sandboxId ?? '';
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  function sandboxTime(item: TopicEventTraceSandbox): number {
    return Date.parse(item.sandbox?.updatedAt || item.sandbox?.createdAt || item.link.createdAt) || 0;
  }

  function uniqueSandboxes(items: TopicEventTraceSandbox[]): TopicEventTraceSandbox[] {
    const seen: string[] = [];
    return [...items]
      .sort((left, right) => sandboxTime(right) - sandboxTime(left))
      .filter((item) => {
        const id = item.link.sandboxId;
        if (!id || seen.includes(id)) return false;
        seen.push(id);
        return true;
      });
  }

  function timeline(): Array<{ id: string; createdAt: string; type: string; message: string }> {
    return runTraces
      .flatMap((trace) =>
        trace.events.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          type: item.type,
          message: item.message,
        })),
      )
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  function sandboxLog(sandboxId: string): string {
    return runTraces
      .filter((trace) => trace.events.some((item) => item.linkedSessionId === sandboxId))
      .flatMap((trace) => trace.events)
      .map((item) => `[${item.createdAt}] ${item.type}${item.message ? `\n${item.message}` : ''}`)
      .join('\n');
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<div data-page-layout="workbench" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="Webhook 事件详情" compact>
    {#snippet meta()}
      {#if event && eventStatus}
        <span class="max-w-72 truncate font-mono text-xs text-muted-foreground" title={event.topic}>{event.topic}</span>
        <CopyableText value={eventId} display={compactIdentifier(eventId)} label="Event ID" class="font-mono text-xs" />
        <StatusBadge status={eventStatus.semantic} label={eventStatus.label} />
        <Timestamp value={event.createdAt} class="text-xs text-muted-foreground" />
        <span class="text-xs text-muted-foreground">{runTraces.length} {t('次执行')}</span>
        <span class="text-xs text-muted-foreground">{linkedSandboxes.length} {t('个环境')}</span>
      {/if}
    {/snippet}
    {#snippet actions()}<CopyLinkButton /><Button
        variant="outline"
        size="sm"
        onclick={() => void load()}
        disabled={loading}>{t(loading ? '刷新中…' : '刷新')}</Button
      >{/snippet}
  </PageHeader>

  <PageContent compact class="flex min-h-0 flex-1 flex-col space-y-2 lg:overflow-hidden">
    {#if error}<div data-page-error class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
    {#if traceTruncated}<div class="rounded-md bg-warning/10 p-3 text-sm text-warning-foreground">
        {t('事件因果链过长，当前只显示前 1000 个关联事件的追踪结果')}
      </div>{/if}
    {#if loading && !event}<p class="text-sm text-muted-foreground">{t('正在加载事件详情…')}</p>
    {:else if event}
      {#if linkedSandboxes.length}
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          {#if linkedSandboxes.length > 1}<div
              data-sandbox-selector="desktop"
              class="hidden shrink-0 gap-2 overflow-x-auto pb-1 sm:flex"
            >
              {#each linkedSandboxes as item (item.link.sandboxId)}<Button
                  size="sm"
                  variant={item.link.sandboxId === selectedSandboxId ? 'default' : 'outline'}
                  aria-pressed={item.link.sandboxId === selectedSandboxId}
                  data-sandbox-id={item.link.sandboxId}
                  onclick={() => (selectedSandboxId = item.link.sandboxId)}
                  >{item.sandbox?.agentName || item.sandbox?.title || t('执行环境')} · {compactIdentifier(
                    item.link.sandboxId,
                  )}</Button
                >{/each}
            </div>
            <select
              data-sandbox-selector="mobile"
              aria-label={t('关联执行环境')}
              bind:value={selectedSandboxId}
              class="h-9 w-full shrink-0 rounded-md border border-input bg-background px-3 text-sm sm:hidden"
            >
              {#each linkedSandboxes as item (item.link.sandboxId)}<option value={item.link.sandboxId}
                  >{item.sandbox?.agentName || item.sandbox?.title || t('执行环境')} · {compactIdentifier(
                    item.link.sandboxId,
                  )}</option
                >{/each}
            </select>{/if}
          <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div data-selected-sandbox-id={selectedSandboxId} class="min-h-0">
              {#key selectedSandboxId}<SandboxWorkbench
                  sandboxId={selectedSandboxId}
                  contextLog={sandboxLog(selectedSandboxId)}
                  {canWrite}
                  embedded
                />{/key}
            </div>
            <EventDetailSidebar {event} {runTraces} timeline={timeline()} />
          </div>
        </div>
      {:else}<EventExecutionOverview {event} {runTraces} timeline={timeline()} />{/if}
    {/if}
  </PageContent>
</div>
