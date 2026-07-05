# Session 统一日志视图设计 (Tier 1)

> **日期**: 2026-07-05
> **范围**: `src/pages/TaskDebugPage.svelte`
> **目标**: 把 Session 调试 tab 顶部的"会话气泡"改成终端日志流,合并 cells + events 按时间排序,在有限区域内展示更多排查信息。
> **前置 spec**: `2026-07-05-task-debug-full-logs-design.md`(已实现截断修复 A1-A5 与字段补齐 B1-B6)。本 spec 在其基础上**取代**气泡式聊天呈现(B3/A3),改为统一日志流。

---

## 背景与问题

Session tab 顶部 `.td-chat-messages` 当前以会话气泡展示 `sessionCells`,存在两个排查障碍:

1. **气泡样式信息密度低**——每条消息有大留白/边框/`max-height`,有限区域内可见条目少。
2. **events 单独放在底部子标签**——`sessionCells`(对话/agent 输出)与 `sessionEvents`(系统/生命周期/错误事件)是两条并行流,排查时需在两个区域间来回切换,无法按时间线对照。

用户希望:在有限区域内展示更多日志,把 session 的全部日志(对话是其中一部分)合并成一条按时间排序的流,帮助排查。

### 真实失败案例(驱动本设计)

用户遇到的连续失败:`exit 137`(OOM)、`context canceled`、`context deadline exceeded`。这些信息当前散落在 cell `output` 与 event `message` 里,需要在两条流之间对照时间才能拼出全貌。

### 数据范围:仅 Tier 1

经全量数据范围分析,排查所需数据分三层。本 spec 只做 **Tier 1**(纯前端整合,零后端改动):

- **Tier 1(本 spec)**:`sessionCells` + `sessionEvents` 已加载,只需合并展示。
- Tier 2(后端 follow-up):暴露 `VMState.LastError`、`cell.AgentResume`(JSONL transcript 路径)、失败 run 的 trace 事件——需扩 proto/API。
- Tier 3(后端 follow-up):类型化失败原因(timeout/cancel/oom)、超时时长、取消来源、token 用量——需新增捕获。

---

## 设计决策(已与用户确认)

| 决策 | 选择 |
|---|---|
| 数据范围 | Tier 1:合并 `sessionCells` + `sessionEvents`,按 `createdAt` 升序 |
| 布局 | 终端日志流(chrono stream,每行一条带类型标签) |
| 展开机制 | 点击行就地(inline)展开完整 body |
| 底部子标签 | 移除 `events`(已并入日志),保留 `terminal` + `artifacts` |
| composer | 保留(本会话已精简 textarea 高度与发送按钮内边距) |

---

## 第 1 节:数据流与状态

### 1.1 现有数据流(不变)

`loadSessionDetail(sid)` 仍调用 `listWorkSessionCells(sid)` → `sessionCells`、`listWorkSessionEvents(sid)` → `sessionEvents`,并 `startWatching(sid)`。watch loop 对两者的更新逻辑不变(cell 按 id upsert、event prepend、chunk 追加 output)。

### 1.2 新增类型

```ts
type LogEntry =
  | {
      kind: 'cell';
      id: string;
      timestamp: string;          // cell.createdAt
      role: 'user' | 'agent' | 'system';
      agent: string;
      content: string;            // user→source,否则 output
      exitCode: number;
      success: boolean;
      running: boolean;
      stopReason: string;
      agentSessionId: string;
    }
  | {
      kind: 'event';
      id: string;
      timestamp: string;          // event.createdAt
      type: string;
      level: string;
      message: string;
    };
```

### 1.3 派生(替换 `buildSessionChatMessages`)

```ts
$: logEntries = buildSessionLog(sessionCells, sessionEvents);
```

`buildSessionLog`:
- 把每个 `WorkSessionCell` 映射成 `cell` entry(role 复用现有映射:`UNSPECIFIED→user`、`AGENT→agent`、其余→`system`;content:user→`source`,其余→`output`)。
- 把每个 `WorkSessionEvent` 映射成 `event` entry。
- 合并后按 `timestamp` 升序排序(同时间戳 cell 优先于 event,稳定排序)。

⚠️ **Svelte 5 legacy 反应性陷阱**:`$:` 语句必须把 `sessionCells`、`sessionEvents` 作为函数参数显式传入,否则函数内部对它们的读取变化不会触发重算(参见 memory `svelte5-legacy-reactivity-no-func-trace`)。本设计已遵循——`buildSessionLog(sessionCells, sessionEvents)`。

`buildSessionChatMessages` 与 `chatMessages` 派生在此 spec 后删除(被 `buildSessionLog`/`logEntries` 取代)。

### 1.4 新增 UI 状态

```ts
let expandedLogIds = new Set<string>();   // 展开的 entry id
```

