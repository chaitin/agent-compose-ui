# 任务调试页日志全量展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TaskDebugPage.svelte 中实现日志全量展示（去除截断 + 补齐 6 类缺失数据），并删除死代码 SessionDebugPage.svelte。

**Architecture:** 所有功能改动集中在 `src/pages/TaskDebugPage.svelte` 单文件。B1-B5 复用已有 API 数据（零新增请求），B6 懒加载 3 个已存在的 topic 事件 API。无前端测试框架，以 `npm run check:ui`（vite build，含 TS 检查）为编译闸门，末尾统一手动验证。

**Tech Stack:** Svelte 4 (script lang="ts"), xterm.js, Connect/gRPC-web, Vite

**参考 spec:** `docs/superpowers/specs/2026-07-05-task-debug-full-logs-design.md`

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/pages/SessionDebugPage.svelte` | 删除 | untracked 死代码，从未被路由引用 |
| `src/pages/TaskDebugPage.svelte` | 修改 | A 截断修复 + B1-B6 全部改动 |
| `src/api/loaders.ts` | 不改 | `getTopicEvent`/`listTopicEventRuns`/`listTopicEventSessions`/`setAutomationTriggerEnabled` 已存在 |
| `src/api/sessions.ts` | 不改 | 所需字段已在类型中 |

---

### Task 1: 删除死代码 SessionDebugPage.svelte

**Files:**
- Delete: `src/pages/SessionDebugPage.svelte`

- [ ] **Step 1: 确认该文件未被任何地方引用**

Run: `grep -rn "SessionDebugPage" /root/agent-compose-ui/src --include="*.svelte" --include="*.ts"`
Expected: 仅出现 `src/pages/SessionDebugPage.svelte` 自身，无其他引用（App.svelte 不导入它）

- [ ] **Step 2: 删除文件**

Run: `rm /root/agent-compose-ui/src/pages/SessionDebugPage.svelte`

- [ ] **Step 3: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功，无错误

- [ ] **Step 4: 提交**

```bash
cd /root/agent-compose-ui && git add -A && git commit -m "refactor: remove dead SessionDebugPage (never routed)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 脚手架 — imports / 类型扩展 / 新增状态

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L6-17 (loaders import), L40-45 (TimelineEntry type), L86-98 (state)

本任务只加"地基"，不改任何行为，编译通过即可。

- [ ] **Step 1: 扩展 loaders import**

在 `src/pages/TaskDebugPage.svelte` L6-17，把现有 import 块：

```ts
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
```

替换为：

```ts
  import {
    getAutomationTask,
    getAutomationRun,
    getTopicEvent,
    listAutomationEvents,
    listLoaderRuns,
    listTopicEventRuns,
    listTopicEventSessions,
    runAutomationTaskNow,
    saveAutomationTask,
    setAutomationTaskEnabled,
    setAutomationTriggerEnabled,
    type AutomationTaskDetail,
    type AutomationRun,
    type AutomationEvent,
    type TopicEvent,
    type TopicEventRun,
    type TopicEventSession,
  } from '../api/loaders';
```

- [ ] **Step 2: 扩展 TimelineEntry 类型**

在 L40-45，把现有类型：

```ts
  type TimelineEntry =
    | { kind: 'input'; id: string; timestamp: string; content: string }
    | { kind: 'loader_event'; id: string; timestamp: string; type: string; level: string; message: string; detail?: string }
    | { kind: 'session_card'; id: string; timestamp: string; sessionId: string; summary: string; messages?: Array<{role: string; content: string}> }
    | { kind: 'error'; id: string; timestamp: string; message: string }
    | { kind: 'artifact'; id: string; timestamp: string; name: string; size: string };
```

替换为：

```ts
  type TimelineEntry =
    | { kind: 'input'; id: string; timestamp: string; content: string }
    | { kind: 'loader_event'; id: string; timestamp: string; type: string; level: string; message: string; detail?: string; topicEventId?: string }
    | { kind: 'session_card'; id: string; timestamp: string; sessionId: string; summary: string; linkedCellId?: string; messages?: Array<{role: string; content: string}> }
    | { kind: 'error'; id: string; timestamp: string; message: string }
    | { kind: 'artifact'; id: string; timestamp: string; name: string; size: string };

  type TopicChain = {
    event: TopicEvent | null;
    runs: TopicEventRun[];
    sessions: TopicEventSession[];
    loading: boolean;
    error: string;
  };
```

- [ ] **Step 3: 新增状态变量**

在 L98 `let pendingLeaveAction: 'enable' | 'keep_disabled' | null = null;` 之后、L100 `let splitContainer` 之前，插入：

