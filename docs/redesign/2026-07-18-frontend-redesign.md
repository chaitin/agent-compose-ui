# agent-compose-ui 前端重设计文档

> 状态：设计草案（待评审）
> 日期：2026-07-18
> 范围：全面重构（信息架构 + 交互 + 视觉）
> 产出：本设计文档。文中所有示意图均为 ASCII，不含 UI 效果图。

---

## 1. 背景与目标

### 1.1 产品是什么

`agent-compose` 是"**给 AI 编码智能体用的 Docker Compose**"：一个常驻守护进程 + CLI 的控制平面，
把 AI 编码智能体（Codex / Claude Code / Gemini / OpenCode）声明式地跑在隔离沙箱里。
`agent-compose-ui` 是它的 Web 控制台——本仓库，一个 Svelte 5 单页应用，通过 ConnectRPC 与守护进程对话。

用户在这里做四件事：

1. **定义智能体**（LLM 提供方 + 运行时镜像 + 工作区 + 环境变量 + 能力集 + 系统提示词）。
2. **交互式运行**智能体（对话式工作会话）。
3. **调度自动化任务**（cron / interval / event / timeout 触发器，或整段 JS 调度脚本）。
4. **观测一切**（运行中心：对话 / 时间轴 / 任务，实时终端与 Jupyter 调试）。

### 1.2 为什么要重设计

当前实现是逐步长出来的手写 SPA，四类问题已经明显：

| # | 痛点 | 具体表现 |
|---|------|----------|
| P1 | **视觉陈旧 / 拥挤** | 全手写 CSS，层级弱，密度失控；只有浅色模式，硬编码 `color-scheme: light` |
| P2 | **导航 / 信息架构混乱** | 侧栏仅 4 项；`/debug/runs/:id`、`/events/:id` 两个整页只能深链接进入；SPA 跳转与整页刷新混用；无面包屑；`WorkbenchPage.svelte` 为死代码 |
| P3 | **表单 / 抽屉太复杂** | 编辑走全高侧抽屉，内嵌原始 JSON/JS `<textarea>`，仅提交时校验；"代码编辑器"是 `textarea`+`pre` 手动滚动同步的伪编辑器 |
| P4 | **运行观测繁杂** | `RunsPage.svelte` 约 4600 行，`workbenchMode / activeMode / activeTab / activeDetailTab` 多套模式概念重叠；难以跟踪实时运行、沙箱、事件 |

### 1.3 目标与成功标准

| 目标 | 可衡量标准 |
|------|-----------|
| 视觉现代、克制、密集但清晰（P1） | 建立分层设计 Token；浅/暗双主题；统一密度与层级 |
| 导航清晰、可发现（P2） | 单一 SPA 路由模型；所有页面/资源进入正式导航；提供面包屑 + ⌘K 命令面板 |
| 编辑顺畅、可校验（P3） | 主编辑流由抽屉迁移到独立页面/分步表单；字段级即时校验；真正的代码编辑器 |
| 运行观测直观、实时（P4） | 运行中心拆分为可独立理解的组件；实时流驱动；沙箱/事件/产物有清晰归位 |

### 1.4 明确的非目标

- 不改动后端 ConnectRPC 契约（`proto/agentcompose/v2` 是 API 事实源；前端仅消费 `src/gen/`）。
- 不做移动端优先（这是桌面型技术控制台，笔记本优先，宽屏增强）。
- 本轮不引入 SSR / SvelteKit 全量重写（见 §9 权衡）。

---

## 2. 现状诊断

### 2.1 当前信息架构（问题可视化）

```
┌───────────────────────────── 当前 App Shell ─────────────────────────────┐
│ Sidebar (可折叠)         │  Top Statusbar: 健康 CPU RSS 运行数  [用户]      │
│  · 智能体                 ├──────────────────────────────────────────────────┤
│  · 自动化任务             │                                                  │
│  · 运行中心               │              当前路由页面                          │
│  · 系统配置               │                                                  │
└──────────────────────────┴──────────────────────────────────────────────────┘

侧栏只暴露 4 项 ↑                     深链接才能到达 ↓（不在任何导航里）
                                     · /debug/runs/:id   （沙箱终端 + Jupyter）
                                     · /events/:id       （事件溯源，整页、无外壳）

死代码：WorkbenchPage.svelte（未被引用）、model/agents.ts 的 builtinAgents（无人消费）
```

问题点（对应文件）：

- **导航模型不统一**：`App.svelte` 用 `pushState` 做 SPA 跳转，但 `AgentsPage.svelte`、`AutomationTasksPage.svelte`
  在跳转运行中心时用 `window.location.assign/replace` 整页刷新 → 白闪、丢状态。
- **隐藏页面**：`DebugRunPage.svelte`、`EventDetailPage.svelte` 无导航入口；后者甚至渲染在外壳之外（无侧栏）。
- **Settings 内部冗余**：`SettingsPage.svelte` 顶部有指标行，左侧又有一份列出相同 6 个分区的子导航。
- **巨型页面**：`RunsPage.svelte`（~4600 行）+ `EventDetailPage.svelte`（~1430 行）承载了绝大部分复杂度。

### 2.2 领域心智模型（新设计需贯穿）

```
项目 Project (revisioned compose 文件, spec_hash)
   └─ 智能体 Agent (provider + model + image + driver + workspace + env + capset)
         ├─ 调度器 Scheduler (触发器[] 或 一段 JS 脚本, sandbox_policy)
         │     └─ 触发器 Trigger (cron | interval | timeout | event → next_fire_at)
         └─ 运行 Run (source: MANUAL | SCHEDULER | API)
               └─ 沙箱 Sandbox (driver 支撑, sticky|new)
                     ├─ cells   (notebook 式执行单元, 可流式 Watch)
                     └─ events  (USER_MESSAGE|AGENT_MESSAGE|AGENT_ACTIVITY|STATUS)

横切资源：镜像 Image · 卷 Volume · MCP 服务 · Skills · 能力集 CapabilitySet
          · 缓存 Cache · 全局环境/设置 · Workspace 预设
```

**关键洞察**：后端有 8 个 ConnectRPC 服务，`Watch* / *Stream / FollowRunLogs / RunAttach / ExecAttach`
等流式接口是一等公民。当前前端把实时当补丁（`App.svelte` 里手写重连/退避）。
**新设计应把"实时订阅"当核心数据获取模式**，而非事后补救。

---

## 3. 设计原则

1. **单一导航模型** —— 全站 SPA 路由，一处 `navigate()`，杜绝 `window.location` 整页刷新；每个可停留状态都有 URL。
2. **实时优先** —— 运行/沙箱/健康等易变数据默认走流式订阅；组件区分"订阅式"与"一次性拉取式"。
3. **渐进式校验** —— 字段级即时反馈 + 内联错误，取代"提交才报错 + 顶部横幅"。
4. **密集但清晰** —— 对标 Linear / GitHub / Vercel：高信息密度、强层级、克制配色、键盘友好。
5. **暗色为一等公民** —— 分层 Token（primitive → semantic），浅/暗对等，不做事后贴皮。
6. **可组合组件** —— 引入基础组件层；页面由小而专注的组件拼装，替代巨型单文件。
7. **可发现性** —— 所有页面、资源、动作都能从导航或 ⌘K 命令面板到达；不留深链接孤岛。

