# 任务调试页日志全量展示设计

> **日期**: 2026-07-05
> **范围**: `src/pages/TaskDebugPage.svelte`（主） + 删除 `src/pages/SessionDebugPage.svelte`（死代码）
> **目标**: 让用户在排查自动化任务问题时能看到全量日志，不截断、不隐藏；并补齐 API 已提供但页面未展示的日志/数据类别。

---

## 背景与问题

当前 `TaskDebugPage.svelte` 是唯一生效的任务调试页（`App.svelte` 路由 `/tasks/{id}/debug`）。它存在两类问题：

### A. 已获取但被截断/隐藏的日志

| # | 位置 | 问题 |
|---|------|------|
| A1 | `buildTimeline` L236-239 | session cell 只展示前 4 条，每条内容截断到 200 字符 |
| A2 | `listAutomationEvents(taskId, 500)` L138/L170 | 硬限制 500 条事件，超出的丢弃 |
| A3 | CSS `.td-chat-body` `max-height: 260px` | 消息体超 260px 被裁剪 |
| A4 | CSS `.td-tl-pre` `max-height: 200px` | timeline pre 块超 200px 被裁剪 |
| A5 | CSS `.td-tl-detail` `max-height: 140px` | event detail 超 140px 被裁剪 |

### B. API 已提供但页面未展示的类别

| # | 类别 | API 来源 | 排查价值 |
|---|------|---------|---------|
| B1 | Run 触发上下文（triggerKind/triggerSource/triggerId） | `AutomationRun` | 关键：定位"run 为什么触发" |
| B2 | Task 触发器配置（triggers[]） | `AutomationTaskDetail.triggers` | 关键：定位"任务为什么没按时触发" |
| B3 | Cell 执行元数据（exitCode/success/stopReason） | `WorkSessionCell` | 关键：agent 失败时定位根因 |
| B4 | Session 元数据（title/driver/guestImage/createdAt/...） | `WorkSession` | 辅助：了解 session 环境 |
| B5 | Event linkedCellId | `AutomationEvent.linkedCellId` | 辅助：event 关联到具体 cell |
| B6 | Topic 事件链（原始 event → 关联 runs → 关联 sessions） | `getTopicEvent` / `listTopicEventRuns` / `listTopicEventSessions` | 辅助：事件驱动自动化全链路追踪 |

### C. 不在本次范围（API 限制，前端无法解决）

- C1: `listWorkSessionEvents` 不返回 payload（后端未暴露）
- C2: 无容器/系统日志拉取 API

---

## 设计原则

1. **B1-B5 复用已有数据，零新增请求**——这些字段已在现有 API 响应里，只是没被展示。
2. **只有 B6 是懒加载新请求**——用户展开 topic event 时才调用。
3. **A2 用"加载更多"而非一次拉全量**——初始 500，每次 +500。
4. **触发器配置只读 + 开关**——后端无"改触发器内容"API，配置由脚本决定；改内容需编辑脚本。

---

## 第 1 节：数据流与状态

### 1.1 现有数据流（不变）

```
load()
  → getAutomationTask(taskId)           → taskDetail (含 triggers, B2 来源)
  → listLoaderRuns(taskId, 100)         → runs
  → listAutomationEvents(taskId, 500)   → allEvents (仅用于收集 sessionIds)
  → 若有 initialRunId: loadRunDetail()
  → 若有 initialSessionId: loadSessionDetail()

loadRunDetail(runId)
  → getAutomationRun(taskId, runId)     → runDetail (含 triggerKind/Source, B1 来源)
  → listAutomationEvents(taskId, eventLimit)  ← A2: 用 eventLimit 替代硬编码 500
  → 过滤 e.runId === runId             → runEvents
  → buildTimeline(runDetail, runEvents) → timeline

loadSessionDetail(sid)
  → getWorkSessionStatus(sid)           → session (B4 来源)
  → listWorkSessionCells(sid)           → sessionCells (B3 来源)
  → listWorkSessionEvents(sid)          → sessionEvents
  → startWatching(sid)
```

### 1.2 新增状态

