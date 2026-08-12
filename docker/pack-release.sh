#!/usr/bin/env bash
# =============================================================================
# Agent Compose 离线部署包一键打包脚本
#
# 在 docker/ 目录下执行，生成 release_<arch>/ 离线部署包及其整包 tar.gz。
#
#   cd docker && bash pack-release.sh [--arch arm64|amd64] [--tag <镜像tag>] [--force]
#
# 镜像来源策略（与用户约定）：
#   - agent-compose / agent-compose-guest：本地已有且架构一致时直接导出；
#     本地缺失或架构不符时从 docker 仓库拉取对应架构（--platform）后重标记再导出。
#   - agent-compose-ui：始终用本地 Dockerfile 构建后导出（不走仓库拉取）。
#
# 环境变量（可选覆盖）：
#   BACKEND_IMAGE  后端仓库镜像，默认 ghcr.io/chaitin/agent-compose:latest
#   GUEST_IMAGE    guest 仓库镜像，默认 ghcr.io/chaitin/agent-compose-guest:latest
# =============================================================================
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$HERE/.." && pwd)"
SELF="$HERE/$(basename -- "${BASH_SOURCE[0]}")"
cd "$HERE"

die()  { printf '\033[31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

usage() {
  sed -n '3,16p' "$SELF" | sed 's/^# \{0,1\}//'
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------
ARCH=""
TAG=""
FORCE=0
NO_REBUILD_UI=0
BACKEND_IMAGE="${BACKEND_IMAGE:-ghcr.io/chaitin/agent-compose:latest}"
GUEST_IMAGE="${GUEST_IMAGE:-ghcr.io/chaitin/agent-compose-guest:latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)         ARCH="$2"; shift 2 ;;
    --tag)          TAG="$2";  shift 2 ;;
    --force)        FORCE=1; shift ;;
    --no-rebuild-ui) NO_REBUILD_UI=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    --backend-image) BACKEND_IMAGE="$2"; shift 2 ;;
    --guest-image)  GUEST_IMAGE="$2";  shift 2 ;;
    *)
      if [[ -z "$ARCH" && "$1" != -* ]]; then ARCH="$1"; shift
      else die "未知参数：$1（用 --help 查看用法）"; fi ;;
  esac
done

# 架构：未指定时按本机推断
if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64|amd64)  ARCH=amd64 ;;
    *) die "无法识别本机架构 $(uname -m)，请用 --arch <arm64|amd64> 指定。" ;;
  esac
fi
case "$ARCH" in
  arm64|amd64) ;;
  *) die "暂不支持的架构：${ARCH}（仅支持 arm64 / amd64）" ;;
esac
PLATFORM="linux/$ARCH"

# 镜像 tag：未指定时用 <日期>-<git短sha>
if [[ -z "$TAG" ]]; then
  short_sha="$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || true)"
  if [[ -n "$short_sha" ]]; then TAG="$(date +%Y%m%d)-$short_sha"
  else TAG="$(date +%Y%m%d)"; fi
fi

RELEASE_DIR="$HERE/release_$ARCH"
IMAGES_DIR="$RELEASE_DIR/images"
FINAL_TAR="$HERE/agent_compose_${TAG}_${ARCH}.tar.gz"

# ----------------------------------------------------------------------------
# 前置检查
# ----------------------------------------------------------------------------
command -v docker   >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker 20.10+。"
docker info >/dev/null 2>&1        || die "无法连接 Docker daemon，请确认 Docker 已启动。"
command -v gunzip  >/dev/null 2>&1 || die "未找到 gunzip。"
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || die "未找到 sha256sum/shasum。"
[[ -f "$REPO_ROOT/docker/Dockerfile" ]] || die "未找到 $REPO_ROOT/docker/Dockerfile。"

if docker buildx version >/dev/null 2>&1; then HAVE_BUILDX=1; else HAVE_BUILDX=0; fi

docker_arch() {
  local a; a="$(docker info --format '{{.Architecture}}' 2>/dev/null || echo "")"
  case "$a" in aarch64) echo arm64 ;; x86_64) echo amd64 ;; *) echo "$a" ;; esac
}

if [[ -e "$RELEASE_DIR" ]]; then
  [[ "$FORCE" -eq 1 ]] || die "目标目录已存在：$RELEASE_DIR\n  使用 --force 覆盖重建，或换用其它 --arch/--tag。"
  rm -rf -- "$RELEASE_DIR"
fi

