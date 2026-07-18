# Agent Compose Web

Agent Compose Web 是 Agent Compose 的浏览器管理界面，用于编辑和启用智能体应用、观察运行状态，并管理运行时与系统资源。前端直接使用 Agent Compose V2 Connect RPC，与本地脚本服务配合保存 YAML 中引用的脚本文件。

## 主要功能

- 使用 Monaco Editor 编辑、校验和启用 Agent Compose YAML。
- 在浏览器中保存、切换和删除多个未启用草稿。
- 预览项目变更，并在启用前执行镜像与依赖检查。
- 查看智能体、Scheduler、Run、Sandbox 及其事件和日志。
- 手动运行智能体，跟踪批量运行和最近一次运行结果。
- 暂停项目运行活动，停止运行，并软删除智能体应用。
- 管理镜像、环境变量、数据卷、缓存和能力服务配置。
- 管理 YAML 中的内联脚本与 `$ref` 脚本文件。

## 技术栈

| 类别 | 技术 |
| --- | --- |
| UI | Svelte 5、TypeScript |
| 构建工具 | Vite 7、Bun |
| 编辑器 | Monaco Editor |
| 终端 | xterm.js |
| API | Connect RPC、Protobuf、`@bufbuild/protobuf` |
| YAML | js-yaml |
| 组件测试 | Vitest、Testing Library、happy-dom |

## 快速开始

### 前置条件

- **Bun** ≥ 1.3：本地开发使用 Bun 作为运行时与包管理器（`dev` 脚本依赖 `bun run`）。安装见 <https://bun.sh>。
- **可访问的 Agent Compose daemon**，默认地址 `http://127.0.0.1:7410`。前端所有 RPC 都会代理到该地址，daemon 未启动时页面可打开但数据为空。
- 脚本服务默认监听 `http://127.0.0.1:7420`，由 `bun run dev` 一并拉起，无需单独配置。
- 镜像、Sandbox 和 LLM 相关功能依赖 daemon 侧对应运行时与模型配置。

> 仅做生产构建或用 Docker 启动时，可用 `npm` 替代 Bun（见下文对应章节）。

### 方式一：本地开发（推荐）

```bash
# 1. 安装依赖
bun install

# 2. 启动前端 + 脚本服务（一条命令同时拉起两者）
bun run dev
```

启动后打开 <http://localhost:5174>。

`bun run dev` 会运行 `scripts/dev.mjs`，它自动生成一个随机 `SCRIPT_SERVICE_TOKEN` 并共享给前端代理与脚本服务，因此本地开发**无需**手动配置任何环境变量。两个子进程任一退出时，另一个会被一并终止。

如需分别启动（例如只调试前端）：

```bash
bun run dev:web      # 仅前端，Vite 开发服务器，监听 0.0.0.0:5174
bun run dev:scripts  # 仅脚本服务，监听 127.0.0.1:7420
```

### 方式二：Docker 启动

`docker/` 目录提供两个 compose 文件，均可通过 `docker compose up --build` 一键构建并运行，详见 [`docker/README.md`](docker/README.md)：

| 文件 | 包含服务 | 适用场景 |
| --- | --- | --- |
| `docker-compose.yml` | web + script-service | 纯前端，连接**外部**已运行的 agent-compose |
| `docker-compose.full.yml` | web + script-service + agent-compose 后端 | 前后端一体，单栈拉起 |

```bash
cd docker
cp .env.example .env          # 必须设置 SCRIPT_SERVICE_TOKEN（示例留空，未设置则启动失败）：openssl rand -hex 32

# 纯前端（连接宿主或其他已运行的 agent-compose）
docker compose up --build
# 或前后端一体（在栈内拉起 agent-compose 后端）
docker compose -f docker-compose.full.yml up --build
```

启动后打开 <http://localhost:8080>（端口可在 `.env` 的 `WEB_PORT` 调整）。Docker 构建使用 `node:22-alpine` + `npm install`（不用 Bun，原因见 docker/README.md）。

### 方式三：生产构建

```bash
bun install        # 或 npm install
bun run build      # 或 npm run build，产物输出到 dist/
```

`dist/` 为纯静态文件，可由任意静态服务器托管。注意：生产部署需像开发期一样把以下路径**反向代理**到 agent-compose daemon 与脚本服务，否则 API 不可达：

- `/agentcompose.v1.*`、`/agentcompose.v2.*`、`/health.v1.*`、`/api/*` → agent-compose daemon `127.0.0.1:7410`
- `/script-api/*` → 脚本服务 `127.0.0.1:7420`（需注入共享的 `x-script-service-token` 请求头）