```ts
// A2: 加载更多
let eventLimit = 500;
let loadingMoreEvents = false;

// B6: topic 事件链懒加载
type TopicChain = {
  event: TopicEvent | null;
  runs: TopicEventRun[];
  sessions: TopicEventSession[];
  loading: boolean;
  error: string;
};
let topicChainCache = new Map<string, TopicChain>();   // key = topicEventId
let expandedTopicEvents = new Set<string>();            // key = event.id

// B5: 跳转高亮
let highlightedCellId = '';
```

### 1.3 B6 懒加载流程

```
用户点击 timeline 中某 loader_event 的展开图标 (该 event.topicEventId 非空)
  → expandedTopicEvents.add(event.id)
  → 若 topicChainCache 已有该 topicEventId：直接渲染
  → 否则：
      topicChainCache.set(topicEventId, { loading: true, ... })
      并行:
        getTopicEvent(topicEventId)              → event (可能 404)
        listTopicEventRuns(topicEventId)         → runs
        listTopicEventSessions(topicEventId)     → sessions
      全部 settled 后:
        topicChainCache.set(topicEventId, { event, runs, sessions, loading: false })
```

缓存按 `topicEventId` 而非 `event.id`——同一原始事件可能在多个 run 的 timeline 里出现，复用缓存。

---

## 第 2 节：UI 结构（A + B1~B5）

### 2.1 B1 — 运行输出 header

**位置**: `TaskDebugPage.svelte` L899-905（run 详情头部面板）

**现状**:
```
#{shortId}  [状态pill]  {duration}
```

**改为**:
```
#{shortId}  [状态pill]  {duration}  · 触发: {triggerKind中文} {triggerSource}
```

`triggerKind` 中文映射：
- `manual` → 手动触发
- `interval` → 周期触发
- `event` → 事件触发
- `cron` → 定时触发
- `timeout` → 延迟触发

`triggerSource` 原样展示（如 `loader.event.published`）。两者为空则不渲染"触发"段。

### 2.2 B2 — 抽屉新增"触发器"section

**位置**: 右侧抽屉，"环境变量"section 之后、"撤销/保存并运行"actions 之前。

**展示**: `taskDetail.triggers` 每个 trigger 一张卡片：

```
[✓ enabled 开关] {kind中文}
  {条件字段，见下}
  下次触发: {nextFireAt 或 "—"}
  上次触发: {lastFiredAt 或 "—"}
  spec ▸  (点击展开 specJson)
```

条件字段按 kind：
- `interval` → `间隔 {intervalMs}ms`
- `event` → `topic: {topic}`
- `cron` → specJson 展开后含 cron 表达式
- `manual`/`timeout` → 无额外字段

**交互**:
- enabled 开关：点击调 `setAutomationTriggerEnabled(taskId, triggerId, !enabled)`，成功后更新本地 `taskDetail.triggers[i].enabled`。
- spec 展开/折叠：本地状态 `expandedTriggerSpecs: Set<triggerId>`。
- **只读**：kind/topic/interval/specJson 均不可编辑，改内容需编辑脚本。

### 2.3 B3 — Session chat 消息元数据

**位置**: `TaskDebugPage.svelte` 的 `buildSessionChatMessages`（L395-407）+ chat 消息模板（L991-1003）。

**现状**: `buildSessionChatMessages` 只返回 `id/role/content/timestamp/agent/running`，丢弃 `exitCode/success/stopReason`。

**改为**: 增加返回 `exitCode/success/stopReason`（移植自 `SessionDebugPage`）。

消息头渲染（agent 消息）：
```
{agent名}  {time}  [输出中...badge if running]  [exit {非0码} 红标 if exitCode≠0且!running]  [{stopReason} 灰标 if stopReason]
```

### 2.4 B4 — Session tab 顶部 header

**位置**: session tab 的 session 选择框下方、split-view 上方（L960-973 之后）。

**展示**:
```
{title}  ·  {driver}/{guestImage}  ·  创建 {createdAt}  ·  {cellCount} cells / {eventCount} events  [状态pill]
```

