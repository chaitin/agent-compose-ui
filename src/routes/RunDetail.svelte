<script lang="ts">
  import { onMount } from 'svelte';
  import * as Tabs from '$lib/components/ui/tabs';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import RunConversation from '$lib/components/run-conversation.svelte';
  import RunLogViewer from '$lib/components/run-log-viewer.svelte';
  import CopyableText from '$lib/components/copyable-text.svelte';
  import CopyLinkButton from '$lib/components/copy-link-button.svelte';
  import PageContent from '$lib/components/page-content.svelte';
  import RunSandboxSummary from '$lib/components/run-sandbox-summary.svelte';
  import RunTimeline from '$lib/components/run-timeline.svelte';
  import StatusBadge from '$lib/components/status-badge.svelte';
  import Timestamp from '$lib/components/timestamp.svelte';
  import { runStreams, type AgentStreamState } from '$lib/run-stream.svelte';
  import XtermView from '$lib/components/xterm-view.svelte';
  import { navigate, router, matchDetail } from '$lib/router.svelte';
  import { openInteractiveTerminal, type InteractiveTerminal } from '../api/exec';
  import { followRunLogs, getRun, listRunEvents, runStatusName, stopRun } from '../api/runs';
  import {
    getSandboxContext,
    listSandboxHistoryCells,
    refreshSandboxHistoryCells,
    resumeSandboxContext,
    type SandboxContextDetail,
  } from '../api/sessions';
  import type { RunDetail, RunEvent } from '../gen/agentcompose/v2/agentcompose_pb.js';
  import { timestampToISOString } from '../model/timestamps';
  import {
    conversationTurns as buildConversationTurns,
    withFailedConversationTurn,
    type ConversationTurn,
  } from '../model/conversation';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import Minus from '@lucide/svelte/icons/minus';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import Plus from '@lucide/svelte/icons/plus';
  import Square from '@lucide/svelte/icons/square';

  const runId = $derived(matchDetail('/runs', router.path) ?? '');
  let detail = $state<RunDetail | null>(null);
  let events = $state<RunEvent[]>([]);
  let sandbox = $state<SandboxContextDetail | null>(null);
  let tab = $state(router.path.endsWith('/terminal') ? 'terminal' : 'chat');
  let shellLines = $state<string[]>([]);
  let terminalState = $state('未连接');
  let terminalFontSize = $state(15);
  let terminalExpanded = $state(false);
  let terminal = $state<InteractiveTerminal | null>(null);
  let logs = $state('');
  let logQuery = $state('');
  let followLogs = $state(true);
  let logWrap = $state(false);
  let message = $state('');
  let sending = $state(false);
  let conversationTurns = $state<ConversationTurn[]>([]);
  let continuationRunId = $state('');
  let loading = $state(true);
  let error = $state('');
  let controller: AbortController | null = null;
  let loadedRunId = '';
  let loadVersion = 0;
  let finalizedOperationId = '';

  const summary = $derived(detail?.summary);
  const runStream = $derived(runStreams.forRun(runId));
  const sandboxStream = $derived(summary?.sandboxId ? runStreams.forSandbox(summary.sandboxId) : undefined);
  const activeStream = $derived(
    sandboxStream?.running ? sandboxStream : runStream?.running ? runStream : (sandboxStream ?? runStream),
  );
  const visibleLogs = $derived(
    logQuery.trim()
      ? logs
          .split('\n')
          .filter((line) => line.toLowerCase().includes(logQuery.toLowerCase()))
          .join('\n')
      : logs,
  );

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
      controller?.abort();
      terminal?.close();
    };
  });

  async function load(targetRunId: string): Promise<void> {
    const version = ++loadVersion;
    loading = true;
    error = '';
    tab = router.path.endsWith('/terminal') ? 'terminal' : 'chat';
    controller?.abort();
    controller = new AbortController();
    terminal?.close();
    terminal = null;
    terminalState = '未连接';
    shellLines = [];
    logs = '';
    sandbox = null;
    detail = null;
    events = [];
    continuationRunId = '';
    conversationTurns = [];
    try {
      const [nextDetail, nextEvents] = await Promise.all([getRun(targetRunId), listRunEvents(targetRunId)]);
      if (version !== loadVersion) return;
      detail = nextDetail;
      events = nextEvents;
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
      void followRunLogs(
        targetRunId,
        (chunk) => {
          logs += chunk;
        },
        controller.signal,
      ).catch((cause) => {
        if (version === loadVersion && !controller?.signal.aborted) error = `日志订阅断开：${errorMessage(cause)}`;
      });
    } catch (cause) {
      if (version === loadVersion) error = errorMessage(cause);
    } finally {
      if (version === loadVersion) loading = false;
    }
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
      output: value.output,
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
    terminal = openInteractiveTerminal(summary.sandboxId, {
      onData: (data) => {
        shellLines = [...shellLines, data];
      },
      onState: (state) => {
        terminalState = state;
      },
      onError: (messageText) => {
        terminalState = '连接失败';
        error = `PTY：${messageText}`;
      },
    });
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
      const [cells, nextDetail, nextEvents] = await Promise.all([
        stream.sandboxId ? refreshSandboxHistoryCells(stream.sandboxId) : Promise.resolve([]),
        stream.runId === runId ? getRun(runId) : Promise.resolve(null),
        stream.runId === runId ? listRunEvents(runId) : Promise.resolve(null),
      ]);
      if (stream.sandboxId) {
        const nextTurns = buildConversationTurns(cells);
        conversationTurns =
          stream.phase === 'failed' ? withFailedConversationTurn(nextTurns, streamFailure(stream)) : nextTurns;
      }
      if (nextDetail) detail = nextDetail;
      if (nextEvents) events = nextEvents;
      error = '';
      runStreams.dismiss(stream);
    } catch (cause) {
      if (stream.phase === 'failed') {
        conversationTurns = withFailedConversationTurn(conversationTurns, streamFailure(stream));
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
    if (!confirm('确认停止当前运行？')) return;
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
  function openJupyter(): void {
    if (sandbox?.notebookUrl) window.open(sandbox.notebookUrl, '_blank', 'noopener');
    else if (sandbox?.proxyPath) window.open(sandbox.proxyPath, '_blank', 'noopener');
  }
  function downloadLogs(): void {
    const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${runId}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : '请求失败');
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div data-page-layout="workbench" class="flex h-full min-h-0 flex-col overflow-hidden">
  <div
    data-page-header
    class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:px-5 xl:px-6"
  >
    {#if summary}<div class="flex items-center gap-3">
        <Button variant="ghost" size="icon" onclick={() => navigate('/runs')}><ArrowLeft class="size-4" /></Button>
        <div>
          <div class="text-sm font-semibold">{summary.agentName}</div>
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <CopyableText
              value={summary.runId}
              display={summary.runShortId || summary.runId}
              label="Run ID"
              class="font-mono"
            />
            <Timestamp value={timestampToISOString(summary.startedAt || summary.createdAt)} />
          </div>
        </div>
        <StatusBadge status={runStatusName(summary.status)} /><span class="text-sm text-muted-foreground"
          >{detail?.imageRef} · {detail?.driver}</span
        >
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <CopyLinkButton />
        {#if runStatusName(summary.status) === 'running'}<Button
            variant="outline"
            size="sm"
            class="text-destructive"
            onclick={stop}><Square class="size-3.5" />停止运行</Button
          >{/if}
      </div>{/if}
  </div>
  {#if error}<div
      data-page-error
      class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive sm:mx-5 xl:mx-6"
    >
      {error}
    </div>{/if}
  {#if loading && !detail}<p class="p-6 text-sm text-muted-foreground">
      正在加载运行详情…
    </p>{:else if detail}<PageContent class="flex min-h-0 flex-1 overflow-hidden">
      <Tabs.Root class="flex h-full min-h-0 w-full flex-col overflow-hidden" value={tab} onValueChange={selectTab}
        ><Tabs.List data-scroll-surface class="shrink-0 max-w-full justify-start overflow-x-auto"
          ><Tabs.Trigger value="chat">对话</Tabs.Trigger><Tabs.Trigger value="timeline">执行动态</Tabs.Trigger
          ><Tabs.Trigger value="logs">原始日志</Tabs.Trigger><Tabs.Trigger value="terminal">终端</Tabs.Trigger
          ><Tabs.Trigger value="sandbox">沙箱</Tabs.Trigger></Tabs.List
        >
        <Tabs.Content value="chat" class="mt-4 min-h-0 flex-1 overflow-hidden">
          <RunConversation
            turns={conversationTurns}
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
          />
        </Tabs.Content>
        <Tabs.Content data-scroll-pane value="timeline" class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
          ><RunTimeline {events} /></Tabs.Content
        >
        <Tabs.Content value="logs" class="mt-4 min-h-0 flex-1 overflow-hidden">
          <RunLogViewer
            query={logQuery}
            content={visibleLogs}
            lineCount={logs ? logs.split('\n').length : 0}
            following={followLogs}
            wrap={logWrap}
            onQuery={(value) => (logQuery = value)}
            onToggleFollow={() => (followLogs = !followLogs)}
            onFollowingChange={(value) => (followLogs = value)}
            onToggleWrap={() => (logWrap = !logWrap)}
            onDownload={downloadLogs}
          />
        </Tabs.Content>
        <Tabs.Content value="terminal" class="mt-4 min-h-0 flex-1 overflow-hidden"
          >{#if terminalExpanded}<div class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"></div>{/if}
          <div
            data-terminal-panel
            class="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background {terminalExpanded
              ? 'fixed inset-3 z-50 shadow-2xl'
              : 'h-full'}"
          >
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
              <span class="flex items-center gap-1 text-sm"
                >沙箱 {#if summary?.sandboxId}<CopyableText
                    value={summary.sandboxId}
                    display={summary.sandboxShortId || summary.sandboxId}
                    label="Sandbox ID"
                    class="font-mono text-xs"
                  />{:else}<span class="font-mono text-xs">已回收</span>{/if}</span
              >{#if sandbox}<StatusBadge status={sandbox.status} />{:else}<span class="text-xs text-muted-foreground"
                  >不可连接</span
                >{/if}<span class="text-xs text-muted-foreground">{terminalState}</span>
              <div class="ml-auto flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  disabled={terminalFontSize <= 12}
                  onclick={() => adjustTerminalFont(-1)}
                  title="缩小终端字体"
                  aria-label="缩小终端字体"><Minus class="size-3.5" /></Button
                ><span class="min-w-8 self-center text-center font-mono text-[11px] text-muted-foreground"
                  >{terminalFontSize}px</span
                ><Button
                  variant="ghost"
                  size="icon"
                  class="size-7"
                  disabled={terminalFontSize >= 20}
                  onclick={() => adjustTerminalFont(1)}
                  title="增大终端字体"
                  aria-label="增大终端字体"><Plus class="size-3.5" /></Button
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
                  title={terminalExpanded ? '还原终端' : '展开终端'}
                  aria-label={terminalExpanded ? '还原终端' : '展开终端'}
                  >{#if terminalExpanded}<Minimize2 class="size-3.5" />{:else}<Maximize2
                      class="size-3.5"
                    />{/if}</Button
                >
                {#if sandbox && !terminal}<Button variant="outline" size="sm" onclick={connectShell}>连接</Button
                  >{/if}{#if sandbox?.status === 'stopped'}<Button variant="outline" size="sm" onclick={resume}
                    >恢复沙箱</Button
                  >{/if}<Button
                  variant="ghost"
                  size="sm"
                  onclick={openJupyter}
                  disabled={!sandbox?.notebookUrl && !sandbox?.proxyPath}
                  ><ExternalLink class="size-3.5" />Jupyter</Button
                >
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