```ts
  // A2: 加载更多事件
  let eventLimit = 500;
  let loadingMoreEvents = false;

  // B5: 跳转高亮
  let highlightedCellId = '';

  // B6: topic 事件链懒加载
  let topicChainCache = new Map<string, TopicChain>();
  let expandedTopicEvents = new Set<string>();

  // B2: 触发器 spec 展开
  let expandedTriggerSpecs = new Set<string>();
```

- [ ] **Step 4: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功（新状态/类型未被使用，但 TS 不会报错）

- [ ] **Step 5: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "refactor: add scaffolding (imports, types, state) for full-log display

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: A — 截断修复（cell 全量 + 去 CSS max-height）

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L236-239 (buildTimeline cell loop), L1340-1357 (.td-tl-pre/.td-tl-detail CSS), L1454-1463 (.td-chat-body CSS)

- [ ] **Step 1: buildTimeline 中 cell 全量展示**

在 L236-239，把：

```ts
          const msgs: Array<{role: string; content: string}> = [];
          for (const cell of cells.slice(0, 4)) {
            const role = cell.type === CellType.UNSPECIFIED ? '用户' : cell.type === CellType.AGENT ? (cell.agent || 'Agent') : '系统';
            const content = cell.type === CellType.UNSPECIFIED ? (cell.source || '') : (cell.output || '');
            if (content.trim()) msgs.push({ role, content: content.length > 200 ? content.slice(0, 200) + '...' : content });
          }
```

替换为：

```ts
          const msgs: Array<{role: string; content: string}> = [];
          for (const cell of cells) {
            const role = cell.type === CellType.UNSPECIFIED ? '用户' : cell.type === CellType.AGENT ? (cell.agent || 'Agent') : '系统';
            const content = cell.type === CellType.UNSPECIFIED ? (cell.source || '') : (cell.output || '');
            if (content.trim()) msgs.push({ role, content });
          }
```

- [ ] **Step 2: 删除 .td-tl-pre 的 max-height**

在 L1340-1354，找到 `.td-tl-pre` 规则，把：

```css
  .td-tl-pre {
    width: 100%;
    margin: 4px 0 2px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    color: var(--muted);
  }
```

替换为（去掉 max-height 两行）：

```css
  .td-tl-pre {
    width: 100%;
    margin: 4px 0 2px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted);
  }
```

- [ ] **Step 3: 删除 .td-tl-detail 的 max-height**

在 L1355-1357，把：

```css
  .td-tl-detail {
    max-height: 140px;
  }
```

替换为（空规则保留为占位，或直接删除整段）：

```css
  .td-tl-detail {
    /* no height clamp — full detail shown */
  }
```

- [ ] **Step 4: 删除 .td-chat-body 的 max-height**

在 L1454-1463，找到 `.td-chat-body` 规则，把：

```css
  .td-chat-body {
    margin: 0;
    font-family: var(--mono);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  }
```

替换为（去掉 max-height，保留 overflow-y 以防单条超长消息内部滚动；外层 .td-chat-messages 已有 overflow-y:auto）：

```css
  .td-chat-body {
    margin: 0;
    font-family: var(--mono);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
```

- [ ] **Step 5: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 6: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "fix: stop truncating timeline cells and clamping log heights

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: A2 — 事件加载更多（500 + 每次加 500）

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L167-179 (loadRunDetail), L906-955 (timeline 模板底部)

- [ ] **Step 1: loadRunDetail 使用 eventLimit**

在 L167-179，把 `loadRunDetail` 函数：

```ts
  async function loadRunDetail(runId: string): Promise<void> {
    try {
      const [detail, events] = await Promise.all([
        getAutomationRun(taskId, runId),
        listAutomationEvents(taskId, 500),
      ]);
      runDetail = detail;
      runEvents = events.filter((e) => !e.runId || e.runId === runId);
      await buildTimeline(detail, runEvents);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
```

替换为：

```ts
  async function loadRunDetail(runId: string): Promise<void> {
    try {
      const [detail, events] = await Promise.all([
        getAutomationRun(taskId, runId),
        listAutomationEvents(taskId, eventLimit),
      ]);
      runDetail = detail;
      runEvents = events.filter((e) => !e.runId || e.runId === runId);
      await buildTimeline(detail, runEvents);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
```

- [ ] **Step 2: 新增 loadMoreEvents 函数**

在 `loadRunDetail` 函数之后（L179 之后）插入：

```ts
  async function loadMoreEvents(): Promise<void> {
    if (loadingMoreEvents || !selectedRunId) return;
    loadingMoreEvents = true;
    eventLimit += 500;
    try {
      await loadRunDetail(selectedRunId);
    } finally {
      loadingMoreEvents = false;
    }
  }

  $: hasMoreEvents = runEvents.length >= eventLimit;
```

