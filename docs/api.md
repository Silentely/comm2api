# API 接口参考规范 (API Reference)

`comm2api` 提供了三套主流的大模型协议兼容接口：**OpenAI Chat Completions**、**Anthropic Messages API** 以及 **OpenAI Responses API**。

---

## 目录

- [通用认证与调用规则](#通用认证与调用规则)
- [POST /v1/chat/completions (OpenAI)](#post-v1chatcompletions-openai)
- [POST /v1/messages (Anthropic)](#post-v1messages-anthropic)
  - [Web Search 服务端工具实现](#web-search-服务端工具实现)
- [POST /v1/responses (OpenAI Responses API)](#post-v1responses-openai-responses-api)
- [GET /v1/models (模型列表)](#get-v1models-模型列表)
- [GET /health (健康探针)](#get-health-健康探针)
- [错误码与状态映射体系](#错误码与状态映射体系)

---

## 通用认证与调用规则

### 认证 Header
支持以下任意一种形式传入 Key：
- `Authorization: Bearer <API_KEY>`
- `x-api-key: <API_KEY>`

### Key 的传入类型
1. **启用 2API Key 保护时**（推荐）：传入在管理后台签发的 `ccp_` 开头凭据，服务端会自动在后台可用池中调度上游账号。
2. **直通模式时**（未设 2API Key 保护）：客户端直接传入自身 Command Code 的 `user_` 开头账号 Key。

---

## POST /v1/chat/completions (OpenAI)

兼容 OpenAI 标准格式，支持流式 SSE、非流式、多轮对话、Function Calling、多模态识图与深度思考输出。

### 请求参数说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model` | string | 是 | - | 模型名称（如 `deepseek/deepseek-v4-flash`、`claude-sonnet-4-6`） |
| `messages` | array | 是 | - | 消息数组，支持角色：`system`, `user`, `assistant`, `tool` |
| `stream` | boolean | 否 | `false` | 是否开启 SSE 流式输出 |
| `max_tokens` | integer | 否 | `64000` | 最大输出 token 数（遇模型物理上限自动学习并适配） |
| `temperature` | number | 否 | - | 采样温度 (0.0 ~ 2.0) |
| `reasoning_effort` | string | 否 | - | 思考模型推理强度：`low` / `medium` / `high` / `max` |
| `tools` | array | 否 | - | Function Calling 工具定义数组 |
| `tool_choice` | string/object | 否 | - | 工具选择策略（如 `"auto"`、`"none"`、`{"type":"function",...}`） |

### 基础调用示例 (cURL)

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer ccp_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "你好，请介绍一下你自己"}],
    "stream": true
  }'
```

### 多模态识图请求示例

```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "请详细描述这幅图片的内容" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..." } }
    ]
  }]
}
```

### 响应流格式 (SSE Chunk)

流式传输时，思考内容通过 `delta.reasoning_content` 透传，最终 chunk 附带真实 Token 统计与 Prompt 缓存命中数据：

```text
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"正在分析问题..."}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好！我是"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":25,"total_tokens":145,"prompt_tokens_details":{"cached_tokens":104}}}

data: [DONE]
```

---

## POST /v1/messages (Anthropic)

原生兼容 Anthropic Messages API，专为 **Claude Code**、Anthropic SDK 及相关生态无缝对接设计。

### 协议差异自动转译矩阵

| Anthropic 规范 | OpenAI / CC 内部映射 | 转换处理细节 |
|---|---|---|
| 顶层 `system` 字段 | `role: "system"` 消息 | 自动提权并拼接至 System 提示词结构 |
| 块状内容 `content: [{type:"text",...}]` | 文本 / 多模态对象 | 自动扁平化与多模态重组 |
| `tool_result` 块 | `role: "tool"` | 依据 `tool_use_id` 精确对齐历史调用 |
| `input_schema` | `parameters` | 完美兼容 JSON Schema 规范 |
| `thinking.budget_tokens` | `reasoning_effort` | 阈值映射：≥10000→`high`, ≥5000→`medium`, ≥2000→`low` |
| `stop_reason` | `finish_reason` | `end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`tool_calls` |

