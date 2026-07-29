<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import EventSessionList from '$lib/components/event-session-list.svelte';
  import EventDetailSidebar from '$lib/components/event-detail-sidebar.svelte';
  import PageHeader from '$lib/components/page-header.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import { runStreams, type AgentStreamState } from '$lib/run-stream.svelte';
  import { navigate, router } from '$lib/router.svelte';
  import {
    getAutomationRunById,
    getAutomationTask,
    getTopicEvent,
    listAutomationEvents,
    listTopicEventRuns,
    listTopicEventSessions,
    type TopicEvent,
    type TopicEventRun,
    type TopicEventSession,
  } from '../api/loaders';
  import {
    getSandboxContext,
    getSandboxRunTarget,
    listSandboxHistoryCells,
    listSandboxHistoryEvents,
    resumeSandboxContext,
    stopSandboxContext,
  } from '../api/sessions';
  import type { EventRunTrace as RunTrace, EventSessionTrace as SessionTrace } from '../model/event-detail';

  const eventId = $derived(decodeURIComponent(router.path.split('/')[2] || ''));
  let event = $state<TopicEvent | null>(null);
  let runTraces = $state<RunTrace[]>([]);
  let sessionTraces = $state<SessionTrace[]>([]);
  let drafts = $state<Record<string, string>>({});
  let sessionAction = $state('');
  let error = $state('');
  let loading = $state(true);
  let loadedEventId = '';

  const activeStreams = $derived.by(() => {
    const result: Record<string, AgentStreamState | undefined> = {};
    for (const trace of sessionTraces) {
      const sandboxId = trace.link.sessionId;
      const stream = runStreams.forSandbox(sandboxId);
      if (stream) result[sandboxId] = stream;
    }
    return result;
  });
  const pendingPrompts = $derived(mapStreamValue((stream) => stream.prompt));
  const streamOutput = $derived(mapStreamValue((stream) => stream.output));
  const streamState = $derived(mapStreamValue((stream) => stream.statusText));
  const streamFailed = $derived(mapStreamFlag((stream) => stream.phase === 'failed'));
  const sendingSessionId = $derived(Object.entries(activeStreams).find(([, stream]) => stream?.running)?.[0] ?? '');

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
      const [nextEvent, deliveries, links] = await Promise.all([
        getTopicEvent(targetEventId),
        listTopicEventRuns(targetEventId),
        listTopicEventSessions(targetEventId),
      ]);
      const nextRunTraces = await Promise.all(deliveries.map(loadRunTrace));
      const combinedLinks = uniqueSessionLinks([...links, ...inferSessionLinks(targetEventId, nextRunTraces)]);
      const nextSessionTraces = await Promise.all(combinedLinks.map(loadSessionTrace));
      event = nextEvent;
      runTraces = nextRunTraces;
      sessionTraces = nextSessionTraces.sort((left, right) => sessionTime(right) - sessionTime(left));
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function loadRunTrace(delivery: TopicEventRun): Promise<RunTrace> {
    if (!delivery.runId) return { delivery, run: null, task: null, events: [] };
    const run = await getAutomationRunById(delivery.runId).catch(() => null);
    if (!run) return { delivery, run: null, task: null, events: [] };
    const [task, events] = await Promise.all([
      getAutomationTask(run.loaderId).catch(() => null),
      listAutomationEvents(run.loaderId, 200).catch(() => []),
    ]);
    return { delivery, run, task, events: events.filter((item) => item.runId === delivery.runId) };
  }

  async function loadSessionTrace(link: TopicEventSession): Promise<SessionTrace> {
    if (!link.sessionId) return { link, session: null, cells: [], events: [] };
    const [session, cells, events, target] = await Promise.all([
      getSandboxContext(link.sessionId).catch(() => null),
      listSandboxHistoryCells(link.sessionId).catch(() => []),
      listSandboxHistoryEvents(link.sessionId).catch(() => []),
      getSandboxRunTarget(link.sessionId).catch(() => undefined),
    ]);
    return { link, session, cells, events, target };
  }

  function uniqueSessionLinks(links: TopicEventSession[]): TopicEventSession[] {
    return [...new Map(links.filter((item) => item.sessionId).map((item) => [item.sessionId, item])).values()];
  }

  function inferSessionLinks(targetEventId: string, traces: RunTrace[]): TopicEventSession[] {
    return traces.flatMap((trace) =>
      trace.events
        .filter((item) => item.linkedSessionId && (!item.topicEventId || item.topicEventId === targetEventId))
        .map((item) => ({
          sessionId: item.linkedSessionId,
          relation: item.type || 'scheduler_event',
          loaderId: item.loaderId,
          runId: item.runId,
          triggerId: item.triggerId,
          loaderEventId: item.id,
          eventId: targetEventId,
          createdAt: item.createdAt,
        })),
    );
  }

  function sessionTime(trace: SessionTrace): number {
    return Date.parse(trace.session?.updatedAt || trace.session?.createdAt || trace.link.createdAt) || 0;
  }

  function isRunning(trace: SessionTrace): boolean {
    return trace.session?.status.trim().toLowerCase() === 'running';
  }

  function updateDraft(sessionId: string, value: string): void {
    drafts = { ...drafts, [sessionId]: value };
  }

  async function refreshSession(trace: SessionTrace): Promise<SessionTrace> {
    const next = await loadSessionTrace(trace.link);
    sessionTraces = sessionTraces.map((item) => (item.link.sessionId === trace.link.sessionId ? next : item));
    return next;
  }

  async function stopSession(trace: SessionTrace): Promise<void> {
    if (!trace.link.sessionId || sessionAction) return;
    sessionAction = trace.link.sessionId;
    try {
      await stopSandboxContext(trace.link.sessionId);
      await refreshSession(trace);
      error = '';
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      sessionAction = '';
    }
  }

  async function resumeSession(trace: SessionTrace): Promise<void> {
    if (!trace.link.sessionId || sessionAction) return;
    sessionAction = trace.link.sessionId;
    try {
      await resumeSandboxContext(trace.link.sessionId);
      await refreshSession(trace);
      error = '';
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      sessionAction = '';
    }
  }

  function openNotebook(trace: SessionTrace): void {
    const url = trace.session?.notebookUrl || trace.session?.proxyPath;
    if (url) window.open(url, '_blank', 'noopener');
  }

  async function sendMessage(trace: SessionTrace): Promise<void> {
    const sessionId = trace.link.sessionId;
    const message = (drafts[sessionId] || '').trim();
    if (!sessionId || !trace.target || !message || sendingSessionId) return;
    drafts = { ...drafts, [sessionId]: '' };
    error = '';
    try {
      const stream = await runStreams.start({
        projectId: trace.target.projectId,
        agentName: trace.target.agentName,
        prompt: message,
        sandboxId: sessionId,
      });
      const refreshed = await refreshSession(trace);
      const failureRecorded = refreshed.cells.some(
        (cell) => cell.stopReason && (!stream.runId || cell.runId === stream.runId),
      );
      if (stream.phase !== 'failed' || failureRecorded) runStreams.dismiss(stream);
      error = '';
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  function mapStreamValue(select: (stream: AgentStreamState) => string): Record<string, string> {
    return Object.fromEntries(
      Object.entries(activeStreams).flatMap(([sandboxId, stream]) =>
        stream ? [[sandboxId, select(stream)] as const] : [],
      ),
    );
  }

  function mapStreamFlag(select: (stream: AgentStreamState) => boolean): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(activeStreams).flatMap(([sandboxId, stream]) =>
        stream ? [[sandboxId, select(stream)] as const] : [],
      ),
    );
  }

  function timeline(): Array<{ id: string; createdAt: string; type: string; message: string }> {
    const items = [
      ...runTraces.flatMap((trace) =>
        trace.events.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          type: item.type,
          message: item.message,
        })),
      ),
      ...sessionTraces.flatMap((trace) =>
        trace.events.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          type: item.type,
          message: item.message,
        })),
      ),
    ];
    return items.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : '请求失败');