---

## 4. 信息架构与导航（重点 · P2）

### 4.1 新站点地图

把隐藏页面与横切资源纳入导航，按"工作区 / 资源 / 系统"三组组织：

```
agent-compose-ui
│
├─ 工作区 Workspace
│   ├─ 概览 Overview            /                     (取代死掉的 WorkbenchPage：健康 + 运行摘要 + 待关注)
│   ├─ 智能体 Agents            /agents               列表 → /agents/:id → /agents/:id/edit
│   ├─ 自动化任务 Automations   /automations          列表 → /automations/:id → /automations/:id/edit
│   └─ 运行 Runs                /runs                 列表 → /runs/:id (详情) → /runs/:id/terminal (调试)
│                                                     事件溯源 /events/:id 归入此组的详情视图
│
├─ 资源 Resources
│   ├─ 镜像 Images              /images
│   ├─ 能力集 Capabilities      /capabilities         (网关状态 + capset + catalog)
│   ├─ MCP 服务                 /mcp
│   └─ Skills                   /skills
│
└─ 系统 System
    ├─ 设置 Settings            /settings             (全局环境 / 网关 / Webhook / Workspace 预设 / 鉴权)
    └─ 缓存 Caches              /settings/caches      (或并入设置的资源清理页)
```

> 说明：资源组中"镜像/卷/能力集"后端已有独立服务（`ImageService`/`VolumeService`/`CapabilityService`），
> 当前 UI 未暴露或只散落在 Settings 里。是否一次全上可分期（见 §10），但 IA 先把位置留好。

### 4.2 App Shell 整体布局

**(1) 全局框架**（三区：Sidebar / TopBar / Content；尺寸为设计基准，非硬约束）：

```
◀─ 240px ─▶◀──────────────── Content: 自适应 (min 1024 · 增强 ≥1920) ────────────────▶
┌──────────┬──────────────────────────────────────────────────────────────────────┐
│ ▤ agent- │ [☰] 面包屑: 运行 / run-a1b2 / 终端        ⌘K 搜索   ◐主题  ⏻正常  [👤] │ 48px  ← TopBar
│  compose ├──────────────────────────────────────────────────────────────────────┤
│          │ 页面头部:  标题  +  主操作按钮  +  视图切换/过滤                  56px  │  ← Page Header
│ 工作区    ├──────────────────────────────────────────────────────────────────────┤
│  概览     │                                                                      │
│  智能体 ● │                                                                      │
│  自动化   │                          页面主体 (Body)                             │
│  运行     │                   列表 / 主从 / 详情 / 编辑 / 工作台                   │  ← 各页嵌入此区
│          │                        (随页面类型变化)                              │
│ 资源      │                                                                      │
│  镜像     │                                                                      │
│  卷       │                                                                      │
│  能力集   │                                                                      │
│  MCP      │                                                                      │
│  Skills   │                                                                      │
│          │                                                                      │
│ 系统      │                                                                      │
│  设置     │                                                                      │
├──────────┤                                                                      │
│ ●正常 12%│                                                                      │
│ 1.2G   ↻ │  ← 侧栏底部常驻全局状态 (点击进概览)                                   │
└──────────┴──────────────────────────────────────────────────────────────────────┘
   Sidebar                              Content
 (折叠→56px)                    = Page Header(56px) + Body(自适应高度, 内部自滚)
```

**(2) 主从骨架**（列表类页面的通用结构：智能体 / 自动化 / 运行）：

```
┌ 页面头部   智能体                                    [+ 新建智能体]  [⧉ 视图] ┐
├────────────────────────┬─────────────────────────────────────────────────────┤
│ 列表 (≈320px)           │ 详情 (自适应)                                         │
│ [🔍 过滤___]  [状态 ▾]   │ ← my-coder   ●可用            [运行] [编辑]           │
│ ─────────────────────  │ ───────────────────────────────────────────────────  │
│ ● my-coder     ●运行中  │ 概况 | 系统提示 | 环境 | 能力 | 扩展                  │
│ ○ api-bot              │ ┌ (标签页内容) ────────────────────────────────────┐ │
│ ○ nightly-sync  ⚠风险   │ │ provider/model/image/driver · workspace · 最近运行│ │
│ …                      │ └───────────────────────────────────────────────────┘ │
│ [空态: + 新建]          │                                                       │
└────────────────────────┴─────────────────────────────────────────────────────┘
  选中项 URL 可分享 (?agent=)          编辑/运行进入独立子路由, 走 SPA navigate
```

**(3) 工作台骨架 —— 运行详情 + 终端嵌入完整外壳**（即 §7.4.1(a) 的"整体"版，补上侧栏）：

```
┌──────────┬──────────────────────────────────────────────────────────────────┐
│ ▤ agent- │ [☰] 运行 / run-a1b2 / 终端              ⌘K   ◐   ⏻正常   [👤]      │
│  compose ├──────────────────────────────────────────────────────────────────┤
│ 工作区    │ ← run-a1b2   ●运行中   claude · node:20 · docker      [停止运行]   │
│  概览     ├──────────────────────────────────────────────────────────────────┤
│  智能体   │ 对话 | 时间轴 | 日志 |〔终端〕| 产物 | 沙箱                          │
│  自动化   ├──────────────────────────────────────────────────────────────────┤
│  运行 ●   │ 沙箱 sbx-9f3c  ●可连接   (●交互 Shell  ○快速命令)        [⤢ 全屏]  │
│          │ ┌──────────────────────────────────────────────────────────────┐ │
│ 资源      │ │ root@sbx-9f3c:/workspace# tail -f logs/app.log               │ │
│  镜像     │ │ 10:22:04 ERROR provider timeout, retrying…                   │ │
│  …       │ │ █                                                            │ │
│          │ └──────────────────────────────────────────────────────────────┘ │
│ 系统      │ ● 已连接  80×24   [Ctrl-C] [Ctrl-D] [清屏]           Jupyter ↗    │
│  设置     │                                                                  │
├──────────┤                                                                  │
│ ●正常    │                                                                  │
└──────────┴──────────────────────────────────────────────────────────────────┘
```

**(4) 折叠态与全屏**（响应式；≤1440px 自动折叠侧栏，⤢ 长时排查全屏终端）：

```
折叠态 (≤1440px 自动 / 手动 ☰)              全屏终端 (⤢)
┌────┬───────────────────────────┐          ┌────────────────────────────────────┐
│ ▤  │ [☰] 面包屑 …      ⌘K ◐ ⏻👤 │          │ ← 退出全屏   run-a1b2 · 终端  ●已连接 │
│ ▦概│                           │          │ ┌────────────────────────────────┐ │
│ ◈体│      页面主体 (更宽)       │          │ │                                │ │
│ ▷运│                           │          │ │          整页 PTY               │ │
│ ⚙设│                           │          │ │                                │ │
├────┤                           │          │ └────────────────────────────────┘ │
│ ●  │                           │          │ 80×24  [Ctrl-C][Ctrl-D][清屏][复制] │
└────┴───────────────────────────┘          └────────────────────────────────────┘
  图标-only 侧栏 56px, hover 出标签        终端占满内容区; 面包屑保留可退出
```