info "打包参数"
printf '  架构        : %s\n' "$PLATFORM"
printf '  镜像 tag    : %s\n' "$TAG"
printf '  后端镜像源  : %s\n' "$BACKEND_IMAGE"
printf '  Guest镜像源 : %s\n' "$GUEST_IMAGE"
printf '  UI 构建     : %s\n' "$([ "$NO_REBUILD_UI" -eq 1 ] && echo 复用本地镜像 || echo 本地 Dockerfile 构建)"
printf '  输出目录    : %s\n' "$RELEASE_DIR"
printf '  整包文件    : %s\n' "$(basename "$FINAL_TAR")"
[[ "$FORCE" -eq 1 ]] && printf '  --force     : 覆盖已存在目录\n'
echo

mkdir -p "$IMAGES_DIR"

# ----------------------------------------------------------------------------
# 镜像导出辅助
# ----------------------------------------------------------------------------
# 导出本地镜像 ref 到 images/<name>.tar.gz
export_image() {
  local ref="$1" out="$2"
  info "导出镜像 $ref -> $(basename "$out")"
  rm -f -- "$out"
  docker save "$ref" | gzip > "$out"
}

# 本地优先（架构须一致）；缺失或架构不符则从仓库拉取对应架构并重标记再导出
ensure_and_export() {
  local name="$1" ref="$2" registry="$3"
  local img_arch=""
  if docker image inspect "$ref" >/dev/null 2>&1; then
    img_arch="$(docker inspect --format '{{.Architecture}}' "$ref" 2>/dev/null || true)"
  fi

  if [[ "$img_arch" == "$ARCH" ]]; then
    info "本地已有 ${ref}（arch=${img_arch}），直接导出"
  else
    if [[ -n "$img_arch" ]]; then
      info "本地 ${ref} 架构为 ${img_arch}，与目标 ${ARCH} 不一致，从仓库拉取 ${registry}（${PLATFORM}）"
    else
      info "本地未找到 ${ref}，从仓库拉取 ${registry}（${PLATFORM}）"
    fi
    docker pull --platform "$PLATFORM" "$registry"
    docker tag "$registry" "$ref"
    info "已重标记为 ${ref}"
  fi
  export_image "$ref" "$IMAGES_DIR/$name.tar.gz"
}

# ----------------------------------------------------------------------------
# 1) 后端 agent-compose（本地优先，仓库兜底）
# ----------------------------------------------------------------------------
info "[1/3] 准备 agent-compose"
ensure_and_export agent-compose "agent-compose:$TAG" "$BACKEND_IMAGE"

# ----------------------------------------------------------------------------
# 2) guest agent-compose-guest（本地优先，仓库兜底）
# ----------------------------------------------------------------------------
info "[2/3] 准备 agent-compose-guest"
ensure_and_export agent-compose-guest "agent-compose-guest:$TAG" "$GUEST_IMAGE"

# ----------------------------------------------------------------------------
# 3) agent-compose-ui（本地构建后导出）
# ----------------------------------------------------------------------------
info "[3/3] 准备 agent-compose-ui"
ui_ref="agent-compose-ui:$TAG"
if [[ "$NO_REBUILD_UI" -eq 1 ]] && docker image inspect "$ui_ref" >/dev/null 2>&1; then
  info "复用本地已有镜像 ${ui_ref}（--no-rebuild-ui）"
else
  info "本地构建 ${ui_ref}（${PLATFORM}，来自 docker/Dockerfile）"
  if [[ "$HAVE_BUILDX" -eq 1 ]]; then
    docker buildx build --platform "$PLATFORM" --load \
      --tag "$ui_ref" -f "$REPO_ROOT/docker/Dockerfile" "$REPO_ROOT"
  else
    host_arch="$(docker_arch)"
    [[ "$host_arch" == "$ARCH" ]] \
      || die "本机无 buildx，无法跨架构构建 ${PLATFORM}；请安装 buildx 或在目标架构主机上打包。"
    docker build --tag "$ui_ref" -f "$REPO_ROOT/docker/Dockerfile" "$REPO_ROOT"
  fi
fi
export_image "$ui_ref" "$IMAGES_DIR/agent-compose-ui.tar.gz"

# ----------------------------------------------------------------------------
# 4) 写入部署文件（模板取自既有 release_arm64/）
# ----------------------------------------------------------------------------
info "生成部署文件"