`session` 为 null 时不渲染。

### 2.5 B5 — timeline session_card 加跳转链接

**位置**: `buildTimeline` 中 session_card 条目（L198-209）+ 模板（L931-942）。

**现状**: session_card 只展示 `shortId · summary` + "查看"按钮。

**改为**: 若关联 event 有 `linkedCellId`，额外渲染"→ 跳转到 cell {shortId}"链接。

**跳转交互**:
```ts
function jumpToCell(sessionId: string, cellId: string): void {
  selectedSessionId = sessionId;
  centerTab = 'session';
  // 若 session 尚未加载，先加载
  if (!session || session.id !== sessionId) {
    void loadSessionDetail(sessionId).then(() => {
      highlightedCellId = cellId;
      scrollCellIntoView(cellId);
    });
  } else {
    highlightedCellId = cellId;
    scrollCellIntoView(cellId);
  }
}
```

`scrollCellIntoView`: 用 `requestAnimationFrame` 等待 DOM 更新，`document.getElementById('cell-' + cellId)?.scrollIntoView({ block: 'center' })`。

**高亮**: chat 消息 div 加 `id="cell-{cellId}"`，当 `highlightedCellId === cellId` 时加 class `td-chat-highlight`，2 秒后清空 `highlightedCellId`（CSS 用 transition 淡出）。

session 切换时清空 `highlightedCellId`，避免跨 session 误高亮。

### 2.6 A — 截断修复

**A1 cell 全量**（`buildTimeline` L236-239）:
```ts
// 现状
for (const cell of cells.slice(0, 4)) {
  if (content.trim()) msgs.push({ role, content: content.length > 200 ? content.slice(0, 200) + '...' : content });
}
// 改为
for (const cell of cells) {
  if (content.trim()) msgs.push({ role, content });
}
```

**A2 加载更多**:
- `loadRunDetail` 内 `listAutomationEvents(taskId, eventLimit)` 替代硬编码 500
- timeline 底部新增"加载更多"按钮，条件：`runEvents.length >= eventLimit && !loadingMoreEvents`
- 点击：`eventLimit += 500; loadingMoreEvents = true; await loadRunDetail(selectedRunId); loadingMoreEvents = false`
- 后端返回 `< eventLimit` 时隐藏按钮（到底了）
- 按钮文案：`加载更多（已展示 {runEvents.length} 条）`

**A3-A5 CSS 去 max-height**:
- `.td-chat-body`: 删 `max-height: 260px`（保留 `overflow-y: auto`，外层 `.td-chat-messages` 已滚动）
- `.td-tl-pre`: 删 `max-height: 200px`
- `.td-tl-detail`: 删 `max-height: 140px`（其父 `.td-tl-pre` 已无限制）

---

## 第 3 节：B6 topic 事件链（方案 A 内联展开）

### 3.1 触发条件

timeline 中 `loader_event` 条目，其 `topicEventId` 非空。`topicEventId` 已在 `listAutomationEvents` API 层从 `payloadJson` 解析（L292）。

### 3.2 timeline loader_event 条目改造

**现状**（L925-930）:
```svelte
{:else if entry.kind === 'loader_event'}
  <span class="td-tl-msg">{translateEventType(entry.type)}</span>
  {#if entry.message}<span class="td-tl-msg-detail">{entry.message}</span>{/if}
  {#if entry.detail}<pre class="td-tl-pre td-tl-detail">{entry.detail}</pre>{/if}
```