---

## 第 2 节:行格式(终端日志流)

### 2.1 行结构

每行一条 entry,monospace,`--font-size-xs`,紧凑行高:

```
HH:MM:SS [tag]  <摘要首行>
```

- **时间**:默认 `HH:MM:SS`;当某行日期与前一行不同时,该行时间加 `YYYY/M/D ` 前缀(首行无从比较时不加)。
- **tag**:
  - cell(agent):`[<agent> <状态>]`,状态取值:`⟳`(running=true)/ `✓`(!running && success)/ `✗`(!running && !success);失败时若 exitCode≠0 则在 `✗` 后追加数字,如 `✗137`、`✗1`;exitCode=0 的失败仅 `✗`
  - cell(user):`[user]`
  - cell(system):`[system]`
  - event:`[<level>]` —— `INFO` / `WARN` / `ERROR`
- **摘要首行**:
  - cell:user→`source` 首行;其余→`content`(output)首行;CSS 单行截断(`text-overflow: ellipsis`)。
  - event:`{type}: {message}` 首行,同样单行截断。

### 2.2 颜色

| 标签 | 颜色 |
|---|---|
| `✓` 成功 | 绿(`--ok`/绿系) |
| `✗` 失败 | 红(`--danger`) |
| `⟳` 运行中 | 蓝(`--primary`) |
| `ERROR` | 红 |
| `WARN` | 黄 |
| `INFO` | 灰(`--muted`) |
| `[user]` / `[system]` | 灰 |

### 2.3 行交互

- hover 高亮整行。
- 点击行 → toggle `expandedLogIds` 中的 id → 在该行下方就地展开 body(见第 3 节)。
- cursor:pointer。

---

## 第 3 节:展开机制(inline)

点击某行 → 该行下方插入一个展开块;再次点击折叠。

### 3.1 cell 展开内容

```
[元数据行] agent: {agent}  ·  agentSessionId: {shortId}  ·  exit: {exitCode}  ·  stopReason: {stopReason}  ·  createdAt: {full}
[完整 body pre] {完整 content}
```

- user cell:body = 完整 `source`。
- agent/system cell:body = 完整 `output`(含 `[tool:...]`/`[mcp:...]`/`[file_change]` 标记的 transcript,不截断)。
- running cell:body 显示"输出中..."(output 可能仍在流式追加)。
- 元数据行字段为空则省略该段。

### 3.2 event 展开内容

```
[元数据行] type: {type}  ·  level: {level}  ·  createdAt: {full}
[完整 body pre] {完整 message}
```

### 3.3 展开块样式

- 缩进对齐摘要行;`pre` 白底/浅边框,`white-space: pre-wrap`,`word-break: break-word`,纵向 `max-height` 限制 + `overflow-y: auto`(便于超长 transcript 滚动,不撑爆日志区)。
- 不推荐右侧 drawer 方案:占横向空间,与"有限区域"目标冲突。

---

## 第 4 节:布局

### 4.1 Session tab 结构(改动后)

```
┌─ Session 调试 ────────────────────┐
│ [统一日志 cells+events]           │  ← 替换 .td-chat-messages
│  22:12:56 [codex ✓]    ...        │
│  22:13:25 [codex ✗137] ...        │
│  22:13:31 [INFO]       ...        │
│  ...   (主区,stick-to-bottom)    │
├──────────────────────────────────┤
│ [composer: textarea + 发送]      │  ← 保留,48px
├──────────────────────────────────┤
│ [terminal] [artifacts]           │  ← 移除 events 子标签
│ > _                               │
└──────────────────────────────────┘
```

### 4.2 滚动行为(stick-to-bottom)

复用现有 `chatMessagesEl` 自动滚动逻辑(改为日志容器):
- 用户在底部时,新 entry 追加 → 自动滚到底。
- 用户上滚查看时,不强制打断(检测"是否在底部"再决定是否滚动)。

### 4.3 子标签改动

- `activeDebugTab` 类型从 `'terminal' | 'events' | 'artifacts'` 改为 `'terminal' | 'artifacts'`。
- 删除 `events` 分支模板(`.td-events-list`)与对应 CSS。
- 默认子标签仍为 `terminal`。
- 子标签切换 UI 去掉 `events` 按钮。

---

## 第 5 节:边界情况

