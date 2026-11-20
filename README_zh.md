# comm2api

<p align="center">
  <strong>将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的高性能反向代理</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node version" />
  <img src="https://img.shields.io/badge/dependencies-zero-blue.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/docker-ready-2496ed.svg" alt="Docker Ready" />
  <img src="https://img.shields.io/badge/tests-350%2B%20pass-success.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" />
</p>

---

`comm2api` 是一个 Node.js 单进程服务，**后端零运行时依赖**。它把 Command Code 上游接口转换为标准的 **OpenAI Chat Completions**、**Anthropic Messages** 与 **OpenAI Responses API** 格式，并自带复古野兽派 Web 管理后台与官方额度感知调度能力。

已针对官方 CLI 源码（`command-code@1.91.1`）进行 1:1 协议逆向与反检测对齐。

---

## ✨ 核心特性

- **三协议原生兼备**：
  - OpenAI `/v1/chat/completions`（流式/非流式、Function Calling 工具调用、多模态识图、深度思考 `reasoning_content`）
  - Anthropic `/v1/messages`（支持 Claude Code 原生接入，集成 `web_search_20250305` 服务端搜索）
  - OpenAI Responses API (`/v1/responses`，内置首字静默保活 `: keepalive`)
- **零运行时依赖**：服务端纯原生 Node.js 实现（`node:http`、`node:crypto` 等），无 Express/Hono 等框架黑盒，轻量稳定，冷启动毫秒级。
- **📊 官方额度感知调度 (v2)**：
  - 定时采集官方额度窗口（包含 5 小时动态窗口与套餐状态）；
  - 内置账号状态机（正常 / 告警 / 耗尽 / 限流），额度用尽自动无缝切号；
  - 支持会话粘性（Sticky Session），保障多轮对话断点缓存收益。
- **🌐 出站代理池与 Key 绑定**：
  - 支持常规 HTTP 代理与轮换型住宅代理池（`pool+` / `#pool`）；
  - 支持 Key ↔ 代理固定绑定与故障平滑转移；全链路（生成/指纹/生命周期）统一出站 IP。
- **🥷 工业级反检测**：
  - 设备指纹按 API Key **确定性派生**（单 Key 永久绑定单台伪装设备）；
  - 单一真源伪装档案（`DEVICE_PROFILE`），系统环境与请求头绝不泄露宿主信息；
  - 自动清洗孤立 Emoji 代理项，规避上游 400 校验错误；空白 System 占位阻断隐式 7.5K token 注入。
- **🛡️ 生产级容灾与背压**：
  - 首字未吐出前遭遇上游闪断（RST/FIN），代理内部自动退避重试（下游完全无感）；
  - 内置 TCP 流控背压机制，客户端慢速读取时上游自动停顿，杜绝内存堆积；
  - 自适应学习并夹持各模型真实的 `max_tokens` 物理上限。
- **☁️ 可选 Redis 云端持久化**：
  - 无持久卷的云平台（Railway / Render / Fly.io / Serverless 容器等）可通过 `REDIS_URL` 或分项 `REDIS_*` 变量直接运行；
  - 启动时自动恢复上游 Key、2API Key、配置项、后台密码、代理池、模型状态与额度快照；Redis 为空时可从本地 `data/*.json` 自动迁入，退出前刷出待写入数据。
- **🖥️ 复古野兽派 Web 管理后台**：
  - 在线管理上游账号与动态签发 2API Key；
  - 实时查看官方额度余量、本地 Token 用量统计与出站代理健康状态；
  - 内置模型目录管理与在线连通性测试工具。

---

## ⚡ 快速上手

### 方式 1：Docker Compose 运行（推荐）

```bash
# 1. 复制配置文件模板
cp config.json.example config.json
cp .env.example .env

# 2. 配置后台管理密码
echo "ADMIN_PASSWORD=your_secure_password" >> .env

# 3. 启动容器
docker compose up -d
```

启动后打开浏览器访问 `http://127.0.0.1:3050/admin/` 登录管理后台。

### 方式 2：Node.js 本地运行

```bash
cp config.json.example config.json
pnpm install
ADMIN_PASSWORD=your_secure_password pnpm start
```

服务将在默认端口 `http://0.0.0.0:3050` 启动。

---

## 🔑 核心概念：两套 Key 体系

本项目明确分离**上游 Key** 与 **2API Key**，避免凭证泄露：