# docker-compose.yml —— 保持 ${IMAGE_TAG} 等字面量，交由 compose 运行时展开
cat > "$RELEASE_DIR/docker-compose.yml" <<'COMPOSE_EOF'
services:
  web:
    image: agent-compose-ui:${IMAGE_TAG:?IMAGE_TAG missing in .env}
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -Y off -q --spider http://127.0.0.1/api/auth/status || exit 1"]
      interval: 10s
      timeout: 3s
      start_period: 10s
      retries: 6
    depends_on:
      - agent-compose
    ports:
      - "${WEB_PORT:-80}:80"
      - "${TOKEN_RBAC_API_PORT:-8081}:8081"
    environment:
      AGENT_COMPOSE_URL: http://agent-compose:7410
      AGENT_COMPOSE_DB_PATH: /data/agent-compose/data.db
      UI_STATE_DB_PATH: /data/ui/project-env.db
      PROJECT_STORAGE_ROOT: /data/work/projects
      LOCAL_VOLUME_ROOT: /data/volumes/local
      SCRIPT_SERVICE_URL: http://127.0.0.1:7420
      SCRIPT_SERVICE_HOST: 127.0.0.1
      SCRIPT_SERVICE_PORT: "7420"
      SCRIPT_DATA_DIR: /data/scripts
      SCRIPT_SERVICE_TOKEN: ${SCRIPT_SERVICE_TOKEN:?run.sh should generate this value}
      NO_PROXY: localhost,127.0.0.1,agent-compose,web
      no_proxy: localhost,127.0.0.1,agent-compose,web
      AUTH_MODE: ${AUTH_MODE:-disabled}
      AUTH_USERNAME: ${AUTH_USERNAME:-admin}
      AUTH_PASSWORD: ${AUTH_PASSWORD:-}
      AUTH_SECRET: ${AUTH_SECRET:-}
      AUTH_SESSION_TTL: ${AUTH_SESSION_TTL:-24h}
      TOKEN_DB_PATH: /data/api/tokens.db
    volumes:
      - ./data:/data/agent-compose:ro
      - ./data/work:/data/work
      - ./data/volumes/local:/data/volumes/local
      - ui-state:/data/ui
      - api-token-data:/data/api
      - script-data:/data/scripts
    networks:
      - agent-web-net

  agent-compose:
    image: agent-compose:${IMAGE_TAG:?IMAGE_TAG missing in .env}
    restart: unless-stopped
    environment:
      AGENT_COMPOSE_RUNTIME_BASE_URL: http://agent-compose:7410
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /etc/localtime:/etc/localtime:ro
      - ./data:/data
      - ./agent-compose.env:/data/work/.env:ro
    working_dir: /data/work
    ports:
      - "127.0.0.1:${AGENT_COMPOSE_PORT:-7410}:7410"
    networks:
      - agent-web-net

networks:
  agent-web-net:

volumes:
  script-data:
  ui-state:
  api-token-data:
COMPOSE_EOF

# run.sh —— 幂等启动脚本（保持原样，含 ${...}/$1 字面量）
cat > "$RELEASE_DIR/run.sh" <<'RUN_EOF'
#!/usr/bin/env bash
# Agent Compose 离线部署启动脚本。幂等，可重复执行。
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

die() { printf '\033[31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || die "未找到 Docker，请先安装 Docker 20.10+。"
docker info >/dev/null 2>&1 || die "无法连接 Docker daemon，请确认 Docker 已启动且当前用户有权限。"
docker compose version >/dev/null 2>&1 || die "未找到 Docker Compose v2；本包不支持 docker-compose v1。"
command -v gunzip >/dev/null 2>&1 || die "未找到 gunzip。"
[[ -f .env ]] || die "缺少 .env，部署包不完整。"
[[ -f agent-compose.env ]] || die "缺少 agent-compose.env，部署包不完整。"

IMAGE_TAG="$(awk -F= '$1 == "IMAGE_TAG" {print substr($0, index($0, "=") + 1); exit}' .env)"
[[ -n "$IMAGE_TAG" && "$IMAGE_TAG" != *'__IMAGE_TAG__'* ]] || die ".env 中缺少有效的 IMAGE_TAG。"

load_image() {
  local archive_name="$1" image_ref="$2" archive="images/$1.tar.gz"
  if docker image inspect "$image_ref" >/dev/null 2>&1; then
    info "镜像 $image_ref 已存在，跳过加载"
    return
  fi
  [[ -f "$archive" ]] || die "缺少镜像文件 ${archive}，部署包不完整。"
  info "加载镜像 $image_ref"
  gunzip -c "$archive" | docker load
}

load_image agent-compose "agent-compose:$IMAGE_TAG"
load_image agent-compose-ui "agent-compose-ui:$IMAGE_TAG"
load_image agent-compose-guest "agent-compose-guest:$IMAGE_TAG"

if grep -q '^SCRIPT_SERVICE_TOKEN=$' .env; then
  command -v openssl >/dev/null 2>&1 || die "首次启动需要 openssl 生成内部 token。"
  token="$(openssl rand -hex 32)"
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || die "内部 token 生成失败。"
  tmp="$(mktemp .env.tmp.XXXXXX)"
  sed "s/^SCRIPT_SERVICE_TOKEN=$/SCRIPT_SERVICE_TOKEN=$token/" .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
fi

mkdir -p data/work data/volumes/local

info "启动 Agent Compose"
if ! docker compose up -d; then
  docker compose logs --tail=80 >&2 || true
  die "容器启动失败。"
fi

if [[ "${SKIP_HEALTHCHECK:-0}" == "1" ]]; then
  exit 0
fi

WEB_PORT="$(awk -F= '$1 == "WEB_PORT" {print substr($0, index($0, "=") + 1); exit}' .env)"
WEB_PORT="${WEB_PORT:-80}"
info "等待前后端就绪（最长 180 秒）"
ready=false
for _ in $(seq 1 90); do
  backend_ok=false
  frontend_ok=false
  if docker compose exec -T agent-compose python3 -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7410/api/version', timeout=2).read()" \
    >/dev/null 2>&1; then
    backend_ok=true
  fi
  web_container="$(docker compose ps -q web 2>/dev/null || true)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$web_container" 2>/dev/null || true)"
  [[ "$status" == healthy ]] && frontend_ok=true
  if [[ "$backend_ok" == true && "$frontend_ok" == true ]]; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "$ready" != true ]]; then
  printf '\n\033[31m服务未在 180 秒内就绪，最近日志如下：\033[0m\n' >&2
  docker compose logs --tail=80 >&2 || true
  die "启动超时，排障后可重新执行 bash run.sh。"