变化要点：

- **全局状态**从"顶部状态栏"改为**侧栏底部常驻摘要 + 顶栏一个健康点**，把顶栏让给面包屑与搜索。
- **面包屑**取代当前"无位置感"，反映 `列表 → 详情 → 子视图` 层级。
- **⌘K 命令面板**：跨页跳转、按 ID 直达资源（复用后端 `ResourceService.ResolveID` —— 输入任意 ID 自动判类型并跳转）。
- **主题切换**在顶栏，`data-theme` 驱动（见 §5）。
- 侧栏折叠状态延续现有 `localStorage` 持久化逻辑（`agent-compose.sidebarCollapsed`）。

### 4.3 路由与导航契约（统一）

- 所有跳转走单一 `navigate(path)`（`pushState` + 一处 `popstate` 监听）；**删除所有 `window.location.assign/replace` 跳转**。
- 每页的可停留状态用查询参数表达并可分享（延续现有 `src/url.ts` 思路，但集中到路由层统一读写）。
- 保留旧路径重定向（`/ui`、`/workbench` → `/`）一个过渡期后移除。
- 删除死代码：`WorkbenchPage.svelte`、`builtinAgents`。

---

## 5. 视觉系统（重点 · P1）

### 5.1 Token 分层

现有 `src/styles.css`（~6700 行）已有一套语义化 CSS 变量，但与浅色强绑定。改为**两层 Token**：

```
Primitive tokens (原子, 与主题无关)        Semantic tokens (语义, 随主题变化)
  --blue-500: #2f5fd0                        --color-bg            背景
  --blue-600: #2549a8                        --color-surface       卡片/面板面
  --gray-50 … --gray-900                     --color-border        描边
  --red-500 / --green-500 / --amber-500      --color-text          正文
  --violet-500 / --teal-500                  --color-text-muted    次要文字
  space-1..6 (4px 栅格, 保留)                 --color-primary       主色
  radius / shadow / font-size / line-height  --color-danger/success/warning/info
  （原子层不变）                              --color-focus-ring
                                            （语义层在 :root 与 [data-theme] 下各定义一套）
```

### 5.2 浅 / 暗双主题

```
:root, [data-theme="light"] {          [data-theme="dark"] {
  --color-bg:      #f7f8fa;              --color-bg:      #0e1116;
  --color-surface: #ffffff;             --color-surface: #171b22;
  --color-border:  #e5e7eb;             --color-border:  #262c36;
  --color-text:    #1f2430;             --color-text:    #e6e8ec;
  --color-text-muted: #6b7280;          --color-text-muted: #9aa4b2;
  --color-primary: #2f5fd0;             --color-primary: #5b8bf0;  (暗色下提亮)
  ...                                   ...
}
```

- 移除硬编码 `color-scheme: light`；改为随 `data-theme` 联动 `color-scheme`。
- 主题选择：`localStorage` + `prefers-color-scheme` 兜底；顶栏可手动切换。
- 状态色（运行中/成功/失败/跳过/待关注）在两套主题下都要保证对比度（WCAG AA）。

### 5.3 状态色语义（贯穿运行/沙箱/触发器）

| 语义 | 用途 | 浅色 | 暗色 |
|------|------|------|------|
| running | 运行中 / RUNNING | 蓝 | 提亮蓝 |
| success | SUCCEEDED | 绿 | 提亮绿 |
| danger  | FAILED | 红 | 提亮红 |
| warning | AT_RISK / 校验 WARNING | 琥珀 | 提亮琥珀 |
| neutral | SKIPPED / CANCELED / PENDING | 灰 | 灰 |

### 5.4 排版与密度

- 字体沿用 IBM Plex Sans / IBM Plex Mono + Noto Sans SC 兜底（CJK）。
- 基础字号维持 13px 的"控制台密度"；type scale 保留 xs..xl。
- 密度基调：紧凑行高、克制留白、强对齐；宽屏（≥1920px）增强档沿用。

---

## 6. 组件体系（技术方向：引入组件库）

### 6.1 组件库选型

用户已确认"引入组件库"。三个候选与权衡：

| 方案 | 契合度 | 代价 | 说明 |
|------|--------|------|------|
| **shadcn-svelte**（推荐） | 高 | 引入 Tailwind；Token 需映射 | 基于 Bits UI 的无障碍 headless + 可复制样式；copy-in 非黑盒依赖；暗色/密集工具风契合度最高 |
| Bits UI（纯 headless） | 高 | 需自写全部样式 | 直接复用现有 CSS Token，零 Tailwind；但等于自建设计系统，工作量大 |
| Skeleton | 中 | 引入 Tailwind + 其主题体系 | 现成主题快，但风格偏"套件感"，定制到密集工具风成本高 |

**推荐 shadcn-svelte**，理由：

1. 无障碍与交互（焦点管理、键盘、ARIA）由 Bits UI 兜底，省掉手写 Modal/Tabs/Select 的坑。
2. copy-in 模式 —— 组件源码进仓库，可深度定制，不受上游黑盒限制。
3. 与"分层 Token + 暗色"天然契合（`data-theme` + CSS 变量映射到 Tailwind theme）。

**关键迁移点**（文档需强调）：现有 6700 行 `styles.css` 的语义 Token → 映射为 Tailwind theme 变量，
让新旧组件共享同一套 Token，实现**渐进迁移**（新组件用库，旧页面样式暂留，逐页替换）。
若团队强烈排斥 Tailwind，则退回 **Bits UI + 现有 CSS Token** 方案（§9 备选）。

### 6.2 基础组件清单

```
交互:   Button  IconButton  Input  Textarea  Select  Combobox  Checkbox
        Radio   Switch      Slider  DatePicker
布局:   Card    Panel       Tabs    Accordion   Splitter(左右分栏)  Drawer  Modal
数据:   Table(可排序/虚拟滚动)  DescriptionList(键值详情)  Tree  Timeline
反馈:   Toast   Alert       Badge   StatusDot   Progress   Skeleton   EmptyState
领域:   CodeEditor(见 §8.3)  LogViewer(流式)  TerminalPane(xterm 封装)
        SecretField(密文, 见 §8.4)  KeyValueEditor(env 行编辑)  TriggerList
```

复用现有：`RuntimeCommandTerminal.svelte`（xterm）、`SessionOutputPanel.svelte`（流式输出）、`AntIcon.svelte`（图标）
在重构中收敛为上表的 `TerminalPane` / `LogViewer` / 图标基元。

### 6.3 组件状态规范（统一四态）

当前错误处理是单条顶部 `alert danger`、成功是 3s toast、详情空态是裸文本"未加载/加载中"。统一为：