- [ ] **Step 3: timeline 底部加"加载更多"按钮**

在 timeline 模板中，找到 L953-954 的闭合标签：

```svelte
                {/each}
              {/if}
            </div>
```

把：

```svelte
                {/each}
              {/if}
            </div>
```

替换为：

```svelte
                {/each}
              {/if}
              {#if selectedRunId && hasMoreEvents}
                <div class="td-tl-loadmore">
                  <button disabled={loadingMoreEvents} on:click={loadMoreEvents}>
                    {loadingMoreEvents ? '加载中...' : `加载更多（已展示 ${runEvents.length} 条）`}
                  </button>
                </div>
              {/if}
            </div>
```

- [ ] **Step 4: 加"加载更多"按钮样式**

在 `.td-tl-pre` 样式规则之后（Task 3 改完的位置附近），插入：

```css
  .td-tl-loadmore {
    padding: 10px 12px;
    display: flex;
    justify-content: center;
  }
  .td-tl-loadmore button {
    min-height: 30px;
    padding: 4px 14px;
    font-size: var(--font-size-sm);
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .td-tl-loadmore button:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .td-tl-loadmore button:disabled {
    color: var(--muted);
    cursor: default;
  }
```

- [ ] **Step 5: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 6: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: load more events in increments of 500

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: B1 — 运行输出 header 展示触发上下文

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L281-290 附近 (runStatusLabel 之后加 triggerKindLabel), L899-905 (header 模板)

- [ ] **Step 1: 新增 triggerKindLabel 辅助函数**

在 `runStatusColor` 函数之后（L298 之后），插入：

```ts
  function triggerKindLabel(run: AutomationRun): string {
    const k = (run.triggerKind || '').toLowerCase();
    if (k === 'manual' || k === '0') return '手动触发';
    if (k === 'interval' || k === '1') return '周期触发';
    if (k === 'event' || k === '2') return '事件触发';
    if (k === 'timeout' || k === '3') return '延迟触发';
    if (k === 'cron' || k === '4') return '定时触发';
    return run.triggerKind || '';
  }
```

- [ ] **Step 2: header 模板加触发段**

在 L899-905，找到 run header 面板：

```svelte
            <div class="panel" style="padding:10px 14px; border-radius:6px 6px 0 0; gap:8px;">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span style="font-weight:var(--font-weight-semibold); font-family:var(--mono); font-size:var(--font-size-sm);">#{shortId(selectedRunId)}</span>
                <span class={`home-pill ${runStatusColor(runDetail)}`}>{runStatusLabel(runDetail)}</span>
                <span style="color:var(--muted); font-size:var(--font-size-sm);">{formatDuration(runDetail.durationMs)}</span>
              </div>
            </div>
```

替换为：

```svelte
            <div class="panel" style="padding:10px 14px; border-radius:6px 6px 0 0; gap:8px;">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span style="font-weight:var(--font-weight-semibold); font-family:var(--mono); font-size:var(--font-size-sm);">#{shortId(selectedRunId)}</span>
                <span class={`home-pill ${runStatusColor(runDetail)}`}>{runStatusLabel(runDetail)}</span>
                <span style="color:var(--muted); font-size:var(--font-size-sm);">{formatDuration(runDetail.durationMs)}</span>
                {#if triggerKindLabel(runDetail)}
                  <span style="color:var(--muted); font-size:var(--font-size-sm);">· 触发: {triggerKindLabel(runDetail)}{runDetail.triggerSource ? ' ' + runDetail.triggerSource : ''}</span>
                {/if}
              </div>
            </div>
```

- [ ] **Step 3: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: show run trigger context in output header

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: B3 — Session chat 消息展示 cell 执行元数据

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L991-1003 (chat 消息模板)

`buildSessionChatMessages` 已返回 exitCode/success/stopReason（L395-407），本任务只改模板。

- [ ] **Step 1: chat 消息头加 exitCode/stopReason badge**

在 L991-1003，找到 chat 消息块：

```svelte
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
```

替换为：