**改为**: 在上述内容后，若 `entry.topicEventId` 非空，渲染展开区：
```svelte
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
        <!-- 原始事件 -->
        {#if chain.event}
          <div class="td-topic-section">
            <span class="td-topic-section-label">原始事件</span>
            <span>topic: {chain.event.topic}</span>
            <span>source: {chain.event.source}</span>
            <span>状态: {chain.event.dispatchStatus}</span>
            <pre class="td-tl-pre">{JSON.stringify(chain.event.payload, null, 2)}</pre>
          </div>
        {:else if chain.error}
          <div class="td-topic-error">原始事件已过期或不存在（{chain.error}）</div>
        {/if}
        <!-- 关联 Runs -->
        {#if chain.runs.length > 0}
          <div class="td-topic-section">
            <span class="td-topic-section-label">关联 Runs ({chain.runs.length})</span>
            {#each chain.runs as r}
              <div class="td-topic-row" class:td-topic-row-current={r.runId === selectedRunId}>
                {shortId(r.loaderId)} → run {shortId(r.runId)} [{r.status}] {formatTime(r.createdAt)}
              </div>
            {/each}
          </div>
        {/if}
        <!-- 关联 Sessions -->
        {#if chain.sessions.length > 0}
          <div class="td-topic-section">
            <span class="td-topic-section-label">关联 Sessions ({chain.sessions.length})</span>
            {#each chain.sessions as s}
              <button class="td-topic-row td-topic-row-link" on:click={() => selectSession(s.sessionId)}>
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

### 3.3 timeline entry 类型扩展

`TimelineEntry` 的 `loader_event` 变体增加 `topicEventId`:
```ts
| { kind: 'loader_event'; id: string; timestamp: string; type: string; level: string; message: string; detail?: string; topicEventId?: string }
```

`buildTimeline` 中赋值 `topicEventId: e.topicEventId`。

### 3.4 toggleTopicChain 实现

```ts
async function toggleTopicChain(entry: TimelineEntry & { kind: 'loader_event' }): Promise<void> {
  const tid = entry.topicEventId!;
  if (expandedTopicEvents.has(entry.id)) {
    expandedTopicEvents.delete(entry.id);
    return;
  }
  expandedTopicEvents.add(entry.id);
  if (topicChainCache.has(tid)) return;
  topicChainCache.set(tid, { event: null, runs: [], sessions: [], loading: true, error: '' });
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
    error: evtRes.status === 'rejected' ? String(evtRes.reason) : '',
  });
}
```

### 3.5 关联 run/session 跳转

- 关联 run：若 `r.loaderId === taskId` 且 `r.runId` 在 `runs` 列表中 → 可点击，点击执行 `selectedRunId = r.runId; void loadRunDetail(r.runId); centerTab = 'output'`（与左侧运行列表点选同一逻辑）；否则灰显（其他任务的 run，当前页无法打开）。
- 关联 session：点击 `selectSession(s.sessionId)`，若该 session 不在 `availableSessions` 里，仍可手动 `loadSessionDetail`（`selectSession` 已支持）。

---

## 第 4 节：边界情况与错误处理

| 场景 | 处理 |
|------|------|
| `topicEventId` 为空 | 不渲染"事件链"展开按钮，按普通 event 显示 |
| `getTopicEvent` 404 | 展开区显示"原始事件已过期或不存在"，`listTopicEventRuns/Sessions` 结果仍展示（它们可能独立可查） |
| `listTopicEventRuns/Sessions` 失败 | 对应 section 不渲染（不阻塞其他 section） |
| 加载更多时返回 `< eventLimit` | 隐藏"加载更多"按钮（到底了） |
| 加载更多过程中 | 按钮置 `loadingMoreEvents`，文案"加载中..."，禁用点击 |
| B5 跳转目标 cell 不在 cells 列表 | 高亮状态 2 秒后自动清空，无视觉副作用 |
| session 切换 | 清空 `highlightedCellId`，避免跨 session 误高亮 |
| 抽屉 trigger specJson 为空 | 不渲染"spec ▸"展开按钮 |
| `taskDetail.triggers` 为空数组 | 渲染"未配置触发器（手动触发）"提示 |
| B1 triggerKind 为空 | 不渲染"触发"段，仅展示 `#{shortId} [状态] {duration}` |

---

## 第 5 节：测试计划（手动）

无单测框架，全手动验证。