```
┌─ 空 Empty ────────────┐  ┌─ 加载 Loading ────────┐
│   [icon]              │  │  ▚▚▚ 骨架占位          │
│   还没有智能体          │  │  ▚▚▚▚▚▚               │
│   [+ 新建智能体]        │  │  ▚▚▚                  │
└──────────────────────┘  └──────────────────────┘
┌─ 错误 Error ──────────┐  ┌─ 成功 Success ────────┐
│  ⚠ 加载失败: 详情       │  │  ✓ 已保存 (toast)      │
│  [重试]                │  │                        │
└──────────────────────┘  └──────────────────────┘
```

- 表单错误：**字段级内联**（红边 + 下方说明），而非仅顶部横幅。
- 列表/详情加载：**骨架屏**，而非文字。
- 流式面板断连：显式"连接断开 / 重连中"状态条（复用现有退避重连逻辑，但可视化）。

---

## 7. 逐页重设计

### 7.1 概览 Overview（新增，取代死掉的 WorkbenchPage）

进入即见的着陆页，回答"系统现在怎么样"：

```
┌ 概览 ─────────────────────────────────────────────────────────────┐
│ 健康 ● 正常   CPU 12%   RSS 1.2G   IO …        [刷新]              │
├───────────────────────────────────────────────────────────────────┤
│ ┌ 运行中 3 ─────┐ ┌ 近期 12 ──────┐ ┌ 待关注 2 ──────┐            │
│ │ run-a1b2 …    │ │ run-… 成功     │ │ run-… 失败 ⚠   │  (点击深链  │
│ │ run-c3d4 …    │ │ run-… 成功     │ │ agent-… 风险   │   入 /runs) │
│ └───────────────┘ └───────────────┘ └────────────────┘            │
├───────────────────────────────────────────────────────────────────┤
│ 最近事件时间轴 (流式 WatchDashboardOverview)                        │
│  ▸ 10:22 触发器 cron 触发 → run-a1b2                                │
│  ▸ 10:20 webhook 事件 → automation X                               │
└───────────────────────────────────────────────────────────────────┘
```

数据源：`DashboardService.WatchDashboardOverview`（已有，当前只喂顶部状态栏，这里升格为主视图）。

### 7.2 智能体 Agents

列表 → 详情为独立路由；**编辑从抽屉迁到独立页面**（P3）：

```
列表 /agents                          详情 /agents/:id
┌──────────┬───────────────────┐     ┌──────────────────────────────────────┐
│ 智能体     │ 详情预览           │     │ ← 智能体 / my-coder      [运行] [编辑] │
│ ○ my-coder│ provider: claude  │     ├──────────────────────────────────────┤
│ ● api-bot │ image: node:20    │     │ 概况 | 系统提示 | 环境 | 能力 | 扩展   │
│ ○ nightly │ driver: docker    │     │ ┌ 概况 ──────────────────────────┐   │
│          │ [运行] [编辑]      │     │ │ provider/model/image/driver     │   │
│ [+ 新建]  │                   │     │ │ workspace: git@…#commit         │   │
└──────────┴───────────────────┘     │ │ 最近运行: run-… 成功 3m 前       │   │
                                      │ └────────────────────────────────┘   │
编辑 /agents/:id/edit (独立页, 分步)  └──────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ ← 编辑 my-coder                              [取消] [保存] │
│ ① 基本   ② 运行时   ③ 工作区   ④ 环境与能力   ⑤ 高级(JSON) │
│ ───────────────────────────────────────────────────────── │
│ 显示名 [__________]  调用名 [my-coder] (创建后不可改)      │
│ provider (○claude ○codex ○gemini ○opencode)  model [___] │
│ 字段级即时校验：调用名重复即时标红                          │
└──────────────────────────────────────────────────────────┘
```

- 保留"保存并运行"，但跳转 `/runs/:id` 走 SPA `navigate`（不再整页刷新）。
- "扩展 JSON"作为高级分步保留，但常规字段结构化编辑，JSON 仅作逃生舱（见 §8.3）。

### 7.3 自动化任务 Automations

保留"代码编排 / 表单配置"双模，但重排为独立编辑页 + 真正的编辑器：

```
编辑 /automations/:id/edit
┌──────────────────────────────────────────────────────────────────┐
│ ← 编辑 nightly-sync                    校验 ● 通过    [调试] [保存] │
├──────────────────────────────────────────────────────────────────┤
│ 模式: (●代码编排  ○表单配置)      绑定智能体 [my-coder ▾]          │
├──────────────────────────┬───────────────────────────────────────┤
│ 触发器 (代码模式下自动解析) │  scheduler 脚本 (CodeEditor, JS)      │
│  ▸ cron  0 2 * * *        │  1 scheduler.cron('0 2 * * *', ...)   │
│  ▸ event topic=deploy     │  2 scheduler.on('deploy', ...)        │
│                          │  … 语法高亮 + 行内校验 + 补全           │
│ 并发/会话策略              │                                       │
│  (○串行 ●并行→强制新会话)  │  sandbox_policy: (○sticky ●new)       │
└──────────────────────────┴───────────────────────────────────────┘
调试抽屉（轻量, 保留）：贴 mock JSON payload → 运行 → 跳 /runs/:id 观测
```

- **表单模式**下"表单合成脚本"逻辑保留（`formScript`），但把交互拆成清晰分区，避免一屏塞满。
- **代码模式**用真正的 CodeEditor（§8.3），替换 `textarea+pre` 手动滚动同步。
- 校验状态用组件级状态条（通过/警告/错误），复用后端 `ValidateProject` 的 severity。

### 7.4 运行中心 Runs（重点 · P4）

把 ~4600 行巨页从概念上拆成三层，每层可独立理解/测试：

```
/runs (列表)              /runs/:id (详情)                    /runs/:id/terminal (调试)
┌────────────┐            ┌──────────────────────────────┐   ┌──────────────────────┐
│ 过滤: 状态  │            │ ← run-a1b2  ●运行中  [停止]    │   │ ← 终端 run-a1b2       │
│  智能体 来源 │            ├──────────────────────────────┤   │ ┌──────────────────┐ │
│ ─────────  │            │ 对话 | 时间轴 | 产物 | 沙箱     │   │ │ xterm 交互(Attach)│ │
│ ● run-a1b2 │──选中─────▶│ ┌ 对话 (流式) ──────────────┐ │   │ │ $ ...            │ │
│ ○ run-c3d4 │            │ │ 👤 user: …                │ │   │ └──────────────────┘ │
│ ○ run-…    │            │ │ 🤖 agent: …  (SessionOut) │ │   │ Jupyter ↗            │
│            │            │ │ [输入框 ▸ 发送]           │ │   └──────────────────────┘
│ 实时更新    │            │ └──────────────────────────┘ │
└────────────┘            └──────────────────────────────┘
     ▲ 流式 ListRuns/Watch      ▲ 详情标签页各自订阅对应流
```

拆解要点：

- **消除模式重叠**：现有 `workbenchMode / activeMode / activeTab / activeDetailTab` 收敛为
  **一层"详情标签页"**：`对话 | 时间轴 | 产物 | 沙箱`。"对话/任务/时间轴"不再是并列的顶层模式，而是详情内的视图。