```svelte
                    {#each chatMessages as msg (msg.id)}
                      <div class="td-chat-msg td-chat-{msg.role}" class:td-chat-running={msg.running} id="cell-{msg.id}" class:td-chat-highlight={highlightedCellId === msg.id}>
                        <div class="td-chat-head">
                          <span class="td-chat-role">
                            {#if msg.role === 'user'}用户{:else if msg.role === 'agent'}{msg.agent || 'Agent'}{:else}系统{/if}
                          </span>
                          <span class="td-chat-time">{formatTime(msg.timestamp)}</span>
                          {#if msg.running}<span class="td-chat-running-badge">输出中...</span>{/if}
                          {#if msg.exitCode !== undefined && msg.exitCode !== 0 && !msg.running}<span class="td-chat-exit-code">exit {msg.exitCode}</span>{/if}
                          {#if msg.stopReason}<span class="td-chat-stop-reason">{msg.stopReason}</span>{/if}
                        </div>
                        <pre class="td-chat-body">{msg.content || (msg.running ? '等待输出...' : '(无内容)')}</pre>
                      </div>
                    {/each}
```

- [ ] **Step 2: 加 exit-code badge 样式**

在 `.td-chat-stop-reason` 样式规则之后（L1450-1453 附近），插入：

```css
  .td-chat-exit-code {
    font-size: var(--font-size-xs);
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(239,68,68,0.1);
    color: var(--danger);
    font-family: var(--mono);
  }
  .td-chat-highlight {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
    transition: outline 0.3s ease;
  }
```

- [ ] **Step 3: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: show cell exitCode/stopReason in session chat

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: B4 — Session tab 顶部展示 session 元数据

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L959-973 (session tab 顶部 panel)

- [ ] **Step 1: 新增 session 状态 pill 辅助函数**

在 `mapSessionStatus` 函数之后（L279 之后），插入：

```ts
  function sessionStatusColor(s: string): string {
    const n = (s || '').toUpperCase();
    if (n === 'FAILED' || n === 'START_FAILED') return 'red';
    if (n === 'STOPPED') return 'gray';
    if (n === 'RUNNING' || n === 'STARTING' || n === 'PENDING') return 'blue';
    return 'gray';
  }
```

- [ ] **Step 2: session tab 顶部 panel 替换为元数据 header**

在 L959-973，找到 session tab 顶部：

```svelte
        <div class="td-session-tab">
          <div class="panel" style="padding:8px 12px; border-radius:6px 6px 0 0; flex-shrink:0;">
            <div style="display:flex; gap:8px; align-items:center;">
              <select bind:value={selectedSessionId} style="flex:1; min-height:32px;"
                on:change={() => { if (selectedSessionId) { void loadSessionDetail(selectedSessionId); } }}>
                <option value="">选择会话...</option>
                {#each availableSessions as s}
                  <option value={s.id}>会话 {s.label}</option>
                {/each}
              </select>
              <button disabled={!canResumeSession()} on:click={resumeCurrentSession}>
                {resuming ? '重启中...' : '重启会话'}
              </button>
            </div>
          </div>
```

替换为：

```svelte
        <div class="td-session-tab">
          <div class="panel" style="padding:8px 12px; border-radius:6px 6px 0 0; flex-shrink:0;">
            <div style="display:flex; gap:8px; align-items:center;">
              <select bind:value={selectedSessionId} style="flex:1; min-height:32px;"
                on:change={() => { if (selectedSessionId) { void loadSessionDetail(selectedSessionId); } }}>
                <option value="">选择会话...</option>
                {#each availableSessions as s}
                  <option value={s.id}>会话 {s.label}</option>
                {/each}
              </select>
              <button disabled={!canResumeSession()} on:click={resumeCurrentSession}>
                {resuming ? '重启中...' : '重启会话'}
              </button>
            </div>
            {#if session}
              <div class="td-session-meta">
                <span class="td-session-meta-title">{session.title || shortId(session.id)}</span>
                <span class="td-session-meta-sep">·</span>
                <span>{session.driver || '-'}{session.guestImage ? '/' + session.guestImage : ''}</span>
                <span class="td-session-meta-sep">·</span>
                <span>创建 {formatTime(session.createdAt)}</span>
                <span class="td-session-meta-sep">·</span>
                <span>{session.cellCount} cells / {session.eventCount} events</span>
                <span class={`home-pill ${sessionStatusColor(rawSessionStatus)}`}>{sessionStatus}</span>
              </div>
            {/if}
          </div>
```

- [ ] **Step 3: 加 session meta 样式**

在 `.td-session-tab` 样式规则之后（L1359-1366 附近），插入：

```css
  .td-session-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
    font-size: var(--font-size-xs);
    color: var(--muted);
  }
  .td-session-meta-title {
    font-weight: var(--font-weight-semibold);
    color: var(--text);
    font-size: var(--font-size-sm);
  }
  .td-session-meta-sep {
    color: var(--line-strong);
  }
```

- [ ] **Step 4: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: show session metadata header in session tab

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: B5 — timeline session_card 加 linkedCellId 跳转

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L198-209 (buildTimeline session_card), L345-349 (selectSession), L931-942 (session_card 模板)

