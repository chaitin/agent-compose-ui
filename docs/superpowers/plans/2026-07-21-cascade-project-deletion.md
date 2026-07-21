# 项目级联删除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 Sidebar 永久删除项目时，先强制删除全部关联 Sandbox，再删除项目定义和运行历史，避免留下孤儿资源。

**Architecture:** 在 `toolbar-actions.ts` 中实现可独立测试的级联删除编排函数，封装 Sandbox 分页、项目归属判断、失败中止和最终 `RemoveProject` 请求。Sidebar 只负责确认、调用、脚本目录清理和 UI 状态更新；现有非级联 `deleteProject` 保留给旧项目替换流程。

**Tech Stack:** TypeScript、Svelte 5、ConnectRPC v2 generated clients、Bun test。

## Global Constraints

- 仅修改 `agent-compose-ui`，不修改 `../agent-compose` daemon 或 protobuf。
- 使用现有 `ListSandboxes`、`RemoveSandbox` 和 `RemoveProject` RPC。
- 任一 Sandbox 清理失败时不得调用 `RemoveProject`，不得删除运行历史或脚本目录。
- 项目 ID 匹配兼容顶层 `projectId`、`project` tag 和 legacy `sha256:` 前缀。
- 现有替换旧项目流程继续使用非级联 `deleteProject`。
- 保留工作区内所有不相关并行改动，只暂存本计划涉及的 hunk。
- 严格执行 TDD：先观察目标测试失败，再写生产代码。

---

### Task 1: 可测试的 Sandbox 与项目级联删除编排

**Files:**
- Modify: `src/lib/toolbar-actions.ts`
- Test: `src/lib/toolbar-actions.test.js`

**Interfaces:**
- Consumes: `ListSandboxesRequest`, `RemoveSandboxRequest`, `RemoveProjectRequest`, `isSameProjectId`
- Produces: `CascadeDeleteProjectClient`
- Produces: `cascadeDeleteProject(projectId: string, client: CascadeDeleteProjectClient): Promise<{ removedSandboxes: number }>`

- [ ] **Step 1: 在测试中导入新函数并写成功路径失败测试**

新增测试，模拟两页 Sandbox：一项通过顶层 `projectId` 匹配，一项通过 `project` tag 匹配，一项不相关。断言两个关联项均收到 `force=true`，然后项目请求包含 `removeHistory=true` 与 `stopRunningSandboxes=true`：

```js
test('removes every related sandbox before removing project history', async () => {
  const calls = [];
  const result = await cascadeDeleteProject('project-1', {
    listSandboxes: async ({ cursor }) => cursor === ''
      ? { sandboxes: [
          { sandboxId: 'direct', projectId: 'project-1', tags: [] },
          { sandboxId: 'other', projectId: 'project-2', tags: [] },
        ], nextCursor: 'page-2' }
      : { sandboxes: [
          { sandboxId: 'tagged', projectId: '', tags: [{ name: 'project', value: 'project-1' }] },
        ], nextCursor: '' },
    removeSandbox: async (request) => {
      calls.push(['sandbox', request.sandboxId, request.force]);
      return { sandboxId: request.sandboxId, removed: true };
    },
    removeProject: async (request) => {
      calls.push(['project', request.removeHistory, request.stopRunningSandboxes]);
      return {};
    },
  });
  expect(calls).toEqual([
    ['sandbox', 'direct', true],
    ['sandbox', 'tagged', true],
    ['project', true, true],
  ]);
  expect(result).toEqual({ removedSandboxes: 2 });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `bun test src/lib/toolbar-actions.test.js`

Expected: FAIL，因为 `cascadeDeleteProject` 尚未导出。

- [ ] **Step 3: 写失败一致性测试**

覆盖以下独立场景，并在每个场景断言 `removeProject` 调用次数为零：

```js
test.each([
  ['missing id', { sandboxId: '', projectId: 'project-1' }],
  ['removed false', { sandboxId: 's1', projectId: 'project-1' }],
])('%s aborts before project removal', async (name, sandbox) => {
  let projectCalls = 0;
  await expect(cascadeDeleteProject('project-1', {
    listSandboxes: async () => ({ sandboxes: [sandbox], nextCursor: '' }),
    removeSandbox: async ({ sandboxId }) => ({ sandboxId, removed: name !== 'removed false' }),
    removeProject: async () => { projectCalls += 1; return {}; },
  })).rejects.toThrow();
  expect(projectCalls).toBe(0);
});
```

再增加：`removeSandbox` 抛错立即中止；重复 `nextCursor` 中止；`sha256:project-1` 与 `project-1` 能匹配。

- [ ] **Step 4: 实现最小级联函数**

在 protobuf import 中加入 `RemoveSandboxRequest` 和 `RemoveSandboxResponse` 类型，并实现：

```ts
export interface CascadeDeleteProjectClient extends DeleteProjectClient {
  listSandboxes(request: ListSandboxesRequest): Promise<ListSandboxesResponse>;
  removeSandbox(request: RemoveSandboxRequest): Promise<RemoveSandboxResponse>;
}

function sandboxBelongsToProjectForDeletion(
  sandbox: { projectId?: string; tags?: Array<{ name: string; value: string }> },
  projectId: string,
): boolean {
  if (isSameProjectId(sandbox.projectId ?? '', projectId)) return true;
  const tag = (sandbox.tags ?? []).find((item) => item.name === 'project');
  return !!tag && isSameProjectId(tag.value, projectId);
}