- **每个标签页订阅各自的流**：对话/时间轴 ← `ListRunEvents`/`RunAgentStream`；沙箱 ← `WatchSandbox`（cells/events）；
  日志 ← `FollowRunLogs`。组件是"订阅式"的，挂载即订阅、卸载即断开。
- **调试终端**（`/runs/:id/terminal`）把现有 `DebugRunPage` + `RuntimeCommandTerminal` 归入运行详情的子路由，进入正式导航。
- **事件溯源** `/events/:id` 作为"从事件反查其触发的运行/会话"的详情视图，归入运行组，套用统一外壳（不再整页无侧栏）。

#### 7.4.1 日志与调试终端（专项 · 排查体验）

> 这是当前最痛的一环。现状：`DebugRunPage.svelte` + `RuntimeCommandTerminal.svelte` 提供的是"单命令执行器"
> （`disableStdin:true`，一次一条命令走 `ExecStream`），且只在会话"运行中"可用、只从深链接 `/debug/runs/:id` 进入、
> 基本只服务自动化运行；流式日志 `FollowRunLogs` 没有专门查看器。后端其实已具备 `ExecAttach`（双向 PTY）、
> `RunAttach`（交互接入运行）、`FollowRunLogs`（流式日志）等能力，UI 未充分使用。

新设计把"日志 + 终端"升级为运行详情里的一等排查工作台：

```
/runs/:id  →  标签页: 对话 | 时间轴 | 日志 | 终端 | 产物 | 沙箱
                                      ▲此二者即排查主场

┌ 日志 (Logs) ───────────────────────────┐  ┌ 终端 (Terminal) ─────────────────────┐
│ [跟随 ▣] [级别 ▾] [搜索____] [下载]      │  │ 模式: (●交互 Shell  ○快速命令)         │
│ 10:22:01 INFO  starting agent…          │  │ ┌──────────────────────────────────┐ │
│ 10:22:03 WARN  retrying provider…       │  │ │ $ ps aux | grep node             │ │
│ 10:22:04 ERROR exit code 1  ◀── 定位     │  │ │ (真正的交互 PTY: stdin/resize/    │ │
│ …流式 FollowRunLogs, 自动滚动+可暂停      │  │ │  信号; 可跑 top/vim/REPL)         │ │
└─────────────────────────────────────────┘  │ └──────────────────────────────────┘ │
                                              │ Jupyter ↗   工作目录 [__]  超时 [__]  │
                                              └──────────────────────────────────────┘
```

关键改进（逐条对应现状短板）：

1. **交互式 PTY 终端**（`ExecAttach`）—— **本轮排查体验的核心，优先落地（见 §10 提前为 P1）**：真正的 shell，
   支持 stdin、窗口 resize、Ctrl-C 等信号、长驻交互进程（`top`/`vim`/REPL 皆可）。
   现有"单命令执行器"（`ExecStream` 一次性执行）降级为一个**"快速命令"轻量模式**，与交互终端二选一切换；交互 PTY 为默认。
2. **日志查看器**（`FollowRunLogs` 流式）成为独立标签页：跟随/暂停、级别过滤、搜索、下载；错误行高亮，一键定位。
   与"时间轴（`ListRunEvents`：USER/AGENT/ACTIVITY/STATUS）"互补——时间轴看语义事件，日志看原始输出。
3. **失败 / 已停止运行也能排查（post-mortem）**：不再"仅运行中可用"。进入运行详情时按沙箱状态分流：
   - 沙箱仍在（`Sandbox` 未回收）→ 直接连 PTY 终端。
   - 沙箱已回收（`workspace_reclamation_state` 已清理）→ 展示只读日志/事件/产物，并提供
     **"以相同镜像+工作区重启一个调试沙箱"** 一键动作，重建现场后再连终端。
   - 明确显示沙箱是"可连接 / 已停止 / 已回收"，替代当前静默禁用 + 3s 轮询。
4. **升为正式导航**：调试终端从深链接 `/debug/runs/:id` 迁为运行详情子路由 `/runs/:id/terminal`，进入面包屑与统一外壳；
   **对所有运行开放**（不再局限自动化运行）。
5. **可发现的快捷入口**：运行列表行、概览"待关注"卡片、失败运行详情头部都放"打开终端 / 看日志"直达按钮；⌘K 也可按 runId 直达。
6. **Jupyter 入口保留**（复用现有 `getWorkSessionProxy`/notebook URL 逻辑），作为终端旁的补充调试方式。

**详细线框**

(a) 交互 Shell 模式（默认）—— 运行详情下的 `/runs/:id/terminal`：

```
┌ TopBar   运行 / run-a1b2 / 终端                          ◐  ⏻正常  [👤] ┐
├─────────────────────────────────────────────────────────────────────────┤
│ ← run-a1b2   ●运行中   claude · node:20 · docker            [停止运行]    │  运行头
├─────────────────────────────────────────────────────────────────────────┤
│ 对话 | 时间轴 | 日志 |〔终端〕| 产物 | 沙箱                                 │  标签页
├─────────────────────────────────────────────────────────────────────────┤
│ 沙箱 sbx-9f3c  ● 可连接      模式:(●交互 Shell  ○快速命令)      [⤢ 全屏]   │  工具条
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ root@sbx-9f3c:/workspace# ps aux | grep node                        │ │
│ │ root   41  0.4  1.2   node server.js                                │ │
│ │ root@sbx-9f3c:/workspace# tail -f logs/app.log                      │ │  真 PTY
│ │ 2026-07-18 10:22:04 ERROR provider timeout, retrying…               │ │  stdin /
│ │ ^C                                                                  │ │  resize /
│ │ root@sbx-9f3c:/workspace# vim src/index.ts                          │ │  信号
│ │ -- INSERT --                                                █       │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ● 已连接  80×24    [Ctrl-C] [Ctrl-D] [清屏] [复制]       Jupyter ↗        │  状态条
└─────────────────────────────────────────────────────────────────────────┘
```

(b) 快速命令模式（同一"终端"标签内切换，一次性执行，适合贴一条命令看结果）：

```
│ 沙箱 sbx-9f3c  ● 可连接      模式:(○交互 Shell  ●快速命令)                 │
│ 命令 [npm test ________________________]  目录 [/workspace]  超时[120] [执行]│
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ $ npm test                                                          │ │  只读输出
│ │ FAIL  src/index.test.ts  ✕ handles retry                            │ │  (ExecStream)
│ │ [exit 1] failed                                                     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ 历史:  [npm test ✗1]  [ls -la ✓0]  [pwd ✓0]  [env|sort ✓0]              │  可点重跑
```

(c) 沙箱状态分流（进入终端标签时按 `Sandbox` 状态决定可做什么）：

```
进入 /runs/:id/terminal → 读取该运行的 Sandbox 状态
        │
   ┌────┴───────────────────────┬───────────────────────────┐
 ● 可连接                     ● 已停止                     ● 已回收
 (Sandbox 存在, 未回收)       (sandbox stopped)            (workspace_reclamation 已清理)
   │                            │                            │
 直接连 PTY,                  [恢复沙箱] ResumeSandbox       只读: 日志 / 事件 / 产物
 交互 Shell 就绪               → 就绪后连 PTY                + [重建调试沙箱] (见 d)
```

