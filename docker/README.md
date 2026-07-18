# Agent Compose Web — Docker 启动

提供两个 compose 文件，均可通过 `docker compose up --build` 一键构建并运行：

| 文件 | 包含服务 | 适用场景 |
| --- | --- | --- |
| `docker-compose.yml` | web + script-service | 纯前端，连接**外部**已运行的 agent-compose |
| `docker-compose.full.yml` | web + script-service + agent-compose 后端 | 前后端一体，单栈拉起 |

## 服务说明

- **web**：nginx 既托管 SPA 静态文件，又把 API 路径反代到后端。
  - `/agentcompose.v1./v2.`、`/health.v1.`、`/api/` → agent-compose daemon
  - `/script-api/` → script-service（nginx 注入内部 token）
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

## 连接与认证

- web 与开发期行为一致：假定 agent-compose daemon 的控制面认证**关闭**（`AGENT_COMPOSE_AUTH_TOKEN` 为空）。若你在后端 `.env` 中启用了该 token，需另行让反代注入 `Authorization: Bearer`（当前模板未注入，与 dev 一致）。
- `SCRIPT_SERVICE_TOKEN` 是 web 与 script-service 之间的内部共享令牌，不会下发到浏览器。

## 端口

| 端口 | 服务 | 默认 |
| --- | --- | --- |
| `WEB_PORT` | web UI | 8080 → 80 |
| `AGENT_COMPOSE_PORT`（仅 full） | agent-compose | 7410 → 7410 |

## 构建说明

- web 镜像为多阶段构建：`node:22-alpine` 执行 `npm install` + `npm run build`（即 `vite build`），产物拷入 `nginx:1.27-alpine`。用 npm 而非 bun 安装依赖，是因为 bun 自带的 BoringSSL CA 在有 TLS 拦截的网络里无法校验 registry 证书，而 npm 用系统/Node 的 OpenSSL 信任库可正常工作。
- scripts 镜像基于 `oven/bun:1-alpine`，无 `install` 步骤（script-service 仅用 Node 内置模块），不受上述问题影响。
- web 构建用 `npm install`（容忍 `package-lock.json` 与 `package.json` 的轻微不同步）；如需可复现构建，提交同步后的 `package-lock.json` 后可改为 `npm ci`。

## 常见问题

- **web 打开但数据为空/报错**：检查 agent-compose 是否可达。纯前端模式下确认 `AGENT_COMPOSE_URL` 指向正确地址且 daemon 已启动；full 模式下查看 `agent-compose` 容器日志。
- **端口冲突**：调整 `.env` 中的 `WEB_PORT` 或 `AGENT_COMPOSE_PORT`。
- **脚本引用功能不可用**：确认 `scripts` 容器正常运行，且 `SCRIPT_SERVICE_TOKEN` 在 web 与 scripts 间一致（compose 已保证）。
