# Run Workspace Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在运行详情现有产物基础上追加本次 Run 执行期间产生或修改的 `/workspace` 文件，并支持点击后进入对应 Sandbox Files TAB 自动预览文件。

**Architecture:** 新增独立 `workspace-artifacts.ts` 模块，通过注入的现有 GetSandbox/ExecStream 客户端执行有界、只读的 `/usr/bin/find`，解析文件修改时间并按 Run 时间窗口过滤。`RunExecutionProcess` 只负责请求生命周期、时间线合并和导航；`FileBrowser` 负责校验 URL 目标并打开父目录和文件。停止的 Sandbox 明确不自动恢复。

**Tech Stack:** TypeScript、Svelte 5、ConnectRPC v2 generated clients、Vitest、Bun test。

## Global Constraints

- 只修改 `agent-compose-ui`；不修改 daemon、protobuf 或后端存储。
- 保留现有后端登记产物，不复制 Workspace 文件到 daemon `artifactsDir`。
- 仅使用现有 `GetSandbox`、`ExecStream` 和 Sandbox Files 能力。
- 只扫描 `/workspace` 普通文件；不得通过 shell 拼接或解释文件路径。
- 扫描输出最多 256 KiB，最终最多展示 5000 个 Workspace 文件。
- 仅展示 `mtime >= startedAt && mtime <= endAt` 的文件；终态上界为 `completedAt`，运行中上界为查询时当前时间。
- Sandbox 为 STOPPED 时不得调用 Resume 或 Exec；用户仍需在 Sandbox 详情手动恢复。
- Sandbox 删除、状态查询失败、扫描失败或时间无效时不得破坏现有运行详情和后端登记产物。
- 点击有效文件必须进入对应 Sandbox 的 Files TAB，并自动加载父目录、选中及预览目标文件。
- 保留工作区所有不相关并行修改，只提交本计划涉及的文件或精确 hunk。
- 严格执行 TDD：每个生产行为先观察目标测试因缺少该行为而失败。

---

### Task 1: 有界 Workspace 产物发现模块

**Files:**
- Create: `src/lib/workspace-artifacts.ts`
- Create: `src/lib/workspace-artifacts.test.ts`

**Interfaces:**
- Consumes: generated `GetSandboxRequest`, `ExecRequest`, `ExecCommand`, `ExecStreamEventType`, `StdioStream`。
- Produces: `WorkspaceArtifactFile`。
- Produces: `WorkspaceArtifactDiscoveryResult`。
- Produces: `parseWorkspaceArtifactRecords(raw, options)`。
- Produces: `discoverWorkspaceArtifacts(options)`。

- [ ] **Step 1: 写解析与时间窗口失败测试**

创建 `src/lib/workspace-artifacts.test.ts`，先覆盖 NUL 分隔、特殊路径、边界时间、去重和排序：

```ts
import { describe, expect, test, vi } from 'vitest';
import {
  parseWorkspaceArtifactRecords,
  discoverWorkspaceArtifacts,
  WORKSPACE_ARTIFACT_OUTPUT_BYTES,
} from './workspace-artifacts';

describe('parseWorkspaceArtifactRecords', () => {
  test('keeps only files modified inside the inclusive Run window', () => {
    const raw = [
      '1784601000.0000000000\t/workspace/before.md\0',
      '1784601037.2570000000\t/workspace/with space.md\0',
      '1784601090.0000000000\t/workspace/line\nbreak.md\0',
      '1784601151.3040000000\t/workspace/final.md\0',
      '1784601200.0000000000\t/workspace/after.md\0',
    ].join('');
    expect(parseWorkspaceArtifactRecords(raw, {
      startedAt: '2026-07-21T03:30:37.257Z',
      endedAt: '2026-07-21T03:32:31.304Z',
      limit: 5000,
    }).files.map(file => file.path)).toEqual([
      '/workspace/with space.md',
      '/workspace/line\nbreak.md',
      '/workspace/final.md',
    ]);
  });

  test('deduplicates paths by their final record and sorts equal mtimes by path', () => {
    const raw = [
      '1784601040\t/workspace/z.md\0',
      '1784601040\t/workspace/a.md\0',
      '1784601041\t/workspace/z.md\0',
    ].join('');
    const result = parseWorkspaceArtifactRecords(raw, {
      startedAt: '2026-07-21T03:30:37Z',
      endedAt: '2026-07-21T03:32:31Z',
      limit: 5000,
    });
    expect(result.files.map(file => [file.path, file.modifiedAt])).toEqual([
      ['/workspace/a.md', '2026-07-21T03:30:40.000Z'],
      ['/workspace/z.md', '2026-07-21T03:30:41.000Z'],
    ]);
  });
});
```