(d) post-mortem —— 沙箱已回收时的排查横幅与"重建现场"确认：

```
┌ 该运行的沙箱已回收 ───────────────────────────────────────────────────┐
│ ⚠ 工作区已清理，无法直接进入 shell。可查看只读日志/事件/产物，          │
│    或以相同镜像+工作区重建一个临时调试沙箱还原现场。                     │
│                                   [查看日志]   [重建调试沙箱 ▸]         │
└───────────────────────────────────────────────────────────────────────┘
             重建调试沙箱 ▸
             ┌ 确认重建 ───────────────────────────────────┐
             │ 镜像    node:20            (同原运行)         │
             │ 工作区  git@repo#a1b2c3    (按 commit 还原)   │
             │ 驱动    docker                               │
             │ 策略    new · 临时调试沙箱 (用完可一键移除)    │
             │                        [取消]  [重建并连接]   │
             └─────────────────────────────────────────────┘
```

(e) 日志查看器（相邻"日志"标签，与终端互为排查双拼；流式 `FollowRunLogs`）：

```
│ 对话 | 时间轴 |〔日志〕| 终端 | 产物 | 沙箱                                 │
│ [▣ 跟随] [级别: 全部▾] [🔍 搜索 error____] [⇩ 下载] [⏸ 暂停]     行 1240/1240│
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ 10:22:01  INFO   starting agent claude on node:20                    │ │
│ │ 10:22:03  WARN   provider slow, retry 1/3                            │ │
│ │ 10:22:04  ERROR  provider timeout · exit 1        ◀── 高亮 + 可点定位 │ │
│ │ 10:22:04  INFO   sandbox sbx-9f3c stopping                           │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│  ↕ 自动滚动到底；暂停后停滚不丢流；断连显示"重连中…"                       │
```

组件层面：复用并升级 `RuntimeCommandTerminal.svelte` → `TerminalPane`（接 `ExecAttach` 交互流为默认 + `ExecStream` 快速模式），
新增 `LogViewer`（接 `FollowRunLogs` 流式）。两者都是"订阅式组件"（挂载订阅、卸载 `AbortController` 断开、断连有可视化重连），
沿用 §3 原则 2、§6.3 四态规范。全屏（⤢）把终端提升为整页，便于长时排查。

### 7.5 设置 Settings

去掉"顶部指标行 + 左侧子导航"的重复，用单一分区导航：

```
/settings
┌ 设置 ────────────────────────────────────────────────┐
│ 全局环境 | 能力网关 | Webhook | Workspace 预设 | 鉴权   │  ← 单一 Tabs
├──────────────────────────────────────────────────────┤
│ (对应分区内容)                                          │
│  · 全局环境: KeyValueEditor + SecretField (§8.4)       │
│  · 能力网关: 地址/令牌 + 实时探测 + capset 方法表        │
│  · Webhook: id/name/provider/topic + 签名密钥          │
│  · Workspace 预设: git/file 切换 + 表单↔JSON + .tar 上传│
└──────────────────────────────────────────────────────┘
```

镜像为只读信息，移入"资源 / 镜像"页（§4.1）而非塞在设置里。

---

## 8. 关键交互模式（重点 · P3）

### 8.1 编辑模型：抽屉 → 独立页面

| 场景 | 现在 | 改为 |
|------|------|------|
| 智能体 创建/编辑 | 全高侧抽屉 + 多分区一屏滚动 | 独立页面 `/agents/:id/edit`，分步 |
| 自动化任务 创建/编辑 | 深抽屉内嵌代码编辑器+多控件 | 独立页面 `/automations/:id/edit`，左右分栏 |
| 运行 / 调试 | 抽屉 | 详情子路由 `/runs/:id`、`/runs/:id/terminal` |
| 轻量确认 / 调试 payload / 快速动作 | 抽屉 | **仍用 Modal/轻抽屉**（合理保留） |

原则：**有独立价值、可分享 URL、内容复杂**的编辑 → 独立页面；**短暂、聚焦、单一动作** → Modal/轻抽屉。

### 8.2 渐进式校验

```
现在:  填完整屏 → 提交 → 顶部一条 "请求失败：xxx" 横幅 → 猜哪错了
改为:  ┌ 调用名 ─────────────┐
       │ my-coder            │  ✗ 该名称已被占用     ← 失焦即校验, 字段级
       └─────────────────────┘
       表单级仅在提交/跨字段约束时给汇总；后端 severity(WARNING/ERROR) 内联呈现。
```

跨字段约束（如"并行 → 强制新会话"）用即时联动 + 说明文案，而非提交后报错。

### 8.3 真正的代码编辑器

- 用 CodeMirror 6（或 shadcn-svelte 生态内的等价封装）替换 `textarea + pre + syncCodeScroll`。
- 能力：JS/JSON 语法高亮、行号、括号匹配、基础校验下划线；只读 diff 视图（用于 spec 版本对比，可选）。
- **结构化优先 + JSON 逃生舱**：常规配置走表单；"扩展 JSON / 原始配置"作为高级切换，双向同步（复用现有
  `hydrate/buildWorkspaceConfigJson` 的往返解析思路）。

### 8.4 密文处理统一模式

当前"留空保持 / 清空令牌"复选散落在 Webhook、网关、env secret 多处，易误读。统一为 `SecretField`：

```
┌ 令牌 ────────────────────────────────────┐
│ ●●●●●●●● (已设置)         [显示] [替换] [清除] │
└──────────────────────────────────────────┘
未设置时: 直接输入框; 已设置时: 掩码 + 明确的 替换/清除 两个动作 (不再靠复选歧义)
```

### 8.5 命令面板 ⌘K 与键盘可达性

- ⌘K：跳转任意页面、按 ID 直达资源（`ResourceService.ResolveID`）、触发常用动作（新建智能体、运行、切主题）。
- 列表可键盘上下选择、回车进入；表单 Tab 顺序合理；Modal 焦点陷阱（由 Bits UI 提供）。

---

## 9. 实现建议 / 迁移路径

**不改后端契约**：继续消费 `src/gen/` 生成的 ConnectRPC 客户端（`src/api/client.ts` 的各 `*Client`）。
复用现有 `src/model/*`（`runs.ts`/`agents.ts`/`sandbox-policy.ts` 等领域类型与格式化）作为组件的数据模型层。

落地顺序（每步可独立合并）：

1. **Token 与主题**：`styles.css` 拆分为 primitive/semantic 两层；加 `[data-theme="dark"]`；主题切换与持久化。
2. **组件层**：接入 shadcn-svelte（引 Tailwind，把语义 Token 映射为 theme 变量）；沉淀 §6.2 基础组件。
3. **路由与外壳**：引入轻量客户端路由；重建 App Shell（侧栏三组 + 顶栏面包屑 + ⌘K）；统一 `navigate`，删 `window.location` 跳转与死代码。
4. **逐页迁移**：概览 → 智能体 → 自动化任务 → 设置（编辑从抽屉迁到独立页 + 渐进校验）。
5. **运行中心拆分**：把 `RunsPage` 拆为 列表 / 详情(标签页) / 终端 组件；标签页各自订阅流；归入 `/events/:id` 与调试子路由。
6. **打磨**：CodeEditor、SecretField、命令面板、四态规范全站铺开。

