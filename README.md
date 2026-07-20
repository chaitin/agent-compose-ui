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
- **Go**：本地认证网关由 `go run` 启动。
- **可访问的 Agent Compose daemon**，默认地址 `http://127.0.0.1:7410`。浏览器请求先经过监听 `127.0.0.1:8080` 的 UI 网关，再由网关代理到 daemon。
- 脚本服务默认监听 `http://127.0.0.1:7420`，由 `bun run dev` 一并拉起，无需单独配置。
- 镜像、Sandbox 和 LLM 相关功能依赖 daemon 侧对应运行时与模型配置。

> 仅做生产构建或用 Docker 启动时，可用 `npm` 替代 Bun（见下文对应章节）。

### 方式一：本地开发（推荐）

```bash
# 1. 安装依赖
bun install

# 2. 启动认证网关 + 前端 + 脚本服务
bun run dev
```

启动后打开 <http://localhost:5174>。

`bun run dev` 会运行 `scripts/dev.mjs`，自动生成一个随机 `SCRIPT_SERVICE_TOKEN` 并共享给网关、Vite 与脚本服务。Vite 的所有后端请求都代理到网关，不持有或注入脚本服务令牌。认证默认使用 `AUTH_MODE=disabled`；任一子进程退出时，其余进程会被一并终止。

如需分别启动（例如只调试前端）：

```bash
export SCRIPT_SERVICE_TOKEN="$(openssl rand -hex 32)"  # 三个进程共享同一个非空令牌
bun run dev:web      # 仅前端，Vite 开发服务器，监听 0.0.0.0:5174
bun run dev:gateway  # 仅 UI 认证网关，监听 127.0.0.1:8080
bun run dev:scripts  # 仅脚本服务，监听 127.0.0.1:7420
```

在继承上述环境变量的三个终端中分别运行这些命令。

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

`dist/` 为纯静态文件。生产部署必须把以下路径**反向代理**到 UI 网关 `127.0.0.1:8080`，由网关执行认证、daemon 转发和脚本令牌注入：

- `/agentcompose.v1.*`、`/agentcompose.v2.*`、`/health.v1.*`、`/api/*`、`/oauth/*`、`/agent-compose/session/*`、`/jupyter`、`/jupyter/*`、`/script-api/*` → UI 网关 `127.0.0.1:8080`

参考实现见 `docker/nginx/default.conf.template`（nginx envsubst 模板）。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 本地开发：同时启动认证网关、前端与脚本服务 |
| `bun run dev:gateway` | 仅启动 UI 认证网关 |
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
| `/agentcompose.v1.*` | UI 网关 `127.0.0.1:8080` |
| `/agentcompose.v2.*` | UI 网关 `127.0.0.1:8080` |
| `/health.v1.*` | UI 网关 `127.0.0.1:8080` |
| `/api/*` | UI 网关 `127.0.0.1:8080` |
| `/oauth/*` | UI 网关 `127.0.0.1:8080` |
| `/agent-compose/session/*` | UI 网关 `127.0.0.1:8080` |
| `/jupyter`、`/jupyter/*` | UI 网关 `127.0.0.1:8080` |
| `/script-api/*` | UI 网关 `127.0.0.1:8080` |

`SCRIPT_SERVICE_TOKEN` 用于 UI 网关与脚本服务之间的内部认证，不会下发到浏览器。网关与脚本服务必须共享同一个令牌；本地 `bun run dev` 会自动生成并共享，Docker 模式由 `.env` 统一注入。

公司内网测试部署可使用兼容默认值 `AUTH_MODE=disabled`；此模式不显示登录页，也不限制后端操作，只适用于可信公司网络或 VPN。密码部署必须设置 `AUTH_MODE=password`、`AUTH_PASSWORD` 和持久且随机的 `AUTH_SECRET`，可选 `AUTH_USERNAME`（默认 `admin`）和 `AUTH_SESSION_TTL`（默认 `24h`），例如：

```bash
AUTH_MODE=password AUTH_USERNAME=admin AUTH_PASSWORD='strong-password' \
  AUTH_SECRET="$(openssl rand -hex 32)" AUTH_SESSION_TTL=24h bun run dev
```

登录成功后浏览器获得 HttpOnly 签名会话 Cookie；注销会清除 Cookie，会话超过 `AUTH_SESSION_TTL` 后须重新登录。该功能只提供认证，不提供细粒度授权：所有已认证用户都拥有 UI 暴露的全部能力。认证网关完全实现在 `agent-compose-ui` 中，不修改 Agent Compose daemon 的行为。公司网络之外仍必须在入口使用 HTTPS；互联网部署还应按组织要求增加限流或 SSO。

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