- [ ] **Step 2: 运行解析测试并确认 RED**

Run: `bunx vitest run src/lib/workspace-artifacts.test.ts`

Expected: FAIL，因为 `./workspace-artifacts` 尚不存在。

- [ ] **Step 3: 实现最小解析器和公开类型**

创建 `src/lib/workspace-artifacts.ts`，定义：

```ts
export const WORKSPACE_ARTIFACT_OUTPUT_BYTES = 256 * 1024;
export const MAX_WORKSPACE_ARTIFACT_FILES = 5000;

export interface WorkspaceArtifactFile {
  path: string;
  modifiedAt: string;
  modifiedAtMs: number;
}

export interface ParseWorkspaceArtifactOptions {
  startedAt: string;
  endedAt: string;
  limit: number;
  truncated?: boolean;
}

export function parseWorkspaceArtifactRecords(
  raw: string,
  options: ParseWorkspaceArtifactOptions,
): { files: WorkspaceArtifactFile[]; truncated: boolean } {
  const start = Date.parse(options.startedAt);
  const end = Date.parse(options.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return { files: [], truncated: false };
  const records = raw.split('\0');
  if (records.at(-1) === '') records.pop();
  else records.pop(); // discard a partial final record
  const byPath = new Map<string, WorkspaceArtifactFile>();
  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator < 1) continue;
    const modifiedAtMs = Number.parseFloat(record.slice(0, separator)) * 1000;
    const path = record.slice(separator + 1);
    if (!Number.isFinite(modifiedAtMs) || !path.startsWith('/workspace/') || modifiedAtMs < start || modifiedAtMs > end) continue;
    byPath.set(path, { path, modifiedAtMs, modifiedAt: new Date(modifiedAtMs).toISOString() });
  }
  const files = [...byPath.values()]
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path))
    .slice(0, options.limit);
  return { files, truncated: Boolean(options.truncated) || byPath.size > options.limit };
}
```

- [ ] **Step 4: 运行解析测试并确认 GREEN**

Run: `bunx vitest run src/lib/workspace-artifacts.test.ts`

Expected: 2 tests pass。

- [ ] **Step 5: 写发现编排失败测试**

在同一测试文件追加：

```ts
describe('discoverWorkspaceArtifacts', () => {
  test('scans a running Sandbox with bounded direct find execution', async () => {
    const requests: any[] = [];
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1',
      startedAt: '2026-07-21T03:30:37Z',
      completedAt: '2026-07-21T03:32:31Z',
      now: () => new Date('2026-07-21T03:40:00Z'),
      getSandbox: async () => ({ sandbox: { status: 'RUNNING' } }),
      execStream: async function* (request) {
        requests.push(request);
        yield { eventType: 1, stream: 1, chunk: '1784601040\t/workspace/report.md\0' };
      },
    });
    expect(result.status).toBe('ready');
    expect(result.files.map(file => file.path)).toEqual(['/workspace/report.md']);
    expect(requests[0]).toMatchObject({
      target: { case: 'sandboxId', value: 'sandbox-1' },
      cwd: '/workspace',
      maxOutputBytes: WORKSPACE_ARTIFACT_OUTPUT_BYTES,
      command: {
        command: '/usr/bin/find',
        args: ['/workspace', '-type', 'f', '-printf', '%T@\\t%p\\0'],
      },
    });
  });

  test('does not resume or exec a stopped Sandbox', async () => {
    const execStream = vi.fn();
    const result = await discoverWorkspaceArtifacts({
      sandboxId: 'sandbox-1', startedAt: '2026-07-21T03:30:37Z', completedAt: '', now: () => new Date(),
      getSandbox: async () => ({ sandbox: { status: 'STOPPED' } }), execStream,
    });
    expect(result).toMatchObject({ status: 'stopped', files: [] });
    expect(execStream).not.toHaveBeenCalled();
  });
});
```

测试中的 enum 数值应使用 generated `ExecStreamEventType.OUTPUT` 与 `StdioStream.STDOUT`，避免依赖裸数值。