</script>

<div data-page-layout="workbench" class="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
  <PageHeader title="事件运行结果" description={event ? `${event.topic} · ${eventId}` : eventId}>
    {#snippet actions()}<CopyLinkButton /><Button
        variant="outline"
        size="sm"
        onclick={() => void load()}
        disabled={loading}>{loading ? '刷新中…' : '刷新'}</Button
      ><Button variant="outline" size="sm" onclick={() => navigate('/events')}>返回事件中心</Button>{/snippet}
  </PageHeader>

  <PageContent class="flex min-h-0 flex-1 flex-col space-y-4 lg:overflow-hidden">
    {#if error}<div data-page-error class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>{/if}
    {#if loading && !event}
      <p class="text-sm text-muted-foreground">正在加载事件运行结果…</p>
    {:else if event}
      <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <section class="rounded-lg border border-border bg-card p-4">
          <div class="text-xs text-muted-foreground">投递状态</div>
          <div class="mt-1">
            <StatusBadge status={event.dispatchStatus || 'pending'} label={event.dispatchStatus || 'pending'} />
          </div>
        </section>
        <section class="rounded-lg border border-border bg-card p-4">
          <div class="text-xs text-muted-foreground">序号</div>
          <div class="mt-1 font-mono font-medium">#{event.sequence}</div>
        </section>
        <section class="rounded-lg border border-border bg-card p-4">
          <div class="text-xs text-muted-foreground">历史任务</div>
          <div class="mt-1 font-medium">{runTraces.length}</div>
        </section>
        <section class="rounded-lg border border-border bg-card p-4">
          <div class="text-xs text-muted-foreground">关联对话</div>
          <div class="mt-1 font-medium">{sessionTraces.length}</div>
        </section>
      </div>

      <div
        class="grid min-h-0 gap-4 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_20rem] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_25rem]"
      >
        <div class="min-h-0">
          <EventSessionList
            traces={sessionTraces}
            {drafts}
            {pendingPrompts}
            {streamOutput}
            {streamState}
            {streamFailed}
            {sendingSessionId}
            {sessionAction}
            {isRunning}
            onDraft={updateDraft}
            onSend={(trace) => void sendMessage(trace)}
            onStop={(trace) => void stopSession(trace)}
            onResume={(trace) => void resumeSession(trace)}
            onOpenNotebook={openNotebook}
          />
        </div>

        <EventDetailSidebar {event} {runTraces} timeline={timeline()} />
      </div>
    {/if}
  </PageContent>
</div>
