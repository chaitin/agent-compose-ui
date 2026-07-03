<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from 'xterm';

  import {
    getAutomationTask,
    getAutomationRun,
    listAutomationEvents,
    listLoaderRuns,
    runAutomationTaskNow,
    saveAutomationTask,
    setAutomationTaskEnabled,
    type AutomationTaskDetail,
    type AutomationRun,
    type AutomationEvent,
  } from '../api/loaders';
  import {
    getWorkSessionStatus,
    listWorkSessionCells,
    listWorkSessionEvents,
    resumeWorkSession,
    sendWorkSessionMessageStream,
    watchWorkSession,
    type WorkSession,
    type WorkSessionCell,
    type WorkSessionEvent,
  } from '../api/sessions';
  import { executeRuntimeCommandStream } from '../api/exec';
  import { formatBeijingTime } from '../time';
  import { appPath } from '../paths';
  import { CellType } from '@chaitin-ai/agent-compose-client/agentcompose/v1/agentcompose_pb.js';

  export let taskId = '';
  export let initialRunId = '';
  export let initialSessionId = '';

  type EnvItem = { name: string; value: string; secret: boolean };
  type CenterTab = 'output' | 'session';
  type TimelineEntry =
    | { kind: 'input'; id: string; timestamp: string; content: string }
    | { kind: 'loader_event'; id: string; timestamp: string; type: string; level: string; message: string; detail?: string }
    | { kind: 'session_card'; id: string; timestamp: string; sessionId: string; summary: string }
    | { kind: 'error'; id: string; timestamp: string; message: string }
    | { kind: 'artifact'; id: string; timestamp: string; name: string; size: string };

  let loading = true;
  let error = '';
  let taskDetail: AutomationTaskDetail | null = null;
  let runs: AutomationRun[] = [];
  let selectedRunId = '';
  let runDetail: AutomationRun | null = null;
  let runEvents: AutomationEvent[] = [];
  let timeline: TimelineEntry[] = [];
  let centerTab: CenterTab = 'output';

  let availableSessions: Array<{ id: string; label: string }> = [];
  let selectedSessionId = '';
  let session: WorkSession | null = null;
  let sessionCells: WorkSessionCell[] = [];
  let sessionEvents: WorkSessionEvent[] = [];
  let sessionStatus = '';
  let rawSessionStatus = '';
  let messageDraft = '';
  let sendingMessage = false;
  let resuming = false;
  let watchAbort: AbortController | null = null;
  let messageAbort: AbortController | null = null;
  let bottomRatio = 0.3;
  let activeDebugTab: 'terminal' | 'events' | 'artifacts' = 'terminal';

  let terminalEl: HTMLDivElement | null = null;
  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let termResizeObserver: ResizeObserver | null = null;
  let lineBuffer = '';
  let cursorPos = 0;
  let history: string[] = [];
  let historyIdx = -1;
  let currentCwd = '';
  let execAbort: AbortController | null = null;
  let execRunning = false;
  let termReady = false;
  let savedLineBeforeHistory = '';

  let drawerOpen = false;
  let scriptDraft = '';
  let envDraft: EnvItem[] = [];
  let scriptScrollTop = 0;
  let scriptScrollLeft = 0;
  let saving = false;
  let runResult: { success: boolean; message: string; runId?: string } | null = null;

  let schedulerPaused = false;
  let taskWasEnabled = false;
  let showEnterPauseDialog = false;
  let showLeaveDialog = false;
  let pendingLeaveAction: 'enable' | 'keep_disabled' | null = null;

  let splitContainer: HTMLDivElement | null = null;
  let chatMessagesEl: HTMLDivElement | null = null;
  let dragging = false;

  $: chatMessages = buildSessionChatMessages(sessionCells);

  onMount(() => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    void load();
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      stopWatching();
      messageAbort?.abort();
      destroyTerminal();
    };
  });

  onDestroy(() => {
    stopWatching();
    messageAbort?.abort();
    destroyTerminal();
  });

  // ── Data Loading ──

  async function load(): Promise<void> {
    if (!taskId) return;
    loading = true;
    error = '';
    try {
      taskDetail = await getAutomationTask(taskId);
      scriptDraft = taskDetail.script || '';
      envDraft = taskDetail.envItems.map((e) => ({ ...e }));
      taskWasEnabled = taskDetail.enabled;

      const allRuns = await listLoaderRuns(taskId, 100);
      runs = allRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      const allEvents = await listAutomationEvents(taskId, 500);
      const sessionIds = new Set<string>();
      for (const e of allEvents) {
        if (e.linkedSessionId) sessionIds.add(e.linkedSessionId);
        if (e.linkedAgentSessionId) sessionIds.add(e.linkedAgentSessionId);
      }
      availableSessions = Array.from(sessionIds).map((id) => ({ id, label: id.substring(0, 8) }));

      if (initialRunId && runs.some((r) => r.id === initialRunId)) {
        selectedRunId = initialRunId;
        await loadRunDetail(initialRunId);
        centerTab = 'output';
      }
      if (initialSessionId && sessionIds.has(initialSessionId)) {
        selectedSessionId = initialSessionId;
        await loadSessionDetail(initialSessionId);
        centerTab = 'session';
      }

      if (taskWasEnabled) {
        showEnterPauseDialog = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadRunDetail(runId: string): Promise<void> {
    try {
      const [detail, events] = await Promise.all([
        getAutomationRun(taskId, runId),
        listAutomationEvents(taskId, 500),
      ]);
      runDetail = detail;
      runEvents = events.filter((e) => !e.runId || e.runId === runId);
      buildTimeline(detail, runEvents);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function buildTimeline(detail: AutomationRun, events: AutomationEvent[]): void {
    const entries: TimelineEntry[] = [];

    if (detail.payloadJson) {
      entries.push({ kind: 'input', id: 'input', timestamp: detail.startedAt, content: tryFormatJson(detail.payloadJson) });
    }

    for (const e of events) {
      entries.push({
        kind: 'loader_event',
        id: e.id,
        timestamp: e.createdAt,
        type: e.type,
        level: e.level,
        message: e.message,
        detail: e.payloadJson ? tryFormatJson(e.payloadJson) : undefined,
      });
      if (e.linkedSessionId || e.linkedAgentSessionId) {
        const sid = e.linkedSessionId || e.linkedAgentSessionId;
        if (!entries.some((en) => en.kind === 'session_card' && en.sessionId === sid)) {
          entries.push({
            kind: 'session_card',
            id: `session-${sid}-${e.id}`,
            timestamp: e.createdAt,
            sessionId: sid,
            summary: translateEventType(e.type),
          });
        }
      }
    }

    if (detail.error) {
      entries.push({ kind: 'error', id: 'error', timestamp: detail.completedAt || detail.startedAt, message: detail.error });
    }

    if (detail.resultJson) {
      entries.push({ kind: 'input', id: 'result', timestamp: detail.completedAt || detail.startedAt, content: tryFormatJson(detail.resultJson) });
    }

    if (detail.artifactsDir) {
      entries.push({ kind: 'artifact', id: 'artifact', timestamp: detail.completedAt || detail.startedAt, name: detail.artifactsDir, size: '-' });
    }

    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    timeline = entries;
  }

  async function loadSessionDetail(sid: string): Promise<void> {
    try {
      const [status, cells, evts] = await Promise.all([
        getWorkSessionStatus(sid).catch(() => null),
        listWorkSessionCells(sid).catch(() => []),
        listWorkSessionEvents(sid).catch(() => []),
      ]);
      session = status;
      rawSessionStatus = status?.status || '';
      sessionStatus = mapSessionStatus(rawSessionStatus);
      sessionCells = cells;
      sessionEvents = evts;
      if (status?.workspacePath) currentCwd = status.workspacePath;
      if (!currentCwd) currentCwd = '/root';
      startWatching(sid);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Helpers ──

  function mapSessionStatus(s: string): string {
    const n = (s || '').toUpperCase();
    if (n === 'PENDING') return '等待中';
    if (n === 'STARTING') return '启动中';
    if (n === 'RUNNING') return '运行中';
    if (n === 'FAILED' || n === 'START_FAILED') return '启动失败';
    if (n === 'STOPPED') return '已停止';
    return s || '未知';
  }

  function runStatusLabel(r: AutomationRun): string {
    const n = (r.status || '').toUpperCase();
    if (n === 'SUCCEEDED' || n === 'SUCCESS') return '成功';
    if (n === 'FAILED' || n === 'FAILURE') return '失败';
    if (n === 'RUNNING') return '运行中';
    if (n === 'PENDING') return '等待中';
    if (n === 'CANCELED' || n === 'CANCELLED') return '已取消';
    if (n === 'SKIPPED') return '跳过';
    return r.status || '未知';
  }

  function runStatusColor(r: AutomationRun): string {
    const s = runStatusLabel(r);
    if (['失败', '已取消', '跳过'].includes(s)) return 'red';
    if (s === '成功') return 'green';
    if (s === '运行中') return 'blue';
    return 'gray';
  }

  function formatDuration(ms: number): string {
    if (ms <= 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function translateEventType(type: string): string {
    const map: Record<string, string> = {
      'loader.run.skipped': 'Run 跳过', 'loader.run.started': 'Run 开始', 'loader.run.completed': 'Run 完成', 'loader.run.failed': 'Run 失败',
      'loader.log': '自定义日志', 'loader.event.published': '事件发布', 'loader.event.publish.failed': '事件发布失败',
      'loader.session.resumed': 'Session 就绪', 'loader.session.rpc.completed': 'RPC 完成', 'loader.session.rpc.failed': 'RPC 失败',
      'loader.agent.completed': 'Agent 完成', 'loader.agent.failed': 'Agent 失败',
      'loader.session.stopped': 'Session 停止', 'loader.session.stop_failed': 'Session 停止失败',
      'loader.command.completed': '命令完成', 'loader.command.failed': '命令失败',
      'loader.llm.completed': 'LLM 完成', 'loader.llm.failed': 'LLM 失败',
      'session.created': 'Session 创建', 'session.resumed': 'Session 恢复', 'session.stopped': 'Session 停止',
      'agent.started': 'Agent 启动', 'agent.completed': 'Agent 完成', 'agent.failed': 'Agent 失败',
    };
    return map[type] || type;
  }

  function eventLevelClass(level: string): string {
    const v = (level || '').toLowerCase();
    if (v === 'error' || v === 'critical' || v === 'fatal') return 'tl-error';
    if (v === 'warning' || v === 'warn') return 'tl-warning';
    return '';
  }

  function tryFormatJson(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }

  function groupRunsByDate(runList: AutomationRun[]): Array<{ label: string; items: AutomationRun[] }> {
    const groups = new Map<string, AutomationRun[]>();
    for (const r of runList) {
      const d = new Date(r.startedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }

  function selectSession(sid: string): void {
    selectedSessionId = sid;
    centerTab = 'session';
    void loadSessionDetail(sid);
  }

  // ── Scheduler Pause ──

  function confirmPauseScheduler(): void {
    showEnterPauseDialog = false;
    void setAutomationTaskEnabled(taskId, false).then(() => {
      schedulerPaused = true;
    });
  }

  function declinePauseScheduler(): void {
    showEnterPauseDialog = false;
    schedulerPaused = false;
  }

  function showLeaveConfirm(): void {
    if (schedulerPaused) {
      showLeaveDialog = true;
    } else {
      window.location.assign(appPath('/automation-tasks'));
    }
  }

  function initiateLeave(action: 'enable' | 'keep_disabled'): void {
    showLeaveDialog = false;
    if (action === 'enable') {
      void setAutomationTaskEnabled(taskId, true);
    }
    schedulerPaused = false;
    window.location.assign(appPath('/automation-tasks'));
  }

  function cancelLeave(): void {
    showLeaveDialog = false;
  }

  function handleBeforeUnload(e: BeforeUnloadEvent): void {
    if (schedulerPaused) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  // ── Session Chat ──

  function buildSessionChatMessages(cellList: WorkSessionCell[]): Array<{ id: string; role: string; content: string; timestamp: string; agent?: string; running?: boolean; exitCode?: number; stopReason?: string; success?: boolean }> {
    return cellList.map((cell) => ({
      id: cell.id,
      role: cell.type === CellType.UNSPECIFIED ? 'user' : cell.type === CellType.AGENT ? 'agent' : 'system',
      content: cell.type === CellType.UNSPECIFIED ? (cell.source || '') : (cell.output || ''),
      timestamp: cell.createdAt || '',
      agent: cell.agent || undefined,
      running: cell.running,
      exitCode: cell.exitCode,
      stopReason: cell.stopReason || undefined,
      success: cell.success,
    }));
  }

  function canResumeSession(): boolean {
    return Boolean(selectedSessionId) && ['已停止', '启动失败'].includes(sessionStatus) && !resuming;
  }

  function canChat(): boolean {
    return Boolean(selectedSessionId) && rawSessionStatus === 'RUNNING' && !sendingMessage;
  }

  async function resumeCurrentSession(): Promise<void> {
    if (!canResumeSession() || !selectedSessionId) return;
    resuming = true;
    error = '';
    try {
      const updated = await resumeWorkSession(selectedSessionId);
      rawSessionStatus = updated.status;
      sessionStatus = mapSessionStatus(rawSessionStatus);
      session = updated;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      resuming = false;
    }
  }

  function latestAgentName(): string {
    for (let i = sessionCells.length - 1; i >= 0; i--) {
      if (sessionCells[i].agent) return sessionCells[i].agent;
    }
    return 'codex';
  }

  async function sendMessage(): Promise<void> {
    const text = messageDraft.trim();
    if (!text || !canChat() || !selectedSessionId) return;
    messageAbort?.abort();
    const controller = new AbortController();
    messageAbort = controller;
    sendingMessage = true;
    const pendingUser: WorkSessionCell = {
      id: `pending-u-${Date.now()}`, source: text, output: text, type: CellType.UNSPECIFIED,
      exitCode: 0, success: true, createdAt: new Date().toISOString(), agent: '',
      agentSessionId: '', stopReason: '', running: false,
    };
    const pendingAgent: WorkSessionCell = {
      id: `pending-a-${Date.now()}`, source: '', output: '', type: CellType.AGENT,
      exitCode: 0, success: false, createdAt: new Date().toISOString(), agent: latestAgentName(),
      agentSessionId: '', stopReason: '', running: true,
    };
    sessionCells = [...sessionCells, pendingUser, pendingAgent];
    messageDraft = '';
    error = '';
    try {
      await sendWorkSessionMessageStream(selectedSessionId, latestAgentName(), text, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'completed' && event.run) {
          sessionCells = sessionCells.map((c) =>
            c.id === pendingAgent.id || c.id === event.run!.id
              ? { ...c, id: event.run!.id, output: event.run!.output, exitCode: event.run!.exitCode, success: event.run!.success, stopReason: event.run!.stopReason || '', running: false, createdAt: event.run!.createdAt || c.createdAt }
              : c,
          );
        } else if (event.type === 'chunk' && event.chunk) {
          sessionCells = sessionCells.map((c) =>
            c.id === pendingAgent.id || c.id === event.runId
              ? { ...c, output: c.output + event.chunk }
              : c,
          );
        }
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) error = err instanceof Error ? err.message : String(err);
    } finally {
      sendingMessage = false;
      if (messageAbort === controller) messageAbort = null;
    }
  }

  function handleMessageKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    void sendMessage();
  }

  function startWatching(sid: string): void {
    stopWatching();
    const controller = new AbortController();
    watchAbort = controller;
    void watchLoop(controller, sid);
  }

  async function watchLoop(ctrl: AbortController, sid: string): Promise<void> {
    while (!ctrl.signal.aborted) {
      try {
        await watchWorkSession(sid, (evt) => {
          if (ctrl.signal.aborted) return;
          if (evt.type === 'session' && evt.session) {
            session = evt.session;
            rawSessionStatus = evt.session.status;
            sessionStatus = mapSessionStatus(rawSessionStatus);
          } else if (evt.type === 'event' && evt.event) {
            sessionEvents = [evt.event, ...sessionEvents];
          } else if (evt.type === 'cell' && evt.cell) {
            const idx = sessionCells.findIndex((c) => c.id === evt.cell!.id);
            if (idx >= 0) sessionCells = [...sessionCells.slice(0, idx), evt.cell, ...sessionCells.slice(idx + 1)];
            else sessionCells = [...sessionCells, evt.cell];
          } else if (evt.type === 'chunk') {
            const idx = sessionCells.findIndex((c) => c.id === evt.cellId);
            if (idx >= 0) {
              const c = sessionCells[idx];
              sessionCells = [...sessionCells.slice(0, idx), { ...c, output: c.output + evt.chunk, running: true }, ...sessionCells.slice(idx + 1)];
            }
          }
        }, ctrl.signal);
      } catch { /* stream ended */ }
      if (!ctrl.signal.aborted) await delay(2000, ctrl.signal);
    }
  }

  function stopWatching(): void {
    watchAbort?.abort();
    watchAbort = null;
  }

  function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });
  }

  // ── Terminal ──

  $: if (terminalEl && !termReady && activeDebugTab === 'terminal') initTerminal();

  function initTerminal(): void {
    if (termReady || !terminalEl) return;
    term = new Terminal({
      convertEol: true, disableStdin: false, cursorBlink: true, cursorStyle: 'bar',
      fontFamily: 'IBM Plex Mono, Fira Code, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13, lineHeight: 1.25, scrollback: 5000, allowProposedApi: true,
      theme: {
        background: '#0a1628', foreground: '#d8e2ec', cursor: '#ffbf69',
        selectionBackground: 'rgba(255,191,105,0.28)',
        black: '#1a2332', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
        brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#f8fafc',
      },
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalEl);
    fitTerminal();
    termResizeObserver = new ResizeObserver(() => fitTerminal());
    termResizeObserver.observe(terminalEl);
    term.onData(handleTerminalInput);
    termReady = true;
    showPrompt();
  }

  function destroyTerminal(): void {
    execAbort?.abort();
    termResizeObserver?.disconnect();
    termResizeObserver = null;
    try { fitAddon?.dispose(); } catch { /* ignore */ }
    term?.dispose();
    term = null; fitAddon = null; termReady = false; execRunning = false;
    lineBuffer = ''; cursorPos = 0;
  }

  function fitTerminal(): void { try { fitAddon?.fit(); } catch { /* ignore */ } }

  function showPrompt(): void {
    const user = 'root';
    const host = selectedSessionId ? selectedSessionId.substring(0, 8) : '--------';
    const dir = currentCwd || '/';
    term?.write(`\x1b[32m${user}@${host}\x1b[0m:\x1b[34m${dir}\x1b[0m# `);
  }

  function redrawAfterPrompt(): void {
    term?.write('\r\x1b[K');
    showPrompt();
    if (lineBuffer) {
      term?.write(lineBuffer);
      const delta = lineBuffer.length - cursorPos;
      if (delta > 0) term?.write(`\x1b[${delta}D`);
    }
  }

  function handleTerminalInput(data: string): void {
    if (!term || !termReady) return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code === 3) { term.write('^C\r\n'); if (execRunning) { execAbort?.abort(); execAbort = null; execRunning = false; } lineBuffer = ''; cursorPos = 0; showPrompt(); continue; }
      if (code === 12) { term.clear(); showPrompt(); term.write(lineBuffer); continue; }
      if (code === 21) { term.write('\r\x1b[K'); lineBuffer = ''; cursorPos = 0; showPrompt(); continue; }
      if (code === 127) { if (cursorPos > 0) { lineBuffer = lineBuffer.slice(0, cursorPos - 1) + lineBuffer.slice(cursorPos); cursorPos--; redrawAfterPrompt(); } continue; }
      if (code === 13) { term.write('\r\n'); const cmd = lineBuffer.trim(); lineBuffer = ''; cursorPos = 0; historyIdx = -1; if (cmd) { history = [cmd, ...history].slice(0, 200); void executeTerminalCommand(cmd); } else { showPrompt(); } continue; }
      if (ch === '\x1b[A') { if (historyIdx === -1) { savedLineBeforeHistory = lineBuffer; historyIdx = 0; } else if (historyIdx < history.length - 1) { historyIdx++; } lineBuffer = history[historyIdx] || savedLineBeforeHistory; cursorPos = lineBuffer.length; redrawAfterPrompt(); continue; }
      if (ch === '\x1b[B') { if (historyIdx > 0) { historyIdx--; lineBuffer = history[historyIdx]; } else if (historyIdx === 0) { historyIdx = -1; lineBuffer = savedLineBeforeHistory; } cursorPos = lineBuffer.length; redrawAfterPrompt(); continue; }
      if (ch === '\x1b[D') { if (cursorPos > 0) { cursorPos--; term.write('\x1b[D'); } continue; }
      if (ch === '\x1b[C') { if (cursorPos < lineBuffer.length) { cursorPos++; term.write('\x1b[C'); } continue; }
      if (code === 1 || ch === '\x1b[H') { const d = cursorPos; if (d > 0) term.write(`\x1b[${d}D`); cursorPos = 0; continue; }
      if (code === 5 || ch === '\x1b[F') { const d = lineBuffer.length - cursorPos; if (d > 0) term.write(`\x1b[${d}C`); cursorPos = lineBuffer.length; continue; }
      if (ch.startsWith('\x1b')) continue;
      if (ch >= ' ') {
        if (cursorPos === lineBuffer.length) { lineBuffer += ch; cursorPos++; term.write(ch); }
        else { lineBuffer = lineBuffer.slice(0, cursorPos) + ch + lineBuffer.slice(cursorPos); cursorPos++; redrawAfterPrompt(); }
      }
    }
  }

  async function executeTerminalCommand(cmd: string): Promise<void> {
    if (cmd === 'clear') { term?.clear(); showPrompt(); return; }
    if (cmd === 'cd' || cmd.startsWith('cd ')) {
      const target = cmd.slice(2).trim();
      if (target === '') currentCwd = session?.workspacePath || '/root';
      else currentCwd = resolvePath(currentCwd, target);
      showPrompt(); return;
    }
    execAbort?.abort();
    const controller = new AbortController();
    execAbort = controller;
    execRunning = true;
    try {
      await executeRuntimeCommandStream(
        { sessionId: selectedSessionId, command: cmd, cwd: currentCwd, timeoutMs: 0 },
        (evt) => {
          if (controller.signal.aborted) return;
          if (evt.type === 'chunk') {
            if (evt.isStderr) term?.write(`\x1b[31m${evt.chunk}\x1b[0m`);
            else term?.write(evt.chunk);
          }
          if (evt.type === 'completed' && evt.result) {
            term?.write(`\r\n\x1b[${evt.result.exitCode === 0 ? 32 : 31}m[exit ${evt.result.exitCode}]\x1b[0m\r\n`);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) term?.write(`\r\n\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
    } finally {
      execAbort = null; execRunning = false; showPrompt();
    }
  }

  function resolvePath(base: string, target: string): string {
    if (target.startsWith('/')) return target;
    const parts = base.split('/').filter(Boolean);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  // ── Drawer ──

  function addEnvItem(): void { envDraft = [...envDraft, { name: '', value: '', secret: false }]; }
  function removeEnvItem(idx: number): void { envDraft = envDraft.filter((_, i) => i !== idx); }

  function discardEdits(): void {
    if (taskDetail) {
      scriptDraft = taskDetail.script || '';
      envDraft = taskDetail.envItems.map((e) => ({ ...e }));
      runResult = null;
    }
  }

  async function saveAndRun(): Promise<void> {
    if (!taskDetail || saving) return;
    saving = true;
    error = '';
    runResult = null;
    try {
      const updated = await saveAutomationTask({
        id: taskDetail.id,
        name: taskDetail.name,
        description: taskDetail.description,
        runtime: taskDetail.runtime,
        script: scriptDraft,
        workspaceId: taskDetail.workspaceId,
        driver: taskDetail.driver,
        guestImage: taskDetail.guestImage,
        agentId: taskDetail.agentId,
        capsetIds: taskDetail.capsetIds,
        defaultAgent: taskDetail.defaultAgent,
        sessionPolicy: taskDetail.sessionPolicy,
        concurrencyPolicy: taskDetail.concurrencyPolicy,
        enabled: taskDetail.enabled,
        envItems: envDraft.filter((e) => e.name.trim()),
      });
      taskDetail = updated;
      const run = await runAutomationTaskNow(taskDetail.id, '{}');
      const isSuccess = run.status.toUpperCase() === 'SUCCEEDED' || run.status.toUpperCase() === 'SUCCESS';
      runResult = { success: isSuccess, message: run.error || runStatusLabel(run), runId: run.id };
      runs = [run, ...runs];
    } catch (err) {
      runResult = { success: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      saving = false;
    }
  }

  function goToNewRun(): void {
    if (runResult?.runId) {
      selectedRunId = runResult.runId;
      drawerOpen = false;
      void loadRunDetail(runResult.runId);
      centerTab = 'output';
    }
  }

  function syncCodeScroll(e: Event): void {
    const t = e.currentTarget as HTMLTextAreaElement;
    scriptScrollTop = t.scrollTop;
    scriptScrollLeft = t.scrollLeft;
  }

  function highlightedJS(source: string): string {
    const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
    return escapeHtml(source).replace(pattern, (token) => {
      if (token.startsWith('//') || token.startsWith('/*')) return `<span class="tok-comment">${token}</span>`;
      if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return `<span class="tok-string">${token}</span>`;
      if (/^\d/.test(token)) return `<span class="tok-number">${token}</span>`;
      if (/^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)$/.test(token)) return `<span class="tok-keyword">${token}</span>`;
      return `<span class="tok-function">${token}</span>`;
    });
  }

  function escapeHtml(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Resize Handle ──

  function handleResizeStart(e: MouseEvent): void {
    e.preventDefault();
    dragging = true;
    const startY = e.clientY;
    const startRatio = bottomRatio;
    const h = splitContainer?.clientHeight || window.innerHeight;
    function onMove(me: MouseEvent): void {
      const d = startY - me.clientY;
      bottomRatio = Math.min(0.6, Math.max(0.12, startRatio + d / h));
    }
    function onUp(): void {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function scrollChatToBottom(_msgs: unknown, el: HTMLDivElement | null): void {
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }
  $: scrollChatToBottom(chatMessages, chatMessagesEl);

  function shortId(id: string): string { return id ? id.substring(0, 8) : ''; }
  function formatTime(v: string | undefined): string { return v ? formatBeijingTime(v) : '-'; }
</script>

{#if loading}
  <div class="alert info">正在加载任务调试信息...</div>
{:else if error && !taskDetail}
  <div class="alert danger">{error}</div>
{:else if !taskDetail}
  <div class="alert info">任务不存在</div>
{:else}
  <!-- Enter Pause Dialog -->
  {#if showEnterPauseDialog}
    <div class="td-dialog-mask" role="dialog">
      <div class="td-dialog-card">
        <h3>暂停任务调度</h3>
        <p>进入调试模式将暂停该任务的所有自动触发（定时 / 周期 / 事件 / 延迟），以免干扰排查。是否暂停？</p>
        <div class="td-dialog-actions">
          <button on:click={declinePauseScheduler}>跳过（保持启用）</button>
          <button class="primary" on:click={confirmPauseScheduler}>确认暂停</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Leave Dialog -->
  {#if showLeaveDialog}
    <div class="td-dialog-mask" role="dialog">
      <div class="td-dialog-card">
        <h3>离开调试模式</h3>
        <p>当前任务调度已暂停。离开后是否恢复任务调度？</p>
        <div class="td-dialog-actions">
          <button on:click={cancelLeave}>取消</button>
          <button on:click={() => initiateLeave('keep_disabled')}>保持暂停</button>
          <button class="primary" on:click={() => initiateLeave('enable')}>恢复调度</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Pause Banner -->
  {#if schedulerPaused}
    <div class="td-pause-banner">调试模式——任务调度已暂停，离开后自动恢复</div>
  {/if}

  {#if error}
    <div class="alert danger">{error}</div>
  {/if}

  <div class="page-title">
    <div>
      <h2>任务调试 · {taskDetail.name || taskId}</h2>
    </div>
    <div class="toolbar">
      <button on:click={showLeaveConfirm}>← 返回任务列表</button>
      <button on:click={() => (drawerOpen = !drawerOpen)}>{drawerOpen ? '关闭编辑器' : '代码 / 变量编辑'}</button>
      <button on:click={() => load()}>{loading ? '加载中...' : '刷新'}</button>
    </div>
  </div>

  <div class="td-layout" class:td-drawer-open={drawerOpen}>
    <!-- Left Sidebar -->
    <aside class="td-sidebar">
      <div class="td-sidebar-head">
        <h3>运行记录</h3>
        <span>{runs.length} 次</span>
      </div>
      <div class="td-sidebar-body">
        {#if runs.length === 0}
          <div class="empty">暂无运行记录</div>
        {:else}
          {#each groupRunsByDate(runs) as group}
            <div class="td-run-group">
              <div class="td-date-label">{group.label}</div>
              {#each group.items as run}
                <button
                  class="td-run-item"
                  class:td-run-active={selectedRunId === run.id}
                  on:click={() => { selectedRunId = run.id; void loadRunDetail(run.id); centerTab = 'output'; }}
                >
                  <span class={`td-status-dot ${runStatusColor(run)}`}></span>
                  <span class="td-run-info">
                    <span class="td-run-time">{formatBeijingTime(run.startedAt).split(' ')[1] || formatBeijingTime(run.startedAt)}</span>
                    <span class="td-run-status">{runStatusLabel(run)}</span>
                  </span>
                  <span class="td-run-duration">{formatDuration(run.durationMs)}</span>
                </button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </aside>

    <!-- Center Area -->
    <div class="td-center">
      <div class="td-center-tabs">
        <button class:active={centerTab === 'output'} on:click={() => (centerTab = 'output')}>运行输出</button>
        <button class:active={centerTab === 'session'} on:click={() => (centerTab = 'session')}>Session 调试</button>
      </div>

      {#if centerTab === 'output'}
        <div class="td-output-tab">
          {#if !selectedRunId}
            <div class="empty">请从左侧选择一条运行记录</div>
          {:else if !runDetail}
            <div class="empty">加载中...</div>
          {:else}
            <div class="td-run-output-header">
              <span>运行 #{shortId(selectedRunId)}</span>
              <span class={`home-pill ${runStatusColor(runDetail)}`}>{runStatusLabel(runDetail)}</span>
              <span>{formatDuration(runDetail.durationMs)}</span>
            </div>
            <div class="td-timeline">
              {#if timeline.length === 0}
                <div class="empty">暂无时间线数据</div>
              {:else}
                {#each timeline as entry (`${entry.kind}-${entry.id}`)}
                  <div class="td-tl-item td-tl-{entry.kind} {eventLevelClass((entry as any).level)}">
                    <span class="td-tl-time">{formatBeijingTime(entry.timestamp)}</span>
                    <span class="td-tl-content">
                      {#if entry.kind === 'input'}
                        <span class="td-tl-badge input">输入</span>
                        {#if entry.id === 'result'}<span class="td-tl-badge result">结果</span>{/if}
                        <pre class="td-tl-body">{entry.content}</pre>
                      {:else if entry.kind === 'loader_event'}
                        <span class="td-tl-badge event">{translateEventType(entry.type)}</span>
                        {#if entry.type}<span class="td-tl-event-type">{entry.type}</span>{/if}
                        <span class="td-tl-message">{entry.message}</span>
                        {#if entry.detail}
                          <pre class="td-tl-detail">{entry.detail}</pre>
                        {/if}
                      {:else if entry.kind === 'session_card'}
                        <span class="td-tl-badge session">会话</span>
                        <button class="td-tl-link" on:click={() => selectSession(entry.sessionId)}>
                          查看会话 {shortId(entry.sessionId)} — {entry.summary}
                        </button>
                      {:else if entry.kind === 'error'}
                        <span class="td-tl-badge err">错误</span>
                        <span class="td-tl-message td-tl-error-text">{entry.message}</span>
                      {:else if entry.kind === 'artifact'}
                        <span class="td-tl-badge artifact">产出物</span>
                        <span class="td-tl-message">{entry.name}</span>
                      {/if}
                    </span>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <!-- Session Debug Tab -->
        <div class="td-session-tab">
          <div class="td-session-top-bar">
            <select bind:value={selectedSessionId} on:change={() => { if (selectedSessionId) { void loadSessionDetail(selectedSessionId); } }}>
              <option value="">选择会话...</option>
              {#each availableSessions as s}
                <option value={s.id}>会话 {s.label}</option>
              {/each}
            </select>
            <button disabled={!canResumeSession()} on:click={resumeCurrentSession}>
              {resuming ? '重启中...' : '重启会话'}
            </button>
          </div>

          {#if !selectedSessionId}
            <div class="empty">请选择要调试的会话</div>
          {:else}
            <div class="td-split-view" bind:this={splitContainer} class:td-dragging={dragging}>
              <!-- Chat Area -->
              <div class="td-chat-pane" style="height: {((1 - bottomRatio) * 100)}%">
                <div class="td-chat-messages" bind:this={chatMessagesEl}>
                  {#if chatMessages.length === 0}
                    <div class="td-chat-empty">暂无对话消息</div>
                  {:else}
                    {#each chatMessages as msg (msg.id)}
                      <div class="td-chat-msg td-chat-{msg.role}" class:td-chat-running={msg.running}>
                        <div class="td-chat-head">
                          <span class="td-chat-role">
                            {#if msg.role === 'user'}用户{:else if msg.role === 'agent'}{msg.agent || 'Agent'}{:else}系统{/if}
                          </span>
                          <span class="td-chat-time">{formatTime(msg.timestamp)}</span>
                          {#if msg.running}<span class="td-chat-running-badge">输出中...</span>{/if}
                          {#if msg.stopReason}<span class="td-chat-stop-reason">{msg.stopReason}</span>{/if}
                        </div>
                        <pre class="td-chat-body">{msg.content || (msg.running ? '等待输出...' : '(无内容)')}</pre>
                      </div>
                    {/each}
                  {/if}
                </div>
                <div class="td-chat-composer" class:td-chat-disabled={!canChat()}>
                  <textarea
                    rows="3"
                    value={messageDraft}
                    placeholder={canChat() ? '输入消息，Enter 发送' : `会话${sessionStatus || '未运行'}`}
                    disabled={!canChat()}
                    on:input={(e) => (messageDraft = e.currentTarget.value)}
                    on:keydown={handleMessageKeydown}
                  ></textarea>
                  <div class="td-composer-actions">
                    <span>{canChat() ? 'Enter 发送 · Shift + Enter 换行' : `会话${sessionStatus || '未运行'}`}</span>
                    <button disabled={!canChat() || !messageDraft.trim()} on:click={sendMessage}>
                      {sendingMessage ? '发送中...' : '发送'}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Resize Handle -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div class="td-resize-handle" role="separator" on:mousedown={handleResizeStart}>
                <div class="td-resize-line"></div>
              </div>

              <!-- Bottom Debug Panel -->
              <div class="td-bottom-panel" style="height: {(bottomRatio * 100)}%">
                <div class="td-debug-tabs">
                  <button class:active={activeDebugTab === 'terminal'} on:click={() => (activeDebugTab = 'terminal')}>终端</button>
                  <button class:active={activeDebugTab === 'events'} on:click={() => (activeDebugTab = 'events')}>事件</button>
                  <button class:active={activeDebugTab === 'artifacts'} on:click={() => (activeDebugTab = 'artifacts')}>产出物</button>
                </div>
                <div class="td-debug-tab-content">
                  {#if activeDebugTab === 'terminal'}
                    <div class="td-terminal-container" bind:this={terminalEl}></div>
                  {:else if activeDebugTab === 'events'}
                    <div class="td-events-list">
                      {#if sessionEvents.length === 0}
                        <div class="empty">暂无事件</div>
                      {:else}
                        {#each sessionEvents as evt}
                          <div class="td-event-row {eventLevelClass(evt.level)}">
                            <span class="td-evt-time">{formatTime(evt.createdAt)}</span>
                            <span class="td-evt-type">{translateEventType(evt.type)}</span>
                            {#if evt.level}<span class="td-evt-level {eventLevelClass(evt.level)}">{evt.level}</span>{/if}
                            <span class="td-evt-msg">{evt.message}</span>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  {:else}
                    <div class="td-artifacts-tab">
                      <p class="muted">产出物浏览需在终端中执行命令查看。</p>
                      <p class="muted">例如: <code>ls -la /workspace</code></p>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Right Drawer -->
    {#if drawerOpen}
      <aside class="td-drawer">
        <div class="td-drawer-head">
          <h3>任务工作区</h3>
          <button class="td-drawer-close" on:click={() => (drawerOpen = false)}>✕</button>
        </div>
        <div class="td-drawer-body">
          <section class="td-drawer-section">
            <h4>JS 脚本</h4>
            <div class="td-code-editor-wrap">
              <pre class="td-code-highlight" aria-hidden="true" style="transform: translate({-scriptScrollLeft}px, {-scriptScrollTop}px);">{@html highlightedJS(scriptDraft)}</pre>
              <textarea
                class="td-code-editor"
                rows="16"
                spellcheck="false"
                bind:value={scriptDraft}
                on:scroll={syncCodeScroll}
              ></textarea>
            </div>
          </section>

          <section class="td-drawer-section">
            <div class="td-section-head">
              <h4>环境变量</h4>
              <button on:click={addEnvItem}>添加变量</button>
            </div>
            {#if envDraft.length === 0}
              <p class="muted">未配置环境变量</p>
            {:else}
              {#each envDraft as item, i}
                <div class="td-env-row">
                  <input bind:value={item.name} placeholder="KEY">
                  <input bind:value={item.value} placeholder="VALUE" type={item.secret ? 'password' : 'text'}>
                  <label class="td-env-secret"><input type="checkbox" bind:checked={item.secret}> 敏感</label>
                  <button on:click={() => removeEnvItem(i)}>删除</button>
                </div>
              {/each}
            {/if}
          </section>

          <div class="td-drawer-actions">
            <button on:click={discardEdits}>撤销</button>
            <button class="primary" disabled={saving} on:click={saveAndRun}>
              {saving ? '保存并运行中...' : '保存并运行'}
            </button>
          </div>

          {#if runResult}
            <section class="td-drawer-section">
              <h4>运行结果</h4>
              <div class="td-result-card" class:td-result-success={runResult.success} class:td-result-failed={!runResult.success}>
                <span>{runResult.success ? '成功' : '失败'}</span>
                <span>{runResult.message}</span>
              </div>
              {#if runResult.runId}
                <button class="td-view-output-btn" on:click={goToNewRun}>查看全量输出 →</button>
              {/if}
            </section>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
{/if}

<style>
  /* Dialog */
  .td-dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .td-dialog-card { background: #fff; border-radius: 8px; padding: 24px; max-width: 440px; box-shadow: var(--shadow-lg); }
  .td-dialog-card h3 { margin: 0 0 8px; font-size: var(--font-size-md); }
  .td-dialog-card p { margin: 0 0 16px; color: var(--muted); line-height: 1.5; }
  .td-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Pause Banner */
  .td-pause-banner { padding: 8px 16px; background: #fef9c3; color: #854d0e; font-weight: var(--font-weight-semibold); font-size: var(--font-size-sm); text-align: center; border-radius: 6px; margin-bottom: 8px; }

  /* Layout */
  .td-layout { display: flex; height: calc(100vh - 140px); gap: 0; overflow: hidden; }
  .td-layout.td-drawer-open .td-drawer { display: flex; }

  /* Sidebar */
  .td-sidebar { width: 240px; flex-shrink: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; overflow: hidden; background: var(--surface); }
  .td-sidebar-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  .td-sidebar-head h3 { margin: 0; font-size: var(--font-size-sm); }
  .td-sidebar-head span { font-size: var(--font-size-xs); color: var(--muted); }
  .td-sidebar-body { flex: 1; overflow-y: auto; }
  .td-run-group { padding: 2px 0; }
  .td-date-label { padding: 6px 12px; font-size: var(--font-size-xs); color: var(--muted); font-weight: var(--font-weight-semibold); }
  .td-run-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; background: none; cursor: pointer; font-size: var(--font-size-sm); text-align: left; }
  .td-run-item:hover { background: var(--surface-2); }
  .td-run-item.td-run-active { background: var(--selected-bg); box-shadow: inset 2px 0 0 var(--selected-border); }
  .td-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .td-status-dot.green { background: var(--success-solid); }
  .td-status-dot.red { background: var(--danger-solid); }
  .td-status-dot.blue { background: var(--primary); }
  .td-status-dot.gray { background: var(--line-strong); }
  .td-run-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .td-run-time { font-size: var(--font-size-xs); }
  .td-run-status { font-size: var(--font-size-xs); color: var(--muted); }
  .td-run-duration { font-size: var(--font-size-xs); color: var(--muted); font-family: var(--mono); flex-shrink: 0; }

  /* Center */
  .td-center { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .td-center-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); padding: 0 8px; background: var(--surface-2); flex-shrink: 0; }
  .td-center-tabs button { padding: 8px 16px; border: none; border-bottom: 2px solid transparent; background: none; cursor: pointer; font-weight: var(--font-weight-semibold); font-size: var(--font-size-sm); color: var(--muted); }
  .td-center-tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }

  /* Output Tab */
  .td-output-tab { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .td-run-output-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); flex-shrink: 0; }

  /* Timeline */
  .td-timeline { flex: 1; overflow-y: auto; padding: 8px; background: #07111a; }
  .td-tl-item { display: flex; gap: 10px; padding: 6px 8px; border-left: 3px solid transparent; margin-bottom: 2px; min-width: 0; }
  .td-tl-item.tl-error { border-left-color: var(--danger); background: rgba(239,68,68,0.06); }
  .td-tl-item.tl-warning { border-left-color: var(--amber); background: rgba(245,158,11,0.04); }
  .td-tl-item.td-tl-loader_event { border-left-color: #f59e0b; }
  .td-tl-item.td-tl-session_card { border-left-color: #22c55e; }
  .td-tl-item.td-tl-error { border-left-color: #ef4444; background: rgba(239,68,68,0.06); }
  .td-tl-item.td-tl-input { border-left-color: #3b82f6; }
  .td-tl-item.td-tl-artifact { border-left-color: #8b5cf6; }
  .td-tl-time { flex-shrink: 0; width: 140px; font-size: 11px; font-family: var(--mono); color: #4a5f73; padding-top: 1px; }
  .td-tl-content { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
  .td-tl-badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; line-height: 1.4; }
  .td-tl-badge.input { background: rgba(59,130,246,0.2); color: #60a5fa; }
  .td-tl-badge.result { background: rgba(34,197,94,0.2); color: #4ade80; }
  .td-tl-badge.event { background: rgba(245,158,11,0.18); color: #fbbf24; }
  .td-tl-badge.session { background: rgba(34,197,94,0.18); color: #4ade80; }
  .td-tl-badge.err { background: rgba(239,68,68,0.22); color: #f87171; }
  .td-tl-badge.artifact { background: rgba(139,92,246,0.18); color: #a78bfa; }
  .td-tl-event-type { font-size: 10px; color: #64748b; font-family: var(--mono); }
  .td-tl-message { font-size: 13px; color: #d8e2ec; word-break: break-word; }
  .td-tl-error-text { color: #fca5a5 !important; }
  .td-tl-body { margin: 4px 0 0; padding: 0; font-family: var(--mono); font-size: 12px; color: #93c5fd; white-space: pre-wrap; word-break: break-word; width: 100%; }
  .td-tl-detail { margin: 4px 0 0; padding: 6px 10px; background: rgba(255,255,255,0.03); border-left: 2px solid rgba(255,255,255,0.1); border-radius: 0 4px 4px 0; font-family: var(--mono); font-size: 12px; color: #7c8fa0; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; width: 100%; }
  .td-tl-link { background: none; border: none; color: #4ade80; cursor: pointer; font-size: 13px; text-decoration: underline; padding: 0; }
  .td-tl-link:hover { color: #86efac; }

  /* Session Tab */
  .td-session-tab { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .td-session-top-bar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); background: var(--surface); flex-shrink: 0; }
  .td-session-top-bar select { flex: 1; min-width: 0; min-height: 32px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; font-size: var(--font-size-sm); }

  /* Split View */
  .td-split-view { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .td-split-view.td-dragging { cursor: row-resize; }
  .td-chat-pane { display: flex; flex-direction: column; min-height: 120px; overflow: hidden; }
  .td-chat-messages { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
  .td-chat-empty { color: var(--muted); font-size: var(--font-size-sm); text-align: center; padding: 40px; }
  .td-chat-msg { max-width: 85%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); }
  .td-chat-user { align-self: flex-end; background: var(--primary-weak); border-color: rgba(59,130,246,0.2); }
  .td-chat-agent { align-self: flex-start; background: #fff; border-color: rgba(34,197,94,0.2); }
  .td-chat-system { align-self: center; max-width: 90%; background: #f8fafc; opacity: 0.8; }
  .td-chat-running { border-color: rgba(59,130,246,0.4); }
  .td-chat-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
  .td-chat-role { font-weight: var(--font-weight-semibold); font-size: var(--font-size-xs); text-transform: uppercase; }
  .td-chat-user .td-chat-role { color: var(--primary); }
  .td-chat-agent .td-chat-role { color: var(--success); }
  .td-chat-system .td-chat-role { color: var(--muted); }
  .td-chat-time { font-size: var(--font-size-xs); color: var(--muted); }
  .td-chat-running-badge { font-size: var(--font-size-xs); padding: 1px 7px; border-radius: 999px; background: rgba(59,130,246,0.12); color: var(--primary); }
  .td-chat-stop-reason { font-size: var(--font-size-xs); color: var(--muted); }
  .td-chat-body { margin: 0; font-family: var(--mono); font-size: var(--font-size-sm); line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }

  /* Chat Composer */
  .td-chat-composer { padding: 8px; border-top: 1px solid var(--line); background: #fff; flex-shrink: 0; }
  .td-chat-composer.td-chat-disabled { background: var(--surface-2); }
  .td-chat-composer textarea { width: 100%; min-height: 52px; resize: none; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: var(--font-size-sm); box-sizing: border-box; }
  .td-chat-composer textarea:disabled { background: var(--surface-2); color: var(--muted); }
  .td-composer-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; }
  .td-composer-actions span { font-size: var(--font-size-xs); color: var(--muted); }

  /* Resize */
  .td-resize-handle { flex-shrink: 0; height: 8px; display: flex; align-items: center; justify-content: center; cursor: row-resize; }
  .td-resize-handle:hover { background: rgba(59,130,246,0.06); }
  .td-resize-line { width: 40px; height: 3px; border-radius: 2px; background: var(--line-strong); }

  /* Bottom Panel */
  .td-bottom-panel { display: flex; flex-direction: column; min-height: 60px; border-top: 1px solid var(--line); background: #fff; overflow: hidden; }
  .td-debug-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); padding: 0 6px; background: var(--surface-2); flex-shrink: 0; }
  .td-debug-tabs button { padding: 6px 12px; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); cursor: pointer; }
  .td-debug-tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }
  .td-debug-tab-content { flex: 1; overflow: hidden; }

  /* Terminal */
  .td-terminal-container { width: 100%; height: 100%; }
  :global(.td-terminal-container .xterm) { height: 100%; padding: 6px; }

  /* Events */
  .td-events-list { height: 100%; overflow-y: auto; font-family: var(--mono); font-size: var(--font-size-xs); }
  .td-event-row { display: flex; gap: 8px; padding: 4px 10px; border-bottom: 1px solid rgba(0,0,0,0.04); align-items: baseline; }
  .td-event-row:hover { background: var(--surface-2); }
  .td-event-row.tl-error { background: rgba(239,68,68,0.04); }
  .td-evt-time { flex: 0 0 140px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .td-evt-type { flex: 0 0 130px; font-weight: var(--font-weight-semibold); }
  .td-evt-level { flex: 0 0 50px; font-size: 10px; text-transform: uppercase; }
  .td-evt-level.tl-error { color: var(--danger); }
  .td-evt-level.tl-warning { color: #d97706; }
  .td-evt-msg { flex: 1; min-width: 0; word-break: break-word; }

  /* Artifacts */
  .td-artifacts-tab { padding: 20px; text-align: center; }
  .td-artifacts-tab code { font-family: var(--mono); background: var(--surface-2); padding: 2px 6px; border-radius: 3px; }

  /* Drawer */
  .td-drawer { display: none; width: 400px; flex-shrink: 0; border-left: 1px solid var(--line); flex-direction: column; overflow: hidden; background: #fff; }
  .td-drawer-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .td-drawer-head h3 { margin: 0; font-size: var(--font-size-sm); }
  .td-drawer-close { background: none; border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 14px; }
  .td-drawer-body { flex: 1; overflow-y: auto; padding: 12px; }
  .td-drawer-section { margin-bottom: 16px; }
  .td-drawer-section h4 { margin: 0 0 8px; font-size: var(--font-size-sm); }
  .td-section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .td-section-head h4 { margin: 0; }

  /* Code Editor */
  .td-code-editor-wrap { position: relative; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .td-code-highlight { position: absolute; inset: 0; margin: 0; padding: 8px 10px; font-family: var(--mono); font-size: 13px; line-height: 1.45; white-space: pre; pointer-events: none; overflow: hidden; color: var(--text); }
  .td-code-editor { display: block; position: relative; width: 100%; padding: 8px 10px; font-family: var(--mono); font-size: 13px; line-height: 1.45; border: none; resize: none; color: transparent; caret-color: var(--text); background: transparent; }
  .td-code-editor:focus { outline: none; }
  :global(.tok-keyword) { color: #7c3aed; font-weight: 600; }
  :global(.tok-string) { color: #059669; }
  :global(.tok-comment) { color: #6b7280; font-style: italic; }
  :global(.tok-number) { color: #d97706; }
  :global(.tok-function) { color: #2563eb; }

  /* Env */
  .td-env-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
  .td-env-row input[type="text"],
  .td-env-row input[type="password"] { flex: 1; min-width: 0; min-height: 30px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; font-size: var(--font-size-sm); }
  .td-env-secret { display: flex; align-items: center; gap: 2px; font-size: var(--font-size-xs); white-space: nowrap; cursor: pointer; }
  .td-env-secret input { width: auto; margin: 0; }

  /* Drawer Actions */
  .td-drawer-actions { display: flex; gap: 8px; margin-bottom: 16px; }

  /* Run Result */
  .td-result-card { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 6px; font-size: var(--font-size-sm); }
  .td-result-success { background: var(--success-weak); color: var(--success); }
  .td-result-failed { background: var(--danger-weak); color: var(--danger); }
  .td-view-output-btn { margin-top: 8px; background: none; border: none; color: var(--primary); cursor: pointer; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
  .td-view-output-btn:hover { text-decoration: underline; }
</style>
