# Run Workspace 产物展示设计

## 目标

在运行详情现有“产物”证据基础上，追加展示该 Run 执行期间在 `/workspace` 中创建或修改的文件。点击 Workspace 文件后进入对应 Sandbox 的 Files TAB，自动打开文件所在目录并预览目标文件。

该功能只修改 `agent-compose-ui`，复用现有 V2 Sandbox、Exec 和 Files 能力，不修改 daemon、protobuf 或后端存储。

## 已确认的产品行为

- 保留现有后端登记产物，包括 Run output、result JSON、logs path、artifacts dir 和已确认的 Cell/Run 事件。
- Workspace 文件作为独立的“Workspace 文件”产物记录追加到现有时间线。
- 仅把文件修改时间位于 Run 的 `startedAt` 到 `completedAt` 区间内的普通文件归属到该 Run。
- 运行尚未结束时，时间区间上界使用当前时间；刷新时重新查询。
- 点击 Workspace 文件后导航到对应 Sandbox 详情的 Files TAB，并自动进入所在目录、选中和预览该文件。
- Sandbox 已停止时不得自动 Resume。运行详情显示需要用户手动恢复的提示；链接仍可进入 Files TAB，由 Sandbox 详情沿用现有停止态提示和手动恢复入口。
- Sandbox 已删除、状态查询失败或文件扫描失败时，不影响已有运行详情和后端登记产物，只显示非阻塞提示。

## 方案选择

采用前端通过现有 `GetSandbox` 与 `ExecStream` 读取 Workspace 的方案。

未采用解析 Agent 输出中的 `[file_change]` 或 Markdown 链接，因为模型输出格式不稳定且会漏掉没有在回复中声明的文件。未采用固定扫描 `/workspace/<日期>`，因为该规则只适用于当前 AIWAF 用例，不能覆盖其他 Agent。

## 架构与职责

### Workspace 产物发现模块

新增独立的纯逻辑与请求编排模块，职责包括：

1. 根据 Run 起止时间判断文件是否属于该 Run。
2. 解析 `find` 的有界、NUL 分隔输出。
3. 通过注入的 Sandbox/Exec 客户端查询 Sandbox 状态并扫描 `/workspace`。
4. 返回明确的结果状态：可用文件、Sandbox 已停止、Sandbox 已删除或扫描失败。

扫描命令直接调用 `/usr/bin/find`，不通过 shell 拼接路径。输出包含文件修改时间和绝对路径，记录使用 NUL 分隔，避免空格和换行破坏记录边界。前端解析时间并执行 Run 时间窗口过滤。

安全上限沿用文件浏览器约束：扫描输出最多 256 KiB，结果最多 5000 个普通文件。超过限制时返回截断提示，不把不完整记录当作完整结果。

### RunExecutionProcess

`RunExecutionProcess` 在取得 RunDetail 后启动 Workspace 产物查询：

- 现有 `confirmedEvidence` 保持不变。
- Workspace 文件转换为带 `artifact` filter tag 的时间线条目后，与现有时间线合并。
- 每条记录展示“Workspace 文件”、完整路径和文件修改时间。
- 查询状态或错误以非阻塞提示呈现，不覆盖运行详情错误。
- Run 身份或刷新版本变化时取消旧请求，并防止旧结果覆盖新 Run。

### 导航与 FileBrowser

点击 Workspace 文件执行两步导航：

1. `store.navigateTo('sandbox-detail', { sandboxId })`。
2. 将 URL 查询参数设置为 `sandboxTab=files` 与 `sandboxPath=<绝对文件路径>`。

`SandboxDetailView` 继续以 `sandboxTab` 选择 Files TAB。`FileBrowser` 增加可选初始目标路径：

- 未提供目标路径时维持当前行为，从 `/workspace` 打开。
- 提供 `/workspace` 内绝对文件路径时，加载父目录并自动预览该文件。
- 拒绝 `/workspace` 之外或无法规范化的目标路径，回退到 `/workspace`。
- 浏览器前进/后退改变 `sandboxPath` 时，Files 实例按现有 key/URL 同步机制重新定位。

## Sandbox 生命周期处理

- `RUNNING`：执行只读 Workspace 扫描并展示文件。
- `STOPPED`：不调用 Resume、不调用 Exec；显示“Sandbox 已停止，请先手动恢复后刷新产物”。文件链接若已存在于当前页面数据中仍可进入 Files TAB。
- `REMOVED` / `DESTROYED` / NotFound：显示产物所在 Sandbox 已删除，不能读取 Workspace 文件。
- 未知状态或暂时性 RPC 错误：保留现有产物，显示 Workspace 产物加载失败及可重试提示。

手动恢复仍只发生在 Sandbox 详情现有恢复按钮中。本功能不新增任何自动恢复或后台重试。

## 时间归属规则

- 起点：可解析的 `startedAt`；无法解析时不扫描，避免把整个 Workspace 误归属到当前 Run。
- 终点：终态 Run 使用可解析的 `completedAt`；运行中使用查询时的当前时间。
- 边界：`mtime >= startedAt && mtime <= endAt`。
- 修改时间相同的路径按完整路径稳定排序。
- 同一路径只展示一次，以扫描结果中的最终记录为准。

该规则表示“本次运行期间创建或修改”，无法证明文件首次由本 Run 创建；UI 文案使用“运行期间产生或修改的 Workspace 文件”，避免过度承诺文件所有权。

## 错误与空状态

- 扫描成功但没有匹配文件：不增加 Workspace 条目，现有“本次执行没有可确认的产物记录”逻辑仍适用。
- 扫描输出截断：展示已完整解析的记录，并显示“Workspace 文件列表已截断”。
- 单个路径无法解析：跳过该记录，不使整个运行详情失败。
- Exec 流 stderr、result error、RPC error：显示 Workspace 扫描失败，不清除现有产物。
- 导航目标无效：Files TAB 回退 `/workspace` 并显示正常目录内容。

## 测试策略

### 纯逻辑测试

- 解析 NUL 分隔的 `mtime + path` 输出，包括空格、制表符和换行路径。
- Run 时间窗口上下边界、运行中上界、非法时间。
- 去重、稳定排序、5000 条上限和截断状态。
- `/workspace` 目标路径校验、父目录计算与文件名提取。

### 组件与编排测试

- 现有后端产物与 Workspace 文件同时展示在“产物”筛选中。
- RUNNING Sandbox 调用 `GetSandbox` 和 `ExecStream`，且命令不经过 shell。
- STOPPED Sandbox 不调用 Resume 或 Exec，并显示手动恢复提示。
- NotFound、Exec 失败和旧请求迟到不影响现有运行详情。
- 点击文件设置 `sandboxTab=files`、`sandboxPath` 并导航到正确 Sandbox。
- FileBrowser 加载父目录后自动选中并预览目标文件。
- Sandbox 停止时 Files TAB 保留现有“Sandbox 未运行，Files 不可用”提示及手动恢复流程。

## 非目标

- 不新增后端 Artifact API 或修改 protobuf。
- 不复制 Workspace 文件到 daemon 的 `artifactsDir`。
- 不自动恢复、重建或启动 Sandbox。
- 不提供批量下载、压缩、永久归档或跨 Run 文件所有权追踪。
- 不把 Agent 回复中的任意 Markdown 链接当作可信产物。
