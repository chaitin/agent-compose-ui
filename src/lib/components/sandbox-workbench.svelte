<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import AgentRecordsPanel from '$lib/components/agent-records-panel.svelte';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import SandboxConversation from '$lib/components/sandbox-conversation.svelte';
  import SandboxLogRuns from '$lib/components/sandbox-log-runs.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import XtermView from '$lib/components/xterm-view.svelte';
  import { runStreams, type AgentStreamState } from '$lib/run-stream.svelte';
  import { t } from '$lib/i18n.svelte';
  import { openInteractiveTerminal, type InteractiveTerminal } from '../../api/exec';
  import {
    getSandboxContext,
    listSandboxExecutionEvents,
    listSandboxHistoryCells,
    resumeSandboxContext,
    stopSandboxContext,
    watchSandbox,
    type SandboxContextDetail,
    type SandboxRunTarget,
  } from '../../api/sessions';
  import { listRuns } from '../../api/runs';
  import {
    RunEventKind,
    SandboxWatchEventType,
    type RunEvent,
    type RunSummary,
    type WatchSandboxResponse,
  } from '../../gen/agentcompose/v2/agentcompose_pb.js';
  import { compactIdentifier } from '../../model/identifiers';
  import { jupyterEntryHref } from '../../model/jupyter';
  import { stoppedRuntimePresentation } from '../../model/stopped-runtime';
  import { conversationTurns, type ConversationTurn } from '../../model/conversation';
  import ExternalLink from '@lucide/svelte/icons/external-link';

  let {
    sandboxId,
    initialTab,
    embedded = false,
    contextLog = '',
  }: {
    sandboxId: string;
    initialTab?: 'conversation' | 'logs' | 'records' | 'terminal';
    embedded?: boolean;
    contextLog?: string;
  } = $props();

  let sandbox = $state<SandboxContextDetail | null>(null);
  let runs = $state<RunSummary[]>([]);
  let conversationRuns = $state<RunSummary[]>([]);
  let events = $state<RunEvent[]>([]);
  let turns = $state<ConversationTurn[]>([]);
  let target = $state<SandboxRunTarget | undefined>();
  let selectedTargetKey = $state('');
  let tab = $state<'conversation' | 'logs' | 'records' | 'terminal'>('logs');
  let loading = $state(true);
  let action = $state('');
  let error = $state('');
  let message = $state('');
  let submitting = $state(false);
  let loadedSandboxId = '';
  let finalizedOperationId = '';
  let terminal = $state<InteractiveTerminal | null>(null);
  let terminalState = $state('未连接');
  let terminalError = $state('');
  let terminalLines = $state<string[]>([]);
  let terminalConnectionVersion = 0;
  let terminalAutoKey = '';
  let terminalAutoAttempts = 0;
  let terminalRetryTimer: number | undefined;
  let contextLogQuery = $state('');
  let liveContextLog = $state('');
  let discoveringRuns = false;

  const activeStream = $derived(runStreams.forSandbox(sandboxId));
  const hasConversation = $derived(conversationRuns.length > 0 || Boolean(activeStream?.prompt));
  const combinedContextLog = $derived([contextLog.trimEnd(), liveContextLog.trimEnd()].filter(Boolean).join('\n'));
  const visibleContextLog = $derived(
    contextLogQuery.trim()
      ? combinedContextLog
          .split('\n')
          .filter((line) => line.toLowerCase().includes(contextLogQuery.toLowerCase()))
          .join('\n')
      : combinedContextLog,
  );
  const contextLogLineCount = $derived(combinedContextLog ? combinedContextLog.split('\n').length : 0);
  const targets = $derived.by(() => {
    const values = runs
      .filter((run) => run.projectId && run.agentName)
      .map((run) => ({ projectId: run.projectId, agentName: run.agentName }));
    if (target) values.unshift(target);
    return [...new Map(values.map((value) => [targetKey(value), value])).values()];
  });
  const selectedTarget = $derived(
    targets.find((item) => targetKey(item) === selectedTargetKey) ?? targets[0] ?? target,
  );
  const jupyterHref = $derived(jupyterEntryHref(sandbox));
  const normalizedStatus = $derived(sandbox?.status.trim().toLowerCase() ?? '');
  const runnable = $derived(normalizedStatus === 'running');
  const resumable = $derived(normalizedStatus === 'stopped');
  const terminalAvailable = $derived(normalizedStatus !== 'failed' && normalizedStatus !== 'deleting');
  const stoppedRuntime = $derived(sandbox ? stoppedRuntimePresentation(sandbox) : null);

  onMount(() => () => {
    window.clearTimeout(terminalRetryTimer);
    terminalConnectionVersion += 1;
    terminal?.close();
  });

  $effect(() => {
    const targetSandboxId = sandboxId;
    if (targetSandboxId && targetSandboxId !== loadedSandboxId) {
      loadedSandboxId = targetSandboxId;
      liveContextLog = '';
      void load(targetSandboxId);
    }
  });

  $effect(() => {
    const watchedSandboxId = sandboxId;
    if (!watchedSandboxId) return;
    const controller = new AbortController();
    void watchSandbox(
      watchedSandboxId,
      (event) => handleSandboxWatchEvent(watchedSandboxId, event),
      controller.signal,
    ).catch((cause) => {
      if (!controller.signal.aborted) console.warn('sandbox subscription disconnected', cause);
    });
    return () => controller.abort();
  });

  $effect(() => {
    const stream = activeStream;
    if (stream && !stream.running && stream.operationId !== finalizedOperationId) {
      finalizedOperationId = stream.operationId;
      void finalizeStream(stream);
    }
  });

  $effect(() => {
    const key = tab === 'terminal' && runnable && sandbox ? sandboxId : '';
    if (key && key !== terminalAutoKey) {
      terminalAutoKey = key;
      terminalAutoAttempts = 0;
      queueMicrotask(() => connectTerminal(true));
    } else if (!key) {
      terminalAutoKey = '';
      terminalAutoAttempts = 0;
      window.clearTimeout(terminalRetryTimer);
    }
  });

  async function load(targetSandboxId: string): Promise<void> {
    loading = true;
    error = '';
    resetTerminal();
    try {
      const [nextSandbox, nextRuns, nextEvents, cells] = await Promise.all([
        getSandboxContext(targetSandboxId),
        listRuns({ sandboxId: targetSandboxId, limit: 200 }),
        listSandboxExecutionEvents(targetSandboxId),
        listSandboxHistoryCells(targetSandboxId),
      ]);
      if (loadedSandboxId !== targetSandboxId) return;
      const nextTarget = firstTarget(nextRuns) ?? sandboxTarget(nextSandbox);
      sandbox = nextSandbox;
      const nextTurns = conversationTurns(cells);
      const nextConversationRuns = conversationRunsFor(nextRuns, nextEvents, nextTurns);
      runs = nextRuns;
      conversationRuns = nextConversationRuns;
      events = nextEvents;
      turns = nextTurns;
      target = nextTarget;
      selectedTargetKey = targetKey(nextTarget ?? firstTarget(nextRuns));
      const conversationAvailable = nextConversationRuns.length > 0;
      const logsAvailable = nextRuns.length > 0 || Boolean(combinedContextLog.trim());
      tab =
        initialTab === 'records'
          ? 'records'
          : initialTab === 'terminal'
            ? 'terminal'
            : initialTab === 'conversation' && conversationAvailable
              ? 'conversation'
              : initialTab === 'logs' && logsAvailable
                ? 'logs'
                : conversationAvailable
                  ? 'conversation'
                  : 'logs';
    } catch (cause) {
      if (loadedSandboxId !== targetSandboxId) return;
      error = errorMessage(cause);
      sandbox = null;
      runs = [];
      conversationRuns = [];
      events = [];
      turns = [];
    } finally {
      if (loadedSandboxId === targetSandboxId) loading = false;
    }
  }

  function handleSandboxWatchEvent(watchedSandboxId: string, event: WatchSandboxResponse): void {
    if (watchedSandboxId !== sandboxId) return;
    if (event.eventType === SandboxWatchEventType.CELL_OUTPUT && event.chunk) {
      liveContextLog += event.chunk;
      return;
    }
    if (event.eventType === SandboxWatchEventType.CELL_STARTED) {
      void discoverRunsFromWatch(watchedSandboxId, false);
      return;
    }
    if (event.eventType === SandboxWatchEventType.CELL_COMPLETED) {
      void discoverRunsFromWatch(watchedSandboxId, true);
    }
  }

  async function discoverRunsFromWatch(watchedSandboxId: string, refreshCompletedState: boolean): Promise<void> {
    if (discoveringRuns) return;
    discoveringRuns = true;
    try {
      const [nextRuns, nextEvents] = await Promise.all([
        listRuns({ sandboxId: watchedSandboxId, limit: 200 }),
        listSandboxExecutionEvents(watchedSandboxId),
      ]);
      if (watchedSandboxId !== sandboxId) return;
      runs = nextRuns;
      events = nextEvents;
      conversationRuns = conversationRunsFor(nextRuns, nextEvents, turns);
      if (refreshCompletedState) sandbox = await getSandboxContext(watchedSandboxId);
    } catch (cause) {
      console.warn('refresh runs after sandbox event failed', cause);
    } finally {
      discoveringRuns = false;
    }
  }

  async function sendMessage(): Promise<void> {
    const prompt = message.trim();
    if (!prompt || !selectedTarget || !runnable || submitting || activeStream?.running) return;
    message = '';
    error = '';
    submitting = true;
    tab = 'conversation';
    try {
      await runStreams.start({ ...selectedTarget, prompt, sandboxId });
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      submitting = false;
    }
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void sendMessage();
  }

  function cancelActiveStream(): void {
    if (activeStream?.running) runStreams.cancel(activeStream);
  }

  async function finalizeStream(stream: AgentStreamState): Promise<void> {
    try {
      const [nextRuns, nextEvents, cells, nextSandbox] = await Promise.all([
        listRuns({ sandboxId, limit: 200 }),
        listSandboxExecutionEvents(sandboxId),
        listSandboxHistoryCells(sandboxId),
        getSandboxContext(sandboxId),
      ]);
      const nextTurns = conversationTurns(cells);
      const nextConversationRuns = conversationRunsFor(nextRuns, nextEvents, nextTurns);
      runs = nextRuns;
      conversationRuns = nextConversationRuns;
      events = nextEvents;
      turns = nextTurns;
      sandbox = nextSandbox;
      if (activeStream?.prompt) tab = 'conversation';
      error = '';
    } catch (cause) {
      error = t('本轮执行已完成，但刷新运行失败：{error}', { error: errorMessage(cause) });
    } finally {
      if (stream.phase !== 'failed') runStreams.dismiss(stream);
    }
  }

  async function stop(): Promise<void> {
    if (!sandbox || action) return;
    action = 'stop';
    try {
      sandbox = { ...sandbox, ...(await stopSandboxContext(sandboxId)) };
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      action = '';
    }
  }

  async function resume(): Promise<void> {
    if (!sandbox || action) return;
    action = 'resume';
    try {
      sandbox = { ...sandbox, ...(await resumeSandboxContext(sandboxId)) };
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      action = '';
    }
  }

  function connectTerminal(automatic = false): void {
    if (!sandbox || terminal) return;
    window.clearTimeout(terminalRetryTimer);
    if (automatic) terminalAutoAttempts += 1;
    terminalError = '';
    terminalLines = [];
    terminalState = t('连接中');
    const version = ++terminalConnectionVersion;
    let connection: InteractiveTerminal | null = null;
    connection = openInteractiveTerminal(sandboxId, {
      onData: (data) => (terminalLines = [...terminalLines, data]),
      onState: (state) => {
        terminalState = t(state);
        if (state === '已连接') terminalError = '';
      },
      onError: (messageText) => {
        if (version !== terminalConnectionVersion) return;
        const retry = automatic && terminalAutoAttempts < 2 && tab === 'terminal' && runnable;
        terminalConnectionVersion += 1;
        connection?.close();
        terminal = null;
        terminalError = messageText;
        terminalState = t(retry ? '正在重试' : '连接失败');
        if (retry) terminalRetryTimer = window.setTimeout(() => connectTerminal(true), 600);
      },
      onClose: () => {
        if (version === terminalConnectionVersion) terminal = null;
      },
    });
    terminal = connection;
  }

  function resetTerminal(): void {
    window.clearTimeout(terminalRetryTimer);
    terminalConnectionVersion += 1;
    terminal?.close();
    terminal = null;
    terminalState = t('未连接');
    terminalError = '';
    terminalLines = [];
  }

  function downloadContextLog(): void {
    const url = URL.createObjectURL(new Blob([combinedContextLog], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sandbox-${compactIdentifier(sandboxId)}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function firstTarget(items: RunSummary[]): SandboxRunTarget | undefined {
    const run = items.find((item) => item.projectId && item.agentName);
    return run ? { projectId: run.projectId, agentName: run.agentName } : undefined;
  }

  function sandboxTarget(value: SandboxContextDetail): SandboxRunTarget | undefined {
    return value.projectId && value.agentName ? { projectId: value.projectId, agentName: value.agentName } : undefined;
  }

  function targetKey(value: SandboxRunTarget | undefined): string {
    return value ? `${value.projectId}\u0000${value.agentName}` : '';
  }

  function conversationRunsFor(
    items: RunSummary[],
    runEvents: RunEvent[],
    conversationHistory: ConversationTurn[],
  ): RunSummary[] {
    const ids = new Set(
      [
        ...runEvents
          .filter((event) => event.kind === RunEventKind.USER_MESSAGE || event.kind === RunEventKind.AGENT_MESSAGE)
          .map((event) => event.runId),
        ...conversationHistory.map((turn) => turn.runId),
      ].filter(Boolean),
    );
    return items.filter((run) => ids.has(run.runId));
  }

  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<section data-sandbox-workbench class="flex min-h-0 min-w-0 flex-1 flex-col {embedded ? 'h-full' : ''}">
  {#if error}<div data-page-error class="mb-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>{/if}
  {#if loading}
    <div class="flex min-h-48 flex-1 items-center justify-center text-sm text-muted-foreground">
      {t('正在加载执行环境…')}
    </div>
  {:else if sandbox}
    <div
      data-page-header={!embedded ? '' : undefined}
      data-sandbox-context-bar
      class="flex shrink-0 flex-wrap items-center justify-between gap-2 {embedded
        ? 'mb-2'
        : 'mb-3 rounded-lg border border-border bg-card px-3 py-2'}"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 class="truncate text-sm font-semibold">{sandbox.agentName || sandbox.title || t('执行环境')}</h2>
        <StatusBadge status={sandbox.status} />
        <span class="truncate text-xs text-muted-foreground"
          >{runs[0]?.projectName || (sandbox.projectId ? compactIdentifier(sandbox.projectId) : t('未关联项目'))}</span
        ><CopyableText
          value={sandbox.id}
          display={compactIdentifier(sandbox.id)}
          label="执行环境 ID"
          class="font-mono text-xs text-muted-foreground"
        /><Timestamp value={sandbox.updatedAt} class="hidden text-xs text-muted-foreground sm:inline" />
      </div>
      {#if runnable || resumable || jupyterHref || !embedded}<div
          data-sandbox-actions
          class="flex w-full shrink-0 flex-wrap justify-end gap-2 sm:w-auto"
        >
          {#if runnable}<Button variant="outline" size="sm" disabled={Boolean(action)} onclick={stop}
              >{t('停止')}</Button
            >{:else if resumable}<Button class="w-full sm:w-auto" size="sm" disabled={Boolean(action)} onclick={resume}
              >{t('恢复')}</Button
            >{/if}
          {#if jupyterHref}<Button
              variant="outline"
              size="sm"
              href={jupyterHref}
              target="_blank"
              rel="noopener noreferrer">Jupyter <ExternalLink class="size-3.5" /></Button
            >{/if}
          {#if !embedded}<CopyLinkButton />{/if}
        </div>{/if}
    </div>

    {#if stoppedRuntime}<div
        data-stopped-runtime-state
        class="mb-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs {stoppedRuntime.status ===
        'failed'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : stoppedRuntime.status === 'pending'
            ? 'border-warning/30 bg-warning/10'
            : 'border-border bg-muted/40 text-muted-foreground'}"
      >
        <StatusBadge status={stoppedRuntime.status} label={stoppedRuntime.label} />
        <span class="min-w-0 break-words">
          {stoppedRuntime.status === 'failed' ? stoppedRuntime.description : t(stoppedRuntime.description)}
        </span>
        {#if sandbox.stoppedRuntimeReleasedAt}<Timestamp
            value={sandbox.stoppedRuntimeReleasedAt}
            class="ml-auto"
          />{/if}
      </div>{/if}

    {#if !embedded}<details class="mb-3 shrink-0 rounded-md border border-border bg-card px-3 py-2 text-xs">
        <summary class="cursor-pointer text-muted-foreground">{t('环境信息')}</summary>
        <dl class="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt class="text-muted-foreground">{t('运行方式')}</dt>
            <dd class="mt-1">{sandbox.driver || '—'}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{t('镜像')}</dt>
            <dd class="mt-1 break-all">{sandbox.guestImage || '—'}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{t('创建时间')}</dt>
            <dd class="mt-1"><Timestamp value={sandbox.createdAt} mode="full" /></dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{t('工作目录')}</dt>
            <dd class="mt-1 break-all font-mono">{sandbox.workspacePath || '—'}</dd>
          </div>
        </dl>
      </details>{/if}

    <Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Tabs.List data-tab-scroll class="shrink-0 justify-start">
        {#if hasConversation || runnable}<Tabs.Trigger value="conversation">{t('对话')}</Tabs.Trigger>{/if}
        {#if runs.length || combinedContextLog}<Tabs.Trigger value="logs">{t('运行日志')}</Tabs.Trigger>{/if}
        <Tabs.Trigger value="records">{t('智能体记录')}</Tabs.Trigger>
        {#if terminalAvailable}<Tabs.Trigger value="terminal">{t('终端')}</Tabs.Trigger>{/if}
      </Tabs.List>

      <Tabs.Content value="conversation" class="mt-3 min-h-0 flex-1 overflow-hidden">
        <SandboxConversation runs={conversationRuns} {events} {turns} {activeStream} />
      </Tabs.Content>
      <Tabs.Content value="logs" class="mt-3 min-h-0 flex-1 overflow-hidden">
        {#if runs.length}<SandboxLogRuns {sandboxId} {runs} {events} {activeStream} />
        {:else}<RunLogViewer
            query={contextLogQuery}
            content={visibleContextLog}
            lineCount={contextLogLineCount}
            onQuery={(value) => (contextLogQuery = value)}
            onDownload={downloadContextLog}
          />{/if}
      </Tabs.Content>
      <Tabs.Content value="records" class="mt-3 min-h-0 flex-1 overflow-hidden">
        <AgentRecordsPanel {sandboxId} active={tab === 'records'} />
      </Tabs.Content>

      <Tabs.Content value="terminal" class="mt-3 min-h-0 flex-1 overflow-hidden">
        <div
          data-terminal-panel
          class="flex h-full min-h-[22rem] flex-col overflow-hidden rounded-lg border border-border bg-[#121722]"
        >
          <div
            class="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-white/70"
          >
            <span>{terminalState}</span>{#if runnable && !terminal}<Button
                variant="outline"
                size="sm"
                onclick={() => connectTerminal(false)}
                >{t(terminalState === t('连接失败') ? '重新连接' : '连接')}</Button
              >{:else if !runnable}<span>{t('恢复后可连接')}</span>{/if}
          </div>
          {#if terminalError}<div
              class="shrink-0 border-b border-red-300/15 bg-red-500/10 px-3 py-2 text-xs text-red-100"
            >
              {terminalError}
            </div>{/if}
          <div class="min-h-0 flex-1 p-2">
            <XtermView
              lines={terminalLines}
              fontSize={15}
              interactive
              onData={(data) => terminal?.send(data)}
              onResize={(cols, rows) => terminal?.resize(cols, rows)}
            />
          </div>
        </div>
      </Tabs.Content>
    </Tabs.Root>

    {#if tab === 'conversation' && runnable && selectedTarget}<div
        data-composer
        class="mt-3 flex shrink-0 flex-col gap-2 sm:flex-row"
      >
        {#if targets.length > 1}<select
            bind:value={selectedTargetKey}
            aria-label={t('继续运行的智能体')}
            class="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >{#each targets as item (targetKey(item))}<option value={targetKey(item)}>{item.agentName}</option
              >{/each}</select
          >{/if}
        <Textarea
          bind:value={message}
          class="max-h-40 min-h-10 resize-none py-2"
          rows={1}
          placeholder={t('输入消息，Shift + Enter 换行')}
          disabled={submitting || Boolean(activeStream?.running)}
          onkeydown={handleComposerKeydown}
        />
        <Button
          class="sm:shrink-0"
          variant={activeStream?.running ? 'outline' : 'default'}
          disabled={!activeStream?.running && (!message.trim() || submitting)}
          onclick={() => (activeStream?.running ? cancelActiveStream() : void sendMessage())}
          >{t(activeStream?.running ? '取消本轮' : '发送')}</Button
        >
      </div>{/if}
  {/if}
</section>
