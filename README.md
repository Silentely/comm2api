# comm2api

<p align="center">
  <strong>High-performance reverse proxy converting Command Code API into OpenAI / Anthropic compatible endpoints</strong>
</p>

<p align="center">
  <strong>English</strong> | <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node version" />
  <img src="https://img.shields.io/badge/dependencies-zero-blue.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/badge/docker-ready-2496ed.svg" alt="Docker Ready" />
  <img src="https://img.shields.io/badge/tests-350%2B%20pass-success.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" />
</p>

---

`comm2api` is a single-process Node.js service with **zero runtime dependencies**. It bridges Command Code upstream APIs into standard **OpenAI Chat Completions**, **Anthropic Messages**, and **OpenAI Responses API** formats, featuring a retro-brutalist Web admin dashboard and official quota-aware scheduling.

Rigorously reverse-engineered and aligned 1:1 with the official CLI source code (`command-code@1.91.1`).

---

## ✨ Features

- **3-in-1 Protocol Compatibility**:
  - OpenAI `/v1/chat/completions` (Streaming SSE / Non-streaming, Function Calling, Multimodal Vision, Reasoning Effort `reasoning_content`)
  - Anthropic `/v1/messages` (Native support for Claude Code, integrated `web_search_20250305` server tool execution)
  - OpenAI Responses API (`/v1/responses`, built-in `: keepalive` SSE comments to prevent client timeout)
- **Zero Runtime Dependencies**: Built purely on Node.js standard libraries (`node:http`, `node:crypto`, `node:fs`). Extremely lightweight, sub-second cold starts, tested by 350+ test suites.
- **📊 Quota-Aware Multi-Account Scheduling (v2)**:
  - Scrapes official quota windows (including the dynamic 5-hour rolling limit and plan status);
  - Account health state machine (`available`, `quota_warning`, `quota_exhausted`, `rate_limited`) with automatic failover to healthy accounts;
  - Sticky session support to preserve Prompt Cache hit rates.
- **🌐 Outbound Proxy Pool & Key Binding**:
  - Supports standard HTTP proxies and rotating residential proxy pools (`pool+` / `#pool`);
  - Per-key proxy binding with transparent failover; unified outbound IP across generation, fingerprint, and lifecycle requests.
- **🥷 Industrial-Grade Anti-Detection**:
  - Deterministic hardware fingerprints per API Key (same key always masquerades as the same machine);
  - Single-source hardware profile (`DEVICE_PROFILE`, Windows x64); never leaks host platform or environment details;
  - Automated lone UTF-16 surrogate cleansing to prevent upstream 400 validation errors; blank system placeholder blocks implicit ~7.5K token default prompt injection.
- **🛡️ Production Reliability & Backpressure**:
  - Transparent pre-first-byte retry on transient connection resets (RST/FIN) with exponential backoff;
  - TCP stream backpressure prevents memory exhaustion when downstream clients read slowly;
  - Automatically learns and clamps model-specific physical `max_tokens` limits.
- **☁️ Optional Redis Persistence**:
  - Runs on platforms without persistent volumes (Railway, Render, Fly.io, serverless containers) via `REDIS_URL` or discrete `REDIS_*` variables;
  - Hydrates keys, 2API tokens, settings, password hash, proxies, model state and quota snapshots at boot, seeds an empty Redis from existing `data/*.json`, and flushes pending writes on shutdown.
- **🖥️ Retro-Brutalist Web Admin Dashboard**:
  - Manage upstream accounts and issue 2API keys dynamically;
  - Real-time quota metrics, local token usage analytics, and proxy health monitoring;
  - Integrated model catalog management and live connectivity testing tools.

---

## ⚡ Quick Start

### Method 1: Docker Compose (Recommended)

```bash
# 1. Copy configuration templates
cp config.json.example config.json
cp .env.example .env

# 2. Set an admin dashboard password
echo "ADMIN_PASSWORD=your_secure_password" >> .env

# 3. Start the container
docker compose up -d
```

Open your browser and navigate to `http://127.0.0.1:3050/admin/` to log into the admin dashboard.

### Method 2: Local Node.js

```bash
cp config.json.example config.json
pnpm install
ADMIN_PASSWORD=your_secure_password pnpm start
```

