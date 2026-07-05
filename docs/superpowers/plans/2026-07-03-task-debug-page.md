# 任务调试页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为任务排查提供一站式调试工作台——看运行历史、进 VM 排查、改脚本、看结果，全在一个页面完成。

**Architecture:** 新增 `TaskDebugPage.svelte` 作为全页面组件，采用三栏布局（左侧运行列表 + 中间双 Tab + 右侧可滑出抽屉）。通过 `App.svelte` 路由 `/tasks/{id}/debug`，支持 `?run=xxx` 和 `?session=xxx` URL 参数自动定位。调度暂停通过复用已有的 `setAutomationTaskEnabled` API 实现，进入/离开时弹出确认框。入口按钮添加到 `AutomationTasksPage` 和 `RunsPage`。

**Tech Stack:** Svelte 5, xterm.js (终端), @ant-design/icons-svg (图标), Connect/gRPC-web (API)

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/api/loaders.ts` | Modify | 新增 `listLoaderRuns` 函数 |
| `src/App.svelte` | Modify | 新增 `task-debug` 路由和导航函数 |
| `src/pages/AutomationTasksPage.svelte` | Modify | 添加"调试"入口按钮 |
| `src/pages/RunsPage.svelte` | Modify | 为自动化任务关联的运行添加"调试任务"入口 |
| `src/pages/TaskDebugPage.svelte` | Create | 任务调试页主体 |

---

### Task 1: 新增 `listLoaderRuns` API

**Files:**
- Modify: `src/api/loaders.ts`

- [ ] **Step 1: 添加 `listLoaderRuns` 函数**

在 `src/api/loaders.ts` 的 `listRecentAutomationRuns` 函数后面添加（大约第 270 行）：

```typescript
export async function listLoaderRuns(loaderId: string, limit = 50): Promise<AutomationRun[]> {
  const response = await loaderClient.listLoaderRuns({ loaderId, limit });
  return response.runs.map(runFromSummary);
}
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run check:ui`
Expected: 无 TypeScript 错误

---

### Task 2: App.svelte 路由和导航

**Files:**
- Modify: `src/App.svelte`

- [ ] **Step 1: 导入 TaskDebugPage**

在第 21 行附近 `SessionDebugPage` 导入后添加：

```typescript
import TaskDebugPage from './pages/TaskDebugPage.svelte';
```

- [ ] **Step 2: 添加 `task-debug` 到 Page 类型**

修改第 28 行的 `Page` 类型联合：

```typescript
type Page = 'runs' | 'agents' | 'automation-tasks' | 'settings' | 'debug-run' | 'event-detail' | 'login' | 'run-detail' | 'session-debug' | 'task-debug';
```

- [ ] **Step 3: 添加 task-debug 状态变量**

在第 31 行 `let sessionDebugId = '';` 后添加：

```typescript
let taskDebugId = '';
let taskDebugRunId = '';
let taskDebugSessionId = '';
```

- [ ] **Step 4: 添加路由匹配**

在 `pageFromPath` 函数中（约第 86 行后），添加 task-debug 路由匹配：

```typescript
const taskDebugMatch = normalized.match(/^\/tasks\/([^/]+)\/debug$/);
if (taskDebugMatch) {
  taskDebugId = decodeURIComponent(taskDebugMatch[1]);
  const params = new URLSearchParams(window.location.search);
  taskDebugRunId = params.get('run') || '';
  taskDebugSessionId = params.get('session') || '';
  return 'task-debug';
}
```

- [ ] **Step 5: 添加导航函数**

在第 170 行 `navigateToSessionDebug` 函数后添加：

```typescript
function navigateToTaskDebug(taskId: string, runId = '', sessionId = ''): void {
  taskDebugId = taskId;
  taskDebugRunId = runId;
  taskDebugSessionId = sessionId;
  activePage = 'task-debug';
  const params = new URLSearchParams();
  if (runId) params.set('run', runId);
  if (sessionId) params.set('session', sessionId);
  const qs = params.toString();
  const nextPath = appPath(`/tasks/${encodeURIComponent(taskId)}/debug${qs ? `?${qs}` : ''}`);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== nextPath) {
    history.pushState({ page: 'task-debug', taskId, runId, sessionId }, '', nextPath);
  }
}
```

- [ ] **Step 6: 在模板中渲染 TaskDebugPage**

在第 563 行 `{:else}` 之前添加：

```svelte
{:else if activePage === 'task-debug'}
  <TaskDebugPage taskId={taskDebugId} initialRunId={taskDebugRunId} initialSessionId={taskDebugSessionId} />
