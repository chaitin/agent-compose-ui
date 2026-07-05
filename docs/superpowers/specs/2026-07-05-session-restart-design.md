# 任务调试页会话重启/关闭机制设计

> **日期**: 2026-07-05
> **范围**: `src/pages/TaskDebugPage.svelte`（单文件）
> **目标**: 当 Work Session 未运行时,任务调试页右上角"重启会话"按钮可点击,点击后启动会话使终端恢复可用;并补齐"停止会话"能力,形成完整的重启/关闭机制。

---

## 背景与问题

任务调试页 Session 模块下有一个 xterm 终端,每条命令通过 v2 `ExecService/ExecStream`(`executeRuntimeCommandStream`)在目标 session 内执行。该 RPC 后端前置校验要求 session 处于 `RUNNING`,否则返回 `failed_precondition`。于是出现:

```
root@be4bfac9:/# ls -a
[failed_precondition] session be4bfac9-... is not running
```

当前 UI 的"重启会话"按钮(`TaskDebugPage.svelte:1269`)无法解决该问题,因为:

| # | 位置 | 问题 |
|---|------|------|
| A1 | `canResumeSession()` L606-608 | 比**后端更严格**:仅 `['已停止','启动失败']` 可点;`等待中/启动中/未知` 状态下按钮禁用,但后端 `ResumeSession` 对这些状态都能启动 |
| A2 | `resumeCurrentSession()` L614-628 | 只更新状态,不通知终端;resume 成功后终端无任何反馈,用户不知道是否可继续输入 |
| A3 | 终端 `executeTerminalCommand` catch L846-847 | 直接打印原始 `[failed_precondition] ...`,无引导提示 |
| A4 | 仅有 resume 按钮 | 无停止能力;`stopWorkSession` API 已存在但页面未使用 |

### 后端语义(已核实,`pkg/agentcompose/session_rpc_bridge.go`)

- `ResumeSession`(L247):**无状态前置条件**——`GetSession` 后直接 `StartSessionVM` 并置 `VMStatus=Running`。仅当 session 不存在时返回 `NotFound`。即对 `STOPPED/START_FAILED/PENDING` 都能启动。
- `StopSession`(L346):幂等——已停止则原样返回;运行中则 `StopSessionVM` 并置 `VMStatus=Stopped`。
- 状态枚举:`PENDING / STARTING / RUNNING / START_FAILED(=FAILED) / STOPPED`。

---

## 设计原则

1. **按钮模型:单切换按钮**——运行中显示"停止会话",未运行显示"重启会话",按状态互斥启用。一个位置、一个动作,语义随状态切换。
2. **对齐后端能力**——resume 在所有非 `RUNNING`/非 `STARTING` 状态都可用,不再比后端更严。
3. **手动重启,不自动**——终端遇到 `not running` 时只打印引导提示,不自动 resume(避免延迟与意外启动用户主动停止的会话)。
4. **信任 RPC + watch 兜底**——`ResumeSession` 同步返回 `RUNNING`(docker 驱动 `StartSessionVM` 阻塞至容器就绪),`watchLoop` 的 `session.updated` 事件持续校正,不额外轮询。
5. **YAGNI**——不加 stop 确认弹窗(可 resume 恢复,低风险);不加重启=stop+start 语义;不自动重执失败命令;不清理 stale session 列表。

---

## 第 1 节:状态模型

### 1.1 现有状态(不变)

```
rawSessionStatus  ← session.summary.vmStatus(大写字符串)
sessionStatus     ← mapSessionStatus(rawSessionStatus)  // 中文展示
```

`mapSessionStatus`(L392)映射:`PENDING→等待中 / STARTING→启动中 / RUNNING→运行中 / FAILED|START_FAILED→启动失败 / STOPPED→已停止 / 其它→未知`。

### 1.2 新增 flag

```ts
let resuming = false;   // 已存在
let stopping = false;   // 新增,与 resuming 并列
```

### 1.3 按钮派生(替换 `canResumeSession`)

新增 `sessionToggleButton()` 返回 `{ label, disabled, action }`,`action ∈ 'resume' | 'stop' | null`:

| rawSessionStatus | resuming/stopping | label | disabled | action |
|---|---|---|---|---|
| `RUNNING` | 否 | 停止会话 | 否 | stop |
| `RUNNING` | stopping | 停止中… | 是 | — |
| `STARTING` | — | 启动中… | 是 | — |
| `STOPPED`/`START_FAILED`/`PENDING`/`''` | 否 | 重启会话 | 否 | resume |
| 同上 | resuming | 重启中… | 是 | — |
| (未选会话) | — | 重启会话 | 是 | — |

`canChat()`(L610)保留不变,仍要求 `rawSessionStatus === 'RUNNING'`。

---

## 第 2 节:重启/停止流程

### 2.1 `toggleSession()`(新增,按钮入口)

```ts
async function toggleSession(): Promise<void> {
  const action = sessionToggleButton().action;
  if (action === 'resume') await resumeCurrentSession();
  else if (action === 'stop') await stopCurrentSession();
}
```

