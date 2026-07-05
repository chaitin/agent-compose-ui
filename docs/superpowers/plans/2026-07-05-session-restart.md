# 任务调试页会话重启/关闭机制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 TaskDebugPage 的会话重启按钮在 session 未运行时可点击并启动会话,同时补齐停止能力,形成单切换按钮的重启/关闭机制。

**Architecture:** 单文件改动 `src/pages/TaskDebugPage.svelte`。新增 `sessionToggleButton()` 派生函数把 session 状态映射为按钮 `{label, disabled, action}`,新增 `toggleSession()`/`stopCurrentSession()`,改造 `resumeCurrentSession()` 在成功/NotFound 时向终端写反馈,终端命令失败时对 `not running` 打印引导提示。按钮模板改用派生状态。信任 RPC 返回状态 + watchLoop 兜底,不轮询。

**Tech Stack:** Svelte 5, TypeScript, @connectrpc/connect, xterm.js。**无单元测试框架**;验证用 `npm run check:ui`(vite build,含类型检查)+ 手动路径。

**Spec:** `docs/superpowers/specs/2026-07-05-session-restart-design.md`

---

## 前置:工作区清理(执行时决定)

`src/pages/TaskDebugPage.svelte` 与 `vite.config.ts` 当前有**未提交的前期工作**(save-and-run 修复 + v2 代理修复,均已验证完成)。开始 Task 1 前建议先把它们提交为独立 commit,使本计划的 restart 改动 commit 保持聚焦:

- [ ] 提交 v2 代理修复(`vite.config.ts`)
- [ ] 提交 save-and-run 修复(`TaskDebugPage.svelte` 当前 working tree 状态)

若用户希望保留这些不提交,则 Task 1-5 的 commit 会一并包含这些改动(因为同文件)。**推荐先单独提交。**

---

## 文件结构

仅改 `src/pages/TaskDebugPage.svelte`(单文件,2175 行)。改动集中在 session 控制逻辑:状态声明(L78-82)、派生与处理器(L606-628)、终端(L819-851)、按钮模板(L1269-1271)。不涉及文件拆分。

---

### Task 1: 加 stopWorkSession import 与 stopping flag

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte:26-36`(import 块)
- Modify: `src/pages/TaskDebugPage.svelte:82`(`resuming` 之后)

- [ ] **Step 1: 加 import**

把第 26-36 行 import 块替换为(在 `resumeWorkSession,` 后加 `stopWorkSession,`):

```ts
  import {
    getWorkSessionStatus,
    listWorkSessionCells,
    listWorkSessionEvents,
    resumeWorkSession,
    stopWorkSession,
    sendWorkSessionMessageStream,
    watchWorkSession,
    type WorkSession,
    type WorkSessionCell,
    type WorkSessionEvent,
  } from '../api/sessions';
```

- [ ] **Step 2: 加 stopping flag**

把第 82 行 `let resuming = false;` 替换为:

```ts
  let resuming = false;
  let stopping = false;
```

- [ ] **Step 3: 类型检查**

Run: `npm run check:ui`
Expected: 构建成功(新 flag 暂未使用,不会失败)。

- [ ] **Step 4: Commit**

```bash
git add src/pages/TaskDebugPage.svelte
git commit -m "feat(task-debug): add stopWorkSession import and stopping flag"
```

---

### Task 2: 新增 sessionToggleButton 派生(保留 canResumeSession)

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte:606-608`(`canResumeSession` 之后新增,本任务不删 canResumeSession)

- [ ] **Step 1: 新增派生函数 + 响应式变量**

把第 606-608 行 `canResumeSession` 函数替换为(保留原函数,在其后追加):

```ts
  function canResumeSession(): boolean {
    return Boolean(selectedSessionId) && ['已停止', '启动失败'].includes(sessionStatus) && !resuming;
  }

  function sessionToggleButton(): { label: string; disabled: boolean; action: 'resume' | 'stop' | null } {
    if (!selectedSessionId) return { label: '重启会话', disabled: true, action: null };
    if (resuming) return { label: '重启中...', disabled: true, action: null };
    if (stopping) return { label: '停止中...', disabled: true, action: null };
    if (rawSessionStatus === 'RUNNING') return { label: '停止会话', disabled: false, action: 'stop' };
    if (rawSessionStatus === 'STARTING') return { label: '启动中...', disabled: true, action: null };
    return { label: '重启会话', disabled: false, action: 'resume' };
  }

  $: toggleBtn = sessionToggleButton();
```

- [ ] **Step 2: 类型检查**

Run: `npm run check:ui`
Expected: 构建成功(canResumeSession 仍被按钮引用,新函数未被引用,均不影响构建)。

- [ ] **Step 3: Commit**

```bash
git add src/pages/TaskDebugPage.svelte
git commit -m "feat(task-debug): add sessionToggleButton derived state"
```

---