- [ ] **Step 1: buildTimeline 传递 linkedCellId**

在 L198-209，找到 session_card 创建逻辑：

```ts
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
```

替换为：

```ts
      if (e.linkedSessionId || e.linkedAgentSessionId) {
        const sid = e.linkedSessionId || e.linkedAgentSessionId;
        if (!entries.some((en) => en.kind === 'session_card' && en.sessionId === sid)) {
          entries.push({
            kind: 'session_card',
            id: `session-${sid}-${e.id}`,
            timestamp: e.createdAt,
            sessionId: sid,
            summary: translateEventType(e.type),
            linkedCellId: e.linkedCellId || undefined,
          });
        }
      }
```

- [ ] **Step 2: selectSession 清空 highlightedCellId**

在 L345-349，把 `selectSession`：

```ts
  function selectSession(sid: string): void {
    selectedSessionId = sid;
    centerTab = 'session';
    void loadSessionDetail(sid);
  }
```

替换为：

```ts
  function selectSession(sid: string): void {
    selectedSessionId = sid;
    highlightedCellId = '';
    centerTab = 'session';
    void loadSessionDetail(sid);
  }

  function jumpToCell(sessionId: string, cellId: string): void {
    selectedSessionId = sessionId;
    highlightedCellId = '';
    centerTab = 'session';
    const afterLoad = () => {
      highlightedCellId = cellId;
      requestAnimationFrame(() => {
        document.getElementById(`cell-${cellId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      setTimeout(() => { highlightedCellId = ''; }, 2000);
    };
    if (!session || session.id !== sessionId) {
      void loadSessionDetail(sessionId).then(afterLoad);
    } else {
      afterLoad();
    }
  }
