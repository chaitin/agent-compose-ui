# Agent Compose Web — Docker 启动

提供两个 compose 文件，均可通过 `docker compose up --build` 一键构建并运行：

| 文件 | 包含服务 | 适用场景 |
| --- | --- | --- |
| `docker-compose.yml` | web + script-service | 纯前端，连接**外部**已运行的 agent-compose |
| `docker-compose.full.yml` | web + script-service + agent-compose 后端 | 前后端一体，单栈拉起 |

## 服务说明

- **web**：nginx 既托管 SPA 静态文件，又把 API 路径反代到后端。
  - `/agentcompose.v1./v2.`、`/health.v1.`、`/api/`、`/script-api/` → UI 认证网关
  - 其余路径 → SPA（`try_files` 回退 `index.html`，支持 hash 路由与 `/events/<id>` 真实路径）
- **scripts**：bun 运行的脚本文件服务（无外部依赖），脚本文件存于命名卷 `script-data`。
- **agent-compose**（仅 full）：后端 daemon，挂载宿主 `docker.sock`、后端 `data/` 与 `.env`。

## 前置准备

1. 已安装 Docker 与 Docker Compose。
2. `cp .env.example .env`，并设置 `SCRIPT_SERVICE_TOKEN`（示例文件留空，未设置则 `docker compose up` 会直接报错退出）：`openssl rand -hex 32`。
3. （仅 full 模式）`cp agent-compose.env.example agent-compose.env`，按需编辑后端 daemon 配置；保持注释即用镜像默认值。

## 用法

### 纯前端（连接外部 agent-compose）

```bash
cd docker
cp .env.example .env
docker compose up --build
# 打开 http://localhost:8080
```

默认通过 `http://host.docker.internal:7410` 连接宿主上已暴露 7410 的 agent-compose。
若 agent-compose 在另一容器内：把它接入 `agent-web-net` 网络并设 `AGENT_COMPOSE_URL=http://agent-compose:7410`，或直接指向其地址。

### 前后端一体

```bash
cd docker
cp .env.example .env
docker compose -f docker-compose.full.yml up --build
# 打开 http://localhost:8080
```

后端默认使用镜像 `ghcr.io/chaitin/agent-compose:latest`，数据与配置默认自包含于 `docker/` 目录下（`./data` 与 `./agent-compose.env`），无需同级 `../../agent-compose` 仓库。首次使用先复制后端配置示例：`cp agent-compose.env.example agent-compose.env`（保持注释即用镜像默认值）。若需迁移位置，在 `.env` 中覆盖 `AGENT_COMPOSE_DATA_DIR` / `AGENT_COMPOSE_ENV_FILE` / `AGENT_COMPOSE_IMAGE`。

> 注意：full 模式会挂载宿主 `/var/run/docker.sock`（agent-compose 管理沙箱所需），并占用宿主 `7410` 端口（可用 `AGENT_COMPOSE_PORT` 调整）。
> **不要与宿主机已运行的 agent-compose 并存**：full 模式用 Docker 容器跑 agent-compose，需独占 `7410` 端口与 `data/` 目录。若宿主机已在跑 agent-compose（占用 7410 或持有 `data/` 锁），full 模式会因端口/数据冲突启动失败。此时请先停掉宿主机的 agent-compose，或改用上面的**纯前端模式**连接宿主机 daemon。

## YAML 全局变量引用

full 模式默认启用服务端 `${VAR}` 解析：web 网关只读挂载 daemon 数据目录，并把引用原文、依赖关系和“待同步”状态保存到独立的 `ui-state` 卷。浏览器始终保留 `${VAR}`，不会收到已保存的密钥；普通字面量不变，`Bearer ${TOKEN}` 仅替换引用部分。解析会递归处理项目配置中的全部字符串值，但任何层级中键名精确为 `script` 的字段会被整体跳过，脚本内容中的 `${...}` 不会替换、记录依赖或产生缺失变量警告。

