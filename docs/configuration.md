# 配置参考手册 (Configuration Guide)

本文档详细列出 `comm2api` 的所有配置项、环境变量与出站代理池语法规则。

---

## 目录

- [配置分层与优先级](#配置分层与优先级)
- [config.json 完整字段参考](#configjson-完整字段参考)
- [用 .env 配置（推荐）](#用-env-配置推荐)
- [环境变量完整列表](#环境变量完整列表)
- [可选：Redis 云端持久化](#可选redis-云端持久化)
- [出站代理池深度指南](#出站代理池深度指南)
- [容量与资源限制配置](#容量与资源限制配置)

---

## 配置分层与优先级

`comm2api` 采用多层配置合并机制。当同一配置项出现在多个地方时，**优先级从高到低**如下：

```
1. 宿主 Shell 环境变量 (export KEY=VAL)
   └── 2. 项目根目录 .env 文件
       └── 3. data/settings.json (Web 后台动态修改并持久化的配置)
           └── 4. config.json (部署期基础模板文件)
               └── 5. 代码内置默认值
```

- **Docker 与直接运行通用**：程序自身已集成轻量级 `.env` 解析器，Docker Compose 也会自动注入同目录 `.env`。
- **配置持久化原则**：`config.json` 在 Docker 中应只读挂载 (`:ro`)；后台在网页修改的选项只保存到 `data/settings.json`（配置 Redis 后保存到 Redis），不会改写 `config.json`。

---

## config.json 完整字段参考

从模板文件复制后编辑：`cp config.json.example config.json`。

| 字段 | 默认值 | 类型 | 说明 |
|---|---|---|---|
| `port` | `3000` | 数字 | 监听端口（模板 `config.json.example` 中使用 `3050`） |
| `host` | `0.0.0.0` | 字符串 | 监听网卡地址 |
| `apiBase` | `https://api.commandcode.ai` | 字符串 | Command Code 官方 API 根地址 |
| `projectSlug` | `cc-proxy` | 字符串 | 请求头 `x-project-slug` 取值 |
| `proxyKey` | `""` | 字符串 | 数据面访问口令。**非空即启用严格鉴权**：客户端只认它，上游凭证从 Key 池按策略选取 |
| `apiKey` | `""` | 字符串/数组 | 上游 CC API Key（`user_` 开头）。推荐改在后台 `/admin/` 动态添加；此处填写的 Key 会作为**只读**条目出现在后台 |
| `strategy` | `round_robin` | 字符串 | Key 轮询策略：`round_robin`（轮询）/ `random`（避让连续重复）/ `fill`（压满首个可用） |
| `defaultModel` | `""` | 字符串 | 默认模型（Key 测试与模型测试使用）；空则默认取目录第一项 |
| `logFile` | `""` | 字符串 | 日志文件路径（留空则只输出到控制台 stdout） |
| `logLevel` | `info` | 字符串 | 日志级别：`debug` / `info` / `warn` / `error` |
| `useProviderModels` | `true` | 布尔 | 是否从 Provider API 动态拉取上游最新模型列表 |
| `useProviderModelsWithPlanFilter` | `false` | 布尔 | 是否按当前 Key 的订阅套餐过滤模型列表 |
| `modelRefreshIntervalMs` | `300000` | 数字 | 模型列表缓存刷新周期（毫秒，默认 5 分钟） |
| `zdr` | `false` | 布尔 | 是否开启 ZDR-only 路由（请求上游时附加 `x-cmd-zdr: 1`） |
| `cliMode` | `agent` | 字符串 | 信封 `mode`，可选：`agent` / `learning` / `custom-agent` / `custom-agent-create` / `title-gen` / `tool-desc` / `compact` / `vision` |
| `cliSessionMode` | `interactive` | 字符串 | lifecycle 元数据里的 `mode`，可选：`interactive` / `non-interactive` |
| `fingerprintSalt` | `""` | 字符串 | 设备指纹生成盐。需要成批更换伪装硬件身份时修改它 |
| `deviceProjectDir` | `""` | 字符串 | 伪装的项目绝对路径（留空使用内置 `C:\Users\dev\projects\app`） |
| `emptySystemPlaceholder` | `true` | 布尔 | 当客户端未传 system prompt 时自动发单空格占位，防止上游强行注入约 7.5K token 默认提示词 |
| `webSearch` | `false` | 布尔 | 是否代为执行 Anthropic 服务端搜索工具 `web_search_20250305` |
| `proxies` | `[]` | 数组 | 出站代理池列表，见下文专门章节 |
| `proxyFile` | `""` | 字符串 | 每行一条出站代理的文件路径（相对路径按 `config.json` 目录解析） |
| `upstreamProxy` | `""` | 字符串 | 单出站代理兼容字段（旧版配置平滑兼容） |

---

## 用 .env 配置（推荐）

项目根目录的 `.env` 是管理敏感口令最安全便捷的方式：

```bash
cp .env.example .env
vim .env
```

### 常用 .env 模板项

```ini
# 后台管理访问口令（强烈建议设置，未设置时管理后台整站拒绝访问）
ADMIN_PASSWORD=your_secure_admin_password

# 数据面共享访问口令（如果使用 2API Key 体系，可留空）
PROXY_KEY=

# 宿主机端口映射（供 docker compose 读取）
PROXY_PORT=3050

# 上游 Key（多个用英文逗号分隔；更推荐在 Web 后台动态添加）
CC_API_KEY=

# 日志级别 (debug / info / warn / error)
CC_LOG_LEVEL=info

# 运行时数据目录（Docker 内部为 /app/data）
CC_DATA_DIR=./data
```

---

## 环境变量完整列表

所有参数均可通过环境变量覆盖，方便容器化管理：

### 1. 服务与安全认证

| 环境变量 | 默认值 | 对应配置 | 说明 |
|---|---|---|---|
| `PORT` | `3000` (Docker 内为 `3050`) | `port` | 服务监听端口 |
| `HOST` | `0.0.0.0` | `host` | 服务监听网卡 IP |
| `ADMIN_PASSWORD` | 空 | - | **管理后台密码**。未设置时 `/admin/` 整体拒绝访问 |
| `ADMIN_COOKIE_SECURE` | 空 | - | 设置为 `1` 时给 Cookie 加 `Secure` 标记（**仅套了 HTTPS 时开启**） |
| `PROXY_KEY` | 空 | `proxyKey` | 数据面访问口令，非空时强制启用严格鉴权 |
| `CC_API_KEY` | 空 | `apiKey` | 上游 Key（多个逗号分隔，以只读模式载入池中） |
| `CC_DATA_DIR` | `./data` | - | 运行时数据目录（存储 UI Key、测试缓存、额度快照） |

### 2. 上游网络与代理池

| 环境变量 | 默认值 | 对应配置 | 说明 |
|---|---|---|---|
| `CC_API_BASE` | `https://api.commandcode.ai` | `apiBase` | 上游接口基地址 |
| `CC_PROXIES` | 空 | `proxies` | 出站代理列表，逗号分隔（支持 `pool+` / `#pool`） |
| `CC_PROXY_FILE` | 空 | `proxyFile` | 出站代理清单文件路径 |
| `CC_UPSTREAM_PROXY` | 空 | `upstreamProxy` | 单出站代理地址 |
| `CC_PROXY_HEALTH_INTERVAL_MS`| `900000` (15m) | - | 定时复查不健康代理的周期 |
| `CC_PROXY_HEALTH_TIMEOUT_MS` | `10000` (10s) | - | 代理健康检查超时时间 |
| `CC_PROXY_PROBE_TIMEOUT_MS`  | `10000` (10s) | - | 后台手动探测代理的超时时间 |

### 3. 反检测与协议伪装

| 环境变量 | 默认值 | 对应配置 | 说明 |
|---|---|---|---|
| `CC_FINGERPRINT_SALT` | 空 | `fingerprintSalt` | 设备指纹混淆盐，批量更换伪装硬件 |
| `CC_DEVICE_PROJECT_DIR` | 空 | `deviceProjectDir` | 伪装的工程目录绝对路径 |
| `CC_CLI_MODE` | `agent` | `cliMode` | 上游信封 mode 枚举值 |
| `CC_CLI_SESSION_MODE` | `interactive` | `cliSessionMode` | lifecycle 上报中的 mode 取值 |
| `CC_EMPTY_SYSTEM_PLACEHOLDER`| `true` | `emptySystemPlaceholder` | 无 system 消息时发送空格占位 |
| `CMD_ZDR` | 关 | `zdr` | 设为 `1` 开启 ZDR-only 路由请求头 |

### 4. 稳定性与资源防护

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `180000` (180s) | 流式读空闲超时。超时返回 429 引导 SDK 优雅重试 |
| `CC_NONSTREAM_IDLE_MS` | `90000` (90s) | 非流式读空闲超时 |
| `CC_UPSTREAM_RETRY_MAX` | `2` | 上游未吐字节前闪断的重试次数（共 3 次尝试），`0` 关闭 |
| `CC_UPSTREAM_RETRY_BASE_MS` | `400` | 闪断重试退避基数（毫秒） |
| `CC_MAX_INFLIGHT` | `0` (不限) | 进程内全局在途并发上限，超限返回 503 引导重试 |
| `CC_MAX_BODY_MB` | `100` | 请求体大小硬上限（MB），超限直接 413 |
| `CC_MAX_TOOL_IMAGE_MB` | `6` | 单请求内工具截图 Base64 总预算（MB），超限转占位符 |
| `CC_CLIENT_DRAIN_TIMEOUT_MS`| 空 | 客户端背压持续阻塞超时断开毫秒数（防僵尸连接） |
| `CC_KEEPALIVE_TIMEOUT_MS` | `65000` (65s) | HTTP Keep-Alive 空闲保持时长（反代必须小于此值） |
| `CC_WEB_SEARCH` | 关 | 设为 `1` 开启代执行 Anthropic Web Search 工具 |
| `CC_WEB_SEARCH_TIMEOUT_MS` | `8000` (8s) | 搜索子请求单次超时时间 |

---

## 可选：Redis 云端持久化

在不提供持久卷的云平台上运行时（Railway、Render、Zeabur、Fly.io、Serverless 容器等），可配置 Redis 作为运行时存储：原本写入 `data/` 的可变数据会以 JSON 值保存在同一个 Redis Hash 中，容器重启后启动即自动水合，不依赖本地磁盘。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `REDIS_URL`（或 `CC_REDIS_URL`） | 空 | Redis 连接串，支持 `redis://` 与 `rediss://`（TLS） |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_DB` / `REDIS_TLS` | `6379` / `0` / 关 | 分项连接配置，仅在 `REDIS_URL` 未设置时生效；均支持 `CC_REDIS_*` 别名 |
| `REDIS_PREFIX`（或 `CC_REDIS_PREFIX`） | `comm2api:` | Hash 键前缀（实际键名 `<prefix>state`），多实例共用一个 Redis 库时用于隔离 |

```bash
# 标准 Redis 或云端 TLS Redis（如 Upstash、Redis Cloud）
REDIS_URL=rediss://default:YOUR_REDIS_PASSWORD@redis.example.com:6379/0
REDIS_PREFIX=comm2api:
```

行为说明：

- **水合范围**：上游 Key（`keys.json`）、2API Key（`api-keys.json`）、运行时配置（`settings.json`）、管理密码（`.admin-auth.json`）、出站代理池（`proxies.json`）、禁用模型（`models.json`）、模型测试记录与额度快照。
- **写入策略**：每次写入先更新内存镜像并异步串行写回 Redis，同时尽力写一份本地文件；云端只读/临时文件系统下本地写入失败不影响服务。
- **首次迁移**：Redis Hash 为空且本地 `data/` 已有合法 `.json` 文件时，首次启动会自动迁入 Redis；之后以 Redis 为准。
- **故障降级**：Redis 短暂不可用时服务继续运行，待写入数据进入重试队列（指数退避，最长 30 秒）；进程收到 SIGTERM/SIGINT 时会先尝试刷出待写入数据再退出。
- **状态查看**：启动日志与后台「仪表盘 / 设置」页会显示当前存储模式、脱敏连接串、Hash 键名与已同步条目数。

---

## 出站代理池深度指南

让代理服务发往 Command Code 官方的请求走指定的出站代理，支持**多 IP 分散**、**轮换代理池接入**以及 **Key 与代理绑定**。

### 代理语法格式

```json
{
  "proxies": [
    "http://user:pass@127.0.0.1:7890",
    "pool+http://user:pass@pool.example.com:8080",
    "http://user:pass@pool2.example.com:8080#pool",
    "direct"
  ]
}
```

- **常规 HTTP 代理**：`http://user:pass@host:port`
- **轮换型代理池**：添加 `pool+` 前缀或 `#pool` 后缀（如 Resin 动态住宅代理，每次 TCP 出口 IP 都会变化）。轮换型条目**永不记录健康失败**，适合高并发动态出口。
- **直连**：`direct`。

### Key ↔ 代理绑定策略

在 Web 管理后台的「出站代理池」页面中，可以为每一个上游 Key 分配出口策略：

| 模式 | 行为特性 | 适用场景 |
|---|---|---|
| **自动 (Auto)** | 默认模式。按 `i % N` 静态均匀分配，故障时自动漂移到最空闲的健康代理，恢复后迁回 | 常规多账号负载均衡 |
| **固定 (Fixed)** | 严格绑定特定代理；该代理离线时**临时**借道其他健康代理，恢复后立即迁回 | 账号需固定在特定区域/IP |
| **每次轮换 (Round-Robin)** | 每次向发起请求均重新在健康池中挑一条代理 | 深度反追踪需求 |

> **关键机制说明**：
> 1. **全链路统一出口**：生成请求 (`/alpha/generate`)、设备指纹上报 (`/alpha/fingerprint/record`) 和 lifecycle 上报均使用**同一条出站代理**，绝不会出现「指纹走直连、推理走代理」的暴露漏洞。
> 2. **自建 CONNECT 隧道**：基于 Node.js 原生 socket 实现端到端 TLS 转发，零外部依赖，严格校验目标主机证书。

---

## 容量与资源限制配置

### 1. 请求体限制 (`CC_MAX_BODY_MB`)
默认 `100MB`。多模态长上下文对话往往包含大量高清图片 Base64，过小会导致大图请求被误杀。若部署在内存小于 1GB 的 VPS 上，建议降低至 `10MB` ~ `20MB`。

### 2. 工具截图预算 (`CC_MAX_TOOL_IMAGE_MB`)
默认 `6MB`。针对 Claude Code 或其他 Agent 产生的频繁桌面/浏览器全屏截图，当会话历史中的截图总 Base64 超过此预算时，代理会自动将较老的历史截图替换为文本占位符，保留最新鲜的上下文，防止请求体指数级膨胀。

### 3. 在途并发兜底 (`CC_MAX_INFLIGHT`)
默认 `0`（不限制）。在没有前置 Nginx 限制连接时，可设置为 `CC_MAX_INFLIGHT=16` 或 `32`。超额请求直接返回 `503 Service Unavailable` 并携带 `Retry-After: 5`，OpenAI / Anthropic 官方 SDK 会自动等待重试。