- [ ] **Step 6: 运行发现测试并确认 RED**

Run: `bunx vitest run src/lib/workspace-artifacts.test.ts`

Expected: FAIL，因为 `discoverWorkspaceArtifacts` 尚未导出。

- [ ] **Step 7: 实现发现编排**

在模块中增加精确接口与状态：

```ts
export type WorkspaceArtifactDiscoveryStatus = 'ready' | 'stopped' | 'removed' | 'invalid-time' | 'error';

export interface WorkspaceArtifactDiscoveryResult {
  status: WorkspaceArtifactDiscoveryStatus;
  files: WorkspaceArtifactFile[];
  truncated: boolean;
  message: string;
}

export interface DiscoverWorkspaceArtifactsOptions {
  sandboxId: string;
  startedAt: string;
  completedAt: string;
  now: () => Date;
  getSandbox(request: GetSandboxRequest, options?: { signal?: AbortSignal }): Promise<{ sandbox?: { status?: string } }>;
  execStream(request: ExecRequest, options?: { signal?: AbortSignal }): AsyncIterable<ExecStreamResponse>;
  signal?: AbortSignal;
}
```

实现要求：

- 先验证 `startedAt` 和结束时间；无效时返回 `invalid-time`，不调用 RPC。
- `getSandbox` NotFound 返回 `removed`；其他错误返回 `error`。
- 仅规范化状态为 `RUNNING` 时调用 `execStream`；`STOPPED` 返回 `stopped`；REMOVED/DESTROYED 返回 `removed`。
- 使用 `new ExecRequest({ target: { case: 'sandboxId', value: sandboxId }, command: new ExecCommand({ command: '/usr/bin/find', args: ['/workspace', '-type', 'f', '-printf', '%T@\\t%p\\0'] }), cwd: '/workspace', maxOutputBytes: WORKSPACE_ARTIFACT_OUTPUT_BYTES, timeoutMs: 30_000 })`。
- 只累计 STDOUT，按 UTF-8 bytes 截断；STDERR 或 terminal result error 返回 `error`。
- 将完整输出传给 `parseWorkspaceArtifactRecords`；不完整末记录由解析器丢弃。
- 不导入或调用 `ResumeSandboxRequest`。

- [ ] **Step 8: 覆盖删除、错误、运行中上界和输出上限**

追加测试，分别断言：GetSandbox NotFound 映射为 `removed`；Exec stderr 映射为 `error`；`completedAt=''` 使用注入 `now()`；超过 256 KiB 时 `truncated=true` 且不会超过 5000 条；signal 原样传递给两个 RPC。

- [ ] **Step 9: 运行 Task 1 验证**

Run: `bunx vitest run src/lib/workspace-artifacts.test.ts && bun run check`

Expected: 全部测试通过；Svelte check 0 errors / 0 warnings。

- [ ] **Step 10: 提交 Task 1**

```bash
git add src/lib/workspace-artifacts.ts src/lib/workspace-artifacts.test.ts
git commit -m "feat(runs): discover workspace artifacts"
```

---

### Task 2: Files TAB 深链接与自动预览

**Files:**
- Modify: `src/pages/session/file-browser.ts`
- Modify: `src/pages/session/file-browser.test.js`
- Modify: `src/pages/session/FileBrowser.svelte`
- Create: `src/pages/session/FileBrowser.component.test.ts`
- Modify: `src/views/runtime/SandboxDetailView.svelte`
- Modify: `src/views/runtime/SandboxDetailView.component.test.ts`

**Interfaces:**
- Produces: `resolveWorkspaceFileTarget(value: string): { directory: string; fileName: string; fullPath: string } | null`。
- `FileBrowser` consumes optional `initialFilePath?: string`。
- `SandboxDetailView` consumes URL parameter `sandboxPath` and passes it to `FileBrowser`。

- [ ] **Step 1: 写目标路径校验失败测试**

在 `src/pages/session/file-browser.test.js` 中追加：