export async function cascadeDeleteProject(projectId: string, client: CascadeDeleteProjectClient) {
  const related = [];
  const seen = new Set<string>();
  let cursor = '';
  while (true) {
    const response = await client.listSandboxes(new ListSandboxesRequest({ limit: 500, cursor }));
    for (const sandbox of response.sandboxes ?? []) {
      if (!sandboxBelongsToProjectForDeletion(sandbox, projectId)) continue;
      if (!sandbox.sandboxId) throw new Error('关联 Sandbox 缺少 ID，项目未删除');
      related.push(sandbox.sandboxId);
    }
    const next = response.nextCursor?.trim() ?? '';
    if (!next) break;
    if (seen.has(next)) throw new Error(`ListSandboxes returned repeated cursor: ${next}`);
    seen.add(next);
    cursor = next;
  }
  for (const sandboxId of related) {
    const response = await client.removeSandbox(new RemoveSandboxRequest({ sandboxId, force: true }));
    if (!response.removed) throw new Error(`Sandbox ${sandboxId} 未能删除，项目未删除`);
  }
  await client.removeProject(new RemoveProjectRequest({
    project: new ProjectRef({ projectId }),
    removeHistory: true,
    stopRunningSandboxes: true,
  }));
  return { removedSandboxes: related.length };
}
```

- [ ] **Step 5: 运行 focused 测试和检查**

Run: `bun test src/lib/toolbar-actions.test.js && bun run check`

Expected: 所有测试通过，Svelte check 为 0 errors / 0 warnings。

- [ ] **Step 6: 提交 Task 1**

```bash
git add src/lib/toolbar-actions.ts src/lib/toolbar-actions.test.js
git commit -m "feat(projects): cascade sandbox and history deletion"
```

---

### Task 2: Sidebar 永久删除交互集成

**Files:**
- Modify: `src/components/Sidebar.svelte`
- Test: `src/components/Sidebar.test.js`

**Interfaces:**
- Consumes: `cascadeDeleteProject(projectId, client)` from Task 1
- Consumes: `projectService` and `sandboxService` from `src/lib/rpc.ts`

- [ ] **Step 1: 先更新 Sidebar 静态行为测试**

将旧的 `deleteProject` 断言替换为：

```js
assert.match(source, /await cascadeDeleteProject\(projectId, cascadeDeleteClient\)/);
assert.match(source, /项目定义、运行历史、关联 Sandbox 与脚本目录/);
assert.match(source, /Sandbox 清理失败时项目不会被删除/);
```

并断言成功提示包含运行历史与 Sandbox。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `bun test src/components/Sidebar.test.js`

Expected: FAIL，因为 Sidebar 仍调用 `deleteProject(projectId, projectService)`。

- [ ] **Step 3: 接入级联客户端与新文案**

更新 import：

```ts
import { projectService, sandboxService } from '../lib/rpc';
import { cascadeDeleteProject } from '../lib/toolbar-actions';
```

在组件模块中组合客户端：

```ts
const cascadeDeleteClient = {
  listSandboxes: sandboxService.listSandboxes.bind(sandboxService),
  removeSandbox: sandboxService.removeSandbox.bind(sandboxService),
  removeProject: projectService.removeProject.bind(projectService),
};
```

确认文案改为：

```text
此操作会永久删除项目定义、运行历史、关联 Sandbox 与脚本目录。Sandbox 清理失败时项目不会被删除。
```

删除调用改为：

```ts
const { removedSandboxes } = await cascadeDeleteProject(projectId, cascadeDeleteClient);
```

成功提示包含 `removedSandboxes` 数量；只有该调用成功后才执行现有 `scriptApi.deleteProject`。

- [ ] **Step 4: 运行 Sidebar 与级联测试**

Run: `bun test src/components/Sidebar.test.js src/lib/toolbar-actions.test.js && bun run check`

Expected: 两组测试全部通过，Svelte check 为 0 errors / 0 warnings。

- [ ] **Step 5: 运行全量前端测试**

Run: `bun run test:all`

Expected: 全部测试通过。

- [ ] **Step 6: 提交 Task 2**

```bash
git add src/components/Sidebar.svelte src/components/Sidebar.test.js
git commit -m "feat(projects): expose permanent project deletion"
```

---

### Task 3: 最终范围与安全验证

**Files:**
- Modify only if Tasks 1-2 exposed a scoped defect.

- [ ] **Step 1: 验证最终差异**

Run:

```bash
git diff --check ff928ea..HEAD
git diff --stat ff928ea..HEAD
git status --short
```

Expected: 只包含级联删除的计划、测试和实现提交；用户现有并行改动保持未暂存且未被覆盖。

- [ ] **Step 2: 复核接口能力**

确认最终请求顺序为 `ListSandboxes* -> RemoveSandbox* -> RemoveProject`，且项目请求严格包含：

```text
remove_history=true
stop_running_sandboxes=true
```

- [ ] **Step 3: 若无新缺陷则不创建额外提交**

只有验证暴露级联删除范围内缺陷时才创建：

```bash
git commit -m "fix(projects): address cascade deletion verification"
```