```

- [ ] **Step 3: session_card 模板加跳转链接**

在 L931-942，找到 session_card 块：

```svelte
                      {:else if entry.kind === 'session_card'}
                        <span class="td-tl-type">会话</span>
                        <span class="td-tl-msg">{shortId(entry.sessionId)} · {entry.summary}</span>
                        <button class="td-tl-link" on:click={() => selectSession(entry.sessionId)}>查看</button>
                        {#if entry.messages}
                          {#each entry.messages as m}
                            <div class="td-tl-session-msg">
                              <span class="td-tl-session-role">{m.role}:</span>
                              <span class="td-tl-session-text">{m.content}</span>
                            </div>
                          {/each}
                        {/if}
```

替换为：

```svelte
                      {:else if entry.kind === 'session_card'}
                        <span class="td-tl-type">会话</span>
                        <span class="td-tl-msg">{shortId(entry.sessionId)} · {entry.summary}</span>
                        <button class="td-tl-link" on:click={() => selectSession(entry.sessionId)}>查看</button>
                        {#if entry.linkedCellId}
                          <button class="td-tl-link" on:click={() => jumpToCell(entry.sessionId, entry.linkedCellId)}>→ 跳转到 cell {shortId(entry.linkedCellId)}</button>
                        {/if}
                        {#if entry.messages}
                          {#each entry.messages as m}
                            <div class="td-tl-session-msg">
                              <span class="td-tl-session-role">{m.role}:</span>
                              <span class="td-tl-session-text">{m.content}</span>
                            </div>
                          {/each}
                        {/if}
```

- [ ] **Step 4: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: jump to linked cell from timeline session_card

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: B2 — 抽屉新增触发器 section（只读 + 开关）

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L281-290 附近 (新增 trigger 辅助函数), L1107-1116 (drawer env section 后), L308-321 附近 (triggerKindLabel 已在 Task 5 加过 run 版，这里加 trigger 版)

- [ ] **Step 1: 新增 trigger 辅助函数**

在 Task 5 加的 `triggerKindLabel(run)` 函数之后，插入（注意这是 trigger 版本，参数是 AutomationTrigger）：

```ts
  function triggerKindLabelFromTrigger(kind: string): string {
    const k = (kind || '').toLowerCase();
    if (k === 'manual' || k === '0') return '手动触发';
    if (k === 'interval' || k === '1') return '周期触发';
    if (k === 'event' || k === '2') return '事件触发';
    if (k === 'timeout' || k === '3') return '延迟触发';
    if (k === 'cron' || k === '4') return '定时触发';
    return kind || '未知';
  }

  async function toggleTriggerEnabled(triggerId: string, currentEnabled: boolean): Promise<void> {
    if (!taskDetail) return;
    try {
      const updated = await setAutomationTriggerEnabled(taskDetail.id, triggerId, !currentEnabled);
      taskDetail = updated;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function toggleTriggerSpec(triggerId: string): void {
    if (expandedTriggerSpecs.has(triggerId)) {
      expandedTriggerSpecs.delete(triggerId);
    } else {
      expandedTriggerSpecs.add(triggerId);
    }
    expandedTriggerSpecs = expandedTriggerSpecs; // trigger reactivity
  }
```

- [ ] **Step 2: 抽屉 env section 之后加触发器 section**

在 L1107-1116，找到 env section 闭合 + actions 开始：

```svelte
          <section>
            <div class="td-section-head">
              <h4>环境变量</h4>
              <button on:click={addEnvItem} style="min-height:28px; font-size:var(--font-size-xs);">添加变量</button>
            </div>
            {#if envDraft.length === 0}
              <p class="muted">未配置环境变量</p>
            {:else}
              {#each envDraft as item, i}
                <div class="td-env-row">
                  <input bind:value={item.name} placeholder="KEY" style="flex:1;">
                  <input bind:value={item.value} placeholder="VALUE" type={item.secret ? 'password' : 'text'} style="flex:1.4;">
                  <label class="td-env-secret"><input type="checkbox" bind:checked={item.secret}> 敏感</label>
                  <button class="ghost" style="min-height:28px; padding:4px 6px; color:var(--danger);" on:click={() => removeEnvItem(i)}>删除</button>
                </div>
              {/each}
            {/if}
          </section>

          <div class="td-drawer-actions">
```

在 `</section>`（env section 结束）和 `<div class="td-drawer-actions">` 之间插入触发器 section：

```svelte
          </section>

          <section>
            <h4>触发器</h4>
            {#if !taskDetail.triggers || taskDetail.triggers.length === 0}
              <p class="muted">未配置触发器（手动触发）</p>
            {:else}
              {#each taskDetail.triggers as t (t.triggerId)}
                <div class="td-trigger-card">
                  <div class="td-trigger-head">
                    <label class="td-trigger-toggle">
                      <input type="checkbox" checked={t.enabled} on:change={() => toggleTriggerEnabled(t.triggerId, t.enabled)}>
                      <span>{triggerKindLabelFromTrigger(t.kind)}</span>
                    </label>
                    {#if t.topic}<span class="td-trigger-cond">topic: {t.topic}</span>{/if}
                    {#if t.intervalMs > 0}<span class="td-trigger-cond">间隔 {t.intervalMs}ms</span>{/if}
                  </div>
                  <div class="td-trigger-times">
                    <span>下次: {t.nextFireAt ? formatTime(t.nextFireAt) : '—'}</span>
                    <span>上次: {t.lastFiredAt ? formatTime(t.lastFiredAt) : '—'}</span>
                  </div>
                  {#if t.specJson}
                    <button class="td-trigger-spec-btn" on:click={() => toggleTriggerSpec(t.triggerId)}>
                      {expandedTriggerSpecs.has(t.triggerId) ? '▾ spec' : '▸ spec'}
                    </button>
                    {#if expandedTriggerSpecs.has(t.triggerId)}
                      <pre class="td-trigger-spec">{tryFormatJson(t.specJson)}</pre>
                    {/if}
                  {/if}
                </div>
              {/each}
            {/if}
          </section>

          <div class="td-drawer-actions">
```

- [ ] **Step 3: 加触发器卡片样式**

在 `.td-env-secret` 样式规则之后（L1670-1678 附近），插入：

```css
  /* Trigger cards */
  .td-trigger-card {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: var(--surface);
  }
  .td-trigger-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .td-trigger-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }
  .td-trigger-toggle input {
    width: auto;
    margin: 0;
  }
  .td-trigger-cond {
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    color: var(--muted);
  }
  .td-trigger-times {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    font-size: var(--font-size-xs);
    color: var(--muted);
  }
  .td-trigger-spec-btn {
    background: none;
    border: none;
    color: var(--primary);
    cursor: pointer;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    padding: 2px 0;
    margin-top: 4px;
    min-height: 0;
  }
  .td-trigger-spec {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--surface-2);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--muted);
  }
```

- [ ] **Step 4: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: show task triggers (read-only + enable toggle) in drawer

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: B6 — timeline 内联展开 topic 事件链

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte` L181-247 (buildTimeline 赋值 topicEventId), L181 之后加 toggleTopicChain, L925-930 (loader_event 模板)

- [ ] **Step 1: buildTimeline 中 loader_event 赋值 topicEventId**

在 L188-197，找到 loader_event 推入逻辑：

```ts
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
```

替换为（加 topicEventId）：

```ts
    for (const e of events) {
      entries.push({
        kind: 'loader_event',
        id: e.id,
        timestamp: e.createdAt,
        type: e.type,
        level: e.level,
        message: e.message,
        detail: e.payloadJson ? tryFormatJson(e.payloadJson) : undefined,
        topicEventId: e.topicEventId || undefined,
      });
```

- [ ] **Step 2: 新增 toggleTopicChain 函数**

在 `buildTimeline` 函数之后（L247 之后），插入：

```ts
  async function toggleTopicChain(entry: TimelineEntry & { kind: 'loader_event' }): Promise<void> {
    const tid = entry.topicEventId;
    if (!tid) return;
    if (expandedTopicEvents.has(entry.id)) {
      expandedTopicEvents.delete(entry.id);
      expandedTopicEvents = expandedTopicEvents;
      return;
    }
    expandedTopicEvents.add(entry.id);
    expandedTopicEvents = expandedTopicEvents;
    if (topicChainCache.has(tid)) return;
    topicChainCache.set(tid, { event: null, runs: [], sessions: [], loading: true, error: '' });
    topicChainCache = topicChainCache;
    const [evtRes, runsRes, sessRes] = await Promise.allSettled([
      getTopicEvent(tid),
      listTopicEventRuns(tid),
      listTopicEventSessions(tid),
    ]);
    topicChainCache.set(tid, {
      event: evtRes.status === 'fulfilled' ? evtRes.value : null,
      runs: runsRes.status === 'fulfilled' ? runsRes.value : [],
      sessions: sessRes.status === 'fulfilled' ? sessRes.value : [],
      loading: false,
      error: evtRes.status === 'rejected' ? (evtRes.reason instanceof Error ? evtRes.reason.message : String(evtRes.reason)) : '',
    });
    topicChainCache = topicChainCache;
  }

  function jumpToTopicRun(runId: string, loaderId: string): void {
    if (loaderId !== taskId || !runs.some((r) => r.id === runId)) return;
    selectedRunId = runId;
    void loadRunDetail(runId);
    centerTab = 'output';
  }
```

- [ ] **Step 3: loader_event 模板加展开区**

在 L925-930，找到 loader_event 块：

```svelte
                      {:else if entry.kind === 'loader_event'}
                        <span class="td-tl-msg">{translateEventType(entry.type)}</span>
                        {#if entry.message}<span class="td-tl-msg-detail">{entry.message}</span>{/if}
                        {#if entry.detail}
                          <pre class="td-tl-pre td-tl-detail">{entry.detail}</pre>
                        {/if}
```

替换为：

```svelte
                      {:else if entry.kind === 'loader_event'}
                        <span class="td-tl-msg">{translateEventType(entry.type)}</span>
                        {#if entry.message}<span class="td-tl-msg-detail">{entry.message}</span>{/if}
                        {#if entry.detail}
                          <pre class="td-tl-pre td-tl-detail">{entry.detail}</pre>
                        {/if}
                        {#if entry.topicEventId}
                          <button class="td-tl-expand" on:click={() => toggleTopicChain(entry)}>
                            {expandedTopicEvents.has(entry.id) ? '▾' : '▸'} 事件链
                          </button>
                          {#if expandedTopicEvents.has(entry.id)}
                            {@const chain = topicChainCache.get(entry.topicEventId)}
                            <div class="td-topic-chain">
                              {#if !chain || chain.loading}
                                <div class="td-topic-loading">加载中...</div>
                              {:else}
                                {#if chain.event}
                                  <div class="td-topic-section">
                                    <span class="td-topic-section-label">原始事件</span>
                                    <div class="td-topic-meta">
                                      <span>topic: {chain.event.topic}</span>
                                      <span>source: {chain.event.source}</span>
                                      <span>状态: {chain.event.dispatchStatus}</span>
                                    </div>
                                    {#if chain.event.payload && Object.keys(chain.event.payload).length > 0}
                                      <pre class="td-tl-pre">{JSON.stringify(chain.event.payload, null, 2)}</pre>
                                    {/if}
                                  </div>
                                {:else if chain.error}
                                  <div class="td-topic-error">原始事件已过期或不存在（{chain.error}）</div>
                                {/if}
                                {#if chain.runs.length > 0}
                                  <div class="td-topic-section">
                                    <span class="td-topic-section-label">关联 Runs ({chain.runs.length})</span>
                                    {#each chain.runs as r}
                                      <div class="td-topic-row" class:td-topic-row-current={r.runId === selectedRunId}>
                                        {#if r.loaderId === taskId && runs.some((rr) => rr.id === r.runId)}
                                          <button class="td-topic-row-link" on:click={() => jumpToTopicRun(r.runId, r.loaderId)}>
                                            {shortId(r.loaderId)} → run {shortId(r.runId || '-')} [{r.status}] {formatTime(r.createdAt)}
                                          </button>
                                        {:else}
                                          <span>{shortId(r.loaderId)} → run {shortId(r.runId || '-')} [{r.status}] {formatTime(r.createdAt)}</span>
                                        {/if}
                                      </div>
                                    {/each}
                                  </div>
                                {/if}
                                {#if chain.sessions.length > 0}
                                  <div class="td-topic-section">
                                    <span class="td-topic-section-label">关联 Sessions ({chain.sessions.length})</span>
                                    {#each chain.sessions as s}
                                      <button class="td-topic-row-link" on:click={() => selectSession(s.sessionId)}>
                                        session {shortId(s.sessionId)} [{s.relation}] {formatTime(s.createdAt)}
                                      </button>
                                    {/each}
                                  </div>
                                {/if}
                              {/if}
                            </div>
                          {/if}
                        {/if}
```

- [ ] **Step 4: 加 topic 事件链样式**

在 Task 4 加的 `.td-tl-loadmore` 样式之后，插入：

```css
  /* Topic event chain */
  .td-tl-expand {
    background: none;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--primary);
    cursor: pointer;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    padding: 1px 8px;
    min-height: 0;
    margin-top: 4px;
  }
  .td-tl-expand:hover { background: var(--surface-2); }
  .td-topic-chain {
    width: 100%;
    margin-top: 6px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .td-topic-loading { color: var(--muted); font-size: var(--font-size-xs); }
  .td-topic-error { color: var(--danger); font-size: var(--font-size-xs); }
  .td-topic-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .td-topic-section-label {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-xs);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .td-topic-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    color: var(--text);
  }
  .td-topic-row {
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    color: var(--text);
    line-height: 1.5;
  }
  .td-topic-row-current {
    font-weight: var(--font-weight-semibold);
    color: var(--primary);
  }
  .td-topic-row-link {
    background: none;
    border: none;
    color: var(--primary);
    cursor: pointer;
    font-family: var(--mono);
    font-size: var(--font-size-xs);
    padding: 0;
    min-height: 0;
    text-align: left;
    text-decoration: underline;
  }
  .td-topic-row-link:hover { color: #1d4ed8; }
```

- [ ] **Step 5: 验证编译**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功

- [ ] **Step 6: 提交**

```bash
cd /root/agent-compose-ui && git add src/pages/TaskDebugPage.svelte && git commit -m "feat: inline topic event chain expansion in timeline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: 最终验证

**Files:**
- 无代码改动

- [ ] **Step 1: 全量编译检查**

Run: `cd /root/agent-compose-ui && npm run check:ui`
Expected: 构建成功，无 TS 错误，无 warning

- [ ] **Step 2: 启动 dev server**

Run: `cd /root/agent-compose-ui && npm run dev:ui`
Expected: dev server 启动，无报错

- [ ] **Step 3: 手动验证清单**

在浏览器中打开一个任务调试页 `/tasks/{id}/debug`，逐项验证：

| # | 场景 | 预期 |
|---|------|------|
| 1 | 选一个事件触发的 run | header 显示"· 触发: 事件触发 ..."；该 run 的 `loader.event.published` 事件有"▸ 事件链"按钮 |
| 2 | 点"▸ 事件链"展开 | 显示原始事件 payload + 关联 Runs + 关联 Sessions；当前 run 高亮 |
| 3 | 点关联 session | 切到 session tab，加载该 session |
| 4 | 选 >500 事件的 run | timeline 底部出现"加载更多"按钮，点击后事件数增加 |
| 5 | 长 cell 内容（>200 字符） | timeline 完整展示，不截断 |
| 6 | agent 失败的 cell | session chat 消息头显示 `exit {非0}` 红标 + stopReason |
| 7 | 点 session_card 的"跳转到 cell" | 切到 session tab，目标 cell 滚动到视野并高亮 2 秒 |
| 8 | 打开抽屉 | "触发器"section 展示所有 trigger 卡片 |
| 9 | 切换 trigger enabled 开关 | 立即生效，刷新后保持 |
| 10 | 展开 trigger spec | 显示 specJson |
| 11 | session tab header | 显示 title/driver/guestImage/createdAt/cellCount/eventCount/状态pill |

- [ ] **Step 4: 最终提交（如有手动修复）**

如果手动验证发现小问题并修复，提交：

```bash
cd /root/agent-compose-ui && git add -A && git commit -m "fix: address manual testing feedback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

如无修复，跳过本步。

---

## 完成标准

- [ ] `npm run check:ui` 构建成功
- [ ] Task 11 手动验证清单全部通过
- [ ] 所有提交已落地，commit message 清晰