```js
import { resolveWorkspaceFileTarget } from './file-browser';

test('resolves only absolute files below workspace', () => {
  expect(resolveWorkspaceFileTarget('/workspace/2026-07-21/report.md')).toEqual({
    directory: '/workspace/2026-07-21',
    fileName: 'report.md',
    fullPath: '/workspace/2026-07-21/report.md',
  });
  expect(resolveWorkspaceFileTarget('/workspace/report with space.md')?.fileName).toBe('report with space.md');
  expect(resolveWorkspaceFileTarget('/etc/passwd')).toBeNull();
  expect(resolveWorkspaceFileTarget('/workspace/../etc/passwd')).toBeNull();
  expect(resolveWorkspaceFileTarget('/workspace')).toBeNull();
  expect(resolveWorkspaceFileTarget('/workspace/folder/')).toBeNull();
});
```

- [ ] **Step 2: 运行路径测试并确认 RED**

Run: `bun test src/pages/session/file-browser.test.js`

Expected: FAIL，因为 `resolveWorkspaceFileTarget` 不存在。

- [ ] **Step 3: 实现路径校验**

在 `file-browser.ts` 中增加不依赖 Node path 模块的浏览器实现：

```ts
export function resolveWorkspaceFileTarget(value: string) {
  if (!value.startsWith('/workspace/') || value.endsWith('/') || value.includes('\0')) return null;
  const segments = value.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  const fileName = segments.at(-1) ?? '';
  if (!fileName) return null;
  const directory = segments.slice(0, -1).join('/') || '/';
  return { directory, fileName, fullPath: value };
}
```

- [ ] **Step 4: 运行路径测试并确认 GREEN**

Run: `bun test src/pages/session/file-browser.test.js`

Expected: 路径测试通过。

- [ ] **Step 5: 写 FileBrowser 自动定位组件失败测试**

创建 `src/pages/session/FileBrowser.component.test.ts`，mock `execService.execStream`，渲染：

```ts
render(FileBrowser, {
  sandboxId: 'sandbox-1',
  initialFilePath: '/workspace/2026-07-21/report.md',
});
```

按请求顺序返回父目录 find 结果和文件 cat 内容，断言：

```ts
expect(execRequests[0]).toMatchObject({
  command: { command: '/usr/bin/find', args: ['/workspace/2026-07-21', '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%f\\n'] },
});
expect(execRequests[1]).toMatchObject({
  command: { command: '/bin/cat', args: ['--', '/workspace/2026-07-21/report.md'] },
});
expect(await screen.findByDisplayValue('report body')).toBeTruthy();
```

- [ ] **Step 6: 运行组件测试并确认 RED**

Run: `bunx vitest run src/pages/session/FileBrowser.component.test.ts`

Expected: FAIL，因为组件忽略 `initialFilePath`。

- [ ] **Step 7: 实现 FileBrowser 初始定位**

修改 props 和挂载行为：

```ts
let { sandboxId, initialFilePath = '' }: { sandboxId: string; initialFilePath?: string } = $props();

onMount(() => {
  const target = resolveWorkspaceFileTarget(initialFilePath);
  void (async () => {
    if (!target) { await list('/workspace'); return; }
    await list(target.directory);
    await open({ name: target.fileName, isDir: false, fullPath: target.fullPath });
  })();
  return () => active?.abort();
});
```

保持 `list`/`open` 的 generation 或 AbortController 防护，确保第一次 list 完成后启动的 cat 不会被旧请求 finally 覆盖新状态。

- [ ] **Step 8: 写 SandboxDetailView URL 传递失败测试**

在 `SandboxDetailView.component.test.ts` 中设置：

```ts
history.replaceState(null, '', '/?sandboxTab=files&sandboxPath=%2Fworkspace%2F2026-07-21%2Freport.md#/project/project-1/sandbox/sandbox-1');
```

让 Sandbox 状态为 RUNNING，断言 Files mock 收到 `initialFilePath='/workspace/2026-07-21/report.md'`。再覆盖 STOPPED 状态，断言仍显示现有“Sandbox 未运行，Files 不可用”且未自动调用 Resume。

- [ ] **Step 9: 运行 URL 测试并确认 RED**

Run: `bunx vitest run src/views/runtime/SandboxDetailView.component.test.ts`

Expected: 新的 initialFilePath 断言失败。

- [ ] **Step 10: 实现 URL 传递**

在 `SandboxDetailView.svelte` 中增加：

```ts
function sandboxPathFromUrl() {
  return new URLSearchParams(window.location.search).get('sandboxPath') || '';
}
```

把当前 URL path 纳入 Files key，并传给组件：

