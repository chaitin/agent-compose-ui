<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import RunConversation from '$lib/components/run-conversation.svelte';
  import RunLogPanel from '$lib/components/run-log-panel.svelte';
  import AgentRecordsPanel from '$lib/components/agent-records-panel.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import RunSandboxSummary from '$lib/components/run-sandbox-summary.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { runStreams, type AgentStreamState } from '$lib/run-stream.svelte';
  import XtermView from '$lib/components/xterm-view.svelte';
  import { navigate, router, matchDetail } from '$lib/router.svelte';
  import { openInteractiveTerminal, type InteractiveTerminal } from '../api/exec';
  import { getRun, listRunEvents, runStatusName, stopRun } from '../api/runs';
  import RunActivityList from '$lib/components/runs/run-activity-list.svelte';
  import {
    getSandboxContext,
    listSandboxHistoryCells,
    refreshSandboxHistoryCells,
    resumeSandboxContext,
    type SandboxContextDetail,
  } from '../api/sessions';
  import { RunStatus, type RunDetail } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { presentAgentOutput } from '../model/agent-output';
  import {
    RUN_STATE_LABEL,
    runDuration,
    runSourceLabel,
    runStartedAt,
    runActivities,
    runState,
    runTriggerDetail,
    type RunActivity,
  } from '../model/run-list';
  import { compactIdentifier } from '../model/identifiers';
  import {
    conversationTurns as buildConversationTurns,
    withFailedConversationTurn,
    type ConversationTurn,
  } from '../model/conversation';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import Minus from '@lucide/svelte/icons/minus';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import Plus from '@lucide/svelte/icons/plus';
  import Square from '@lucide/svelte/icons/square';
  import { t } from '$lib/i18n.svelte';
  import { jupyterEntryHref } from '../model/jupyter';

  const runId = $derived(matchDetail('/runs', router.path) ?? '');
  let detail = $state<RunDetail | null>(null);
  let sandbox = $state<SandboxContextDetail | null>(null);
  let tab = $state(router.path.endsWith('/terminal') ? 'terminal' : 'logs');
  let shellLines = $state<string[]>([]);
  let terminalState = $state(t('未连接'));
  let terminalFontSize = $state(15);
  let terminalExpanded = $state(false);
  let terminal = $state<InteractiveTerminal | null>(null);
  let terminalConnectionVersion = 0;
  let message = $state('');
  let sending = $state(false);
  let conversationTurns = $state<ConversationTurn[]>([]);
  let continuationRunId = $state('');
  let loading = $state(true);
  let error = $state('');
  let statusPollTimer: number | undefined;
  let loadedRunId = '';
  let loadVersion = 0;
  let finalizedOperationId = '';

  const summary = $derived(detail?.summary);
  // 运行事件（活动、状态、消息）只在打开「活动」页签时加载；运行中每次轮询到状态变化会重新取。
  let activities = $state<RunActivity[]>([]);
  let activitiesLoading = $state(false);
  let activitiesFor = '';

  $effect(() => {
    if (tab !== 'activity' || !summary) return;
    const key = `${summary.runId}:${summary.status}`;
    if (key === activitiesFor) return;
    activitiesFor = key;
    const runId = summary.runId;
    activitiesLoading = true;
    listRunEvents(runId)
      .then((events) => {
        if (runId === summary?.runId) activities = runActivities(events);
      })
      .catch((cause) => (error = errorMessage(cause)))
      .finally(() => (activitiesLoading = false));
  });

  const runStream = $derived(runStreams.forRun(runId));
  const sandboxStream = $derived(summary?.sandboxId ? runStreams.forSandbox(summary.sandboxId) : undefined);
  const activeStream = $derived(
    sandboxStream?.running ? sandboxStream : runStream?.running ? runStream : (sandboxStream ?? runStream),
  );
  const jupyterHref = $derived(jupyterEntryHref(sandbox));

  $effect(() => {
    const targetRunId = runId;
    if (targetRunId && targetRunId !== loadedRunId) {
      loadedRunId = targetRunId;
      void load(targetRunId);
    }
  });

  $effect(() => {
    const stream = activeStream;
    if (stream && !stream.running && stream.operationId !== finalizedOperationId) {
      finalizedOperationId = stream.operationId;
      void finalizeStream(stream);
    }
  });

  onMount(() => {
    return () => {
      window.clearTimeout(statusPollTimer);
      terminalConnectionVersion += 1;
      terminal?.close();
    };
  });

  async function load(targetRunId: string): Promise<void> {
    const version = ++loadVersion;
    loading = true;
    error = '';
    tab = router.path.endsWith('/terminal') ? 'terminal' : 'logs';
    window.clearTimeout(statusPollTimer);
    terminalConnectionVersion += 1;
    terminal?.close();
    terminal = null;
    terminalState = t('未连接');
    shellLines = [];
    sandbox = null;
    detail = null;
    continuationRunId = '';
    conversationTurns = [];
    try {
      const nextDetail = await getRun(targetRunId);
      if (version !== loadVersion) return;
      detail = nextDetail;
      const sandboxId = nextDetail.summary?.sandboxId ?? '';
      if (sandboxId) {
        try {
          sandbox = await getSandboxContext(sandboxId);
        } catch {
          sandbox = null;
        }
      }
      if (version !== loadVersion) return;
      conversationTurns = [fallbackConversationTurn(targetRunId, nextDetail)];
      loading = false;
      if (tab === 'terminal' && sandbox) connectShell();
      if (sandboxId) void loadConversationHistory(sandboxId, targetRunId, version);
      scheduleStatusPoll(targetRunId, version);
    } catch (cause) {
      if (version === loadVersion) error = errorMessage(cause);
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  function scheduleStatusPoll(targetRunId: string, version: number): void {
    window.clearTimeout(statusPollTimer);
    if (!isActiveRunStatus(detail?.summary?.status)) return;
    statusPollTimer = window.setTimeout(() => void pollRunStatus(targetRunId, version), 1_000);
  }

  async function pollRunStatus(targetRunId: string, version: number): Promise<void> {
    try {
      const nextDetail = await getRun(targetRunId);
      if (version !== loadVersion || targetRunId !== runId) return;
      detail = nextDetail;
      if (isActiveRunStatus(nextDetail.summary?.status)) {
        scheduleStatusPoll(targetRunId, version);
        return;
      }
      const sandboxId = nextDetail.summary?.sandboxId ?? '';
      if (sandboxId) conversationTurns = buildConversationTurns(await refreshSandboxHistoryCells(sandboxId));
    } catch {
      if (version === loadVersion && targetRunId === runId) scheduleStatusPoll(targetRunId, version);
    }
  }

  function isActiveRunStatus(status: RunStatus | undefined): boolean {
    return status === RunStatus.PENDING || status === RunStatus.RUNNING;
  }

  async function loadConversationHistory(sandboxId: string, targetRunId: string, version: number): Promise<void> {
    try {
      const turns = buildConversationTurns(await listSandboxHistoryCells(sandboxId));
      if (version === loadVersion && turns.length) conversationTurns = turns;
    } catch {
      if (version === loadVersion && !conversationTurns.length && detail)
        conversationTurns = [fallbackConversationTurn(targetRunId, detail)];
    }
  }

  function fallbackConversationTurn(targetRunId: string, value: RunDetail): ConversationTurn {
    return {
      id: targetRunId,
      runId: targetRunId,
      prompt: value.prompt,
      output: presentAgentOutput(value.output),
      createdAt: '',
    };
  }

  function selectTab(value: string): void {
    tab = value;
    if (value === 'terminal') {
      navigate(`/runs/${encodeURIComponent(runId)}/terminal`);
      if (sandbox && !terminal) connectShell();
    } else {
      terminalExpanded = false;
      if (router.path.endsWith('/terminal')) navigate(`/runs/${encodeURIComponent(runId)}`);
    }
  }

  function connectShell(): void {
    if (!summary?.sandboxId || terminal) return;
    shellLines = [];
    error = '';
    const connectionVersion = ++terminalConnectionVersion;
    let connection: InteractiveTerminal | null = null;
    connection = openInteractiveTerminal(summary.sandboxId, {
      onData: (data) => {
        shellLines = [...shellLines, data];
      },
      onState: (state) => {
        terminalState = state;
      },
      onError: (messageText) => {
        if (terminalConnectionVersion !== connectionVersion) return;
        terminalState = t('连接失败');
        error = `PTY：${messageText}`;
        connection?.close();
        terminal = null;
      },
      onClose: () => {
        if (terminalConnectionVersion === connectionVersion) terminal = null;
      },
    });
    terminal = connection;
  }

  function adjustTerminalFont(delta: number): void {
    terminalFontSize = Math.min(20, Math.max(12, terminalFontSize + delta));
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && terminalExpanded) terminalExpanded = false;
  }

  async function sendMessage(): Promise<void> {
    if (!summary?.sandboxId || !message.trim()) return;
    const text = message.trim();
    const target = {
      sandboxId: summary.sandboxId,
      agentName: summary.agentName,
      projectId: summary.projectId,
    };
    message = '';
    sending = true;
    continuationRunId = '';
    error = '';
    try {
      await runStreams.start({
        projectId: target.projectId,
        agentName: target.agentName,
        prompt: text,
        sandboxId: target.sandboxId,
      });
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      sending = false;
    }
  }

  async function finalizeStream(stream: AgentStreamState): Promise<void> {
    if (stream.runId && stream.runId !== runId) continuationRunId = stream.runId;
    try {
      const [cells, nextDetail] = await Promise.all([
        stream.sandboxId ? refreshSandboxHistoryCells(stream.sandboxId) : Promise.resolve([]),
        stream.runId === runId ? getRun(runId) : Promise.resolve(null),
      ]);
      if (stream.sandboxId) {
        const nextTurns = buildConversationTurns(cells);
        conversationTurns =
          stream.phase === 'failed' ? withFailedConversationTurn(nextTurns, streamFailure(stream)) : nextTurns;
      }
      if (nextDetail) detail = nextDetail;
      error = '';
      runStreams.dismiss(stream);
    } catch (cause) {
      if (stream.phase === 'failed') {
        conversationTurns = withFailedConversationTurn(conversationTurns, streamFailure(stream));
        error = '';
        runStreams.dismiss(stream);
      } else {
        error = t('本轮执行已完成，但刷新对话失败：{error}', { error: errorMessage(cause) });
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
    if (!confirm(t('确认停止当前运行？'))) return;
    try {
      await stopRun(runId);
      await load(runId);
    } catch (cause) {
      error = errorMessage(cause);
    }
  }
  async function resume(): Promise<void> {
    if (!summary?.sandboxId) return;
    try {
      await resumeSandboxContext(summary.sandboxId);
      sandbox = await getSandboxContext(summary.sandboxId);
      connectShell();
    } catch (cause) {
      error = errorMessage(cause);
    }
  }
  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : t('请求失败'));
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div data-page-layout="workbench" class="flex h-full min-h-0 flex-col overflow-hidden">
  <div data-page-header class="shrink-0 border-b border-border">
    <div
      data-page-frame
      class="mx-auto flex w-full max-w-[112rem] flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5 xl:px-6"
    >
      {#if summary}
        {@const state = runState(summary.status)}
        {@const trigger = runTriggerDetail(summary)}
        <div class="min-w-0">
          <h1 class="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight">
            <StatusBadge status={state} dotOnly />
            <span class="shrink-0">{summary.agentName}</span>
            <span class="truncate font-normal text-muted-foreground">· {summary.projectName}</span>
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span class={state === 'failed' ? 'text-destructive' : 'text-foreground/80'}
              >{t(RUN_STATE_LABEL[state])}{#if state === 'failed'}<span class="px-1">·</span>{t('退出码')}
                {summary.exitCode}{/if}</span
            >
            {#if runDuration(summary)}<span
                >{t('耗时')} <span class="text-foreground/80">{runDuration(summary)}</span></span
              >{/if}
            <span>{t('开始')} <Timestamp class="text-foreground/80" value={runStartedAt(summary)} /></span>
            <span>{runSourceLabel(summary.source)}{trigger ? ` · ${trigger}` : ''}</span>
            {#if detail?.imageRef}<span class="hidden truncate font-mono text-[11px] lg:inline"
                >{detail.imageRef}{detail.driver ? ` · ${detail.driver}` : ''}</span
              >{/if}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          {#if state === 'running'}<Button variant="outline" size="sm" class="text-destructive" onclick={stop}
              ><Square class="size-3.5" />{t('停止运行')}</Button
            >{/if}
          <CopyLinkButton />
        </div>
        {#if state === 'failed'}
          <div class="w-full rounded-r-md border-l-2 border-destructive bg-destructive/5 px-3 py-2">
            <pre
              class="max-h-28 overflow-auto font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap">{summary.error ||
                t('后端未返回错误信息')}</pre>
          </div>
        {/if}
      {/if}
    </div>
  </div>
  {#if error}<div data-page-error class="mx-auto w-full max-w-[112rem] shrink-0 px-4 pt-3 sm:px-5 xl:px-6">
      <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
    </div>{/if}
  {#if loading && !detail}<p class="p-6 text-sm text-muted-foreground">
      {t('正在加载运行详情…')}
    </p>{:else if detail}<PageContent class="flex min-h-0 flex-1 overflow-hidden">
      <Tabs.Root class="flex h-full min-h-0 w-full flex-col overflow-hidden" value={tab} onValueChange={selectTab}
        ><Tabs.List data-tab-scroll class="shrink-0 justify-start"
          ><Tabs.Trigger value="logs">{t('运行日志')}</Tabs.Trigger><Tabs.Trigger value="activity"
            >{t('活动')}</Tabs.Trigger
          ><Tabs.Trigger value="records">{t('智能体记录')}</Tabs.Trigger><Tabs.Trigger value="chat"
            >{t('对话')}</Tabs.Trigger
          ><Tabs.Trigger value="terminal">{t('终端')}</Tabs.Trigger><Tabs.Trigger value="sandbox"
            >{t('Sandbox')}</Tabs.Trigger
          ></Tabs.List
        >
        <Tabs.Content value="chat" class="mt-4 min-h-0 flex-1 overflow-hidden">
          <RunConversation
            turns={conversationTurns}
            currentRunId={runId}
            currentRunStatus={summary ? runStatusName(summary.status) : 'pending'}
            currentRunError={summary?.error || ''}
            {continuationRunId}
            pendingPrompt={activeStream?.prompt || ''}
            pendingOutput={activeStream?.output || ''}
            pendingRunId={activeStream?.runId || ''}
            pendingStreamState={activeStream?.statusText || ''}
            sandboxId={summary?.sandboxId || ''}
            {message}
            sending={sending || Boolean(activeStream?.running)}
            onMessage={(value) => (message = value)}
            onSend={() => void sendMessage()}
            onCancel={() => activeStream && runStreams.cancel(activeStream)}
          />
        </Tabs.Content>
        <Tabs.Content value="logs" data-run-logs class="mt-4 min-h-0 flex-1 overflow-hidden">
          {#if summary}<RunLogPanel
              runId={summary.runId}
              projectId={summary.projectId}
              running={summary.status === RunStatus.RUNNING || summary.status === RunStatus.PENDING}
              onError={(message) => (error = t('日志订阅断开：{error}', { error: message }))}
            />{/if}
        </Tabs.Content>
        <Tabs.Content data-scroll-pane value="activity" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {#if activitiesLoading && !activities.length}<p class="text-sm text-muted-foreground">
              {t('加载中…')}
            </p>{:else if summary}<RunActivityList {activities} startedAt={runStartedAt(summary)} />{/if}
        </Tabs.Content>
        <Tabs.Content value="records" class="mt-4 min-h-0 flex-1 overflow-hidden">
          {#if summary?.sandboxId}<AgentRecordsPanel
              sandboxId={summary.sandboxId}
              active={tab === 'records'}
            />{:else}<p class="p-6 text-sm text-muted-foreground">
              {t('这次运行没有关联的 Sandbox')}
            </p>{/if}
        </Tabs.Content>
        <Tabs.Content value="terminal" class="mt-4 min-h-0 flex-1 overflow-hidden"
          >{#if terminalExpanded}<div class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"></div>{/if}
          <div
            data-terminal-panel
            class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background {terminalExpanded
              ? 'fixed inset-0 z-50 shadow-2xl sm:inset-3'
              : 'h-full'}"
          >
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
              <span class="flex items-center gap-1 text-sm"
                >{t('Sandbox')}
                {#if summary?.sandboxId}<CopyableText
                    value={summary.sandboxId}
                    display={summary.sandboxShortId || compactIdentifier(summary.sandboxId)}
                    label="Sandbox ID"
                    class="font-mono text-xs"
                  />{:else}<span class="font-mono text-xs">{t('已回收')}</span>{/if}</span
              >{#if sandbox}<StatusBadge status={sandbox.status} />{:else}<span class="text-xs text-muted-foreground"
                  >{t('不可连接')}</span
                >{/if}<span class="text-xs text-muted-foreground">{terminalState}</span>
              <div class="ml-auto flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  disabled={terminalFontSize <= 12}
                  onclick={() => adjustTerminalFont(-1)}
                  title={t('缩小终端字体')}
                  aria-label={t('缩小终端字体')}><Minus class="size-3.5" /></Button
                ><span class="min-w-8 self-center text-center font-mono text-[11px] text-muted-foreground"
                  >{terminalFontSize}px</span
                ><Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  disabled={terminalFontSize >= 20}
                  onclick={() => adjustTerminalFont(1)}
                  title={t('增大终端字体')}
                  aria-label={t('增大终端字体')}><Plus class="size-3.5" /></Button
                >
                <Button variant="ghost" size="sm" onclick={() => terminal?.send('\x03')}>Ctrl-C</Button><Button
                  variant="ghost"
                  size="sm"
                  onclick={() => terminal?.eof()}>Ctrl-D</Button
                ><Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  onclick={() => (terminalExpanded = !terminalExpanded)}
                  title={t(terminalExpanded ? '还原终端' : '展开终端')}
                  aria-label={t(terminalExpanded ? '还原终端' : '展开终端')}
                  >{#if terminalExpanded}<Minimize2 class="size-3.5" />{:else}<Maximize2
                      class="size-3.5"
                    />{/if}</Button
                >
                {#if sandbox && !terminal}<Button variant="outline" size="sm" onclick={connectShell}>{t('连接')}</Button
                  >{/if}{#if sandbox?.status === 'stopped'}<Button variant="outline" size="sm" onclick={resume}
                    >{t('恢复 Sandbox')}</Button
                  >{/if}{#if jupyterHref}<Button
                    variant="ghost"
                    size="sm"
                    href={jupyterHref}
                    target="_blank"
                    rel="noopener noreferrer"><ExternalLink class="size-3.5" />Jupyter</Button
                  >{/if}
              </div>
            </div>
            <div class="min-h-0 flex-1 bg-[#121722] p-2">
              <XtermView
                lines={shellLines}
                fontSize={terminalFontSize}
                interactive
                onData={(data) => terminal?.send(data)}
                onResize={(cols, rows) => terminal?.resize(cols, rows)}
              />
            </div>
          </div></Tabs.Content
        >
        <Tabs.Content data-scroll-pane value="sandbox" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
          ><RunSandboxSummary {sandbox} {detail} /></Tabs.Content
        >
      </Tabs.Root>
    </PageContent>{/if}
</div>
