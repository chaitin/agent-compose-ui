<script lang="ts">
  import { onMount } from 'svelte';

  import SessionOutputPanel from '../components/SessionOutputPanel.svelte';

  import {
    getAutomationRun,
    getAutomationTask,
    getTopicEvent,
    listAutomationEvents,
    listTopicEventRuns,
    listTopicEventSessions,
    resolveAutomationSessionTarget,
    type AutomationEvent,
    type AutomationRun,
    type AutomationTaskDetail,
    type TopicEvent,
    type TopicEventRun,
    type TopicEventSession,
  } from '../api/loaders';
  import {
    getWorkSession,
    getWorkSessionRunTarget,
    getWorkSessionProxy,
    listWorkSessionCells,
    listWorkSessionEvents,
    resumeWorkSession,
    sendWorkSessionMessageStream,
    stopWorkSession,
    type WorkSessionCell,
    type WorkSessionDetail,
    type WorkSessionEvent,
    type WorkSessionRunTarget,
  } from '../api/sessions';
  import { apiPath } from '../paths';
  import { CellType } from '../api/sessions';
  import { mapLoaderRunStatus, mapSessionStatus, statusTone } from '../model/runs';
  import { isAgentSessionCell } from '../model/session-output';
  import { appPath } from '../paths';
  import { formatBeijingTime } from '../time';

  export let eventId = '';

  type RunTrace = {
    delivery: TopicEventRun;
    task: AutomationTaskDetail | null;
    run: AutomationRun | null;
    events: AutomationEvent[];
    allEvents: AutomationEvent[];
  };

  type SessionTrace = {
    link: TopicEventSession;
    session: WorkSessionDetail | null;
    cells: WorkSessionCell[];
    events: WorkSessionEvent[];
    conversationTarget?: WorkSessionRunTarget;
  };

  let loading = true;
  let error = '';
  let event: TopicEvent | null = null;
  let runTraces: RunTrace[] = [];
  let sessionTraces: SessionTrace[] = [];
  let stoppableTrace: SessionTrace | null = null;
  let resumableTrace: SessionTrace | null = null;
  let notebookTrace: SessionTrace | null = null;
  let sessionActionStatusText = '';
  let sessionAction: { sessionId: string; action: 'stop' | 'resume' } | null = null;
  let jupyterOpeningSessionId = '';
  let messageDrafts: Record<string, string> = {};
  let sendingSessionId = '';
  let refreshingSessionId = '';
  let outputResetVersion = 0;
  let messageAbort: AbortController | null = null;

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    if (!eventId.trim()) {
      error = '缺少 event id';
      loading = false;
      return;
    }
    loading = true;
    error = '';
    outputResetVersion += 1;
    try {
      const [nextEvent, deliveries, links] = await Promise.all([
        getTopicEvent(eventId),
        listTopicEventRuns(eventId),
        listTopicEventSessions(eventId),
      ]);
      event = nextEvent;
      const traces = await Promise.all(deliveries.map(loadRunTrace));
      runTraces = traces;
      const loadedSessionTraces = await Promise.all(mergeSessionLinks(links, inferSessionLinksFromRunEvents(nextEvent.eventId, traces)).map(loadSessionTrace));
      sessionTraces = sortedSessionTraces(loadedSessionTraces);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      event = null;
      runTraces = [];
      sessionTraces = [];
    } finally {
      loading = false;
    }
  }

  async function loadRunTrace(delivery: TopicEventRun): Promise<RunTrace> {
    const [task, run, allEvents] = await Promise.all([
      getAutomationTask(delivery.loaderId).catch(() => null),
      delivery.runId ? getAutomationRun(delivery.loaderId, delivery.runId).catch(() => null) : Promise.resolve(null),
      listAutomationEvents(delivery.loaderId, 200)
        .catch(() => []),
    ]);
    const events = allEvents.filter((item) => !delivery.runId || item.runId === delivery.runId);
    return { delivery, task, run, events, allEvents };
  }

  function inferSessionLinksFromRunEvents(rootEventId: string, traces: RunTrace[]): TopicEventSession[] {
    const links: TopicEventSession[] = [];
    for (const trace of traces) {
      for (const item of trace.allEvents) {
        if (!item.linkedSessionId) {
          continue;
        }
        if (item.topicEventId && item.topicEventId !== rootEventId) {
          continue;
        }
        if (!item.topicEventId && trace.delivery.runId && item.runId && item.runId !== trace.delivery.runId) {
          continue;
        }
        links.push({
          sessionId: item.linkedSessionId,
          relation: item.type || 'loader_event',
          loaderId: item.loaderId,
          runId: item.runId,
          triggerId: item.triggerId,
          loaderEventId: item.id,
          eventId: rootEventId,
          createdAt: item.createdAt,
        });
      }
    }
    return links;
  }

  function mergeSessionLinks(explicitLinks: TopicEventSession[], inferredLinks: TopicEventSession[]): TopicEventSession[] {
    const merged = new Map<string, TopicEventSession>();
    for (const link of [...explicitLinks, ...inferredLinks]) {
      const key = link.sessionId;
      if (link.sessionId && !merged.has(key)) {
        merged.set(key, link);
      }
    }
    return Array.from(merged.values());
  }

  async function loadSessionTrace(link: TopicEventSession): Promise<SessionTrace> {
    if (!link.sessionId) {
      return { link, session: null, cells: [], events: [] };
    }
    const [session, cells, events, runTarget, automationTarget] = await Promise.all([
      getWorkSession(link.sessionId, { includeProxy: false }).catch(() => null),
      listWorkSessionCells(link.sessionId).catch(() => []),
      listWorkSessionEvents(link.sessionId).catch(() => []),
      getWorkSessionRunTarget(link.sessionId).catch(() => undefined),
      link.loaderId ? resolveAutomationSessionTarget(link.loaderId).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return { link, session, cells, events, conversationTarget: runTarget || automationTarget };
  }

  function sortedSessionTraces(traces: SessionTrace[]): SessionTrace[] {
    return [...traces].sort((left, right) => compareTraceTime(right, left));
  }

  function compareTraceTime(left: SessionTrace, right: SessionTrace): number {
    return traceTimeValue(left) - traceTimeValue(right);
  }

  function traceTimeValue(trace: SessionTrace): number {
    const value = trace.session?.updatedAt || trace.session?.createdAt || trace.link.createdAt;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function formatTime(value: string): string {
    return value ? formatBeijingTime(value) : '-';
  }

  function formatJsonDocument(raw: string): string {
    if (!raw.trim()) return '-';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function firstLine(value: string): string {
    return value.trim().split(/\r?\n/)[0] || '-';
  }

  function shouldCollapseError(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length > 96 || trimmed.split(/\r?\n/).length > 1;
  }

  function errorSummary(value: string): string {
    const line = firstLine(value);
    return line.length > 120 ? `${line.slice(0, 120)}...` : line;
  }

  function compactTime(value: string): string {
    const formatted = formatTime(value);
    return formatted === '-' ? '-' : formatted.replace(/^\d{4}[/-]/, '');
  }

  function shortId(value: string, size = 8): string {
    if (!value) return '-';
    return value.length > size ? value.slice(0, size) : value;
  }

  function compactPath(value: string): string {
    if (!value) return '-';
    const parts = value.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join('/');
    }
    return value;
  }

  function compactImage(value: string): string {
    if (!value) return '-';
    const image = value.split('/').pop() || value;
    const tag = image.includes(':') ? image.split(':').pop() || image : image;
    return tag.length > 30 ? `${tag.slice(0, 30)}...` : tag;
  }

  function deliveryLabel(status: string): string {
    const normalized = status.toLowerCase();
    if (normalized === 'matched') return '已匹配';
    if (normalized === 'run_started') return '已启动';
    if (normalized === 'run_succeeded') return '成功';
    if (normalized === 'run_failed') return '失败';
    if (normalized === 'skipped') return '跳过';
    return status || '-';
  }

  function deliveryTone(status: string): 'blue' | 'green' | 'red' | 'gray' {
    const normalized = status.toLowerCase();
    if (normalized === 'run_failed' || normalized === 'skipped') return 'red';
    if (normalized === 'run_succeeded') return 'green';
    if (normalized === 'matched' || normalized === 'run_started') return 'blue';
    return 'gray';
  }

  function eventSourceLabel(value: string): string {
    if (value === 'webhook') return 'Webhook';
    if (value === 'loader') return 'Loader';
    if (value === 'system') return 'System';
    return value || '-';
  }

  function latestCellAgent(trace: SessionTrace): string {
    for (let index = trace.cells.length - 1; index >= 0; index -= 1) {
      const agent = trace.cells[index].agent?.trim();
      if (agent) return agent;
    }
    return 'codex';
  }

  function sessionStatus(trace: SessionTrace | null): string {
    return mapSessionStatus(trace?.session?.status || '');
  }

  function traceSessionId(trace: SessionTrace | null): string {
    return trace?.link.sessionId || trace?.session?.id || '';
  }

  function canStopSession(trace: SessionTrace): boolean {
    return Boolean(traceSessionId(trace)) && sessionStatus(trace) === '运行中';
  }

  function canResumeSession(trace: SessionTrace): boolean {
    return Boolean(traceSessionId(trace)) && ['已停止', '启动失败'].includes(sessionStatus(trace));
  }

  function latestAgentCell(trace: SessionTrace): WorkSessionCell | null {
    for (let index = trace.cells.length - 1; index >= 0; index -= 1) {
      const cell = trace.cells[index];
      if (isAgentSessionCell(cell)) return cell;
    }
    return null;
  }

  function hasActiveReply(trace: SessionTrace): boolean {
    return Boolean(latestAgentCell(trace)?.running);
  }

  function canSendMessage(trace: SessionTrace): boolean {
    return Boolean(trace.link.sessionId) && Boolean(trace.conversationTarget) && sessionStatus(trace) === '运行中' && sendingSessionId !== trace.link.sessionId && !hasActiveReply(trace);
  }

  function messageInputHint(trace: SessionTrace): string {
    if (sendingSessionId === trace.link.sessionId || hasActiveReply(trace)) return '正在回复';
    if (!trace.conversationTarget) return '旧会话缺少可用项目/智能体，仅供查看';
    if (sessionStatus(trace) === '运行中') return 'Enter 发送，Shift + Enter 换行';
    return `会话${sessionStatus(trace) || '未运行'}`;
  }

  function canOpenNotebook(trace: SessionTrace | null): boolean {
    return Boolean(traceSessionId(trace)) && trace !== null && sessionStatus(trace) === '运行中' && !jupyterOpeningSessionId;
  }

  function canOpenTerminal(trace: SessionTrace | null): boolean {
    return Boolean(traceSessionId(trace)) && trace !== null && sessionStatus(trace) === '运行中';
  }

  function isStopping(trace: SessionTrace | null): boolean {
    return Boolean(trace && sessionAction?.sessionId === traceSessionId(trace) && sessionAction.action === 'stop');
  }

  function isResuming(trace: SessionTrace | null): boolean {
    return Boolean(trace && sessionAction?.sessionId === traceSessionId(trace) && sessionAction.action === 'resume');
  }

  function isOpeningNotebook(trace: SessionTrace | null): boolean {
    return Boolean(trace && jupyterOpeningSessionId === traceSessionId(trace));
  }

  async function refreshSessionTrace(link: TopicEventSession): Promise<void> {
    const nextTrace = await loadSessionTrace(link);
    sessionTraces = sessionTraces.map((trace) => trace.link.sessionId === link.sessionId ? nextTrace : trace);
  }

  async function refreshSessionOutput(trace: SessionTrace): Promise<void> {
    const sessionId = trace.link.sessionId;
    if (!sessionId || refreshingSessionId) throw new Error('会话正在刷新');
    refreshingSessionId = sessionId;
    error = '';
    try {
      const cells = await listWorkSessionCells(sessionId);
      sessionTraces = sessionTraces.map((item) => item.link.sessionId === sessionId ? { ...item, cells } : item);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      refreshingSessionId = '';
    }
  }

  async function stopSession(trace: SessionTrace): Promise<void> {
    const sessionId = traceSessionId(trace);
    if (!sessionId || sessionAction) return;
    sessionAction = { sessionId, action: 'stop' };
    error = '';
    try {
      await stopWorkSession(sessionId);
      await refreshSessionTrace(trace.link);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sessionAction = null;
    }
  }

  async function resumeSession(trace: SessionTrace): Promise<void> {
    const sessionId = traceSessionId(trace);
    if (!sessionId || sessionAction) return;
    sessionAction = { sessionId, action: 'resume' };
    error = '';
    try {
      await resumeWorkSession(sessionId);
      await refreshSessionTrace(trace.link);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sessionAction = null;
    }
  }

  async function openNotebook(trace: SessionTrace): Promise<void> {
    if (!canOpenNotebook(trace)) return;
    const sessionId = traceSessionId(trace);
    const popup = window.open('about:blank', '_blank');
    jupyterOpeningSessionId = sessionId;
    error = '';
    try {
      const proxy = await getWorkSessionProxy(sessionId);
      sessionTraces = sessionTraces.map((item) => item.link.sessionId === sessionId && item.session
        ? { ...item, session: { ...item.session, proxyPath: proxy.proxyPath, notebookUrl: proxy.notebookUrl } }
        : item);
      const notebookPath = proxy.notebookUrl || proxy.proxyPath;
      if (notebookPath) {
        const notebookUrl = new URL(apiPath(notebookPath), window.location.origin).toString();
        if (popup) {
          popup.opener = null;
          popup.location.href = notebookUrl;
        } else {
          window.location.href = notebookUrl;
        }
      } else {
        popup?.close();
      }
    } catch (err) {
      popup?.close();
      error = err instanceof Error ? err.message : String(err);
    } finally {
      jupyterOpeningSessionId = '';
    }
  }

  function openTerminal(trace: SessionTrace): void {
    const sessionId = traceSessionId(trace);
    if (!sessionId) return;
    window.location.assign(appPath(`/debug/runs/${encodeURIComponent(sessionId)}`));
  }

  function updateMessageDraft(sessionId: string, value: string): void {
    messageDrafts = { ...messageDrafts, [sessionId]: value };
  }

  function appendPendingOutput(sessionId: string, cellId: string, chunk: string): void {
    sessionTraces = sessionTraces.map((trace) => {
      if (trace.link.sessionId !== sessionId) return trace;
      const existing = trace.cells.find((cell) => cell.id === cellId);
      if (existing) {
        return {
          ...trace,
          cells: trace.cells.map((cell) => cell.id === cellId ? { ...cell, output: `${cell.output || ''}${chunk}` } : cell),
        };
      }
      const pendingCell: WorkSessionCell = {
        id: cellId,
        source: '',
        output: chunk,
        type: CellType.AGENT,
        exitCode: 0,
        success: true,
        createdAt: new Date().toISOString(),
        agent: latestCellAgent(trace),
        agentSessionId: '',
        stopReason: '',
        running: true,
      };
      return { ...trace, cells: [...trace.cells, pendingCell] };
    });
  }

  function insertPendingMessagePair(sessionId: string, userCellId: string, agentCellId: string, message: string, agent: string): void {
    sessionTraces = sessionTraces.map((trace) => {
      if (trace.link.sessionId !== sessionId) return trace;
      const now = new Date().toISOString();
      const userCell: WorkSessionCell = {
        id: userCellId,
        source: '',
        output: message,
        type: CellType.UNSPECIFIED,
        exitCode: 0,
        success: true,
        createdAt: now,
        agent: '',
        agentSessionId: '',
        stopReason: '',
        running: false,
      };
      const agentCell: WorkSessionCell = {
        id: agentCellId,
        source: '',
        output: '',
        type: CellType.AGENT,
        exitCode: 0,
        success: true,
        createdAt: now,
        agent,
        agentSessionId: '',
        stopReason: '',
        running: true,
      };
      return { ...trace, cells: [...trace.cells, userCell, agentCell] };
    });
  }

  function replacePendingCellId(sessionId: string, previousId: string, nextId: string): void {
    if (!nextId || previousId === nextId) return;
    sessionTraces = sessionTraces.map((trace) => trace.link.sessionId === sessionId
      ? {
        ...trace,
        cells: trace.cells.map((cell) => cell.id === previousId ? { ...cell, id: nextId } : cell),
      }
      : trace);
  }

  function failPendingCell(sessionId: string, cellId: string, message: string): void {
    sessionTraces = sessionTraces.map((trace) => trace.link.sessionId === sessionId
      ? {
        ...trace,
        cells: trace.cells.map((cell) => cell.id === cellId
          ? { ...cell, output: '', stopReason: message, success: false, running: false }
          : cell),
      }
      : trace);
  }

  async function sendMessage(trace: SessionTrace): Promise<void> {
    const sessionId = trace.link.sessionId;
    const message = (messageDrafts[sessionId] || '').trim();
    if (!message || !canSendMessage(trace)) return;
    messageAbort?.abort();
    const controller = new AbortController();
    messageAbort = controller;
    sendingSessionId = sessionId;
    updateMessageDraft(sessionId, '');
    error = '';
    let pendingCellId = '';
    try {
      const sentAt = Date.now();
      const agent = latestCellAgent(trace);
      const userCellId = `pending-user-${sentAt}`;
      pendingCellId = `pending-agent-${sentAt}`;
      insertPendingMessagePair(sessionId, userCellId, pendingCellId, message, agent);
      await sendWorkSessionMessageStream(sessionId, agent, message, (event) => {
        if (event.type === 'started' && event.runId) {
          replacePendingCellId(sessionId, pendingCellId, event.runId);
          pendingCellId = event.runId;
          appendPendingOutput(sessionId, pendingCellId, '');
        } else if (event.type === 'chunk' && event.chunk) {
          appendPendingOutput(sessionId, event.runId || pendingCellId, event.chunk);
        } else if (event.type === 'completed' && event.run) {
          sessionTraces = sessionTraces.map((item) => item.link.sessionId === sessionId
            ? {
              ...item,
              cells: item.cells.map((cell) => cell.id === (event.run?.id || event.runId || pendingCellId)
                ? {
                  ...cell,
                  output: event.run?.output || cell.output,
                  exitCode: event.run?.exitCode || 0,
                  success: Boolean(event.run?.success),
                  running: Boolean(event.run?.running),
                  stopReason: event.run?.stopReason || '',
                  agentSessionId: event.run?.agentSessionId || cell.agentSessionId,
                }
                : cell),
            }
            : item);
          sendingSessionId = '';
        }
      }, controller.signal, trace.conversationTarget);
      await refreshSessionTrace(trace.link);
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        failPendingCell(sessionId, pendingCellId, message);
        error = message;
      }
    } finally {
      sendingSessionId = '';
      if (messageAbort === controller) {
        messageAbort = null;
      }
    }
  }

  function handleMessageKeydown(event: KeyboardEvent, trace: SessionTrace): void {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    void sendMessage(trace);
  }

  $: stoppableTrace = sessionTraces.find(canStopSession) || null;
  $: resumableTrace = sessionTraces.find(canResumeSession) || null;
  $: notebookTrace = sessionTraces.find((trace) => sessionStatus(trace) === '运行中') || null;
  $: sessionActionStatusText = sessionStatus(stoppableTrace || resumableTrace || notebookTrace || sessionTraces[0] || null);
</script>

<svelte:head>
  <title>{event ? `${event.topic || event.eventId} · 事件运行结果` : '事件运行结果'}</title>
</svelte:head>

<main class="event-page">
  <section class="event-hero">
    <div>
      <p class="eyebrow">事件运行结果</p>
      <h1>{event?.topic || '事件详情'}</h1>
      <p class="subline">{event ? `${event.eventId} · ${event.correlationId || '-'}` : eventId}</p>
    </div>
    <div class="hero-actions">
      {#if event}
        <div class="hero-session-actions" aria-label="会话操作">
          {#if sessionActionStatusText}
            <em class={`home-pill ${statusTone(sessionActionStatusText)}`}>{sessionActionStatusText}</em>
          {/if}
          <button
            class="event-action-button danger-lite"
            disabled={!stoppableTrace || Boolean(sessionAction)}
            on:click={() => { if (stoppableTrace) stopSession(stoppableTrace); }}
          >
            {isStopping(stoppableTrace) ? '停止中...' : '停止'}
          </button>
          <button
            class="event-action-button"
            disabled={!resumableTrace || Boolean(sessionAction)}
            on:click={() => { if (resumableTrace) resumeSession(resumableTrace); }}
          >
            {isResuming(resumableTrace) ? '重启中...' : '重启'}
          </button>
          <button
            class="event-action-button primary-link"
            disabled={!canOpenTerminal(notebookTrace)}
            on:click={() => { if (notebookTrace) openTerminal(notebookTrace); }}
          >
            打开终端
          </button>
          <button
            class="event-action-button primary-link"
            disabled={!canOpenNotebook(notebookTrace)}
            on:click={() => { if (notebookTrace) openNotebook(notebookTrace); }}
          >
            {isOpeningNotebook(notebookTrace) ? '打开中...' : '打开 Jupyter'}
          </button>
        </div>
      {/if}
      <button on:click={load}>{loading ? '刷新中...' : '刷新'}</button>
    </div>
  </section>

  {#if error}
    <section class="alert danger">{error}</section>
  {/if}

  {#if loading && !event}
    <section class="panel loading-panel">正在加载 event 结果...</section>
  {:else if event}
    <section class="event-layout">
      <div class="main-column">
        <section class="panel section-panel session-panel">
          <div class="section-head">
            <h2>最近会话</h2>
          </div>
          {#if sessionTraces.length === 0}
            <div class="empty">这个事件没有产生或绑定工作会话。</div>
          {:else}
            <div class="trace-list" class:single-session={sessionTraces.length === 1}>
              {#each sessionTraces as trace}
                {@const sessionId = trace.link.sessionId}
                <article class="trace-card session-card">
                  <div class="trace-card-head">
                    <div>
                      <h3>{trace.session?.title || trace.link.sessionId}</h3>
                      <p>Session {trace.link.sessionId}</p>
                    </div>
                  </div>
                  <SessionOutputPanel
                    {sessionId}
                    cells={trace.cells}
                    refreshing={refreshingSessionId === sessionId}
                    refreshDisabled={Boolean(refreshingSessionId)}
                    resetVersion={outputResetVersion}
                    refresh={() => refreshSessionOutput(trace)}
                  />
                  <div class="message-composer" class:disabled={!canSendMessage(trace)}>
                    <textarea
                      rows="3"
                      value={messageDrafts[trace.link.sessionId] || ''}
                      placeholder={canSendMessage(trace) ? '输入消息' : messageInputHint(trace)}
                      disabled={!canSendMessage(trace)}
                      on:input={(event) => updateMessageDraft(trace.link.sessionId, event.currentTarget.value)}
                      on:keydown={(event) => handleMessageKeydown(event, trace)}
                    ></textarea>
                    <div class="composer-actions">
                      <span>{messageInputHint(trace)}</span>
                      <button
                        class="compact-button primary-action"
                        disabled={!canSendMessage(trace) || !(messageDrafts[trace.link.sessionId] || '').trim()}
                        on:click={() => sendMessage(trace)}
                      >
                        {sendingSessionId === trace.link.sessionId ? '发送中...' : '发送'}
                      </button>
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <aside class="side-column">
        <section class="panel side-panel event-summary-panel">
          <h2>事件摘要</h2>
          <div class="facts side-facts">
            <div class="wide-fact"><span>事件 ID</span><b>{event.eventId}</b></div>
            <div class="wide-fact"><span>Topic</span><b>{event.topic}</b></div>
            <div><span>来源</span><b>{eventSourceLabel(event.source)}</b></div>
            <div><span>Provider</span><b>{event.provider || '-'}</b></div>
            <div class="wide-fact"><span>Correlation</span><b>{event.correlationId || '-'}</b></div>
            <div><span>创建时间</span><b>{formatTime(event.createdAt)}</b></div>
          </div>
        </section>

        <section class="panel side-panel side-scroll-panel">
          <div class="section-head">
            <h2>历史任务</h2>
            <span>{runTraces.length} 条</span>
          </div>
          {#if runTraces.length === 0}
            <div class="empty compact-empty">这个事件没有匹配到自动任务。</div>
          {:else}
            <div class="run-list">
              {#each runTraces as trace}
                <article class="run-card">
                  <div class="run-card-head">
                    <div>
                      <h3>{trace.task?.name || trace.delivery.loaderId}</h3>
                      <p title={trace.delivery.runId || '-'}>Run {trace.delivery.runId || '-'}</p>
                    </div>
                    <em class={`home-pill ${deliveryTone(trace.delivery.status)}`}>{deliveryLabel(trace.delivery.status)}</em>
                  </div>
                  <div class="run-meta-grid">
                    <div><span>运行</span><b>{trace.run ? mapLoaderRunStatus(trace.run.status) : '-'}</b></div>
                    <div><span>开始</span><b>{compactTime(trace.run?.startedAt || trace.delivery.createdAt)}</b></div>
                    <div><span>完成</span><b>{compactTime(trace.run?.completedAt || trace.delivery.updatedAt)}</b></div>
                    <div class="wide-meta"><span>Run ID</span><b title={trace.delivery.runId || '-'}>{trace.delivery.runId || '-'}</b></div>
                  </div>
                  {#if trace.delivery.error || trace.run?.error}
                    {@const runError = trace.delivery.error || trace.run?.error || ''}
                    {#if shouldCollapseError(runError)}
                      <details class="run-error-details">
                        <summary title={firstLine(runError)}>{errorSummary(runError)}</summary>
                        <pre>{runError}</pre>
                      </details>
                    {:else}
                      <div class="run-error">{runError}</div>
                    {/if}
                  {/if}
                  {#if trace.run?.resultJson}
                    <details class="run-result">
                      <summary>运行结果</summary>
                      <pre>{formatJsonDocument(trace.run.resultJson)}</pre>
                    </details>
                  {/if}
                </article>
              {/each}
            </div>
          {/if}
        </section>

        <section class="panel side-panel">
          <div class="section-head">
            <h2>事件时间线</h2>
            <span>{runTraces.reduce((total, trace) => total + trace.events.length, 0) + sessionTraces.reduce((total, trace) => total + trace.events.length, 0)} 条</span>
          </div>
          <div class="timeline-list">
            {#each runTraces as trace}
              {#each trace.events as loaderEvent}
                <div class="timeline-item">
                  <time>{compactTime(loaderEvent.createdAt)}</time>
                  <div>
                    <b>{loaderEvent.type}</b>
                    <p>{loaderEvent.message || '-'}</p>
                  </div>
                </div>
              {/each}
            {/each}
            {#each sessionTraces as trace}
              {#each trace.events as sessionEvent}
                <div class="timeline-item">
                  <time>{compactTime(sessionEvent.createdAt)}</time>
                  <div>
                    <b>{sessionEvent.type}</b>
                    <p>{sessionEvent.message || '-'}</p>
                  </div>
                </div>
              {/each}
            {/each}
          </div>
        </section>
      </aside>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    background: var(--bg);
    overflow: hidden;
  }

  .event-page {
    height: 100vh;
    height: 100dvh;
    max-height: 100vh;
    max-height: 100dvh;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 12px;
    width: min(100%, 1420px);
    margin: 0 auto;
    overflow: hidden;
    padding: 14px 18px 18px;
    background:
      linear-gradient(180deg, rgba(47, 95, 208, 0.06), transparent 260px),
      var(--bg);
  }

  .event-hero,
  .event-layout,
  .main-column,
  .side-column,
  .trace-list,
  .run-list,
  .facts,
  .section-head,
  .trace-card-head,
  .timeline-list {
    display: grid;
    gap: 12px;
  }

  .event-hero {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--shadow-md);
  }

  .hero-actions {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    min-width: 0;
  }

  .hero-session-actions {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
  }

  .eyebrow {
    margin: 0 0 6px;
    color: var(--primary);
    font-size: 12px;
    font-weight: 700;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 19px;
    line-height: 1.25;
    word-break: break-word;
  }

  h2 {
    font-size: 16px;
  }

  h3 {
    font-size: 15px;
    word-break: break-word;
  }

  .trace-card-head h3,
  .trace-card-head p {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subline,
  .trace-card p,
  .run-card p,
  .section-head span,
  .empty,
  .empty {
    color: var(--muted);
  }

  .panel,
  .trace-card,
  .run-card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }

  .facts span {
    color: var(--muted);
    font-size: 12px;
  }

  .panel {
    display: grid;
    gap: 14px;
    min-height: 0;
    padding: 14px;
  }

  .section-panel {
    gap: 18px;
  }

  .event-layout {
    grid-template-columns: minmax(0, 1fr) 420px;
    align-items: stretch;
    gap: 16px;
    min-height: 0;
  }

  .main-column,
  .side-column {
    min-width: 0;
    min-height: 0;
  }

  .main-column {
    grid-template-rows: minmax(0, 1fr);
  }

  .side-column {
    grid-template-rows: auto minmax(240px, 1.15fr) minmax(180px, 0.85fr);
    align-self: stretch;
  }

  .side-panel {
    align-content: start;
  }

  .side-scroll-panel {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .event-summary-panel {
    gap: 10px;
    padding: 12px;
  }

  .side-column > .side-panel:last-child {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .run-facts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .side-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 10px;
  }

  .wide-fact {
    grid-column: 1 / -1;
  }

  .facts div {
    display: grid;
    gap: 1px;
    min-width: 0;
  }

  .facts b {
    min-width: 0;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event-summary-panel .facts span {
    font-size: 11px;
    line-height: 14px;
  }

  .event-summary-panel .facts b {
    font-size: 11px;
    line-height: 15px;
  }

  .section-head,
  .trace-card-head {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
  }

  .trace-card-head > div:first-child,
  .run-card-head > div:first-child {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .session-card > .trace-card-head {
    align-items: center;
  }

  .session-card .trace-card-head h3 {
    font-size: 14px;
    line-height: 18px;
  }

  .session-card .trace-card-head p {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 15px;
  }

  .trace-card,
  .run-card {
    display: grid;
    gap: 14px;
    padding: 14px;
    align-content: start;
  }

  .session-card {
    height: auto;
    min-height: 300px;
    max-height: calc(100vh - 230px);
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 10px;
    padding: 12px;
    border-color: rgba(47, 95, 208, 0.24);
    box-shadow: var(--shadow-md);
    background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
    overflow: hidden;
  }

  .trace-list {
    grid-template-columns: 1fr;
    grid-auto-rows: max-content;
    min-height: 0;
    align-content: start;
    overflow: auto;
    padding-right: 2px;
  }

  .trace-list.single-session {
    grid-auto-rows: minmax(0, 1fr);
    overflow: hidden;
    padding-right: 0;
  }

  .trace-list.single-session .session-card {
    height: 100%;
    min-height: 0;
    max-height: none;
  }

  .session-panel {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .run-list {
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
  }

  .run-card {
    gap: 8px;
    padding: 10px;
    background: #fff;
    box-shadow: none;
  }

  .run-card-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .run-card h3 {
    font-size: 13px;
    line-height: 18px;
  }

  .run-card p {
    overflow: hidden;
    font-family: var(--mono);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-meta-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
    min-width: 0;
    padding: 7px 8px;
    border-radius: 6px;
    background: var(--surface-2);
  }

  .run-meta-grid div {
    min-width: 0;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
  }

  .run-meta-grid span {
    color: var(--muted);
    font-size: 10px;
    line-height: 13px;
  }

  .run-meta-grid b {
    min-width: 0;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-error {
    padding: 8px;
    border: 1px solid #ffccc7;
    border-radius: 6px;
    color: var(--danger);
    background: #fff2f0;
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .run-error-details {
    min-width: 0;
    padding: 8px;
    border: 1px solid #ffccc7;
    border-radius: 6px;
    color: var(--danger);
    background: #fff2f0;
  }

  .run-error-details summary {
    min-width: 0;
    cursor: pointer;
    font-size: 12px;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-error-details pre {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-height: 180px;
    margin: 8px 0 0;
    padding: 8px;
    border-radius: 5px;
    background: #fff;
    color: var(--danger);
    font-size: 11px;
    line-height: 1.45;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: anywhere;
  }

  .run-result pre {
    max-height: 150px;
  }

  .session-actions {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: nowrap;
    min-width: 0;
  }

  .compact-button {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 5px 9px;
    font-size: 12px;
  }

  .compact-link {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 5px 9px;
    font-size: 12px;
  }

  .event-action-button {
    flex: 0 0 auto;
    min-height: 34px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    line-height: 18px;
  }

  .primary-link {
    border-color: var(--primary);
    background: var(--primary);
    color: #fff;
  }

  .danger-lite {
    color: var(--danger);
    border-color: #ffccc7;
    background: #fff;
  }

  .timeline-list {
    gap: 8px;
    min-height: 0;
    overflow: auto;
  }

  .timeline-item {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 9px;
    min-width: 0;
    padding: 8px 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #fff;
  }

  .timeline-item b,
  .timeline-item time {
    min-width: 0;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timeline-item time {
    color: var(--muted);
  }

  .timeline-item > div {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .timeline-item b {
    color: var(--text);
  }

  .timeline-item p {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  pre {
    margin: 0;
    overflow: visible;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #07111a;
    color: #d8e2ec;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .run-result pre {
    max-height: 150px;
    overflow: auto;
  }

  .message-composer {
    align-self: end;
    display: grid;
    gap: 7px;
    min-height: 0;
    padding: 9px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
  }

  .message-composer.disabled {
    background: var(--surface-2);
  }

  .message-composer textarea {
    width: 100%;
    min-height: 64px;
    resize: none;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 9px 10px;
    color: var(--text);
    background: #fff;
    font: inherit;
    line-height: 1.45;
    box-sizing: border-box;
  }

  .message-composer textarea:disabled {
    color: var(--muted);
    background: var(--surface-2);
  }

  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .composer-actions span {
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .primary-action {
    border-color: var(--primary);
    background: var(--primary);
    color: #fff;
  }

  details {
    display: grid;
    gap: 8px;
  }

  summary {
    cursor: pointer;
    color: var(--primary);
    font-weight: 600;
  }

  .loading-panel,
  .empty {
    min-height: 120px;
    display: grid;
    place-items: center;
  }

  .compact-empty {
    min-height: 80px;
  }

  @media (max-width: 960px) {
    :global(body) {
      overflow: auto;
    }

    .event-page {
      height: auto;
      min-height: 100vh;
      overflow: visible;
      padding: 12px;
    }

    .event-hero,
    .event-layout,
    .main-column,
    .side-column,
    .trace-list,
    .run-list,
    .facts,
    .run-facts {
      grid-template-columns: 1fr;
    }

    .hero-actions,
    .hero-session-actions {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .side-column {
      grid-template-rows: none;
    }

    .timeline-list {
      max-height: none;
    }

    .trace-card-head {
      grid-template-columns: 1fr;
    }

    .session-actions {
      justify-content: flex-start;
    }

  }
</style>
