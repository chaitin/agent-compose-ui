<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

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

  type OutputSearchMatch = {
    cellId: string;
    section: 'source' | 'output';
    lineIndex: number;
  };

  type OutputSearchState = {
    query: string;
    appliedQuery: string;
    matches: OutputSearchMatch[];
    currentIndex: number;
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
  let messageAbort: AbortController | null = null;
  let outputSearches: Record<string, OutputSearchState> = {};
  let copyFeedbacks: Record<string, string> = {};
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  const cellListElements = new Map<string, HTMLElement>();
  const outputLineElements = new Map<string, HTMLElement>();
  const outputSearchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    messageAbort?.abort();
    outputSearchTimers.forEach((timer) => clearTimeout(timer));
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  });

  async function load(): Promise<void> {
    if (!eventId.trim()) {
      error = '缺少 event id';
      loading = false;
      return;
    }
    loading = true;
    error = '';
    outputSearchTimers.forEach((timer) => clearTimeout(timer));
    outputSearchTimers.clear();
    outputSearches = {};
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
    await scrollAllSessionMessagesToBottom();
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

  function cellOutput(cell: WorkSessionCell): string {
    if (cell.running && !cell.output && !cell.stopReason) return '等待回复...';
    return stripAgentResultPayload(cell.output || cell.stopReason || '-');
  }

  function cellStatus(cell: WorkSessionCell): string {
    if (cell.id.startsWith('pending-user-')) return '已发送';
    if (cell.running) return '运行中';
    return cell.success ? '完成' : `失败${cell.exitCode ? ` · ${cell.exitCode}` : ''}`;
  }

  function messageStatusTone(cell: WorkSessionCell): 'running' | 'succeeded' | 'failed' {
    if (cell.running) return 'running';
    return cell.success ? 'succeeded' : 'failed';
  }

  function isAgentCell(cell: WorkSessionCell): boolean {
    return Boolean(cell.agent) || cell.type === CellType.AGENT || cell.id.startsWith('pending-agent-');
  }

  function messageSource(cell: WorkSessionCell): string {
    if (cell.id.startsWith('pending-user-')) return cell.output;
    if (cell.agent && cell.source) return cell.source;
    return '';
  }

  function messageOutput(cell: WorkSessionCell): string {
    if (cell.id.startsWith('pending-user-')) return '';
    return cellOutput(cell);
  }

  function visibleSessionCells(cells: WorkSessionCell[]): WorkSessionCell[] {
    const meaningful = cells.filter((cell) => Boolean(messageSource(cell) || messageOutput(cell)));
    return meaningful;
  }

  const AGENT_RESULT_PREFIX = '__AGENT_RESULT__';

  function stripAgentResultPayload(text: string): string {
    const index = text.lastIndexOf(AGENT_RESULT_PREFIX);
    return index >= 0 ? text.slice(0, index) : text;
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
      if (isAgentCell(cell)) return cell;
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
    await scrollSessionMessagesToBottom(link.sessionId);
  }

  async function refreshSessionOutput(trace: SessionTrace): Promise<void> {
    const sessionId = trace.link.sessionId;
    if (!sessionId || refreshingSessionId) return;
    refreshingSessionId = sessionId;
    error = '';
    try {
      const searchState = outputSearchState(sessionId);
      const currentMatch = searchState.matches[searchState.currentIndex];
      await refreshSessionTrace(trace.link);
      if (searchState.query.trim()) applyOutputSearch(sessionId, currentMatch);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      refreshingSessionId = '';
    }
  }

  function registerCellList(node: HTMLElement, sessionId: string): { destroy: () => void } {
    if (sessionId) {
      cellListElements.set(sessionId, node);
    }
    return {
      destroy: () => {
        if (sessionId && cellListElements.get(sessionId) === node) {
          cellListElements.delete(sessionId);
        }
      },
    };
  }

  async function scrollSessionMessagesToBottom(sessionId: string): Promise<void> {
    await tick();
    const node = cellListElements.get(sessionId);
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }

  async function scrollAllSessionMessagesToBottom(): Promise<void> {
    await tick();
    for (const trace of sessionTraces) {
      const node = cellListElements.get(trace.link.sessionId);
      if (node) node.scrollTop = node.scrollHeight;
    }
  }

  function defaultOutputSearchState(): OutputSearchState {
    return { query: '', appliedQuery: '', matches: [], currentIndex: -1 };
  }

  function outputSearchState(sessionId: string): OutputSearchState {
    return outputSearches[sessionId] || defaultOutputSearchState();
  }

  function outputLines(value: string): string[] {
    return value.split(/\r?\n/);
  }

  function findOutputMatches(trace: SessionTrace, query: string): OutputSearchMatch[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];
    const matches: OutputSearchMatch[] = [];
    for (const cell of visibleSessionCells(trace.cells)) {
      const sections: Array<{ section: OutputSearchMatch['section']; value: string }> = [
        { section: 'source', value: messageSource(cell) },
        { section: 'output', value: messageOutput(cell) },
      ];
      for (const { section, value } of sections) {
        if (!value) continue;
        outputLines(value).forEach((line, lineIndex) => {
          if (line.toLocaleLowerCase().includes(normalizedQuery)) {
            matches.push({ cellId: cell.id, section, lineIndex });
          }
        });
      }
    }
    return matches;
  }

  function scheduleOutputSearch(sessionId: string, query: string): void {
    const previous = outputSearchState(sessionId);
    const queryChanged = query.trim() !== previous.appliedQuery;
    outputSearches = {
      ...outputSearches,
      [sessionId]: query.trim()
        ? { ...previous, query, currentIndex: queryChanged ? -1 : previous.currentIndex }
        : { query, appliedQuery: '', matches: [], currentIndex: -1 },
    };
    const existingTimer = outputSearchTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    if (!query.trim()) {
      outputSearchTimers.delete(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      outputSearchTimers.delete(sessionId);
      applyOutputSearch(sessionId);
    }, 160);
    outputSearchTimers.set(sessionId, timer);
  }

  function applyOutputSearch(sessionId: string, preferredMatch?: OutputSearchMatch): void {
    const trace = sessionTraces.find((item) => item.link.sessionId === sessionId);
    const previous = outputSearchState(sessionId);
    if (!trace || !previous.query.trim()) return;
    const matches = findOutputMatches(trace, previous.query);
    const preferredIndex = preferredMatch
      ? matches.findIndex((match) => outputMatchKey(sessionId, match) === outputMatchKey(sessionId, preferredMatch))
      : -1;
    const currentIndex = matches.length === 0
      ? -1
      : preferredIndex >= 0
        ? preferredIndex
        : Math.min(Math.max(previous.currentIndex, 0), matches.length - 1);
    outputSearches = {
      ...outputSearches,
      [sessionId]: { ...previous, appliedQuery: previous.query.trim(), matches, currentIndex },
    };
    if (currentIndex >= 0) void scrollToOutputMatch(sessionId, matches[currentIndex]);
  }

  function moveOutputSearch(sessionId: string, direction: -1 | 1): void {
    const pendingTimer = outputSearchTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      outputSearchTimers.delete(sessionId);
      applyOutputSearch(sessionId);
      return;
    }
    const state = outputSearchState(sessionId);
    if (state.matches.length === 0) return;
    const currentIndex = (state.currentIndex + direction + state.matches.length) % state.matches.length;
    outputSearches = { ...outputSearches, [sessionId]: { ...state, currentIndex } };
    void scrollToOutputMatch(sessionId, state.matches[currentIndex]);
  }

  function handleOutputSearchKeydown(keyboardEvent: KeyboardEvent, sessionId: string): void {
    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      moveOutputSearch(sessionId, keyboardEvent.shiftKey ? -1 : 1);
    } else if (keyboardEvent.key === 'Escape') {
      scheduleOutputSearch(sessionId, '');
    }
  }

  function outputMatchKey(sessionId: string, match: OutputSearchMatch): string {
    return `${sessionId}\u0000${match.cellId}\u0000${match.section}\u0000${match.lineIndex}`;
  }

  function registerOutputLine(node: HTMLElement, key: string): { update: (nextKey: string) => void; destroy: () => void } {
    let currentKey = '';
    function update(nextKey: string): void {
      if (currentKey && outputLineElements.get(currentKey) === node) outputLineElements.delete(currentKey);
      currentKey = nextKey;
      if (currentKey) outputLineElements.set(currentKey, node);
    }
    update(key);
    return {
      update,
      destroy: () => {
        if (currentKey && outputLineElements.get(currentKey) === node) outputLineElements.delete(currentKey);
      },
    };
  }

  async function scrollToOutputMatch(sessionId: string, match: OutputSearchMatch): Promise<void> {
    await tick();
    outputLineElements.get(outputMatchKey(sessionId, match))?.scrollIntoView({ block: 'center' });
  }

  function isCurrentOutputMatch(sessionId: string, cellId: string, section: OutputSearchMatch['section'], lineIndex: number): boolean {
    const state = outputSearchState(sessionId);
    const current = state.matches[state.currentIndex];
    return Boolean(current && current.cellId === cellId && current.section === section && current.lineIndex === lineIndex);
  }

  function highlightedOutputParts(value: string, query: string): Array<{ text: string; matched: boolean; lineIndex: number }> {
    if (!query) return [{ text: value, matched: false, lineIndex: 0 }];
    const parts: Array<{ text: string; matched: boolean; lineIndex: number }> = [];
    const normalizedValue = value.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    let offset = 0;
    let lineIndex = 0;
    while (offset < value.length) {
      const matchIndex = normalizedValue.indexOf(normalizedQuery, offset);
      if (matchIndex < 0) break;
      if (matchIndex > offset) {
        const text = value.slice(offset, matchIndex);
        parts.push({ text, matched: false, lineIndex });
        lineIndex += (text.match(/\n/g) || []).length;
      }
      parts.push({ text: value.slice(matchIndex, matchIndex + query.length), matched: true, lineIndex });
      offset = matchIndex + query.length;
    }
    if (offset < value.length) parts.push({ text: value.slice(offset), matched: false, lineIndex });
    return parts.length > 0 ? parts : [{ text: value, matched: false, lineIndex: 0 }];
  }

  function sessionOutputText(trace: SessionTrace): string {
    const blocks: string[] = [];
    for (const cell of visibleSessionCells(trace.cells)) {
      const source = messageSource(cell);
      const output = messageOutput(cell);
      if (source) blocks.push(`用户:\n${source}`);
      if (output) blocks.push(`${cell.agent || '助手'}:\n${output}`);
    }
    return blocks.join('\n\n');
  }

  async function copyAllSessionOutput(trace: SessionTrace): Promise<void> {
    const sessionId = trace.link.sessionId;
    try {
      await writeClipboardText(sessionOutputText(trace));
      copyFeedbacks = { ...copyFeedbacks, [sessionId]: '已复制' };
    } catch {
      copyFeedbacks = { ...copyFeedbacks, [sessionId]: '复制失败' };
    }
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copyFeedbacks = { ...copyFeedbacks, [sessionId]: '' };
    }, 1600);
  }

  async function writeClipboardText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('复制失败');
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
      if (proxy.notebookUrl) {
        const notebookUrl = new URL(apiPath(proxy.notebookUrl), window.location.origin).toString();
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
    void scrollSessionMessagesToBottom(sessionId);
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
    void scrollSessionMessagesToBottom(sessionId);
  }

  function replacePendingCellId(sessionId: string, previousId: string, nextId: string): void {
    if (!nextId || previousId === nextId) return;
    sessionTraces = sessionTraces.map((trace) => trace.link.sessionId === sessionId
      ? {
        ...trace,
        cells: trace.cells.map((cell) => cell.id === previousId ? { ...cell, id: nextId } : cell),
      }
      : trace);
    void scrollSessionMessagesToBottom(sessionId);
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
    void scrollSessionMessagesToBottom(sessionId);
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
                {@const searchState = outputSearchState(sessionId)}
                {@const visibleCells = visibleSessionCells(trace.cells)}
                <article class="trace-card session-card">
                  <div class="trace-card-head">
                    <div>
                      <h3>{trace.session?.title || trace.link.sessionId}</h3>
                      <p>Session {trace.link.sessionId}</p>
                    </div>
                  </div>
                  <div class="inline-block session-output">
                    <div class="session-output-head">
                      <h4>会话输出</h4>
                      <div class="session-output-toolbar">
                        <label class="output-search-field">
                          <span class="visually-hidden">搜索会话输出</span>
                          <input
                            type="search"
                            value={searchState.query}
                            placeholder="搜索输出"
                            disabled={visibleCells.length === 0}
                            on:input={(inputEvent) => scheduleOutputSearch(sessionId, inputEvent.currentTarget.value)}
                            on:keydown={(keyboardEvent) => handleOutputSearchKeydown(keyboardEvent, sessionId)}
                          >
                        </label>
                        <span class="search-count" aria-live="polite">
                          {searchState.matches.length > 0 ? `${searchState.currentIndex + 1}/${searchState.matches.length}` : '0/0'}
                        </span>
                        <button type="button" class="compact-button" disabled={searchState.matches.length === 0} on:click={() => moveOutputSearch(sessionId, -1)}>上一个</button>
                        <button type="button" class="compact-button" disabled={searchState.matches.length === 0} on:click={() => moveOutputSearch(sessionId, 1)}>下一个</button>
                        <button type="button" class="compact-button" disabled={Boolean(refreshingSessionId)} on:click={() => refreshSessionOutput(trace)}>
                          {refreshingSessionId === sessionId ? '刷新中...' : '刷新'}
                        </button>
                        <button type="button" class="compact-button" disabled={visibleCells.length === 0} on:click={() => copyAllSessionOutput(trace)}>
                          {copyFeedbacks[sessionId] || '拷贝全部'}
                        </button>
                      </div>
                    </div>
                    {#if visibleCells.length > 0}
                      <div class="cell-list message-stack" use:registerCellList={sessionId}>
                        {#each visibleCells as cell}
                          {#if messageSource(cell)}
                            <article class="message-card role-user">
                              <div class="message-cell-head">
                                <div class="message-cell-summary">
                                  <div class="message-title-row">
                                    <b>用户</b>
                                    <span class="message-cell-id">{cell.id}</span>
                                  </div>
                                </div>
                                <div class="message-cell-meta">
                                  <span>{formatTime(cell.createdAt)}</span>
                                </div>
                              </div>
                              <pre class="message-source">{#if searchState.appliedQuery}{#each highlightedOutputParts(messageSource(cell), searchState.appliedQuery) as part}{#if part.matched}<mark
                                  class="output-match"
                                  class:current-search-match={isCurrentOutputMatch(sessionId, cell.id, 'source', part.lineIndex)}
                                  use:registerOutputLine={outputMatchKey(sessionId, { cellId: cell.id, section: 'source', lineIndex: part.lineIndex })}
                                >{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{messageSource(cell)}{/if}</pre>
                            </article>
                          {/if}
                          {#if messageOutput(cell)}
                          <article class="message-card" class:failed={!cell.running && !cell.success} class:running={cell.running}>
                            <div class="message-cell-head">
                              <div class="message-cell-summary">
                                <div class="message-title-row">
                                  <b>{cell.agent || '助手'}</b>
                                  <span class="message-cell-id">{cell.id}</span>
                                  <span class={`message-status ${messageStatusTone(cell)}`}>{cellStatus(cell)}</span>
                                </div>
                              </div>
                              <div class="message-cell-meta">
                                <span>{formatTime(cell.createdAt)}</span>
                              </div>
                            </div>
                            {#if isAgentCell(cell)}
                              <div class="run-terminal-block" class:running={cell.running}>
                                <pre class="run-terminal-static">{#if searchState.appliedQuery}{#each highlightedOutputParts(messageOutput(cell), searchState.appliedQuery) as part}{#if part.matched}<mark
                                    class="output-match"
                                    class:current-search-match={isCurrentOutputMatch(sessionId, cell.id, 'output', part.lineIndex)}
                                    use:registerOutputLine={outputMatchKey(sessionId, { cellId: cell.id, section: 'output', lineIndex: part.lineIndex })}
                                  >{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{messageOutput(cell)}{/if}</pre>
                              </div>
                            {:else if messageOutput(cell)}
                              <pre class="run-terminal-static">{#if searchState.appliedQuery}{#each highlightedOutputParts(messageOutput(cell), searchState.appliedQuery) as part}{#if part.matched}<mark
                                  class="output-match"
                                  class:current-search-match={isCurrentOutputMatch(sessionId, cell.id, 'output', part.lineIndex)}
                                  use:registerOutputLine={outputMatchKey(sessionId, { cellId: cell.id, section: 'output', lineIndex: part.lineIndex })}
                                >{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{messageOutput(cell)}{/if}</pre>
                            {/if}
                          </article>
                          {/if}
                        {/each}
                      </div>
                    {:else}
                      <div class="empty compact-empty">暂无会话输出。</div>
                    {/if}
                  </div>
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
  .inline-block,
  .cell-list,
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

  .inline-block {
    min-height: 0;
    padding-top: 0;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .session-output {
    gap: 8px;
    min-height: 0;
    overflow: hidden;
  }

  .session-output-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }

  .session-output-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
  }

  .output-search-field {
    min-width: 120px;
  }

  .output-search-field input {
    box-sizing: border-box;
    width: clamp(120px, 16vw, 220px);
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text);
    background: #fff;
    font: inherit;
    font-size: 12px;
  }

  .output-search-field input:focus {
    border-color: var(--primary);
    outline: 2px solid rgba(47, 95, 208, 0.14);
  }

  .search-count {
    min-width: 36px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 11px;
    text-align: center;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  h4 {
    margin: 0;
    color: var(--text);
    font-size: 13px;
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

  .cell-list {
    gap: 8px;
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

  .cell-list {
    overflow: auto;
    padding-right: 2px;
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

  .message-card {
    gap: 6px;
    padding: 10px 12px;
  }

  .message-cell-head {
    gap: 10px;
  }

  .message-cell-meta {
    font-size: 11px;
  }

  .message-cell-id {
    display: inline-block;
    max-width: min(100%, 220px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  .message-source {
    margin: 0;
    overflow: visible;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #475569;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 17px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .output-match {
    border-radius: 2px;
    background: #fadb14;
    color: #172033;
  }

  .output-match.current-search-match {
    background: #fa8c16;
    box-shadow: 0 0 0 2px rgba(250, 140, 22, 0.35);
  }

  .run-terminal-block {
    min-width: 0;
    overflow: hidden;
  }

  .run-terminal-block .run-terminal-static {
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .message-card > .run-terminal-static {
    overflow: visible;
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

  .session-output > .compact-empty {
    min-height: 0;
    align-self: stretch;
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

    .session-output-head,
    .session-output-toolbar {
      align-items: stretch;
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .session-output-head {
      flex-direction: column;
    }

    .output-search-field {
      flex: 1 1 180px;
    }

    .output-search-field input {
      width: 100%;
    }
  }
</style>