参考实现见 `docker/nginx/default.conf.template`（nginx envsubst 模板）。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 本地开发：同时启动前端与脚本服务 |
| `bun run dev:web` | 仅启动前端开发服务器 |
| `bun run dev:scripts` | 仅启动脚本服务 |
| `bun run build` | 生产构建，产物在 `dist/` |
| `bun run check` | `svelte-check` 类型检查 |
| `bun run gen` | 用 Buf 重新生成 Protobuf 客户端到 `src/gen` |
| `bun run test` | 运行 `.test.js` / `.test.mjs` 单元测试 |
| `bun run test:component` | 运行 Vitest 组件测试 |
| `bun run test:all` | check + 单元测试 + e2e 助手测试 + 组件测试 |
| `bun run test:e2e:real` | 端到端真实数据测试（需运行中的 daemon + 前端 + Playwright） |

## 环境与代理配置

Vite 开发服务器默认使用端口 `5174`，并将浏览器请求代理到后端服务：

| 请求路径 | 目标服务 |
| --- | --- |
| `/agentcompose.v1.*` | Agent Compose daemon `127.0.0.1:7410` |
| `/agentcompose.v2.*` | Agent Compose daemon `127.0.0.1:7410` |
| `/health.v1.*` | Agent Compose daemon `127.0.0.1:7410` |
| `/api/*` | Agent Compose daemon `127.0.0.1:7410` |
| `/script-api/*` | 脚本服务 `127.0.0.1:7420` |

`SCRIPT_SERVICE_TOKEN` 用于前端代理与脚本服务之间的内部认证。配置后，Vite 会把它作为 `x-script-service-token` 请求头转发给脚本服务。前端代理与脚本服务必须共享同一个令牌；本地 `bun run dev` 会自动生成并共享，Docker 模式由 `.env` 统一注入。`docker/.env.example` 不再内置任何 token（留空），脚本服务启动时会拒绝空值、过短或已知占位符令牌，需用 `openssl rand -hex 32` 自行生成。

与 Agent、模型、镜像、环境变量和能力服务有关的配置由 Agent Compose daemon 管理，不在前端仓库中保存密钥。前端假定 daemon 控制面认证**关闭**（`AGENT_COMPOSE_AUTH_TOKEN` 为空）；若你在后端启用了该 token，需让反代额外注入 `Authorization: Bearer`（当前模板与 dev 行为一致，未注入）。

## 目录结构

```text
agent-compose-web/
├── README.md                 # 项目主文档
├── docker/                   # Docker 构建与编排（纯前端 / 前后端一体），见 docker/README.md
├── script-service/           # 本地脚本文件与 manifest 服务
├── scripts/                  # 开发编排脚本（dev.mjs 等）
├── src/
│   ├── components/           # 通用 UI、Toolbar、Sidebar 和脚本组件
│   ├── gen/                  # Protobuf 生成的 TypeScript 客户端
│   ├── lib/                  # Store、RPC、YAML 和领域逻辑
│   ├── modals/               # 操作弹框
│   ├── pages/                # 系统管理页面
│   └── views/runtime/        # Agent、Run、Scheduler、Sandbox 运行视图
├── test/                     # 跨组件与页面测试
├── e2e/                      # 端到端测试与真实数据夹具
├── proto/                    # Protobuf 协议定义（供 buf 生成客户端）
├── package.json
└── vite.config.ts
```

`src/gen` 属于生成代码目录，不应直接手工修改。

## Protobuf 客户端生成

前端协议客户端由 Buf 根据 Agent Compose Protobuf 定义生成，配置入口位于 `buf.gen.yaml`。需要在协议定义更新后重新生成客户端时，在仓库根目录执行：

```bash
bun run gen
```

生成结果写入 `src/gen`。应提交协议源或生成配置对应的变更，并保持生成文件与后端协议版本一致。

## 测试

- **单元 / 组件测试**：`bun run test`（`.test.js`/`.test.mjs`）与 `bun run test:component`（Vitest + Testing Library），无需外部服务，可接入 CI。
- **端到端测试**（`e2e/`）：针对**真实** agent-compose daemon 与前端运行，需先启动 daemon（`7410`）与前端（`5174`），并安装 Playwright 浏览器（`npx playwright install`）。通过 `bun run test:e2e:real` 触发，报告写入 `e2e/reports/`。属于可选的开发者测试，不在默认 `bun run test` 流程中。