The service will listen on `http://0.0.0.0:3050` by default.

---

## 🔑 Core Concept: Two Kinds of Keys

This project clearly decouples **Upstream Keys** from **2API Keys** to protect credentials:

| Aspect | Upstream Key | 2API Key (Downstream Key) |
|---|---|---|
| **Format** | Starts with `user_` | Starts with `ccp_` |
| **What it is** | Official Command Code account token | Custom token issued by this proxy |
| **Used by** | The proxy server (to call upstream CC API) | End clients / Applications / Team members |
| **Leak Risk** | Critical (surrenders account access) | Safe (can be revoked or limited in panel) |
| **Management** | Admin Panel `/admin/` 🔑 Upstream Keys | Admin Panel `/admin/` 🔐 2API Keys |

---

## 💻 Client Integration Examples

Once the proxy is running and you have issued a `ccp_` token, connect your favorite AI tools:

### 1. cURL (OpenAI Chat Completions)

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer ccp_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 2. Cursor / NextChat / Common AI Clients

- **API Base URL**: `http://<server-ip>:3050/v1`
- **API Key**: `ccp_your_token`
- **Model**: Any supported model ID (e.g. `deepseek/deepseek-v4-flash`, `claude-sonnet-4-6`, `gpt-5.5`)

### 3. Claude Code / OpenCode

For Anthropic Messages API:

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

## 📚 Documentation Center

Detailed operational guides, configuration parameters, and internal architecture are modularized in the `docs/` folder:

| Document | Description |
|---|---|
| 🚀 **[Deployment Guide](docs/deployment.md)** | Docker, Compose, GHCR images, Systemd service, production Nginx reverse proxy configuration, Keep-Alive timing, and memory tuning |
| ⚙️ **[Configuration Reference](docs/configuration.md)** | Complete `config.json` reference, `.env` file guide, environment variables reference, outbound proxy syntax, and key binding |
| 🔌 **[API Reference](docs/api.md)** | Chat Completions, Messages, Responses API specifications, Anthropic Web Search server tool execution, and error code mappings |
| 📊 **[Quota & Scheduling](docs/quota.md)** | Official quota scraping mechanics, account state machine, pool rotation, and automated failover |
| 🛡️ **[Architecture & Anti-Detection](docs/architecture.md)** | Hardware fingerprint derivation, 9-key wire protocol envelopes, pre-first-byte retry, adaptive token learning, and stream backpressure |
| 🛠️ **[Admin API Contract](docs/admin-api.md)** | RESTful API specifications between backend and web dashboard |
| 📐 **[Design Notes](docs/design-notes.md)** | Architectural philosophy, deliberate trade-offs, and project constraints |

---

## 📂 Project Structure

```text
comm2api/
├── proxy.mjs                 # Core proxy server entry point (data plane & routing)
├── lib/                      # Backend modules (zero external dependencies)
│   ├── admin-api.mjs         # Admin dashboard RESTful API implementation
│   ├── auth.mjs              # 2API Key & downstream authentication
│   ├── outbound-proxy.mjs    # Outbound proxy pool & CONNECT tunneling
│   ├── quota-poller.mjs      # Quota scraping & scheduling state machine
│   └── web-search.mjs        # Anthropic server tool web search executor
├── web/                      # Admin dashboard source (Vue 3 + Tailwind CSS)
├── docs/                     # Modular documentation center
│   ├── deployment.md         # Deployment guide
│   ├── configuration.md      # Configuration reference
│   ├── api.md                # API reference
│   ├── architecture.md       # Architecture & anti-detection
│   ├── quota.md              # Quota & scheduling
│   ├── admin-api.md          # Admin API contract
│   └── design-notes.md       # Design notes
├── data/                     # Persistent runtime data directory (mounted volume)
├── docker-compose.yml        # Production Docker Compose orchestration
├── Dockerfile                # Container build specification
└── package.json              # Project scripts & dev dependencies
```

---

## ⚠️ Disclaimer

This project is strictly for **educational and research purposes**.

- **Unofficial**: This project is not affiliated with, endorsed by, or sponsored by Command Code.
- **Compliance**: Users are solely responsible for adhering to applicable terms of service and regulations.

---

## 📄 License

Distributed under the [MIT License](LICENSE).
