# 项目级联删除设计

## 目标

从 YML 项目列表删除项目时，同时删除该项目关联的 Sandbox、运行历史和脚本目录。删除过程必须避免在 Sandbox 清理失败时先删除项目，导致资源成为无法定位的孤儿。

## 范围

- 仅修改 `agent-compose-ui` 的前端删除流程。
- 使用现有 v2 RPC，不修改 `agent-compose` daemon 或 protobuf。
- 项目运行历史通过 `ProjectService.RemoveProject(remove_history=true)` 删除。
- Sandbox 通过 `SandboxService.ListSandboxes` 与 `RemoveSandbox(force=true)` 清理。
- 当前“替换旧项目”流程继续使用原有非级联语义，避免误删新旧项目可能共享的运行资源。

## 删除流程

用户从 Sidebar 确认永久删除后：

1. 分页调用 `ListSandboxes`，直到 `next_cursor` 为空。
2. 筛选关联 Sandbox：
   - `sandbox.project_id` 与目标项目 ID 相同；或
   - 名为 `project` 的 tag 值与目标项目 ID 相同。
   - 项目 ID 比较沿用现有兼容逻辑，兼容 legacy `sha256:` 前缀。
3. 对每个匹配且具有 `sandbox_id` 的 Sandbox 调用 `RemoveSandbox(force=true)`。
4. Sandbox 删除串行执行，便于准确定位失败资源并避免瞬时并发压力。
5. 任一 Sandbox 删除失败时立即中止；不调用 `RemoveProject`，不删除运行历史或脚本目录。前端显示包含 Sandbox ID 的错误。
6. 所有 Sandbox 删除成功后调用 `RemoveProject`：

   ```text
   remove_history=true
   stop_running_sandboxes=true
   ```

7. 项目及历史删除成功后，按现有行为删除脚本目录并刷新项目列表。

## 接口与代码边界

在 `src/lib/toolbar-actions.ts` 增加独立的级联删除函数。它接收同时具备以下能力的客户端：

- `listSandboxes(ListSandboxesRequest)`
- `removeSandbox(RemoveSandboxRequest)`
- `removeProject(RemoveProjectRequest)`

该函数负责 Sandbox 分页、归属判断、强制删除及最终项目删除。Sidebar 只负责确认提示、调用该函数、处理脚本目录和更新 UI。

保留现有 `deleteProject` 函数供替换旧项目等非级联场景使用，避免扩大行为变化。

## 错误与一致性

- 重复的 Sandbox cursor 视为错误并中止，防止无限循环。
- 缺少 `sandbox_id` 的匹配记录视为无法安全删除并中止。
- `RemoveSandbox` 返回 `removed=false` 时视为失败，即使 RPC 本身成功。
- Sandbox 清理完成但 `RemoveProject` 失败时，项目仍存在，但 Sandbox 已被删除；提示项目删除失败，用户可安全重试。
- 脚本目录清理继续采用现有的独立错误提示，不回滚 daemon 侧删除。

## 用户界面

确认文案明确说明操作会永久删除：

- 项目定义；
- 运行历史；
- 关联 Sandbox；
- 关联脚本目录。

同时说明任一 Sandbox 清理失败时项目不会被删除。

删除按钮在整个流程期间保持禁用，成功提示明确说明项目、历史、Sandbox 和脚本目录已处理。

## 测试

单元测试覆盖：

- 多页 Sandbox 查询及 cursor 推进；
- 顶层 `project_id` 匹配；
- `project` tag 匹配；
- legacy 项目 ID 匹配；
- 非关联 Sandbox 不删除；
- `RemoveSandbox(force=true)`；
- Sandbox RPC 失败、`removed=false`、缺失 ID、重复 cursor 时不调用 `RemoveProject`；
- 全部 Sandbox 成功后 `RemoveProject` 使用 `remove_history=true` 和 `stop_running_sandboxes=true`；
- Sidebar 调用新的级联函数，并展示永久删除确认文案。

## 非目标

- 不增加 `DeleteRun` 接口。
- 不直接操作 daemon 数据库。
- 不实现跨 RPC 的事务或回滚。
- 不改变独立 Sandbox 页面上的删除行为。