| 场景 | 处理 |
|---|---|
| `sessionCells` 为空 | 日志区显示空态:"暂无日志"(若 `sessionEvents` 也空)或仅渲染 events |
| `sessionEvents` 为空 | 仅渲染 cells(不影响) |
| 同时间戳的 cell 与 event | cell 排在 event 前(稳定排序) |
| running cell(output 仍在流式) | tag `⟳`,body 显示当前 output + "输出中..." |
| chunk 事件追加 output | watch loop 更新 `sessionCells` → `logEntries` 重算 → 对应行摘要/展开 body 自动更新 |
| entry 极多 | Tier 1 不做虚拟滚动(YAGNI);依赖浏览器原生滚动。若后续卡顿再引入 |
| 展开行后新 entry 追加 | 展开块属于该行 DOM,排序变化时 Svelte `{#each}` 按 id 复用,展开状态(`expandedLogIds` by id)保持 |
| 用户上滚时 stick-to-bottom | 不自动滚动(避免打断阅读) |
| composer 发送消息 | 产生 user cell + agent cell(optimistic)→ 进 `sessionCells` → 日志流自动出现新行 |

---

## 第 6 节:测试计划(手动)

无单测框架,全手动验证。

| # | 场景 | 预期 |
|---|---|---|
| T1 | `npm run check:ui` | 编译无 TS 错误 |
| T2 | 选有失败 run 的 session | 日志按时间排序,失败 cell 行显示 `✗137` / `✗1` 红标,event 行显示 `[ERROR]` |
| T3 | 点击日志行 | 就地展开完整 body + 元数据;再次点击折叠 |
| T4 | cells + events 混合 | 两者按 createdAt 交错排列,时间连续 |
| T5 | running 中的 cell | tag `⟳` 蓝,body 显示"输出中..."且随 chunk 流式更新 |
| T6 | 发送新消息 | composer 发送后日志流底部出现 user 行 + agent running 行,stick-to-bottom 滚到底 |
| T7 | 用户上滚后新消息到达 | 不强制滚到底(不打断) |
| T8 | 底部子标签 | 仅 `terminal` + `artifacts`,无 `events` |
| T9 | 跨日 session | 首行时间带日期前缀 |
| T10 | 长 transcript(展开) | body 区域内部滚动,不撑爆日志区 |
| T11 | `npm run dev:ui` 浏览器实测 T2-T10 | 全部通过 |

---

## 第 7 节:文件改动清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/pages/TaskDebugPage.svelte` | 修改 | 见下 |
| `src/api/sessions.ts` | 无改动 | 所需字段已在 `WorkSessionCell`/`WorkSessionEvent` |
| `src/api/loaders.ts` | 无改动 | — |

### TaskDebugPage.svelte 改动汇总(按代码区域)

1. **类型**:新增 `LogEntry` 联合类型。
2. **派生**:新增 `buildSessionLog(sessionCells, sessionEvents)`;`$: logEntries = buildSessionLog(sessionCells, sessionEvents)`;删除 `buildSessionChatMessages` 与 `$: chatMessages`。
3. **状态**:新增 `expandedLogIds: Set<string>`;`activeDebugTab` 类型收窄为 `'terminal' | 'artifacts'`。
4. **模板**:
   - 替换 `.td-chat-messages` 块(`{#each chatMessages ...}`)为 `.td-log` 块(`{#each logEntries ...}`),按第 2 节行格式渲染;每行 `id="log-{entry.id}"`,点击 toggle 展开;展开块按第 3 节渲染。
   - 移除底部子标签 `events` 按钮 + `.td-events-list` 分支;保留 `terminal` + `artifacts`。
   - composer 块不变。
5. **CSS**:
   - 新增 `.td-log`、`.td-log-row`、`.td-log-tag`、`.td-log-time`、`.td-log-summary`、`.td-log-expand`、`.td-log-meta`、`.td-log-body` 及状态修饰类(`--ok`/`--err`/`--running`/`--warn`/`--info`)。
   - 删除 `.td-chat-msg`、`.td-chat-head`、`.td-chat-body`、`.td-chat-role`、`.td-chat-cellid`、`.td-chat-time`、`.td-chat-stop-reason`、`.td-chat-exit` 等气泡样式(若仅此处使用)。
   - 删除 `.td-events-list` 相关样式。
   - `.td-chat-messages` 容器选择器改名 `.td-log`(或保留容器名,内部替换)。
6. **滚动**:`chatMessagesEl` 绑定到日志容器,复用现有 stick-to-bottom 逻辑(若逻辑引用 `chatMessages`,改为 `logEntries` 的追加检测)。

---

## 非目标(明确排除)

- 不做过滤(按 level/type)、搜索、虚拟滚动——Tier 1 验证后再加。
- 不做后端字段暴露(`VMState.LastError`、`agent_resume`、失败 trace 事件)——Tier 2 单独立项。
- 不做类型化失败原因/超时时长/取消来源——Tier 3 单独立项。
- 不改 `sessions.ts`/`loaders.ts` API 签名。
- 不改 watch loop 数据获取逻辑。
- 不动 composer(本会话已精简)。
- 不改其他 tab(运行输出 timeline、抽屉)。