**数据获取约定**：区分"订阅式组件"（挂载订阅 `Watch*/Stream/Follow`，卸载 `AbortController` 断开，带可视化重连）
与"一次性拉取组件"（`Get*/List*`）。把现有散落在 `App.svelte` 的重连/退避逻辑收敛成一个可复用的 `subscribe()` 帮助函数。

**备选（若排斥 Tailwind）**：改用 Bits UI（纯 headless）+ 保留现有 CSS Token 手写样式——省一个依赖，但组件样式全部自建，工作量更大、风格一致性更依赖纪律。

---

## 10. 分期路线图

| 阶段 | 内容 | 风险 | 可独立交付 |
|------|------|------|-----------|
| **P0 基础** | Token 分层 + 暗色 + 组件层接入 + 路由/外壳 + ⌘K | 中（引 Tailwind、Token 映射） | 是（新外壳可先与旧页共存） |
| **P1 排查工作台（提前）** | **交互式 PTY 终端（`ExecAttach`）+ 日志查看器（`FollowRunLogs`）**，作为运行详情子路由 `/runs/:id/terminal`；post-mortem 分流 + 全运行开放 + 快捷入口 | 中（`ExecAttach` 双向流/PTY 尺寸/信号） | 是（可挂在最小运行详情壳上，独立上线，不必等 RunsPage 全拆完） |
| **P1 各页迁移** | 概览 / 智能体 / 自动化任务 / 设置，编辑抽屉→独立页 + 渐进校验 | 中（表单逻辑多） | 是（逐页替换） |
| **P2 运行中心** | RunsPage 拆分 + 实时流订阅（对话/时间轴/沙箱）+ 事件溯源归位 | 高（4600 行、多模式收敛） | 部分（先列表+详情） |
| **P3 打磨** | CodeEditor / SecretField / 命令面板 / 四态全站化 | 低 | 是 |

**排查工作台提前的理由**：用户明确交互式 PTY 终端是最高优先。它对 RunsPage 大拆分依赖很弱——只需一个"运行详情最小外壳 + 子路由"即可承载，
因此从 P2 提到 P1 独立交付，让"能进真 shell 排查失败运行"尽早可用，不被 4600 行 RunsPage 的拆分节奏卡住。

新旧共存策略：P0 建好外壳与组件层后，未迁移的旧页面暂时挂在新外壳内（共享 Token），逐页替换，避免大爆炸式重写。

---

## 11. 附录

### 11.1 i18n 就绪（前瞻，非阻塞）

用户未勾选"只保留中文"。当前字符串硬编码中文、无 i18n 层。建议：**保持中文为主**，但在迁移各页时
把可见文案集中到一处消息映射（轻量 key→中文），为将来接入 i18n 抽取留出接口——不在本轮强制引入 i18n 框架。

### 11.2 术语对照

| 中文 | 英文 / proto |
|------|-------------|
| 项目 | Project / ProjectSpec |
| 智能体 | Agent / AgentSpec |
| 调度器 | Scheduler / SchedulerSpec |
| 触发器 | Trigger（cron/interval/timeout/event） |
| 运行 | Run（source: MANUAL/SCHEDULER/API） |
| 沙箱 | Sandbox（sticky/new；cells/events） |
| 能力集 | CapabilitySet / capset_ids |
| 工作区 | Workspace（local/git + commit pin） |

### 11.3 开放问题

1. 资源组（镜像/卷/MCP/Skills/能力集）本轮是否一次全暴露，还是随各自后端成熟度分期？
2. shadcn-svelte 引入 Tailwind 是否可接受？若否，走 §9 备选（Bits UI）。
3. 概览页的"待关注"判定规则（失败运行 + AT_RISK 智能体）是否符合运维预期？
4. 是否需要 spec 版本 diff 视图（ProjectRevision）作为一个可见功能？

---

## 12. UI 侧可承载的功能（不动 compose 引擎）

### 12.1 现状：UI 项目的 Go 后端是什么

本仓库自带一个 Go BFF（`cmd/agent-compose-ui-server` + `internal/`），当前只做两件事：

```
浏览器 ──HTTP──▶ ┌─────────────── agent-compose-ui BFF (Echo) ───────────────┐ ──▶ 守护进程
                │ /api/auth/* · /oauth/*   单用户鉴权 (密码 或 OAuth)         │     (compose 引擎)
                │ HMAC 签名 Cookie 会话                                       │     127.0.0.1:7410
                │ /*  ─ Protect() 鉴权后 ─ 单主机反向代理 → 守护进程           │
                └───────────────────────────────────────────────────────────┘
                无数据库 · 无持久化 · 单一身份 · Config 基本硬编码
```

关键事实（决定"什么该放这儿"）：

- **BFF 在通往引擎的每一条请求路径上**（`app.Any("/*", Protect(proxy))`）—— 是做横切关注点（鉴权/审计/通知/缓存）的天然位置。
- **引擎不拥有"用户"概念**：鉴权只在 BFF，且是单一身份（`AUTH_USERNAME`/`AUTH_PASSWORD` 或一个 OAuth 用户）。
- **BFF 无任何持久化**：要做有状态功能，需在 UI 项目引入一个轻量存储（建议 SQLite，单节点即可；随镜像挂卷）。
- **守护进程是领域事实的唯一真源**：UI 侧新增数据必须只属于"UI 域"（用户/审计/偏好/元数据），绝不复制或篡改引擎的权威状态。

### 12.2 可加功能 · 三类

**A 类｜纯前端即可（零后端改动，只是更好地消费既有 RPC）**

| 功能 | 依赖的既有能力 |
|------|---------------|
| ⌘K 命令面板、快捷键 | `ResourceService.ResolveID` |
| 保存的视图/过滤器、收藏、最近访问 | localStorage |
| Spec 版本 diff（ProjectRevision） | `GetProject` 已返回 revisions |
| compose YAML 预览/导出、run 详情导出为 Markdown | 既有 `Get*` |
| 客户端预校验（JSON 结构/镜像名即时反馈） | 正式校验仍走 `ValidateProject` |
| 主题/布局偏好 | localStorage / `data-theme` |

**B 类｜加在 BFF（需引入轻量存储，但不动引擎）—— 收益最大，填补引擎有意不做的空白**

| 功能 | 为什么适合放 BFF |
|------|-----------------|
| **多用户 + RBAC / 团队** | 引擎只认单一身份；BFF 在代理层做"谁能看/操作哪些项目/动作"的授权 |
| **审计日志 / 操作历史** | BFF 已在写请求路径上，天然可记录"谁、何时、对什么资源做了什么" |
| **用户级元数据**（收藏、标签、备注、仪表盘布局、跨设备偏好） | 引擎不拥有这些"UI 域"数据 |
| **通知 / 告警** | BFF 后台订阅 run 流（`WatchDashboardOverview`/`FollowRunLogs`），失败时发邮件/Webhook/飞书 |
| **定时摘要报告** | BFF 定时任务生成每日运行摘要（引擎无此展示层职责） |
| **模板 / 片段库** | 存可复用的 agent/compose 模板，套用时调 `ApplyProject`；引擎只有 WorkspacePreset，无通用模板 |
| **运行注释 / 协作** | 给 run 挂讨论/备注，纯 UI 域 |
| **UI 作用域 API Token** | 为外部自动化签发 UI 侧令牌，映射到 RBAC |