fi

host="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[[ -n "$host" ]] || host=localhost
printf '\n\033[32m部署完成\033[0m\n'
printf '  访问地址：http://%s:%s\n' "$host" "$WEB_PORT"
printf '  查看日志：docker compose logs -f\n'
printf '  停止服务：bash stop.sh\n'
RUN_EOF
chmod +x "$RELEASE_DIR/run.sh"

# stop.sh —— 停止脚本（保持原样）
cat > "$RELEASE_DIR/stop.sh" <<'STOP_EOF'
#!/usr/bin/env bash
# 停止 Agent Compose。默认保留全部业务数据。
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

die() { printf '\033[31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -h|--help)
      printf '用法：bash stop.sh [--purge]\n\n'
      printf '  无参数    停止服务，保留 ./data 与具名卷\n'
      printf '  --purge   停止并永久删除全部数据，需输入 yes 确认\n'
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

if [[ "$PURGE" -eq 0 ]]; then
  info "停止服务（保留数据）"
  docker compose down
  printf '\033[32m已停止。数据已保留；重新启动请执行 bash run.sh。\033[0m\n'
  exit 0
fi

printf '\033[31m警告：即将永久删除 ./data 和全部具名卷，此操作不可恢复。\033[0m\n'
confirm="${PURGE_CONFIRM:-}"
if [[ -z "$confirm" ]]; then
  printf '确认请输入 yes：'
  read -r confirm
fi
[[ "$confirm" == yes ]] || die "未确认，已取消；数据未改动。"

info "停止服务并删除具名卷"
docker compose down --volumes
info "删除 ./data"
rm -rf -- "$HERE/data"
printf '\033[32m已停止并清空数据。\033[0m\n'
STOP_EOF
chmod +x "$RELEASE_DIR/stop.sh"

# .env —— 注入 IMAGE_TAG；SCRIPT_SERVICE_TOKEN 留空，run.sh 首次运行生成
cat > "$RELEASE_DIR/.env" <<EOF
# Agent Compose Web 配置
IMAGE_TAG=$TAG

# 对外服务端口
WEB_PORT=80
TOKEN_RBAC_API_PORT=8081
# 后端排障端口，仅绑定 127.0.0.1
AGENT_COMPOSE_PORT=7410

# 首次执行 run.sh 时自动生成，请勿手工使用弱口令。
SCRIPT_SERVICE_TOKEN=

# 默认适用于可信内网。公网部署请改为 password，并配置强密码和随机 secret。
AUTH_MODE=disabled
AUTH_USERNAME=admin
AUTH_PASSWORD=
AUTH_SECRET=
AUTH_SESSION_TTL=24h
EOF
chmod 600 "$RELEASE_DIR/.env"

# agent-compose.env —— guest 镜像指向整包内附 tag
cat > "$RELEASE_DIR/agent-compose.env" <<EOF
# agent-compose daemon 配置，只读挂载到容器 /data/work/.env

# 离线沙箱必须使用整包内附的 guest 镜像。
DEFAULT_IMAGE=agent-compose-guest:$TAG
RUNTIME_DRIVER=docker

# 沙箱加入 agent-web-net 后，通过服务名回连 daemon。
CAP_GRPC_LISTEN=0.0.0.0:9100
CAP_GRPC_TARGET=agent-compose:9100
EOF

# README.md
cat > "$RELEASE_DIR/README.md" <<EOF
# Agent Compose 离线部署包（${PLATFORM}）

本整包包含 Agent Compose 后端、前端，以及运行沙箱所需的 guest 镜像。目标机无需访问镜像仓库。

## 四步部署

\`\`\`bash
# 01 解压整包
tar -xzf agent_compose_*.tar.gz

# 02 进入解压目录
cd release_*

# 03 启动服务
bash run.sh

# 04 停止服务（需要时）
bash stop.sh
\`\`\`

首次启动会加载三个镜像，通常需要数分钟。启动完成后终端会打印访问地址，默认使用 80 端口。

## 环境要求

- $PLATFORM
- Docker 20.10+ 和 Docker Compose v2
- 当前用户可访问 Docker daemon 和 \`/var/run/docker.sock\`
- 建议至少保留 10 GB 磁盘空间

## 配置与数据

- \`.env\`：Web 端口和登录配置；首次运行会自动生成内部 token。
- \`agent-compose.env\`：后端配置；默认使用整包内附的 guest 镜像。
- \`data/\`：项目、运行记录、沙箱状态和卷文件。备份时请备份此目录。
- \`images/\`：离线镜像；确认系统正常运行后可另行归档以节省空间。

默认 \`AUTH_MODE=disabled\`，只适合可信内网。公网部署前请在 \`.env\` 中配置 \`AUTH_MODE=password\`、强密码和随机 \`AUTH_SECRET\`，并在入口增加 HTTPS。

## 常用命令

\`\`\`bash
docker compose ps
docker compose logs -f
bash run.sh                 # 幂等，可用于启动或重启
bash stop.sh                # 停止并保留数据
bash stop.sh --purge        # 停止并永久清空数据，需输入 yes
\`\`\`

修改 \`.env\` 后，执行 \`bash stop.sh && bash run.sh\` 使配置生效。

## 排障

- 无法连接 Docker daemon：确认 Docker 已启动，当前用户具有 Docker 权限。
- 端口占用：修改 \`.env\` 中的 \`WEB_PORT\`、\`TOKEN_RBAC_API_PORT\` 或 \`AGENT_COMPOSE_PORT\`。
- UI 可打开但任务无法创建：执行 \`docker images | grep agent-compose-guest\`，确认 guest 镜像 tag 与 \`.env\` 的 \`IMAGE_TAG\` 一致。
- 启动超时：执行 \`docker compose logs --tail=200\` 查看最近日志。
EOF

# ----------------------------------------------------------------------------
# 5) VERSION / SHA256SUMS
# ----------------------------------------------------------------------------
ui_branch="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
ui_commit="$(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(cd "$REPO_ROOT" && git status --porcelain 2>/dev/null || true)" ]]; then
  ui_commit="${ui_commit}-dirty"
fi
backend_rev="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "agent-compose:$TAG" 2>/dev/null || true)"
[[ -n "$backend_rev" ]] || backend_rev="n/a"

cat > "$RELEASE_DIR/VERSION" <<EOF
build_date=$(date +%Y%m%d)
image_tag=$TAG
ui_branch=$ui_branch
ui_commit=$ui_commit
backend_commit=$backend_rev
platform=$PLATFORM
change_scope=manual packaging
EOF

info "生成 SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$RELEASE_DIR" && sha256sum images/*.tar.gz > SHA256SUMS )
else
  ( cd "$RELEASE_DIR" && for f in images/*.tar.gz; do shasum -a 256 "$f"; done > SHA256SUMS )
fi

# ----------------------------------------------------------------------------
# 6) 整包压缩
# ----------------------------------------------------------------------------
info "生成整包压缩文件 $(basename "$FINAL_TAR")"
tar -czf "$FINAL_TAR" -C "$HERE" "release_$ARCH"

# ----------------------------------------------------------------------------
# 汇总
# ----------------------------------------------------------------------------
info "打包完成"
printf '\n\033[32m离线部署包：\033[0m\n'
printf '  目录 : %s\n' "$RELEASE_DIR"
printf '  整包 : %s\n' "$FINAL_TAR"
printf '\nSHA256SUMS:\n'
cat "$RELEASE_DIR/SHA256SUMS" | sed 's/^/  /'
printf '\n部署方式：将整包拷贝到目标机，解压后执行 bash run.sh。\n'