### 调用示例

```bash
curl http://127.0.0.1:3050/v1/messages \
  -H "x-api-key: ccp_your_token" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "system": "你是一个资深架构师。",
    "messages": [{"role": "user", "content": "请对比 Redis 和 Memcached"}],
    "stream": true
  }'
```

### Web Search 服务端工具实现

当使用 Claude Code 等客户端请求 `web_search_20250305` 服务端工具时：
- 若未启用 `CC_WEB_SEARCH`：代理会自动剥离未实现的服务端工具定义，防止上游因缺乏 Schema 抛出 400 异常。
- 若启用 `CC_WEB_SEARCH=1`：代理会捕获模型的 `web_search` 调用，直接调用上游自带的 `/alpha/web-search` 获取真实网络结果，并将结果作为 `server_tool_use` / `web_search_tool_result` 回填模型完成单轮流式续写。

---

## POST /v1/responses (OpenAI Responses API)

为新版 OpenAI Responses API（Codex 等）提供兼容支持。

- **流式保活与首字静默消除**：针对大上下文思考模型，在上游未吐字的前 15~40 秒内，代理每 5 秒发送一条 SSE 注释行 `: keepalive`，彻底解决中间层（反代、CDN）因空闲无数据主动斩断连接（499/504）的问题。
- **无状态设计**：不支持 `previous_response_id`，客户端需在每轮交互中传入完整 `input` 数组。

```bash
curl http://127.0.0.1:3050/v1/responses \
  -H "Authorization: Bearer ccp_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}]
  }'
```

---

## GET /v1/models (模型列表)

动态返回当前代理支持的模型列表。默认优先从官方 Provider API 获取最新可用模型（内置 5 分钟内存缓存），上游不可用时自动回落至内置预设列表。

```bash
curl http://127.0.0.1:3050/v1/models -H "Authorization: Bearer ccp_your_token"
```

---

## GET /health (健康探针)

用于 Docker 容器健康检查或 Kubernetes Liveness/Readiness 探活。

- **返回状态**：`200 OK`
- **特点**：探活请求不计入在途并发限制，不占用访问日志。

---

## 错误码与状态映射体系

### 代理自身生成的错误码

| HTTP 状态 | 错误类别 (type) | 触发场景 |
|---|---|---|
| `400` | `invalid_request_error` | 请求体 JSON 不合法、缺少必需参数、传递了不支持的会话继承 ID |
| `401` | `authentication_error` | 缺少 Authorization/x-api-key 或格式错误（非 `ccp_` / `user_`） |
| `404` | `not_found_error` | 访问了不存在的 API 路由 |
| `413` | `request_too_large` | 请求体大小超过 `CC_MAX_BODY_MB`（连接保持优雅关闭） |
| `429` | `rate_limit_error` | 触发流空闲超时（默认 180s）、非流式零输出防御，带 `Retry-After` 头 |
| `502` | `upstream_error` | 上游 Command Code 网络不可达、连接重置或返回畸形响应 |
| `503` | `server_busy` | 超过进程内全局并发上限 `CC_MAX_INFLIGHT`，引导客户端退避重试 |

### 上游状态码转换表 (CC_STATUS_MAP)

| 上游原始状态码 | 下游映射状态码 | 错误分类 (code / type) |
|---|---|---|
| `400` | `400` | `invalid_request_error` |
| `401` / `403` | `401` | `authentication_error` |
| `402` (额度不足) | `429` | `rate_limit_error` (透传 retry_after) |
| `404` | `404` | `not_found_error` |
| `422` | `400` | `invalid_request_error` |
| `429` | `429` | `rate_limit_error` |
| `500` / `502` | `502` | `upstream_error` |
| `503` | `503` | `temporarily_unavailable` |