```svelte
{#key `${targetProjectId}:${snapshot.sandbox.sandboxId}:files:${sandboxPathFromUrl()}`}
  <FileBrowser sandboxId={snapshot.sandbox.sandboxId} initialFilePath={sandboxPathFromUrl()} />
{/key}
```

- [ ] **Step 11: 运行 Task 2 验证**

Run: `bun test src/pages/session/file-browser.test.js && bunx vitest run src/pages/session/FileBrowser.component.test.ts src/views/runtime/SandboxDetailView.component.test.ts && bun run check`

Expected: 全部通过；Svelte check 0 errors / 0 warnings。

- [ ] **Step 12: 提交 Task 2**

```bash
git add src/pages/session/file-browser.ts src/pages/session/file-browser.test.js src/pages/session/FileBrowser.svelte src/pages/session/FileBrowser.component.test.ts src/views/runtime/SandboxDetailView.svelte src/views/runtime/SandboxDetailView.component.test.ts
git commit -m "feat(sandboxes): deep link workspace files"
```

---

### Task 3: 运行详情 Workspace 产物集成

**Files:**
- Modify: `src/lib/runtime-timeline.ts`
- Modify: `src/views/runtime/RunExecutionTimelineEntry.svelte`
- Modify: `src/views/runtime/RunExecutionProcess.svelte`
- Modify: `src/views/runtime/RunDetailView.component.test.ts`
- Modify: `src/views/runtime/RunExecutionProcess.component.test.ts`

**Interfaces:**
- Consumes: `discoverWorkspaceArtifacts(options)` and `WorkspaceArtifactFile` from Task 1。
- Produces optional `artifactTarget?: { sandboxId: string; path: string }` on `RuntimeTimelineEntry`。
- Consumes Task 2 URL contract: query parameter `sandboxTab=files` plus URL-encoded `sandboxPath` containing an absolute `/workspace/...` file path。

- [ ] **Step 1: 写运行详情 Workspace 文件失败测试**

在 `RunDetailView.component.test.ts` 的 RPC mocks 中提供 `sandboxService.getSandbox` 与 `execService.execStream`。让 RunDetail 包含：

```ts
summary: {
  runId: 'run-1', sandboxId: 'sandbox-1',
  startedAt: '2026-07-21T03:30:37Z', completedAt: '2026-07-21T03:32:31Z',
},
artifactsDir: '/data/sessions/sandbox-1/state/cells/cell-1',
```

让 ExecStream 返回 `/workspace/2026-07-21/report.md`，断言选择“产物”后同时看到现有 `artifactsDir` 和 Workspace 路径：

```ts
await fireEvent.click(screen.getByRole('button', { name: '产物' }));
expect(await screen.findByText('/data/sessions/sandbox-1/state/cells/cell-1')).toBeTruthy();
expect(await screen.findByRole('button', { name: '打开 Workspace 文件 /workspace/2026-07-21/report.md' })).toBeTruthy();
```

- [ ] **Step 2: 运行集成测试并确认 RED**

Run: `bunx vitest run src/views/runtime/RunDetailView.component.test.ts`

Expected: FAIL，因为 Workspace 文件尚未查询和渲染。

- [ ] **Step 3: 扩展时间线条目动作接口**

在 `RuntimeTimelineEntry` 中增加：

```ts
artifactTarget?: {
  sandboxId: string;
  path: string;
};
```

在 `RunExecutionTimelineEntry.svelte` 中，当 `entry.artifactTarget` 存在时渲染可访问按钮并通过 callback 交给父组件。为避免通用组件直接控制 URL，新增可选 prop：

```ts
onOpenArtifact?: (target: { sandboxId: string; path: string }) => void;
```

按钮：

```svelte
<button
  class="artifact-link"
  aria-label={`打开 Workspace 文件 ${entry.artifactTarget.path}`}
  onclick={() => onOpenArtifact?.(entry.artifactTarget!)}
>{entry.artifactTarget.path}</button>
```

- [ ] **Step 4: 集成 Workspace 发现状态和时间线**

在 `RunExecutionProcess.svelte`：

- import `execService` 和 `discoverWorkspaceArtifacts`。
- 新增 `workspaceArtifacts: WorkspaceArtifactFile[]`、`workspaceArtifactNotice` 状态。
- 每次 Run 身份刷新时清空状态；复用 identity AbortSignal。
- `fetchDetail` 取得带 sandboxId 和 startedAt 的 detail 后并行启动 `fetchWorkspaceArtifacts`。
- 将文件映射为：