| 维度 | 上游 Key (Upstream Key) | 2API Key (Downstream Key) |
|---|---|---|
| **格式** | `user_` 开头 | `ccp_` 开头 |
| **是什么** | 你的 Command Code 账号官方凭据 | 本代理自行签发的分发密钥 |
| **使用者** | 服务端自身（用于打上游 API） | 最终调用方 / 客户端 / 团队成员 |
| **泄露风险** | 致命（相当于交出账号） | 安全（随时在后台吊销或改配额） |
| **配置位置** | 管理后台 `/admin/` 🔑 上游 Key | 管理后台 `/admin/` 🔐 2API Key |

---

## 💻 客户端接入示例

启动代理并签发 `ccp_` 开头的 2API Key 后，即可在各类应用中接入：

### 1. cURL (OpenAI Chat Completions)

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer ccp_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 2. Cursor / NextChat / 常见 AI 客户端

- **API Base URL**：`http://<服务器IP>:3050/v1`
- **API Key**：`ccp_your_token`
- **Model**：填写支持的模型（如 `deepseek/deepseek-v4-flash`、`claude-sonnet-4-6`、`gpt-5.5` 等）

### 3. Claude Code / OpenCode

对于 Anthropic Messages 协议：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3050"
export ANTHROPIC_API_KEY="ccp_your_token"
```

### 4. Python SDK (OpenAI)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3050/v1",
    api_key="ccp_your_token"
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

---

## 📚 完整文档中心

所有进阶功能、参数规格与底层原理已模块化归档于 `docs/` 目录：

| 文档 | 主要内容 |
|---|---|
| 🚀 **[部署指南 (Deployment)](docs/deployment.md)** | Docker、Compose、GHCR 镜像、Systemd、生产级 Nginx 反代配置、Keep-Alive 时序与内存调优 |
| ⚙️ **[配置手册 (Configuration)](docs/configuration.md)** | `config.json` 详解、`.env` 配置、完整环境变量清单、出站代理池语法规则与 Key 绑定 |
| 🔌 **[API 接口参考 (API Reference)](docs/api.md)** | Chat Completions、Messages、Responses API 协议规范、Web Search 服务端工具实现与错误码映射 |
| 📊 **[官方额度与调度 (Quota & Scheduling)](docs/quota.md)** | 官方额度采集原理、账号状态机运转逻辑、多账号轮询与额度耗尽自动切换机制 |
| 🛡️ **[底层架构与反检测 (Architecture)](docs/architecture.md)** | 硬件指纹派生算法、上游 9 键通信信封、首字未吐闪断重试、自适应 Token 上限学习与流控背压 |
| 🛠️ **[管理后台 API 契约 (Admin API)](docs/admin-api.md)** | 后台前后端唯一接口约定（Key 管理、用量统计、代理测试、模型配置） |
| 📐 **[设计约定 (Design Notes)](docs/design-notes.md)** | 本项目的架构设计哲学、既定取舍与约束原则 |

---

## 📂 项目结构简览

```text
comm2api/
├── proxy.mjs                 # 核心代理服务主入口 (数据面与协议分发)
├── lib/                      # 后端核心能力模块 (零外部依赖)
│   ├── admin-api.mjs         # 管理后台 RESTful API 实现
│   ├── auth.mjs              # 2API Key 与访问鉴权逻辑
│   ├── outbound-proxy.mjs    # 出站代理池与 CONNECT 隧道
│   ├── quota-poller.mjs      # 官方额度采集与调度状态机
│   └── web-search.mjs        # Anthropic 服务端 Web Search 执行器
├── web/                      # 管理后台前端源码 (Vue 3 + Tailwind CSS)
├── docs/                     # 模块化技术与使用文档
│   ├── deployment.md         # 部署指南
│   ├── configuration.md      # 配置参考
│   ├── api.md                # API 接口规范
│   ├── architecture.md       # 底层架构与反检测
│   ├── quota.md              # 额度感知与调度
│   ├── admin-api.md          # 后台接口契约
│   └── design-notes.md       # 设计约定
├── data/                     # 运行时持久化数据目录 (需挂载)
├── docker-compose.yml        # 生产 Docker Compose 编排
├── Dockerfile                # 容器构建文件
└── package.json              # 依赖与脚本声明
```

---

## ⚠️ 免责声明

本项目仅供**学习和研究**用途。

- **非官方**：本项目与 Command Code 官方无任何关联，非官方维护产品。
- **合规使用**：使用者须自行承担所有使用责任，请遵守相关服务条款与当地法律法规。

---

## 📄 开源许可

本项目基于 [MIT License](LICENSE) 开源。