### Task 3: 新增 stop/toggle 处理器,改造 resumeCurrentSession

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte:614-628`(`resumeCurrentSession`)

- [ ] **Step 1: 替换 resumeCurrentSession 并追加 stop/toggle**

把第 614-628 行的 `resumeCurrentSession` 函数替换为下面三个函数:

```ts
  async function resumeCurrentSession(): Promise<void> {
    if (!selectedSessionId || resuming || stopping) return;
    resuming = true;
    error = '';
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

  async function stopCurrentSession(): Promise<void> {
    if (!selectedSessionId || resuming || stopping) return;
    stopping = true;
    error = '';
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

  async function toggleSession(): Promise<void> {
    const action = sessionToggleButton().action;
    if (action === 'resume') await resumeCurrentSession();
    else if (action === 'stop') await stopCurrentSession();
  }
```

- [ ] **Step 2: 类型检查**

Run: `npm run check:ui`
Expected: 构建成功。

- [ ] **Step 3: Commit**

```bash
git add src/pages/TaskDebugPage.svelte
git commit -m "feat(task-debug): add stop/toggle handlers and terminal feedback on resume"
```

---

### Task 4: 终端 not-running 引导提示

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte:846-847`(`executeTerminalCommand` catch)

- [ ] **Step 1: 改造 catch**

把第 846-847 行的 catch 块替换为(注意保留其后的 `finally`):

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
    } finally {
```

- [ ] **Step 2: 类型检查**

Run: `npm run check:ui`
Expected: 构建成功。

- [ ] **Step 3: Commit**

```bash
git add src/pages/TaskDebugPage.svelte
git commit -m "feat(task-debug): hint to restart session on terminal failed_precondition"
```

---

### Task 5: 按钮模板改用 toggleBtn,删除 canResumeSession

**Files:**
- Modify: `src/pages/TaskDebugPage.svelte:1269-1271`(按钮)
- Modify: `src/pages/TaskDebugPage.svelte:606-608`(删除 `canResumeSession`)

- [ ] **Step 1: 改按钮模板**

把第 1269-1271 行的按钮替换为:

```svelte
              <button disabled={toggleBtn.disabled} on:click={toggleSession}>
                {toggleBtn.label}
              </button>
```

- [ ] **Step 2: 删除 canResumeSession**

删除第 606-608 行的 `canResumeSession` 函数(按钮已不再引用)。即移除:

```ts
  function canResumeSession(): boolean {
    return Boolean(selectedSessionId) && ['已停止', '启动失败'].includes(sessionStatus) && !resuming;
  }
```

注意:Task 2 在其后追加了 `sessionToggleButton` 与 `toggleBtn`,**只删 `canResumeSession` 这一个函数,保留后面的内容**。

- [ ] **Step 3: 类型检查**

Run: `npm run check:ui`
Expected: 构建成功,无 "canResumeSession is not defined" 报错(模板已不引用它)。

- [ ] **Step 4: Commit**

```bash
git add src/pages/TaskDebugPage.svelte
git commit -m "feat(task-debug): wire session toggle button to derived state"
```

---

### Task 6: 验证

**Files:** 无改动。

- [ ] **Step 1: 全量构建**

Run: `npm run check:ui`
Expected: 构建成功,无类型错误。

- [ ] **Step 2: 手测路径 A — 重启已停止会话**

1. `npm run dev:ui`,打开任务调试页,选一个 `已停止` session。
2. 确认右上角按钮显示"重启会话"且可点。
3. 点击 → 状态变"运行中",终端出现 `✓ 会话已恢复,终端可用`。
4. 终端输入 `ls -a` → 正常返回文件列表,无 `failed_precondition`。

- [ ] **Step 3: 手测路径 B — 停止运行中会话**

1. 选一个 `运行中` session → 按钮显示"停止会话"。
2. 点击 → 状态变"已停止",终端出现 `○ 会话已停止`。
3. 终端输入 `ls -a` → 出现 `会话未运行,请点击右上角"重启会话"`。

- [ ] **Step 4: 手测路径 C — stale session**

1. 选一个 metadata 已丢失的 session(如 `019f1e06-...`)→ 点"重启会话"。
2. 终端出现 `会话不存在或已删除`,按钮恢复可点。

- [ ] **Step 5: 回归**

确认聊天发消息(`canChat` 仍要求 `RUNNING`)、事件流、run 详情不受影响。

---

## Self-Review

**1. Spec coverage:**
- §1.3 按钮派生表 → Task 2 ✓
- §2.1 `toggleSession` → Task 3 ✓
- §2.2 `resumeCurrentSession` 改造(终端反馈 + NotFound 特化)→ Task 3 ✓
- §2.3 `stopCurrentSession` → Task 3 ✓
- §2.4 watch 兜底 → 无需改动(已存在)✓
- §3.1 终端 not-running 引导 → Task 4 ✓
- §3.2 resume/stop 终端反馈 → Task 3 ✓
- §4.1 按钮模板 → Task 5 ✓
- §4.2 import → Task 1 ✓
- §5 错误处理 → Task 3(NotFound)/ Task 4(终端提示)✓
- §6 验证 → Task 6 ✓

**2. Placeholder scan:** 无 TBD/TODO/"适当处理"。每个代码步骤含完整可粘贴代码。

**3. Type consistency:**
- `sessionToggleButton()` 返回类型 `{label, disabled, action}` 在 Task 2 定义;Task 3 `toggleSession` 读取 `.action`、Task 5 模板读取 `.label`/`.disabled` — 一致。
- `stopWorkSession` import 于 Task 1,使用于 Task 3 `stopCurrentSession` — 一致。
- `stopping` flag 声明于 Task 1,使用于 Task 2(派生)/ Task 3(互斥)— 一致。
- `toggleBtn` 响应式声明于 Task 2,使用于 Task 5 模板 — 一致。
- 删除 `canResumeSession`(Task 5)前,Task 2-4 仍保留它且按钮仍引用,确保每个中间 commit 构建通过。
