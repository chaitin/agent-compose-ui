# Agent Compose 单镜像部署

该构建产出一个可分发镜像，内部包含 agent-compose 引擎、SPA、Go 网关、
Bun script-service、nginx，以及完整的 `agent-compose-guest` sandbox 根文件系统。
容器首次启动会通过挂载的 Docker socket 导入内置 guest 镜像，因此默认 sandbox
不依赖运行时访问镜像仓库。
`tini` 作为 PID 1，入口脚本先等待引擎数据库和 `/api/version` 就绪，再启动 Go
网关、script-service 与 nginx；任一进程退出都会结束容器并交给 Compose 重启。

## 本地源码一键构建并启动

要求 Docker 20.10+ 与 Docker Compose v2，不依赖 Buildx 插件：

```bash
cd agent-compose-ui/docker
./build-and-up-all-in-one.sh
```

访问 `http://localhost:8080`。首次构建会比较久，因为 guest 镜像包含 Jupyter、
Node.js 与多个 Agent CLI。首次启动还需将压缩 guest 根文件系统导入宿主 Docker，
健康检查会在导入完成后变为 healthy。

网络受限环境可以指定镜像代理：

```bash
REGISTRY_MIRROR=docker.m.daocloud.io \
BUN_IMAGE=docker.m.daocloud.io/oven/bun:1 \
./build-and-up-all-in-one.sh
```

## 使用已发布的单镜像

部署机器只需保存 `docker-compose.all-in-one.yml` 并执行：

```bash
AGENT_COMPOSE_ALL_IN_ONE_IMAGE=ghcr.io/chaitin/agent-compose-all-in-one:latest \
  docker compose -f docker-compose.all-in-one.yml up -d
```

单容器必须挂载 `/var/run/docker.sock`，否则无法导入或运行 Docker sandbox。数据、
UI 状态、脚本、Token 数据库与自动生成的内部令牌都在 `/data`，应持久化和备份。

如需覆盖配置：

```bash
cp all-in-one.env.example all-in-one.env
# 编辑认证、LLM、OAuth、镜像仓库、资源限制等配置
./build-and-up-all-in-one.sh
```

Compose 的 `env_file` 会把示例中的前后端变量原样注入同一容器；镜像中已固定单容器
拓扑所需的 URL、数据库和存储路径。`SCRIPT_SERVICE_TOKEN` 留空时会自动生成并保存
到 `/data/.script-service-token`，也可显式注入。公网部署必须启用 `AUTH_MODE=password`、
设置强密码和持久的 `AUTH_SECRET`，并在容器前配置 HTTPS。