修改全局变量只会把相关项目标记为“变量已更新，待同步”，不会自动 Apply、运行、启停或改动调度。用户下次明确保存、启用或同步项目时才使用新值，已有延时与定时任务保持不变。受 daemon 无法修改的限制，解析后的明文仍会持久化在 daemon 数据库中；请同时保护和备份 daemon 数据目录与 `ui-state` 卷。

纯前端模式默认不启用解析，因为 web 容器看不到外部 daemon 数据库。如需启用，必须通过自有 Compose override 将 daemon 数据目录只读挂载到 web，并同时设置不同的 `AGENT_COMPOSE_DB_PATH` 与 `UI_STATE_DB_PATH`；不要把数据库文件或 `ui-state` 目录暴露给浏览器静态服务。

## 连接与认证

- 公司内网共享测试环境可保留 `AUTH_MODE=disabled`（默认值）。此模式不要求登录，必须限制在可信公司网络或 VPN 内。
- 密码部署需在 `.env` 设置 `AUTH_MODE=password`、`AUTH_PASSWORD=<强密码>`、`AUTH_SECRET=<持久随机签名密钥>`。`AUTH_USERNAME` 默认 `admin`，`AUTH_SESSION_TTL` 默认 `24h`；可用 `openssl rand -hex 32` 生成 `AUTH_SECRET`，部署重启时不要重新生成。
- 登录成功后浏览器获得 HttpOnly 签名会话 Cookie；注销会清除 Cookie，会话超过 `AUTH_SESSION_TTL` 后须重新登录。所有已认证用户都拥有 UI 暴露的完整操作能力，本功能不提供角色或细粒度授权。
- `SCRIPT_SERVICE_TOKEN` 是网关与 script-service 之间的内部共享令牌，不会下发到浏览器。
- 认证网关完全属于 `agent-compose-ui`，不会修改 agent-compose daemon 的认证或其他行为。
- 公司网络之外仍必须通过 HTTPS 暴露 UI；互联网部署还应按组织要求在入口增加限流或 SSO。

## 端口

| 端口 | 服务 | 默认 |
| --- | --- | --- |
| `WEB_PORT` | web UI | 8080 → 80 |
| `TOKEN_RBAC_API_PORT` | Token 保护的 daemon API | 8081 → 8081 |
| `AGENT_COMPOSE_PORT`（仅 full） | agent-compose | 127.0.0.1:7410 → 7410 |

## 构建说明

- web 镜像为多阶段构建：`node:22-alpine` 执行 `npm install` + `npm run build`（即 `vite build`），产物拷入 `nginx:1.27-alpine`。用 npm 而非 bun 安装依赖，是因为 bun 自带的 BoringSSL CA 在有 TLS 拦截的网络里无法校验 registry 证书，而 npm 用系统/Node 的 OpenSSL 信任库可正常工作。
- scripts 镜像基于 `oven/bun:1-alpine`，无 `install` 步骤（script-service 仅用 Node 内置模块），不受上述问题影响。
- web 构建用 `npm install`（容忍 `package-lock.json` 与 `package.json` 的轻微不同步）；如需可复现构建，提交同步后的 `package-lock.json` 后可改为 `npm ci`。

## 常见问题

- **web 打开但数据为空/报错**：检查 agent-compose 是否可达。纯前端模式下确认 `AGENT_COMPOSE_URL` 指向正确地址且 daemon 已启动；full 模式下查看 `agent-compose` 容器日志。
- **端口冲突**：调整 `.env` 中的 `WEB_PORT`、`TOKEN_RBAC_API_PORT` 或 `AGENT_COMPOSE_PORT`。
- **脚本引用功能不可用**：确认 `scripts` 容器正常运行，且 `SCRIPT_SERVICE_TOKEN` 在 web 与 scripts 间一致（compose 已保证）。