### 2.2 `resumeCurrentSession()`(改造)

在现有实现基础上:
- 成功后向终端写反馈:`✓ 会话已恢复,终端可用` 并 `showPrompt()`(终端存在时)。
- `NotFound` 错误特化为"会话不存在或已删除"(对应 stale session,如 metadata 已丢失的 `019f1e06-...`)。

```ts
async function resumeCurrentSession(): Promise<void> {
  if (!selectedSessionId || resuming || stopping) return;
  resuming = true; error = '';
  try {
    const updated = await resumeWorkSession(selectedSessionId);
    rawSessionStatus = updated.status;
    sessionStatus = mapSessionStatus(rawSessionStatus);
    session = updated;
    if (termReady) {
      term?.write('\r\n\x1b[32m✓ 会话已恢复,终端可用\x1b[0m\r\n');
      showPrompt();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (termReady && /not_found/i.test(error)) {
      term?.write('\r\n\x1b[31m会话不存在或已删除\x1b[0m\r\n');
      showPrompt();
    }
  } finally {
    resuming = false;
  }
}
```

### 2.3 `stopCurrentSession()`(新增)

```ts
async function stopCurrentSession(): Promise<void> {
  if (!selectedSessionId || resuming || stopping) return;
  stopping = true; error = '';
  try {
    const updated = await stopWorkSession(selectedSessionId);
    rawSessionStatus = updated.status;
    sessionStatus = mapSessionStatus(rawSessionStatus);
    session = updated;
    if (termReady) {
      term?.write('\r\n\x1b[33m○ 会话已停止\x1b[0m\r\n');
      showPrompt();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    stopping = false;
  }
}
```

### 2.4 watch 兜底

`watchLoop`(L695)已订阅 `session.updated`,收到时更新 `rawSessionStatus`/`sessionStatus`/`session`。resume/stop RPC 返回后 UI 立即更新,后续 watch 事件继续校正(例如后端 reconcile 把失联的 microsandbox session 改为 `STOPPED`)。无需新增轮询。

---

## 第 3 节:终端联动

### 3.1 命令失败引导(改造 `executeTerminalCommand` catch,L846-847)

```ts
} catch (err) {
  if (!controller.signal.aborted) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not running|failed_precondition/i.test(msg)) {
      term?.write('\r\n\x1b[33m会话未运行,请点击右上角"重启会话"\x1b[0m\r\n');
    } else {
      term?.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
    }
  }
}
```

### 3.2 resume/stop 后的终端反馈

见 §2.2 / §2.3。终端在切 tab 时销毁(`activeDebugTab !== 'terminal'` → `destroyTerminal`),resume 时若终端不存在则只更新状态,用户切回 terminal 时 `initTerminal` 的 `showPrompt()` 自然反映新会话状态(状态 pill 已更新)。

---

## 第 4 节:UI 改动

### 4.1 按钮(L1269-1271)

```svelte
<button disabled={sessionToggleButton().disabled} on:click={toggleSession}>
  {sessionToggleButton().label}
</button>
```

(为避免重复调用,可在 script 顶部加 `$: toggleBtn = sessionToggleButton();`,模板用 `{toggleBtn.label}`/`{toggleBtn.disabled}`。)

### 4.2 import(L27-30 区域)

`from '../api/sessions'` 增加 `stopWorkSession`。

---

## 第 5 节:错误处理

| 场景 | 处理 |
|---|---|
| resume `NotFound`(stale session) | `error` 置消息 + 终端写"会话不存在或已删除" |
| resume/stop `Internal` | `error` 置 `err.message`,按钮自动恢复(resuming/stopping=false) |
| 终端命令 `failed_precondition` | 终端写引导提示,不弹 error 条 |
| resuming 期间点 stop(或反之) | `stopping`/`resuming` 互斥,派生函数返回 disabled |

---

## 第 6 节:验证

1. **typecheck**:`npm run check:ui`(或等价),确保无类型错误。
2. **手测路径**:
   - 选一个 `STOPPED` session → 按钮显示"重启会话"且可点 → 点击 → 状态变 `运行中` → 终端输入 `ls -a` 正常返回。
   - 选一个 `RUNNING` session → 按钮显示"停止会话" → 点击 → 状态变 `已停止` → 终端输命令 → 提示"会话未运行,请点击右上角..."。
   - 选 stale session(metadata 缺失)→ 点重启 → 提示"会话不存在或已删除"。
3. **回归**:v1 会话数据加载、watch、聊天发消息不受影响。

---

## 第 7 节:不在范围

- 重启=stop+start 语义(运行中一键重启刷新状态)。
- stop 前确认弹窗。
- 自动 resume + 重执失败命令。
- stale session 列表清理(availableSessions 仍可能含已删除 session,另议)。
- 异步驱动(microsandbox)的就绪轮询——当前 docker 驱动同步启动,trust RPC 足够;若后续接入异步驱动再补轮询。