| # | 场景 | 预期 |
|---|------|------|
| T1 | `npm run check:ui` | 编译无 TS 错误 |
| T2 | 选事件触发的 run | header 显示"触发: 事件触发 ..."；该 run 的 `loader.event.published` 事件有"事件链"展开按钮 |
| T3 | 展开 topic 事件链 | 显示原始事件 payload + 关联 runs + 关联 sessions；当前 run 高亮 |
| T4 | 点关联 session | 切到 session tab，加载该 session |
| T5 | 选 >500 事件的 run | timeline 底部出现"加载更多"按钮，点击后事件数增加，按钮文案更新 |
| T6 | 加载到全部事件 | 按钮消失 |
| T7 | 长 cell 内容（>200 字符） | timeline 完整展示，不截断 |
| T8 | agent 失败的 cell | session chat 消息头显示 `exit {非0}` 红标 + stopReason |
| T9 | 点 session_card 的"跳转到 cell" | 切到 session tab，目标 cell 滚动到视野并高亮 2 秒 |
| T10 | 打开抽屉 | "触发器"section 展示所有 trigger 卡片，开关 enabled 立即生效 |
| T11 | 展开 trigger spec | 显示 specJson |
| T12 | session tab header | 显示 title/driver/guestImage/createdAt/cellCount/eventCount/状态 |
| T13 | `npm run dev:ui` 浏览器实测 T2-T12 | 全部通过 |

---

## 第 6 节：文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/pages/TaskDebugPage.svelte` | 修改 | A1-A5, B1-B6 全部改动 |
| `src/pages/SessionDebugPage.svelte` | **删除** | untracked 死代码，从未被路由引用，与 TaskDebugPage session tab 重复 |
| `src/api/loaders.ts` | 无改动 | `getTopicEvent`/`listTopicEventRuns`/`listTopicEventSessions`/`setAutomationTriggerEnabled` 均已存在 |
| `src/api/sessions.ts` | 无改动 | 所有需要的字段已在类型中 |

### TaskDebugPage.svelte 改动汇总（按代码区域）

1. **imports**: 增加 `getTopicEvent, listTopicEventRuns, listTopicEventSessions, setAutomationTriggerEnabled, type TopicEvent, type TopicEventRun, type TopicEventSession` from loaders
2. **TimelineEntry 类型**: `loader_event` 变体加 `topicEventId?: string`
3. **新增状态**: `eventLimit, loadingMoreEvents, topicChainCache, expandedTopicEvents, highlightedCellId, expandedTriggerSpecs`
4. **`buildTimeline`**: 赋值 `topicEventId`；cell 全量（去 slice/截断）
5. **`loadRunDetail`**: 用 `eventLimit`；新增 `loadingMoreEvents` 控制
6. **新增 `loadMoreEvents`**: `eventLimit += 500; loadRunDetail(selectedRunId)`
7. **新增 `toggleTopicChain`**: B6 懒加载
8. **新增 `jumpToCell` + `scrollCellIntoView`**: B5 跳转
9. **`buildSessionChatMessages`**: 返回 exitCode/success/stopReason
10. **`selectSession`**: 切换时清空 `highlightedCellId`
11. **新增 trigger 辅助函数**: `triggerKindLabel`, `toggleTriggerEnabled`, `toggleTriggerSpec`
12. **模板**:
    - run header 加 B1 触发段
    - timeline loader_event 加 B6 展开区 + session_card 加 B5 跳转链接
    - timeline 底部加 A2 加载更多按钮
    - session tab 加 B4 header
    - chat 消息加 B3 元数据 + cell id + 高亮 class
    - 抽屉加 B2 触发器 section
13. **CSS**: 删 A3-A5 的 max-height；加 `.td-chat-highlight`, `.td-tl-expand`, `.td-topic-chain`, `.td-topic-section`, `.td-topic-row`, `.td-trigger-card`, `.td-trigger-toggle` 等样式

---

## 非目标（明确排除）

- 不修改 `loaders.ts` / `sessions.ts` 的 API 签名（所有字段已就绪）
- 不实现触发器内容编辑（B2 只读 + 开关）
- 不做 session event payload 展示（C1，后端限制）
- 不做容器系统日志（C2，无 API）
- 不引入虚拟滚动（500 + 加载更多已够用，YAGNI）
- 不改动 `App.svelte` 路由
