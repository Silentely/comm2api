# 部署指南 (Deployment Guide)

`comm2api` 是一个 Node.js 单进程服务，后端**零运行时依赖**。支持通过 Docker 容器化部署或直接在宿主机通过 Node.js (>= 18) 运行。

---

## 目录

- [推荐：Docker Compose 部署](#推荐docker-compose-部署)
- [Docker 裸机运行 (docker run)](#docker-裸机运行-docker-run)
- [配置持久化与目录挂载](#配置持久化与目录挂载)
- [无持久卷的云端部署：Redis 持久化](#无持久卷的云端部署redis-持久化)
- [从源码构建本地镜像](#从源码构建本地镜像)
- [宿主机 Node.js 运行](#宿主机-nodejs-运行)
- [生产环境 Nginx 反向代理配置](#生产环境-nginx-反向代理配置)
- [内存开销与资源调优](#内存开销与资源调优)
- [常见部署问题与排查](#常见部署问题与排查)

---

## 推荐：Docker Compose 部署

最快、最推荐的部署方式是使用预构建的 GHCR 镜像与 `docker-compose.yml`。

### 1. 准备配置

```bash
# 1. 复制配置文件模板
cp config.json.example config.json
cp .env.example .env

# 2. 编辑环境变量（至少设置后台管理密码）
# 例如：ADMIN_PASSWORD=your_secure_password
vim .env
```

### 2. 启动服务

```bash
docker compose up -d
```

服务默认在宿主机 `http://0.0.0.0:3050` 监听。可随时在浏览器中打开 `http://<主机IP>:3050/admin/` 进行可视化配置与 Key 管理。

如果需要自定义宿主机映射端口（例如改为 `13050`）：

```bash
PROXY_PORT=13050 docker compose up -d
```

---

## Docker 裸机运行 (docker run)

如果不使用 Compose，可直接通过 `docker run` 运行：

```bash
# 确保已创建 config.json 和数据目录
cp config.json.example config.json
mkdir -p data

docker run -d \
  --name comm2api \
  --restart unless-stopped \
  -p 3050:3050 \
  -e PORT=3050 \
  -e ADMIN_PASSWORD="your_admin_password" \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/data:/app/data" \
  ghcr.io/silentely/comm2api:latest
```

> **关于镜像源与标签**：
> - 镜像仓库：`ghcr.io/silentely/comm2api`
> - `:latest`：跟踪主分支稳定发布
> - `:v*`：指定 release 版本（如 `:v1.6.0`）

---

## 配置持久化与目录挂载

为保证容器重启或升级后数据不丢失，务必理解以下两个挂载点：

| 容器内路径 | 宿主挂载推荐 | 性质 | 说明 |
|---|---|---|---|
| `/app/config.json` | `./config.json` | 只读 (`:ro`) | 静态基础配置，初始化模板 |
| `/app/data` | `./data` | 读写 (`:rw`) | **核心数据目录**：持久化后台添加的 Key、2API Key、代理绑定、额度缓存与模型设置 |

> ⚠️ **避坑提示**：
> 1. **宿主机文件必须事先存在**：若宿主机上没有 `config.json` 就直接启动挂载，Docker 会自动在宿主机创建名为 `config.json` 的**空目录**，导致容器读取报错 `EISDIR` 并回退到内置空配置。
> 2. **容器内部端口恒定为 3050**：容器内环境固定 `PORT=3050`（健康检查依赖此端口），更换对外端口请通过宿主端口映射（如 `-p 8080:3050` 或 `PROXY_PORT=8080`）。

---

## 无持久卷的云端部署：Redis 持久化

Railway、Render、Zeabur、Fly.io、Serverless 容器等平台通常不提供可长期保留的本地卷，容器重建后 `/app/data` 会被清空。此类部署可配置 Redis，把运行时数据保存到远端：

```bash
# 以 Railway/Render 等平台的环境变量面板为例
REDIS_URL=rediss://default:YOUR_REDIS_PASSWORD@redis.example.com:6379/0
# 多个实例共用一个 Redis 库时，用前缀隔离数据（默认 comm2api:）
REDIS_PREFIX=comm2api:
```

配置后无需改动挂载结构：服务启动时从 Redis Hash（`<prefix>state`）恢复上游 Key、2API Key、后台密码、运行时配置、代理池与额度快照；首次启动且 Redis 为空时会自动迁入本地已有的 `data/*.json`。后台仪表盘与设置页会显示 Redis 连接状态和已同步条目数，若显示「待重连」会在后台自动重试。

> 变量含义、`redis://`（TLS）与分项 `REDIS_HOST` 等方式见 [配置参考：Redis 云端持久化](configuration.md#可选redis-云端持久化)。

---

## 从源码构建本地镜像

如果你拉取了仓库源码并进行了本地定制，可使用本地编排文件：

```bash
# 构建并启动本地镜像 (产物镜像标记为 comm2api:local)
docker compose -f docker-compose.local.yml up -d --build
```

或者使用 CLI 原生构建：

```bash
docker build -t comm2api:local .
docker run -d -p 3050:3050 \
  -e ADMIN_PASSWORD="your_admin_password" \
  -v "$PWD/data:/app/data" \
  comm2api:local
```

多架构镜像构建（开发者可用）：

```bash
pnpm run docker:build:multi
```

---

## 宿主机 Node.js 运行

适用于本地调试、轻量 VPS 或直接作为 systemd 守护进程运行。

### 环境要求
- Node.js >= 18.0.0
- pnpm (或 npm / yarn)

### 快速启动

```bash
# 1. 准备配置
cp config.json.example config.json
cp .env.example .env

# 2. 安装依赖（仅开发依赖，生产零外部运行时依赖）
pnpm install

# 3. 启动
ADMIN_PASSWORD=your_admin_password pnpm start
```

### 推荐的 Systemd 服务模板

创建 `/etc/systemd/system/comm2api.service`：

```ini
[Unit]
Description=comm2api proxy service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/comm2api
EnvironmentFile=/opt/comm2api/.env
ExecStart=/usr/bin/node proxy.mjs
Restart=always
RestartSec=3
# 内存保护：防止极端大请求导致整机 OOM
MemoryMax=2G
Environment=NODE_OPTIONS="--max-old-space-size=1536"

[Install]
WantedBy=multi-user.target
```

启动与自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now comm2api
```

---

## 生产环境 Nginx 反向代理配置

在公网暴露服务时，强烈建议前置 Nginx 处理 SSL/TLS、连接并发控制与请求体大小裁剪。

### 标准 Nginx 配置示例

```nginx
# 提取下游鉴权凭证作为限流 Key
map $http_authorization $cc_key {
    default $http_authorization;
    ""      $http_x_api_key;
}
map "" $cc_global_key { default "global"; }

# 内存防御：三个维度的连接池限制
limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

upstream comm2api_backend {
    server 127.0.0.1:3050;
    # 必须小于 comm2api 内部的 CC_KEEPALIVE_TIMEOUT_MS (默认 65s)
    keepalive 32;
    keepalive_timeout 60s;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # 1. 管理后台 /admin/
    location /admin/ {
        proxy_pass http://comm2api_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 2. 数据面 API /v1/
    location /v1/ {
        # 严格限制单请求大小（须 <= CC_MAX_BODY_MB）
        # 超限请求在 Nginx 层直接 413，绝不进入 Node 消耗内存
        client_max_body_size 10m;

        # 并发控制：单 IP / 单 Key / 全局连接上限
        limit_conn cc_ip     8;
        limit_conn cc_key    4;
        limit_conn cc_global 32;
        limit_conn_status    429;

        proxy_pass http://comm2api_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 核心：流式传输必须关闭 Nginx 缓冲
        proxy_buffering off;
        proxy_cache off;

        # 读取超时须大于上游流空闲超时（默认 180s）
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

> ⚠️ **特别注意事项：Keep-Alive 时序对齐**
> 
> Nginx `upstream` 里的 `keepalive_timeout` 必须**小于**后端的 `CC_KEEPALIVE_TIMEOUT_MS`（默认 65s）。
> 如果设置颠倒，Nginx 会复用已被后端关闭的连接发送非幂等的 POST 请求，导致 `sendfile() failed (32: Broken pipe)` 并向下游抛出 502。

---

## 内存开销与资源调优

实测表明，Node.js 处理大 JSON 请求体时存在内存放大现象：

### 内存开销公式
```text
进程 RSS ≈ 70 MB + 在途请求数 × (0.13 MB + 5.5 × body_MB)
```

1. **请求体放大 ~5.5×**：一个 20MB 的多模态长上下文请求体，在 JSON 反序列化、协议对象重建和出网序列化过程中，会瞬间占用约 116MB 内存。
2. **流式背压机制**：已内置基于 TCP 写缓冲的流控背压。当客户端阅读较慢时，会自动暂停上游读取，防止响应流在内存中无限制积压。
3. **在途并发限制**：通过环境变量 `CC_MAX_INFLIGHT=32` 可以为整个 Node 进程设定兜底的在途请求上限，超限立刻返回 503 引导 SDK 优雅重试。
4. **僵死客户端处理**：如果客户端既不读取数据也不关闭连接，可启用 `CC_CLIENT_DRAIN_TIMEOUT_MS=60000`（持续阻塞 60 秒则主动切断）。

---

## 常见部署问题与排查

1. **后台显示拒绝访问 (403/Forbidden)**：
   - 未设置 `ADMIN_PASSWORD` 环境变量。为了安全，未配置密码时后台整体拒绝访问。
2. **容器重启后配置和 Key 丢失**：
   - 未正确挂载 `/app/data` 目录。必须挂载宿主目录到容器 `/app/data`。
3. **Nginx 报 Broken pipe 或客户端偶发 502**：
   - 检查 Nginx 的 `keepalive_timeout` 是否低于后端的 65s。
4. **流式输出卡顿或一次性吐出**：
   - 检查中间代理（如 Nginx、Cloudflare）是否开启了响应缓冲，必须设置 `proxy_buffering off;`。