> B 类的共同前提：在 UI 项目引入持久化。**决策已定：允许引入存储，采用 SQLite（单节点，随镜像挂数据卷）。**
> 因此 A + B 两类均可落地。配套需补齐 `internal/config`（目前 `LoadFromEnv()` 几乎硬编码，需支持数据目录、迁移等真正的配置加载），
> 并新增一个 `internal/store`（SQLite + 迁移）与相应的领域包（如 `internal/audit`、`internal/users`）。

**C 类｜可从引擎"下移"到 UI（谨慎，仅限展示/聚合/便利层）**

引擎是运行时权威，能安全下移的很有限：

| 可下移 | 说明 |
|--------|------|
| Dashboard 计数聚合 | `GetDashboardOverview` 的聚合可改由 BFF 从 `List*` 计算，减轻引擎（收益有限，引擎已实现） |
| Spec / YAML 渲染与 diff | 纯展示，本就该在 UI |
| ID 解析便利 | 可客户端化（但引擎版更省，建议保留） |

**不建议下移**（都贴着运行时/沙箱，属于引擎）：Jupyter 代理、Webhook 接收（触发运行）、`ValidateProject`、Runtime LLM Facade 令牌代理。

### 12.3 建议

- **最干净的高价值项是 B 类**——审计日志、用户/RBAC、失败通知——因为它们利用了 BFF 在请求路径上的位置，且填补引擎有意不做的空白，全程不碰引擎。
- **不要追求把运行时逻辑从引擎搬出**（C 类可下移面很窄）；守好"引擎＝真源、UI＝呈现+UI 域数据"的边界。
- **存储已确认（SQLite）**。建议先落地一个"存储基座"（`internal/store` + 迁移 + 配置数据目录），再按下面优先级挂 B 类功能。
- **B 类建议优先级**：
  1. **审计日志**（成本低、痛点普适；BFF 已在写路径上，拦截 `ApplyProject/RunAgent/Stop*/Remove*` 等写操作记流水）。
  2. **失败通知**（BFF 后台订阅 run 流，失败发邮件/Webhook/飞书）。
  3. **用户 / RBAC**（最重但价值最高；单身份 → 多用户 + 角色，代理层做授权，与审计天然联动）。
- 这些属于本重设计之外的**独立工作流**（各自 spec → plan）；本节是工程可行性分析与落地清单。

**BFF 引入存储后的目标结构（示意）：**

```
agent-compose-ui (BFF)
  cmd/agent-compose-ui-server/main.go
  internal/
    app/        Echo 装配、路由、DI
    auth/       (已存在) 会话/OAuth  ── 演进为多用户 + RBAC
    proxy/      (已存在) 反向代理     ── 挂 审计中间件 + 授权中间件
    config/     (已存在, 需补) 数据目录/迁移/SMTP 等配置
    store/      (新增) SQLite 连接 + schema 迁移
    audit/      (新增) 写操作流水记录与查询
    users/      (新增) 用户/角色/令牌
    notify/     (新增) run 流订阅 + 邮件/Webhook 发送
  data/         (新增, 挂卷) sqlite 数据文件
```

### 12.4 存储技术选型（轻量，不用重 ORM）

原则：单节点 SQLite、迁移随二进制走、启动即迁移、不引入 ORM。推荐组合：

| 层 | 选型 | 理由 |
|----|------|------|
| 驱动 | **`modernc.org/sqlite`**（纯 Go，无 cgo） | 交叉编译 / Docker 多阶段构建简单，无需 C 工具链；BFF 量级下性能无感 |
| 迁移 | **`pressly/goose`**（`embed.FS` 内嵌） | 库模式一等公民，启动时 `goose.Up` 与 DI 契合；`.sql` 为主、必要时 Go 迁移；轻、维护活跃 |
| 查询 | **`sqlc`**（写 SQL 生成类型安全代码） | 非 ORM、零运行时反射；想更少 codegen 可换 `jmoiron/sqlx`（薄封装） |

不用：GORM / ent（codegen 重、带自动迁移魔法），正是要避开的。
何时改用 `golang-migrate`：需要独立迁移 CLI 融进 CI/运维，或将来要统一多数据库的迁移工具。

**最小骨架**（`internal/store`，启动即迁移，挂进 `samber/do` DI）：

```go
// internal/store/migrations/0001_init.sql
//   -- +goose Up
//   CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT, action TEXT,
//     resource TEXT, at DATETIME DEFAULT CURRENT_TIMESTAMP);
//   -- +goose Down
//   DROP TABLE audit_log;

package store

import (
    "database/sql"
    "embed"
    _ "modernc.org/sqlite"
    "github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func Open(dataDir string) (*sql.DB, error) {
    db, err := sql.Open("sqlite",
        dataDir+"/agent-compose-ui.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
    if err != nil {
        return nil, err
    }
    goose.SetBaseFS(migrationsFS)
    if err := goose.SetDialect("sqlite3"); err != nil { // 注意: dialect 名 != 驱动名
        return nil, err
    }
    if err := goose.Up(db, "migrations"); err != nil {  // 启动时自动迁移
        return nil, err
    }
    return db, nil
}
```

在 `internal/app/server.go` 里 `do.Provide(di, NewStore)`（返回 `*sql.DB`），与 `NewAuthManager`/`NewBackendProxy` 同样挂进 DI。

**注意点**：
1. `modernc.org/sqlite` 驱动注册名是 `"sqlite"`，但 goose 的 dialect 要设 `"sqlite3"`——两者不一致，别混。
2. goose 会自建 `goose_db_version` 版本表（正常）。
3. SQLite 单写：务必开 WAL + `busy_timeout`（上面 DSN 已带）。
4. 迁移文件用递增序号前缀（`0001_`、`0002_`…），goose 按序执行。

---

## 变更影响的关键文件（供实现参考）

- `src/styles.css` —— Token 源，拆分为 primitive/semantic + 暗色。
- `src/App.svelte` —— 外壳与路由重建重点；收敛全局订阅逻辑。
- `src/pages/RunsPage.svelte` —— 拆分为运行列表/详情/终端组件（最大工作量）。
- `src/pages/AgentsPage.svelte`、`AutomationTasksPage.svelte`、`SettingsPage.svelte` —— 编辑抽屉迁独立页 + 渐进校验。
- `src/pages/EventDetailPage.svelte`、`DebugRunPage.svelte` —— 归入运行组统一外壳。
- `src/api/client.ts`、`src/model/*` —— 复用，不改契约。
- 删除：`src/pages/WorkbenchPage.svelte`、`model/agents.ts` 的 `builtinAgents`。
```