```

- [ ] **Step 7: 传递导航回调到页面事件**

不需要自定义事件——TaskDebugPage 使用 `window.location.assign` 或直接调用 `navigate` 函数。但为了页面内跳转（如回到 tasks 列表），TaskDebugPage 通过 `createEventDispatcher` 发出事件。在 App.svelte 中，TaskDebugPage 是独立页面，所以它用 `dispatch('navigateTasks')` 让 App 处理返回导航即可。或者更简单的做法：TaskDebugPage 直接用 `window.history.back()` 返回。

暂定方案：TaskDebugPage 不发出导航事件，用 `<a href={appPath('/automation-tasks')}>` 返回。

Wait，先用 TaskDebugPage 内联 `<button on:click={() => window.location.assign(appPath('/automation-tasks'))}>` 返回。

- [ ] **Step 8: 验证编译**

Run: `npm run check:ui`
Expected: 无错误

---

### Task 3: AutomationTasksPage 添加调试入口

**Files:**
- Modify: `src/pages/AutomationTasksPage.svelte`

- [ ] **Step 1: 导入 appPath**

检查已有的 import。`appPath` 已经在第 24 行导入，无需修改。

- [ ] **Step 2: 在任务详情工具栏添加"调试"按钮**

在第 759 行的 `<button disabled={Boolean(activeTask.lastError)} on:click={() => { debugTask = activeTask; debugPayload = '{}'; }}>调试</button>` **后面**，添加任务调试页入口：

```svelte
<button on:click={() => window.location.assign(appPath(`/tasks/${encodeURIComponent(activeTask.id)}/debug`))}>任务调试</button>
```

- [ ] **Step 3: 验证编译**

Run: `npm run check:ui`
Expected: 无错误

---

### Task 4: RunsPage 添加"调试任务"入口

**Files:**
- Modify: `src/pages/RunsPage.svelte`

- [ ] **Step 1: 查找 RunsPage 中运行记录的操作按钮位置**

在 RunsPage 中，找到显示单个运行记录条目且该运行有 `automationId` 的地方（即类型为 `automation_run` 的运行），在操作按钮区域添加一个"调试任务"按钮，点击跳转到 `/tasks/{automationId}/debug?run={runId}`。

需要找到 RunsPage 中渲染运行条目的模板部分。具体位置需要 grep 确认。

- [ ] **Step 2: 搜索运行操作按钮位置**

Run: `grep -n "openDebugRun\|调试终端\|debug.*run\|dispatch.*debug\|dispatch.*viewRunDetail" /root/agent-compose-ui/src/pages/RunsPage.svelte`

根据输出定位到运行条目的按钮区域。

- [ ] **Step 3: 添加"调试任务"按钮**

在找到的操作按钮区域（在"调试终端"按钮附近），添加条件渲染的"调试任务"按钮：

```svelte
{#if run.automationId}
  <button on:click={() => window.location.assign(appPath(`/tasks/${encodeURIComponent(run.automationId)}/debug?run=${encodeURIComponent(run.id)}`))}>调试任务</button>
{/if}
```

- [ ] **Step 4: 验证编译**

Run: `npm run check:ui`
Expected: 无错误

---

### Task 5: 创建 TaskDebugPage 骨架——状态定义和数据加载

**Files:**
- Create: `src/pages/TaskDebugPage.svelte`

- [ ] **Step 1: 创建文件并编写 script 头部（imports 和 props）**

```svelte
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
  import { formatBeijingTime } from '../time';
  import { appPath } from '../paths';
  import { CellType } from '@chaitin-ai/agent-compose-client/agentcompose/v1/agentcompose_pb.js';

  export let taskId = '';
  export let initialRunId = '';
  export let initialSessionId = '';

  // ... state variables defined in next step
</script>
```

- [ ] **Step 2: 定义所有状态变量**

```typescript
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

  // Session debug state
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

  // Terminal state
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

  // Drawer state
  let drawerOpen = false;
  let scriptDraft = '';
  let envDraft: EnvItem[] = [];
  let scriptScrollTop = 0;
  let scriptScrollLeft = 0;
  let saving = false;
  let runResult: { success: boolean; message: string; runId?: string } | null = null;

  // Pause state
  let schedulerPaused = false;
  let taskWasEnabled = false;
  let showEnterPauseDialog = false;
  let showLeaveDialog = false;
  let pendingLeaveAction: 'enable' | 'keep_disabled' | null = null;

  // Computed
  let bottomContainer: HTMLDivElement | null = null;
  let chatMessagesEl: HTMLDivElement | null = null;
```

- [ ] **Step 3: 实现数据加载函数**

```typescript
  onMount(() => {
    void load();
    return () => {
      stopWatching();
      messageAbort?.abort();
      destroyTerminal();
    };
  });

  onDestroy(() => {
    // If task was paused by us, show leave dialog is handled via beforeunload
  });

  async function load(): Promise<void> {
    if (!taskId) return;
    loading = true;
    error = '';
    try {
      taskDetail = await getAutomationTask(taskId);
      scriptDraft = taskDetail.script || '';
      envDraft = taskDetail.envItems.map(e => ({ ...e }));
      taskWasEnabled = taskDetail.enabled;

      const allRuns = await listLoaderRuns(taskId, 100);
      runs = allRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      // Extract unique session IDs from events
      const allEvents = await listAutomationEvents(taskId, 500);
      const sessionIds = new Set<string>();
      for (const e of allEvents) {
        if (e.linkedSessionId) sessionIds.add(e.linkedSessionId);
        if (e.linkedAgentSessionId) sessionIds.add(e.linkedAgentSessionId);
      }
      availableSessions = Array.from(sessionIds).map(id => ({ id, label: id.substring(0, 8) }));

      // Handle URL params
      if (initialRunId && runs.some(r => r.id === initialRunId)) {
        selectedRunId = initialRunId;
        await loadRunDetail(initialRunId);
        centerTab = 'output';
      }
      if (initialSessionId && sessionIds.has(initialSessionId)) {
        selectedSessionId = initialSessionId;
        await loadSessionDetail(initialSessionId);
        centerTab = 'session';
      }

      // If task is enabled, show pause confirmation
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
      runEvents = events.filter(e => !e.runId || e.runId === runId);
      buildTimeline(detail, runEvents);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function buildTimeline(detail: AutomationRun, events: AutomationEvent[]): void {
    const entries: TimelineEntry[] = [];

    if (detail.payloadJson) {
      entries.push({ kind: 'input', id: 'input', timestamp: detail.startedAt, content: detail.payloadJson });
    }

    for (const e of events) {
      entries.push({
        kind: 'loader_event',
        id: e.id,
        timestamp: e.createdAt,
        type: e.type,
        level: e.level,
        message: e.message,
        detail: e.payloadJson || undefined,
      });
      if (e.linkedSessionId || e.linkedAgentSessionId) {
        const sid = e.linkedSessionId || e.linkedAgentSessionId;
        entries.push({
          kind: 'session_card',
          id: `session-${sid}-${e.id}`,
          timestamp: e.createdAt,
          sessionId: sid,
          summary: e.type,
        });
      }
    }

    if (detail.error) {
      entries.push({ kind: 'error', id: 'error', timestamp: detail.completedAt || detail.startedAt, message: detail.error });
    }

    if (detail.artifactsDir) {
      entries.push({ kind: 'artifact', id: 'artifact', timestamp: detail.completedAt || detail.startedAt, name: detail.artifactsDir, size: '-' });
    }

    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    timeline = entries;
  }

  async function loadSessionDetail(sessionId: string): Promise<void> {
    try {
      const [status, cells, evts] = await Promise.all([
        getWorkSessionStatus(sessionId).catch(() => null),
        listWorkSessionCells(sessionId).catch(() => []),
        listWorkSessionEvents(sessionId).catch(() => []),
      ]);
      session = status;
      rawSessionStatus = status?.status || '';
      sessionStatus = mapSessionStatus(rawSessionStatus);
      sessionCells = cells;
      sessionEvents = evts;
      if (status?.workspacePath) currentCwd = status.workspacePath;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function mapSessionStatus(s: string): string {
    const n = (s || '').toUpperCase();
    if (n === 'PENDING') return '等待中';
    if (n === 'STARTING') return '启动中';
    if (n === 'RUNNING') return '运行中';
    if (n === 'FAILED' || n === 'START_FAILED') return '启动失败';
    if (n === 'STOPPED') return '已停止';
    return s || '未知';
  }
```

- [ ] **Step 4: 实现调度暂停和恢复逻辑**

```typescript
  function confirmPauseScheduler(): void {
    showEnterPauseDialog = false;
    schedulerPaused = true;
    void setAutomationTaskEnabled(taskId, false);
  }

  function declinePauseScheduler(): void {
    showEnterPauseDialog = false;
    schedulerPaused = false;
  }

  function initiateLeave(action: 'enable' | 'keep_disabled'): void {
    if (schedulerPaused) {
      if (action === 'enable') {
        void setAutomationTaskEnabled(taskId, true);
      }
      schedulerPaused = false;
    }
    window.location.assign(appPath('/automation-tasks'));
  }

  function showLeaveConfirm(): void {
    showLeaveDialog = true;
  }

  function cancelLeave(): void {
    showLeaveDialog = false;
  }

  // Warn on browser close/refresh if paused
  function handleBeforeUnload(e: BeforeUnloadEvent): void {
    if (schedulerPaused) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  // Called from template
  $: if (typeof window !== 'undefined') {
    // svelte-ignore
  }
```

Wait, the beforeunload needs to be registered in onMount. Let me fix this:

```typescript
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
```

- [ ] **Step 5: 验证编译**

Run: `npm run check:ui`
Expected: 无 TypeScript 错误（页面尚未在模板中使用，但类型应正确）

---

### Task 6: TaskDebugPage 左侧栏——运行记录列表

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（同一文件继续添加）

- [ ] **Step 1: 添加运行记录分类和格式化函数**

```typescript
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
```

- [ ] **Step 2: 编写左侧栏模板**

```svelte
{#if loading}
  <div class="alert info">正在加载任务调试信息...</div>
{:else if error && !taskDetail}
  <div class="alert danger">{error}</div>
{:else if !taskDetail}
  <div class="alert info">任务不存在</div>
{:else}
  <!-- Pause Banner -->
  {#if schedulerPaused}
    <div class="pause-banner">
      <span>调试模式——任务调度已暂停，离开后自动恢复</span>
    </div>
  {/if}

  <!-- Enter Pause Dialog -->
  {#if showEnterPauseDialog}
    <div class="dialog-mask" role="dialog">
      <div class="dialog-card">
        <h3>暂停任务调度</h3>
        <p>进入调试模式将暂停该任务的所有自动触发（定时/周期/事件/延迟），以免干扰排查。是否暂停？</p>
        <div class="dialog-actions">
          <button on:click={declinePauseScheduler}>跳过（保持启用）</button>
          <button class="primary" on:click={confirmPauseScheduler}>确认暂停</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Leave Dialog -->
  {#if showLeaveDialog}
    <div class="dialog-mask" role="dialog">
      <div class="dialog-card">
        <h3>离开调试模式</h3>
        <p>当前任务调度已暂停。离开后是否恢复任务调度？</p>
        <div class="dialog-actions">
          <button on:click={cancelLeave}>取消</button>
          <button on:click={() => initiateLeave('keep_disabled')}>保持暂停</button>
          <button class="primary" on:click={() => initiateLeave('enable')}>恢复调度</button>
        </div>
      </div>
    </div>
  {/if}

  <div class="page-title">
    <div>
      <h2>任务调试 · {taskDetail.name || taskId}</h2>
    </div>
    <div class="toolbar">
      <button on:click={showLeaveConfirm}>← 返回任务列表</button>
      <button on:click={() => drawerOpen = !drawerOpen}>
        {drawerOpen ? '关闭编辑器' : '代码 / 变量编辑'}
      </button>
      <button on:click={() => load()}>{loading ? '加载中...' : '刷新'}</button>
    </div>
  </div>

  <div class="debug-page-layout" class:drawer-visible={drawerOpen}>
    <!-- Left Sidebar -->
    <aside class="debug-sidebar">
      <div class="sidebar-head">
        <h3>运行记录</h3>
        <span>{runs.length} 次</span>
      </div>
      <div class="sidebar-body">
        {#if runs.length === 0}
          <div class="empty">暂无运行记录</div>
        {:else}
          {#each groupRunsByDate(runs) as group}
            <div class="run-date-group">
              <div class="date-label">{group.label}</div>
              {#each group.items as run}
                <button
                  class="run-item"
                  class:active={selectedRunId === run.id}
                  on:click={() => { selectedRunId = run.id; void loadRunDetail(run.id); centerTab = 'output'; }}
                >
                  <span class={`status-dot ${runStatusColor(run)}`}></span>
                  <span class="run-item-info">
                    <span class="run-item-time">{formatBeijingTime(run.startedAt).split(' ')[1] || formatBeijingTime(run.startedAt)}</span>
                    <span class="run-item-status">{runStatusLabel(run)}</span>
                  </span>
                  <span class="run-item-duration">{formatDuration(run.durationMs)}</span>
                </button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </aside>
```

- [ ] **Step 3: 验证编译**

Run: `npm run check:ui`
Expected: 模板语法正确

---

### Task 7: TaskDebugPage 中间——运行输出 Tab

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（继续在模板中添加）

- [ ] **Step 1: 添加辅助函数**

在 script 段添加：

```typescript
  function translateEventType(type: string): string {
    const map: Record<string, string> = {
      'loader.run.skipped': 'Run 跳过', 'loader.run.started': 'Run 开始', 'loader.run.completed': 'Run 完成', 'loader.run.failed': 'Run 失败',
      'loader.log': '自定义日志', 'loader.event.published': '事件发布', 'loader.event.publish.failed': '事件发布失败',
      'loader.session.resumed': 'Session 就绪', 'loader.session.rpc.completed': 'RPC 完成', 'loader.session.rpc.failed': 'RPC 失败',
      'loader.agent.completed': 'Agent 完成', 'loader.agent.failed': 'Agent 失败',
      'loader.session.stopped': 'Session 停止', 'loader.command.completed': '命令完成', 'loader.command.failed': '命令失败',
      'loader.llm.completed': 'LLM 完成', 'loader.llm.failed': 'LLM 失败',
      'session.created': 'Session 创建', 'session.resumed': 'Session 恢复',
      'agent.started': 'Agent 启动', 'agent.completed': 'Agent 完成', 'agent.failed': 'Agent 失败',
    };
    return map[type] || type;
  }

  function eventLevelClass(level: string): string {
    const v = (level || '').toLowerCase();
    if (v === 'error' || v === 'critical' || v === 'fatal') return 'error';
    if (v === 'warning' || v === 'warn') return 'warning';
    return 'default';
  }

  function tryFormatJson(raw: string): string {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }

  function selectSession(sessionId: string): void {
    selectedSessionId = sessionId;
    centerTab = 'session';
    void loadSessionDetail(sessionId);
  }
```

- [ ] **Step 2: 编写中间主区域模板（Tab 切换 + 运行输出 Tab）**

在左侧栏模板后面继续添加：

```svelte
    <!-- Center Area -->
    <div class="debug-center">
      <div class="center-tabs">
        <button class:active={centerTab === 'output'} on:click={() => centerTab = 'output'}>
          运行输出
        </button>
        <button class:active={centerTab === 'session'} on:click={() => centerTab = 'session'}>
          Session 调试
        </button>
      </div>

      {#if centerTab === 'output'}
        <div class="output-tab">
          {#if !selectedRunId}
            <div class="empty">请从左侧选择一条运行记录</div>
          {:else if !runDetail}
            <div class="empty">加载中...</div>
          {:else}
            <div class="run-output-header">
              <span>运行 #{selectedRunId.substring(0, 8)}</span>
              <span class={`status-pill ${runStatusColor(runDetail)}`}>{runStatusLabel(runDetail)}</span>
              <span>{formatDuration(runDetail.durationMs)}</span>
            </div>
            <div class="timeline">
              {#each timeline as entry (`${entry.kind}-${entry.id}`)}
                <div class="tl-item tl-{entry.kind}" class:tl-error={eventLevelClass((entry as any).level) === 'error'}>
                  <span class="tl-time">{formatBeijingTime(entry.timestamp)}</span>
                  <span class="tl-content">
                    {#if entry.kind === 'input'}
                      <span class="tl-badge input">输入</span>
                      <pre class="tl-body">{tryFormatJson(entry.content)}</pre>
                    {:else if entry.kind === 'loader_event'}
                      <span class="tl-badge event">{translateEventType(entry.type)}</span>
                      <span class="tl-message">{entry.message}</span>
                      {#if entry.detail}
                        <pre class="tl-detail">{tryFormatJson(entry.detail)}</pre>
                      {/if}
                    {:else if entry.kind === 'session_card'}
                      <span class="tl-badge session">会话</span>
                      <button class="tl-link" on:click={() => selectSession(entry.sessionId)}>
                        查看会话 {entry.sessionId.substring(0, 8)} — {entry.summary}
                      </button>
                    {:else if entry.kind === 'error'}
                      <span class="tl-badge err">错误</span>
                      <span class="tl-message tl-error-text">{entry.message}</span>
                    {:else if entry.kind === 'artifact'}
                      <span class="tl-badge artifact">产出物</span>
                      <span class="tl-message">{entry.name}</span>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
```

- [ ] **Step 3: 验证编译**

---

### Task 8: TaskDebugPage 中间——Session 调试 Tab

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（继续添加）

- [ ] **Step 1: 添加 session 相关函数**

在 script 中添加：

```typescript
  function buildChatMessages(cells: WorkSessionCell[]): Array<{ id: string; role: string; content: string; timestamp: string; agent?: string; running?: boolean }> {
    return cells.map(cell => ({
      id: cell.id,
      role: cell.type === CellType.UNSPECIFIED ? 'user' : cell.type === CellType.AGENT ? 'agent' : 'system',
      content: cell.type === CellType.UNSPECIFIED ? (cell.source || '') : (cell.output || ''),
      timestamp: cell.createdAt || '',
      agent: cell.agent || undefined,
      running: cell.running,
    }));
  }

  function canResume(): boolean {
    return Boolean(selectedSessionId) && ['已停止', '启动失败'].includes(sessionStatus) && !resuming;
  }

  function canChat(): boolean {
    return Boolean(selectedSessionId) && rawSessionStatus === 'RUNNING' && !sendingMessage;
  }

  async function resumeCurrentSession(): Promise<void> {
    if (!canResume() || !selectedSessionId) return;
    resuming = true;
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
    // Add pending messages to cells
    const pendingUser: WorkSessionCell = { id: `pending-u-${Date.now()}`, source: text, output: text, type: CellType.UNSPECIFIED, exitCode: 0, success: true, createdAt: new Date().toISOString(), agent: '', agentSessionId: '', stopReason: '', running: false };
    const pendingAgent: WorkSessionCell = { id: `pending-a-${Date.now()}`, source: '', output: '', type: CellType.AGENT, exitCode: 0, success: false, createdAt: new Date().toISOString(), agent: latestAgentName(), agentSessionId: '', stopReason: '', running: true };
    sessionCells = [...sessionCells, pendingUser, pendingAgent];
    messageDraft = '';
    try {
      await sendWorkSessionMessageStream(selectedSessionId, latestAgentName(), text, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'completed' && event.run) {
          sessionCells = sessionCells.map(c => c.id === pendingAgent.id || c.id === event.run!.id
            ? { ...c, id: event.run!.id, output: event.run!.output, exitCode: event.run!.exitCode, success: event.run!.success, stopReason: event.run!.stopReason || '', running: false, createdAt: event.run!.createdAt || c.createdAt }
            : c);
        } else if (event.type === 'chunk' && event.chunk) {
          sessionCells = sessionCells.map(c => c.id === pendingAgent.id || c.id === event.runId
            ? { ...c, output: c.output + event.chunk }
            : c);
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

  function startWatching(): void {
    if (!selectedSessionId) return;
    stopWatching();
    const controller = new AbortController();
    watchAbort = controller;
    void watchLoop(controller, selectedSessionId);
  }

  async function watchLoop(ctrl: AbortController, sid: string): Promise<void> {
    while (!ctrl.signal.aborted) {
      try {
        await watchWorkSession(sid, (evt) => {
          if (ctrl.signal.aborted) return;
          if (evt.type === 'event' && evt.event) sessionEvents = [evt.event, ...sessionEvents];
          if (evt.type === 'cell' && evt.cell) {
            const idx = sessionCells.findIndex(c => c.id === evt.cell!.id);
            if (idx >= 0) sessionCells = [...sessionCells.slice(0, idx), evt.cell, ...sessionCells.slice(idx + 1)];
            else sessionCells = [...sessionCells, evt.cell];
          }
          if (evt.type === 'chunk') {
            const idx = sessionCells.findIndex(c => c.id === evt.cellId);
            if (idx >= 0) { const c = sessionCells[idx]; sessionCells = [...sessionCells.slice(0, idx), { ...c, output: c.output + evt.chunk }, ...sessionCells.slice(idx + 1)]; }
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
    return new Promise(r => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => clearTimeout(t), { once: true }); });
  }
```

- [ ] **Step 2: 编写 Session 调试 Tab 模板**

继续在模板的 `{:else}` 分支添加（Session 调试 Tab 内容）：

```svelte
        <!-- Session Debug Tab -->
        <div class="session-tab">
          <div class="session-top-bar">
            <select bind:value={selectedSessionId} on:change={() => { void loadSessionDetail(selectedSessionId); startWatching(); }}>
              <option value="">选择会话...</option>
              {#each availableSessions as s}
                <option value={s.id}>{s.id.substring(0, 8)}</option>
              {/each}
            </select>
            <button disabled={!canResume()} on:click={resumeCurrentSession}>
              {resuming ? '重启中...' : '重启会话'}
            </button>
          </div>

          {#if !selectedSessionId}
            <div class="empty">请选择要调试的会话</div>
          {:else}
            <div class="split-view" bind:this={bottomContainer}>
              <!-- Chat Area -->
              <div class="chat-pane" style="height: {((1 - bottomRatio) * 100)}%">
                <div class="chat-messages" bind:this={chatMessagesEl}>
                  {#each buildChatMessages(sessionCells) as msg (msg.id)}
                    <div class="chat-message chat-{msg.role}" class:chat-running={msg.running}>
                      <div class="chat-head">
                        <span class="chat-role">{msg.role === 'user' ? '用户' : msg.role === 'agent' ? msg.agent || 'Agent' : '系统'}</span>
                        <span class="chat-time">{formatBeijingTime(msg.timestamp)}</span>
                      </div>
                      <pre class="chat-body">{msg.content || (msg.running ? '等待输出...' : '(无内容)')}</pre>
                    </div>
                  {/each}
                </div>
                <div class="chat-composer">
                  <textarea
                    rows="3"
                    value={messageDraft}
                    placeholder={canChat() ? '输入消息，Enter 发送' : `会话${sessionStatus}`}
                    disabled={!canChat()}
                    on:input={e => messageDraft = e.currentTarget.value}
                    on:keydown={handleMessageKeydown}
                  ></textarea>
                  <div class="composer-actions">
                    <span>{canChat() ? 'Enter 发送' : `会话${sessionStatus}`}</span>
                    <button disabled={!canChat() || !messageDraft.trim()} on:click={sendMessage}>
                      {sendingMessage ? '发送中...' : '发送'}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Resize Handle -->
              <div class="resize-handle" role="separator" on:mousedown={handleResizeStart}></div>

              <!-- Bottom Debug Panel -->
              <div class="bottom-panel" style="height: {(bottomRatio * 100)}%">
                <div class="debug-tabs">
                  <button class:active={activeDebugTab === 'terminal'} on:click={() => activeDebugTab = 'terminal'}>终端</button>
                  <button class:active={activeDebugTab === 'events'} on:click={() => activeDebugTab = 'events'}>事件</button>
                  <button class:active={activeDebugTab === 'artifacts'} on:click={() => activeDebugTab = 'artifacts'}>产出物</button>
                </div>
                <div class="debug-tab-content">
                  {#if activeDebugTab === 'terminal'}
                    <div class="terminal-container" bind:this={terminalEl}></div>
                  {:else if activeDebugTab === 'events'}
                    <div class="events-list-sm">
                      {#each sessionEvents as evt}
                        <div class="event-row-sm {eventLevelClass(evt.level)}">
                          <span class="evt-time">{formatBeijingTime(evt.createdAt)}</span>
                          <span class="evt-type">{evt.type}</span>
                          <span class="evt-msg">{evt.message}</span>
                        </div>
                      {/each}
                      {#if sessionEvents.length === 0}<div class="empty">暂无事件</div>{/if}
                    </div>
                  {:else}
                    <div class="artifacts-placeholder">
                      <p>产出物浏览需在终端中执行命令查看。</p>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
```

- [ ] **Step 3: 添加 resize handle 逻辑**

```typescript
  let dragging = false;
  let splitContainer: HTMLDivElement | null = null;

  function handleResizeStart(e: MouseEvent): void {
    e.preventDefault();
    dragging = true;
    const startY = e.clientY;
    const startRatio = bottomRatio;
    const h = splitContainer?.clientHeight || window.innerHeight;
    function onMove(me: MouseEvent): void { const d = startY - me.clientY; bottomRatio = Math.min(0.6, Math.max(0.12, startRatio + d / h)); }
    function onUp(): void { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; }
    document.body.style.cursor = 'row-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
```

- [ ] **Step 4: 验证编译**

---

### Task 9: TaskDebugPage 终端实现

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（继续添加）

- [ ] **Step 1: 添加终端函数（从 SessionDebugPage 移植，稍作简化）**

```typescript
  // Reactive: init terminal when DOM node appears
  $: if (terminalEl && !termReady && activeDebugTab === 'terminal') initTerminal();

  function initTerminal(): void {
    if (termReady || !terminalEl) return;
    term = new Terminal({
      convertEol: true, disableStdin: false, cursorBlink: true, cursorStyle: 'bar',
      fontFamily: 'IBM Plex Mono, Fira Code, ui-monospace, monospace', fontSize: 13,
      lineHeight: 1.25, scrollback: 5000, allowProposedApi: true,
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
    const host = selectedSessionId.substring(0, 8);
    const dir = currentCwd || '/';
    term?.write(`\x1b[32m${user}@${host}\x1b[0m:\x1b[34m${dir}\x1b[0m# `);
  }

  function handleTerminalInput(data: string): void {
    if (!term || !termReady) return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code === 3) { /* Ctrl+C */ term.write('^C\r\n'); if (execRunning) { execAbort?.abort(); execAbort = null; execRunning = false; } lineBuffer = ''; cursorPos = 0; showPrompt(); continue; }
      if (code === 12) { /* Ctrl+L */ term.clear(); showPrompt(); term.write(lineBuffer); continue; }
      if (code === 21) { /* Ctrl+U */ term.write('\r\x1b[K'); lineBuffer = ''; cursorPos = 0; showPrompt(); continue; }
      if (code === 127) { /* Backspace */ if (cursorPos > 0) { lineBuffer = lineBuffer.slice(0, cursorPos - 1) + lineBuffer.slice(cursorPos); cursorPos--; redrawAfterPrompt(); } continue; }
      if (code === 13) { /* Enter */ term.write('\r\n'); const cmd = lineBuffer.trim(); lineBuffer = ''; cursorPos = 0; historyIdx = -1; if (cmd) { history = [cmd, ...history].slice(0, 200); void executeTerminalCommand(cmd); } else { showPrompt(); } continue; }
      if (ch === '\x1b[A') { /* Up */ if (historyIdx === -1) { savedLineBeforeHistory = lineBuffer; historyIdx = 0; } else if (historyIdx < history.length - 1) { historyIdx++; } lineBuffer = history[historyIdx] || savedLineBeforeHistory; cursorPos = lineBuffer.length; redrawAfterPrompt(); continue; }
      if (ch === '\x1b[B') { /* Down */ if (historyIdx > 0) { historyIdx--; lineBuffer = history[historyIdx]; } else if (historyIdx === 0) { historyIdx = -1; lineBuffer = savedLineBeforeHistory; } cursorPos = lineBuffer.length; redrawAfterPrompt(); continue; }
      if (ch === '\x1b[D') { if (cursorPos > 0) { cursorPos--; term.write('\x1b[D'); } continue; }
      if (ch === '\x1b[C') { if (cursorPos < lineBuffer.length) { cursorPos++; term.write('\x1b[C'); } continue; }
      if (code === 1 || ch === '\x1b[H') { term.write(`\x1b[${cursorPos}D`); cursorPos = 0; continue; }
      if (code === 5 || ch === '\x1b[F') { const d = lineBuffer.length - cursorPos; if (d > 0) term.write(`\x1b[${d}C`); cursorPos = lineBuffer.length; continue; }
      if (ch.startsWith('\x1b')) continue;
      if (ch >= ' ') {
        if (cursorPos === lineBuffer.length) { lineBuffer += ch; cursorPos++; term.write(ch); }
        else { lineBuffer = lineBuffer.slice(0, cursorPos) + ch + lineBuffer.slice(cursorPos); cursorPos++; redrawAfterPrompt(); }
      }
    }
  }

  function redrawAfterPrompt(): void { term?.write('\r\x1b[K'); showPrompt(); if (lineBuffer) { term?.write(lineBuffer); } }

  async function executeTerminalCommand(cmd: string): Promise<void> {
    if (cmd === 'clear') { term?.clear(); showPrompt(); return; }
    if (cmd === 'cd' || cmd.startsWith('cd ')) {
      const target = cmd.slice(2).trim();
      if (target === '') currentCwd = session?.workspacePath || '/root';
      else if (target === '-') { /* swap */ } else currentCwd = resolvePath(currentCwd, target);
      showPrompt(); return;
    }
    execAbort?.abort();
    const controller = new AbortController();
    execAbort = controller;
    execRunning = true;
    try {
      const { executeRuntimeCommandStream } = await import('../api/exec');
      await executeRuntimeCommandStream({ sessionId: selectedSessionId, command: cmd, cwd: currentCwd, timeoutMs: 0 }, (evt) => {
        if (controller.signal.aborted) return;
        if (evt.type === 'chunk') { if (evt.isStderr) term?.write(`\x1b[31m${evt.chunk}\x1b[0m`); else term?.write(evt.chunk); }
        if (evt.type === 'completed' && evt.result) term?.write(`\r\n\x1b[${evt.result.exitCode === 0 ? 32 : 31}m[exit ${evt.result.exitCode}]\x1b[0m\r\n`);
      }, controller.signal);
    } catch (err) { if (!controller.signal.aborted) term?.write(`\r\n\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`); }
    finally { execAbort = null; execRunning = false; showPrompt(); }
  }

  function resolvePath(base: string, target: string): string {
    if (target.startsWith('/')) return target;
    const parts = base.split('/').filter(Boolean);
    for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.' && seg !== '') parts.push(seg); }
    return '/' + parts.join('/');
  }
```

- [ ] **Step 2: 修复 executeTerminalCommand 中的 import**

不要在函数内部动态 import——在文件顶部添加 import：

```typescript
  import { executeRuntimeCommandStream } from '../api/exec';
```

然后简化 executeTerminalCommand 中的调用：

```typescript
      await executeRuntimeCommandStream(
        { sessionId: selectedSessionId, command: cmd, cwd: currentCwd, timeoutMs: 0 },
        (evt) => { /* same body */ },
        controller.signal,
      );
```

---

### Task 10: TaskDebugPage 右侧抽屉

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（继续添加）

- [ ] **Step 1: 添加抽屉相关函数**

```typescript
  function addEnvItem(): void { envDraft = [...envDraft, { name: '', value: '', secret: false }]; }
  function removeEnvItem(idx: number): void { envDraft = envDraft.filter((_, i) => i !== idx); }

  function discardEdits(): void {
    if (taskDetail) {
      scriptDraft = taskDetail.script || '';
      envDraft = taskDetail.envItems.map(e => ({ ...e }));
    }
  }

  async function saveAndRun(): Promise<void> {
    if (!taskDetail || saving) return;
    saving = true;
    error = '';
    runResult = null;
    try {
      // 1. Save
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
        envItems: envDraft.filter(e => e.name.trim()),
      });
      taskDetail = updated;

      // 2. Run
      const run = await runAutomationTaskNow(taskDetail.id, '{}');
      runResult = { success: run.status.toUpperCase() === 'SUCCEEDED' || run.status.toUpperCase() === 'SUCCESS', message: run.error || run.status, runId: run.id };
      runs = [run, ...runs];
    } catch (err) {
      runResult = { success: false, message: err instanceof Error ? err.message : String(err) };
      error = err instanceof Error ? err.message : String(err);
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
```

- [ ] **Step 2: 编写右侧抽屉模板**

在 `</div>` (debug-center) 之后添加：

```svelte
    <!-- Right Drawer -->
    {#if drawerOpen}
      <aside class="debug-drawer">
        <div class="drawer-head">
          <h3>任务工作区</h3>
          <button on:click={() => drawerOpen = false}>✕</button>
        </div>
        <div class="drawer-body">
          <section>
            <h4>JS 脚本</h4>
            <div class="code-editor-wrap">
              <pre class="code-highlight" aria-hidden="true" style="transform: translate({-scriptScrollLeft}px, {-scriptScrollTop}px);">{@html highlightedJS(scriptDraft)}</pre>
              <textarea class="code-editor" rows="16" spellcheck="false" bind:value={scriptDraft} on:scroll={syncCodeScroll}></textarea>
            </div>
          </section>

          <section>
            <div class="section-head">
              <h4>环境变量</h4>
              <button on:click={addEnvItem}>添加变量</button>
            </div>
            {#each envDraft as item, i}
              <div class="env-row">
                <input bind:value={item.name} placeholder="KEY">
                <input bind:value={item.value} placeholder="VALUE" type={item.secret ? 'password' : 'text'}>
                <label><input type="checkbox" bind:checked={item.secret}> 敏感</label>
                <button on:click={() => removeEnvItem(i)}>删除</button>
              </div>
            {/each}
          </section>

          <div class="drawer-actions">
            <button on:click={discardEdits}>撤销</button>
            <button class="primary" disabled={saving} on:click={saveAndRun}>
              {saving ? '保存并运行中...' : '保存并运行'}
            </button>
          </div>

          {#if runResult}
            <section class="run-result">
              <h4>运行结果</h4>
              <div class="result-card" class:success={runResult.success} class:failed={!runResult.success}>
                <span>{runResult.success ? '成功' : '失败'}</span>
                <span>{runResult.message}</span>
              </div>
              {#if runResult.runId}
                <button on:click={goToNewRun}>查看全量输出 →</button>
              {/if}
            </section>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
{/if}
```

- [ ] **Step 3: 添加 JS 语法高亮函数**

从 AutomationTasksPage 复制并稍作调整：

```typescript
  function highlightedJS(source: string): string {
    const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
    return escapeHtml(source).replace(pattern, token => {
      if (/^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|export|from|async|await|true|false|null|undefined)$/.test(token)) return `<span class="tok-keyword">${token}</span>`;
      return `<span class="tok-ident">${token}</span>`;
    });
  }

  function escapeHtml(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
```

---

### Task 11: TaskDebugPage 样式

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte`（在文件末尾添加 `<style>` 块）

- [ ] **Step 1: 添加样式**

在文件末尾添加完整的 `<style>` 块。这里只列出核心样式结构：

```css
  .debug-page-layout { display: flex; height: calc(100vh - 140px); gap: 0; }
  .debug-page-layout.drawer-visible .debug-drawer { display: flex; }

  .debug-sidebar { width: 240px; flex-shrink: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; overflow: hidden; }
  .sidebar-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  .sidebar-body { flex: 1; overflow-y: auto; }
  .run-date-group { padding: 4px 0; }
  .date-label { padding: 6px 12px; font-size: var(--font-size-xs); color: var(--muted); font-weight: var(--font-weight-semibold); }
  .run-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; background: none; cursor: pointer; font-size: var(--font-size-sm); text-align: left; }
  .run-item:hover { background: var(--surface-2); }
  .run-item.active { background: var(--selected-bg); }

  .debug-center { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  .center-tabs { display: flex; border-bottom: 1px solid var(--line); }
  .center-tabs button { padding: 8px 16px; border: none; border-bottom: 2px solid transparent; background: none; cursor: pointer; font-weight: var(--font-weight-semibold); }
  .center-tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }

  .timeline { flex: 1; overflow-y: auto; padding: 8px; }
  .tl-item { display: flex; gap: 10px; padding: 6px 8px; border-left: 3px solid transparent; margin-bottom: 4px; }
  .tl-item.tl-error { border-left-color: var(--danger); background: var(--danger-weak); }
  .tl-time { flex-shrink: 0; width: 130px; font-size: var(--font-size-xs); color: var(--muted); font-family: var(--mono); }
  .tl-content { flex: 1; min-width: 0; }
  .tl-badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; margin-right: 6px; }
  .tl-badge.input { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .tl-badge.event { background: rgba(245,158,11,0.15); color: #d97706; }
  .tl-badge.session { background: rgba(34,197,94,0.15); color: #16a34a; }
  .tl-badge.err { background: rgba(239,68,68,0.15); color: #dc2626; }
  .tl-badge.artifact { background: rgba(139,92,246,0.15); color: #7c3aed; }

  .session-tab { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .session-top-bar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--line); }
  .session-top-bar select { flex: 1; min-width: 0; }

  .chat-messages { flex: 1; overflow-y: auto; padding: 8px; }
  .chat-message { margin-bottom: 8px; padding: 8px 12px; border-radius: 8px; }
  .chat-user { background: var(--primary-weak); }
  .chat-agent { background: #f0fdf4; }

  .debug-drawer { width: 400px; flex-shrink: 0; border-left: 1px solid var(--line); display: flex; flex-direction: column; overflow-y: auto; background: #fff; }
  .drawer-head { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }

  .pause-banner { padding: 8px 16px; background: #fef9c3; color: #854d0e; font-weight: var(--font-weight-semibold); font-size: var(--font-size-sm); text-align: center; }
  .dialog-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .dialog-card { background: #fff; border-radius: 8px; padding: 24px; max-width: 420px; box-shadow: var(--shadow-lg); }
  .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

  /* Terminal */
  .terminal-container { width: 100%; height: 100%; }
  :global(.terminal-container .xterm) { height: 100%; padding: 6px; }
```

还需要加上 split-view、chat-composer、bottom-panel、events-list-sm、code-editor 等样式。完整样式从现有组件复用。

---

### Task 12: 端到端测试验证

- [ ] **Step 1: 编译验证**

```bash
cd /root/agent-compose-ui && npm run check:ui
```

- [ ] **Step 2: 启动 dev server 测试**

```bash
cd /root/agent-compose-ui && npm run dev:ui
```

- [ ] **Step 3: 在浏览器中验证以下场景**

1. 从 AutomationTasksPage 点击"任务调试"按钮，确认导航到 `/tasks/{id}/debug`
2. 暂停确认弹框正常显示
3. 左侧栏运行记录列表正常加载
4. 点击运行记录，时间线正确渲染
5. 选择会话，Session 调试 Tab 正常交互
6. 右侧抽屉编辑代码和变量
7. [保存并运行] 正常触发
8. 离开页面时弹框确认恢复/保持暂停

---

### Task 13: 提交代码

- [ ] **Step 1: 提交**

```bash
git add src/api/loaders.ts src/App.svelte src/pages/AutomationTasksPage.svelte src/pages/RunsPage.svelte src/pages/TaskDebugPage.svelte
git commit -m "feat: add task debug page with run history, session debug, and script editor"
```
