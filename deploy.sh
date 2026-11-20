#!/usr/bin/env bash
# ============================================================
# comm2api —— 一键 gh 登录 + Docker Compose 部署
# 用法：
#   ./deploy.sh            # 登录 GitHub → 用当前源码本地构建 → 启动
#   ./deploy.sh --no-gh    # 跳过 gh 登录段
#   ./deploy.sh --prebuilt # 改用 GHCR 预构建镜像（不含本地改动）
#
# 后台密码：优先取环境变量 ADMIN_PASSWORD，未设置则随机生成（不落仓库、不写死）。
#   ADMIN_PASSWORD='你的强口令' ./deploy.sh
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

HOST_PORT=37080          # Web 端口（可用 PROXY_PORT 环境变量覆盖）
DETECTED_GH=$(gh api user -q .login 2>/dev/null || true)
GH_ACCOUNT="${GH_ACCOUNT:-${DETECTED_GH:-silentely}}"   # 目标 GitHub 账号
IMAGE="ghcr.io/${GH_ACCOUNT}/comm2api:latest"
COMPOSE_FILE=docker-compose.yml
DO_GH=1
DO_REBUILD=1   # 默认本地构建：源码已含修复，GHCR 预构建镜像追不上本地提交
for a in "$@"; do
  case "$a" in
    --no-gh)    DO_GH=0 ;;
    --rebuild)  DO_REBUILD=1 ;;
    --prebuilt) DO_REBUILD=0 ;;
    *) echo "未知参数: $a"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------- 1. gh 登录 GitHub ----------
if [ "$DO_GH" = 1 ]; then
  say "检查 gh 登录状态"
  if ! command -v gh >/dev/null 2>&1; then
    echo "未安装 gh，正在安装..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq gh
    else
      echo "请先安装 GitHub CLI: https://cli.github.com"; exit 1
    fi
  fi

  if gh auth status -h github.com >/dev/null 2>&1; then
    echo "已登录：$(gh api user -q .login 2>/dev/null || echo unknown)"
  else
    echo "未登录，启动交互式登录（浏览器打开 https://github.com/login/device 输入一次性码）"
    gh auth login -h github.com -p https -w
  fi

  ACTUAL=$(gh api user -q .login 2>/dev/null || true)
  if [ -n "${ACTUAL:-}" ] && [ "$ACTUAL" != "$GH_ACCOUNT" ]; then
    echo "⚠️  当前登录账号为 $ACTUAL，与预期 $GH_ACCOUNT 不一致"
    read -r -p "是否切换账号？[y/N] " ans
    if [ "${ans,,}" = y ]; then
      gh auth login -h github.com -p https -w
      ACTUAL=$(gh api user -q .login 2>/dev/null || true)
    fi
  fi
  echo "GitHub 账号：${ACTUAL:-unknown}"

  # git 走 gh 的凭证助手，后续 clone/push 免密码
  gh auth setup-git || true

  # 若 ghcr 包是私有的，用 gh token 登录 registry（公共包可跳过，失败不阻塞）
  say "登录 ghcr.io（私有包需要；公共包可忽略失败）"
  if TOKEN=$(gh auth token 2>/dev/null); then
    printf '%s' "$TOKEN" | docker login ghcr.io -u "${ACTUAL:-$GH_ACCOUNT}" --password-stdin \
      && echo "ghcr.io 登录成功" || echo "ghcr.io 登录跳过（匿名拉取公共镜像即可）"
  fi
fi

# ---------- 2. 准备配置文件 ----------
say "准备 config.json / .env / data 目录"
[ -f config.json ] || cp config.json.example config.json

if [ ! -f .env ]; then
  PK=$(openssl rand -hex 24)
  SALT=$(openssl rand -hex 16)
  # 口令不写死在脚本里（这个脚本要进公开仓库），未显式提供就随机生成
  ADMIN_PASS="${ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}"
  cat > .env <<EOF
ADMIN_PASSWORD=${ADMIN_PASS}
ADMIN_COOKIE_SECURE=0
PROXY_PORT=${HOST_PORT}
PORT=3050
HOST=0.0.0.0
PROXY_KEY=${PK}
CC_API_KEY=
CC_API_BASE=https://api.commandcode.ai
CC_UPSTREAM_PROXY=
CC_LOG_LEVEL=info
CC_USE_PROVIDER_MODELS=true
CC_MAX_INFLIGHT=0
CC_DATA_DIR=/app/data
CMD_ZDR=0
CC_FINGERPRINT_SALT=${SALT}
CC_DEVICE_PROJECT_DIR=/workspace/cc-proxy
EOF
  chmod 600 .env
  echo "已生成 .env（PROXY_KEY 自动随机）"
else
  echo ".env 已存在，保留原配置"
fi

# config.json 必须是文件，不能是目录（Docker 会误建目录导致配置加载失败）
if [ -d config.json ]; then
  echo "✗ config.json 是目录，正在修正..."
  rm -rf config.json && cp config.json.example config.json
fi

mkdir -p data

HOST_PORT=$(grep -E '^PROXY_PORT=' .env | cut -d= -f2 | tr -d '[:space:]' || true)
HOST_PORT=${HOST_PORT:-37080}
export PROXY_PORT="$HOST_PORT"

# ---------- 3. 拉镜像 / 构建 ----------
if [ "$DO_REBUILD" = 1 ]; then
  COMPOSE_FILE=docker-compose.local.yml
  say "本地源码构建：docker compose -f $COMPOSE_FILE up -d --build"
  docker compose -f "$COMPOSE_FILE" up -d --build
else
  say "拉取预构建镜像 $IMAGE"
  docker pull "$IMAGE"
  say "启动容器"
  docker compose -f "$COMPOSE_FILE" up -d
fi

# ---------- 4. 健康检查 ----------
say "等待健康检查 http://127.0.0.1:${HOST_PORT}/health"
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then
    echo "健康检查通过"
    break
  fi
  sleep 2
  [ "$i" = 30 ] && { echo "✗ 健康检查超时，查看日志：docker compose logs -f"; exit 1; }
done

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

============================================================
部署完成
------------------------------------------------------------
Web / 后台 : http://${IP:-127.0.0.1}:${HOST_PORT}/admin/
健康检查   : http://${IP:-127.0.0.1}:${HOST_PORT}/health
API Base   : http://${IP:-127.0.0.1}:${HOST_PORT}/v1
后台账号   : admin
后台密码   : $(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2)
数据面 Key : $(grep -E '^PROXY_KEY=' .env | cut -d= -f2)
------------------------------------------------------------
下一步：
  1) 打开后台 →「🔑 上游 Key」添加 Command Code Key（user_ 开头），否则 /v1 请求返回 500
  2) 客户端（Claude Code / 任意 OpenAI 兼容端）base_url 填 http://IP:${HOST_PORT}/v1，
     api_key 填上面的「数据面 Key」，或去后台「🔐 2API Key」逐个签发
------------------------------------------------------------
常用命令：docker compose ps | docker compose logs -f | docker compose restart
============================================================
EOF
