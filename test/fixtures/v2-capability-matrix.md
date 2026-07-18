# v2 CLI / Web 能力最终决策矩阵

审计日期：2026-07-15。代码审计基准 HEAD 为 `61c0736`；本文档提交 SHA 另见 Git 历史。以只读后端 `agentcompose.v2` 契约为能力边界；入口和限制均按实际代码记录，不把 RPC 已接线等同于完整用户闭环。

| 能力域 | 用户任务 | CLI 用户价值 | v2 契约 | 当前 Web | 是否迫使使用 CLI | 决策 | 优先级 | 验收标准 | 证据 |
|---|---|---|---|---|---|---|---|---|---|
| Project | 校验项目 YAML | 提交前纠错 | `ValidateProject` | 项目编辑器 → 工具栏“验证”，已闭环 | 否 | 保留 | P0 | 仅 v2，显示 issues | `web/src/components/Toolbar.svelte`; `web/src/lib/toolbar-actions.ts` |
| Project | Dry Run 后 Apply | 避免盲目覆盖 | `ApplyProject(dry_run, changes, issues, expected_spec_hash)` | 工具栏“保存/运行”先发 server dry-run，展示 changes/issues，再确认 Apply；编辑或切项目会使预览失效 | 否 | 补齐 | P0 | 已达标：确认前预览并携带 spec hash | `web/src/lib/toolbar-actions.ts:126`; `web/src/components/Toolbar.svelte` |
| Project | 搜索、查看、删除项目 | 日常治理 | `List/Get/RemoveProject` | 左侧项目列表、筛选及行删除，均为 v2 | 否 | 重构 | P0 | 上下文操作并说明运行环境影响 | `web/src/components/Sidebar.svelte`; `web/src/lib/toolbar-actions.ts:108` |
| Run | 启动 Agent 与常用覆盖 | 核心执行 | `RunAgentStream/StartRun/RunAttach` | 项目 → Agent →“运行”；支持流式、detached、启动新交互 Run，以及 prompt/command、driver、cleanup、Jupyter；Sandbox 下拉来自当前项目最多 1000 条 v2 Run | 否（可见目标） | 补齐 | P0 | 新交互 Run 支持 started ID、stdin、resize、human message、cancel；不附着 existing Run | `web/src/modals/RunAgentModal.svelte`; `web/src/lib/run-controls.ts`; `web/src/lib/run-attach.ts` |
| Run | 列表、详情、日志、停止 | 诊断和恢复 | `ListRuns/GetRun/FollowRunLogs/StopRun` | 项目/Agent Runtime 每页 50 条，可加载更多并按 status/source/date/sandbox 筛选；RunDetail 仅负责详情、tail/follow logs 与 stop | 否 | 重构 | P0 | 已达标：旧 Run 可分页到达；RunDetail 不宣称 attach existing Run | `web/src/views/runtime/ProjectRuntimeView.svelte`; `web/src/views/runtime/AgentRunListView.svelte`; `web/src/views/runtime/RunDetailView.svelte` |
| Run | Scheduler 上下文手动触发 | 一次调度运行 | Run 请求含 scheduler/trigger/payload 与常用覆盖；`StartRun` 可 detached | 项目 → Scheduler → Trigger“手动 Run”；支持 wait/detached、payload、sandbox、driver、prompt、cleanup、Jupyter | 否 | 合并 | P1 | 已达标：两种执行方式复用同一请求快照并进入 Run 详情 | `web/src/views/runtime/SchedulerListView.svelte`; `web/src/views/runtime/SchedulerListView.component.test.ts` |
| Run | 新交互式 Run / 多轮 prompt | TTY 与 human message | `RunAttach` | Agent“运行”弹窗 →“交互 TTY/启动新交互 Run”；从当前表单构造完整新 Run 请求 | 否 | 补齐 | P1 | 已达标：prompt/command mode、stdin、resize、human message、cancel；关闭/重启隔离各自 RPC session | `web/src/modals/RunAgentModal.svelte`; `web/src/lib/run-attach.ts` |
| Exec | 命令、Terminal 与文件 | 运行后调试 | `Exec/ExecStream/ExecAttach` | 项目 → Sandbox：行内 Exec、Terminal TTY/resize/cancel、Files 浏览/预览/保存 | 否（可见 Sandbox） | 合并 | P0 | 已达标常用闭环；Files 写入限 64 KiB、预览 512 KiB、目录最多 5000 项 | `web/src/views/runtime/SandboxListView.svelte`; `web/src/pages/session/SessionTerminal.svelte`; `web/src/pages/session/FileBrowser.svelte` |
| Exec | Agent prompt attach / cwd/env 高级执行 | Agent 协助与精确执行环境 | `ExecAttach(prompt/human_message)`、`ExecRequest.cwd/env` | Sandbox → Terminal 连接前选择 command/agent-prompt，设置 cwd/env；prompt 后可继续 human message | 否 | 补齐 | P1 | 已达标：env 空键/重复键在发流前拒绝 | `web/src/pages/session/SessionTerminal.svelte`; `web/src/lib/exec-attach.ts` |
| Image | 列表、拉取、检查、删除 | 资源治理 | `List/Pull/Inspect/RemoveImage` | 左侧“镜像”，已闭环 | 否 | 保留 | P1 | 全流程 v2 | `web/src/pages/ImageListView.svelte`; `web/src/modals/PullImageModal.svelte` |
| Image | 构建镜像及流式进度 | 构建交付物 | `BuildImage` | 左侧“镜像”→“构建镜像”；支持 Dockerfile/tags/args/target/store/platform/no-cache/pull 与流事件 | 否 | 补齐 | P1 | 已达标；context 是 daemon 主机路径；缺显式用户取消为 Minor UX，非能力 gap | `web/src/modals/BuildImageModal.svelte`; `web/src/modals/build-image.ts` |
| Cache | 列表、筛选、检查 | 定位占用 | `ListCaches/InspectCache` | 左侧“缓存” | 否 | 补齐 | P1 | 已达标：上下文检查 | `web/src/pages/CacheListView.svelte`; `web/src/lib/caches.ts` |
| Cache | dry-run 清理/删除 | 安全回收 | `PruneCaches(include_referenced)/RemoveCache` | 缓存页默认安全预览；危险选项可显式启用 include-referenced，必须以相同选项重新预览后确认 | 否 | 补齐 | P1 | 已达标：隐藏危险选项会撤销预览和风险状态 | `web/src/pages/CacheListView.svelte`; `web/src/pages/CacheVolumeViews.test.ts` |
| Volume | 列表、创建、检查 | 持久资源治理 | `List/Create/InspectVolume`，Create 含 labels/options | 左侧“数据卷”；创建支持 name/driver 与可增删 labels/options 键值对 | 否 | 补齐 | P1 | 已达标：拒绝空键与重复键 | `web/src/pages/VolumeListView.svelte`; `web/src/lib/volumes.ts` |
| Volume | dry-run 清理/删除 | 安全回收 | `PruneVolumes/RemoveVolume` | 数据卷页预览、确认和结果 | 否 | 补齐 | P1 | 已达标：matched/removed/skipped | `web/src/pages/VolumeListView.svelte`; `web/src/pages/CacheVolumeViews.test.ts` |
| Sandbox | 有限清单、Stats、工具入口 | 环境诊断 | Run 派生 ID；无 ListSandbox | 项目 → Sandbox；最多扫描当前项目 1000 条 Run，提供完整 v2 Stats、Exec、Terminal、Files | 否（可见目标） | 重构 | P1 | 已展示 sampledAt、CPU、memory limit/usage/percent、network、block I/O、uptime；inventory 仍受后端无 ListSandbox 限制 | `web/src/views/runtime/SandboxListView.svelte`; `web/src/lib/runtime-inventory.ts` |
| Sandbox | 停止、恢复 | 生命周期治理 | v2 未提供 | 行内说明，不可操作 | 否，不伪造 | 后端阻塞 | P1 | 当前 v2 API 未提供此能力 | `web/src/lib/v2-capabilities.ts`; `web/src/views/runtime/SandboxListView.svelte` |
| Sandbox | 单删、批量清理 | 回收环境 | `RemoveSandbox(force)` | 行内 Remove / 清理全部 | 否 | 重构 | P1 | 快照逐项删除并提示强制风险 | `web/src/modals/SandboxPruneModal.svelte`; `web/src/lib/sandbox-prune.ts` |
| Dashboard | 全局流式概览 | 概览 | v2 未提供 | 旧 v1 实现已移除；总览仅说明 | 否 | 移除 | P2 | 当前 v2 API 未提供此能力 | `web/src/pages/Dashboard.svelte` |
| Session | 生命周期、文件、Jupyter | 调试上下文 | v2 未提供 | 历史路由仅说明；Exec 已迁出 | 否 | 禁用 | P0 | 当前 v2 API 未提供此能力 | `web/src/views/runtime/SessionDetailView.svelte`; `web/src/lib/v2-capabilities.ts` |
| Scheduler | 查看定义与 trigger | 调度治理 | `GetProject(include_spec)` 提供 summary/spec | 项目 → Scheduler，展示 agent、scheduler ID、enabled 声明、trigger 类型/表达式/prompt | 否 | 保留 | P1 | 只读检查已达标；动态启停为“当前 v2 API 未提供此能力” | `web/src/views/runtime/SchedulerListView.svelte` |
| Scheduler | 动态启停 | 生命周期控制 | v2 未提供 mutation RPC | Scheduler 页明确禁用 | 否，不伪造 | 后端阻塞 | P1 | 当前 v2 API 未提供此能力 | `web/src/views/runtime/SchedulerListView.svelte`; `web/src/lib/v2-capabilities.ts` |
| Loader Run | Loader Run/Event | 调度诊断 | v2 未提供 | Loader 路由仅说明 | 否 | 禁用 | P1 | 当前 v2 API 未提供此能力 | `web/src/views/runtime/LoaderRunListView.svelte` |
| 全局环境变量 | daemon 环境配置 | 运维 | v2 未提供 | 设置页仅说明 | 否 | 禁用 | P2 | 当前 v2 API 未提供此能力 | `web/src/pages/SystemSettings.svelte` |
| 能力目录 | capability catalog/status | 运维诊断 | v2 未提供 | 设置页仅说明 | 否 | 禁用 | P2 | 当前 v2 API 未提供此能力 | `web/src/pages/SystemSettings.svelte` |
| CLI 专属 | host/file/project-name/json/管道/补全 | 本机与自动化语义 | 不适用 | 不进入 Web 导航 | 否 | CLI 专属 | 不实施 | 保持 CLI 独立 | `agent-compose/cmd/agent-compose/main.go:419`; `web/src/lib/rpc.ts:20` |

## 最终结论

- Run、Cache、Volume、Run 派生 Sandbox 的已交付任务均提供上下文入口，普通用户不必复制 Run/Sandbox/Cache/Volume ID 到 CLI。
- Dashboard、Session 生命周期、Scheduler 控制、Loader Run、全局环境变量、能力目录以及 Sandbox stop/resume 因 v2 缺失而明确禁用，不发送 v1 请求。
- Tasks 10–12 已补齐 Run 历史分页过滤、RunAttach、Scheduler 常用高级覆盖、Exec prompt/cwd/env、Cache include-referenced、Volume labels/options 与完整 Stats。
- Scheduler wait/detached 最后一项缺口已补齐。最终未发现 v2-supported CLI 普通用户 Web gap；剩余限制均为真正 v2 缺失或合理 CLI 专属。
- CLI 专属的进程地址、本地文件、机器输出与 Shell 自动化未进入导航，保持 CLI 独立性。