```ts
const workspaceEntries: RuntimeTimelineEntry[] = workspaceArtifacts.map((file, index) => ({
  id: `workspace-file:${file.path}`,
  timestamp: file.modifiedAt,
  sortTime: file.modifiedAtMs,
  sequence: 20_000 + index,
  kind: 'result',
  source: 'Workspace 文件',
  level: 'info',
  content: file.path,
  timestampInferred: false,
  filterTags: ['artifact'],
  artifactTarget: { sandboxId: runDetail!.summary!.sandboxId, path: file.path },
}));
```

- `timelineFor` 返回 `base + evidence + workspaceEntries` 的稳定排序结果。
- 状态文案：`stopped` → `Sandbox 已停止，请先手动恢复后刷新产物`；`removed` → `产物所在 Sandbox 已删除，无法读取 Workspace 文件`；`invalid-time` → 不展示提示；`error` → 使用 `Workspace 产物加载失败：` 加具体 RPC/Exec 错误文本；`truncated` → `Workspace 文件列表已截断`。

- [ ] **Step 5: 实现点击导航**

在 `RunExecutionProcess.svelte` 定义：

```ts
function openWorkspaceArtifact(target: { sandboxId: string; path: string }) {
  store.navigateTo('sandbox-detail', { sandboxId: target.sandboxId });
  const url = new URL(window.location.href);
  url.searchParams.set('sandboxTab', 'files');
  url.searchParams.set('sandboxPath', target.path);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
```

将 callback 传给 `RunExecutionTimelineEntry`。使用 `replaceState` 保证一次点击只新增 store 导航产生的一条历史记录。

- [ ] **Step 6: 运行成功路径并确认 GREEN**

Run: `bunx vitest run src/views/runtime/RunDetailView.component.test.ts src/views/runtime/RunExecutionProcess.component.test.ts`

Expected: Workspace 文件和现有产物共同展示。

- [ ] **Step 7: 写点击导航失败测试**

点击 Workspace 文件按钮，断言：

```ts
expect(navigate).toHaveBeenCalledWith('sandbox-detail', { sandboxId: 'sandbox-1' });
expect(new URLSearchParams(location.search).get('sandboxTab')).toBe('files');
expect(new URLSearchParams(location.search).get('sandboxPath')).toBe('/workspace/2026-07-21/report.md');
```

- [ ] **Step 8: 写停止态与错误隔离失败测试**

分别覆盖：

- GetSandbox 返回 STOPPED：显示手动恢复提示，`execStream` 和 Resume mock 均未调用，原 `artifactsDir` 仍显示。
- GetSandbox 抛 NotFound：显示已删除提示，原有产物仍显示。
- ExecStream 抛错：显示非阻塞错误，原有产物仍显示。
- Run A 的 deferred 查询在切换到 Run B 后才返回：不得在 B 的时间线显示 A 文件。

- [ ] **Step 9: 运行新增测试并确认 RED/GREEN**

先在每组生产行为实现前运行 focused 测试观察预期失败，再完成最小实现并运行：

Run: `bunx vitest run src/views/runtime/RunDetailView.component.test.ts src/views/runtime/RunExecutionProcess.component.test.ts`

Expected: 全部测试通过，无未处理 Promise 或 Svelte warning。

- [ ] **Step 10: 运行完整验证**

Run: `bun run test:all`

Expected: Svelte check 0 errors / 0 warnings；Bun、E2E unit、Vitest 全部通过且无 unhandled error。

- [ ] **Step 11: 验证最终范围与后端零修改**

Run:

```bash
git diff --check a3bffc3..HEAD
git diff --stat a3bffc3..HEAD
git status --short
```

Expected: 提交差异只包含 Workspace 产物前端模块、Files 深链接、运行详情集成和测试；现有并行工作区修改保持未暂存；`../agent-compose`、generated protobuf 和 Go daemon 无变更。

- [ ] **Step 12: 提交 Task 3**

```bash
git add src/lib/runtime-timeline.ts src/views/runtime/RunExecutionTimelineEntry.svelte src/views/runtime/RunExecutionProcess.svelte src/views/runtime/RunDetailView.component.test.ts src/views/runtime/RunExecutionProcess.component.test.ts
git commit -m "feat(runs): show workspace artifacts"
```
