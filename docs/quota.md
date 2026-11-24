# 官方额度与额度感知调度

这份文档说明 v2 新增的「官方额度采集 → 账号状态机 → 额度感知调度 → 会话粘性 → 告警」整条链路，
以及它如何与**已有的** Key 池、代理池、三协议兼容层共存。

设计底线只有一句：**新功能全部可选，关掉就等于升级前的行为**。

---

## 1. 为什么不是「用 token 数算额度」

Command Code 的套餐额度（尤其是 Go $1 的五小时窗口）是官方口径，
本地 token 计数与官方"已用额度"既不同单位也不同口径。因此：

- 官方数字只来自 `/alpha/whoami`、`/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/usage/summary`；
- 本地 token 统计仍然只用于「这个账号今天用了多少」这类**本地**指标，永远带 `source: 'local'`；
- 解析不到就以 `null` 表示「未知」，**绝不用 0 冒充未知**，也不做任何单位换算。

## 2. 数据落在哪

| 文件 | 内容 | 是否新增 |
|---|---|---|
| `data/quota.json` | 每个账号的官方额度快照 + 运行期封锁（耗尽/限流/鉴权）+ 采样历史 | 新增 |
| `data/keys.json` | 上游账号（不变） | 否 |
| `data/proxies.json` | 代理与绑定（新增 `strict_bind` 模式值） | 兼容 |
| `data/settings.json` | 后台设置（新增若干字段，缺省即可） | 兼容 |

`quota.json` 用 `keyId`（Key 池的稳定 id）做索引，**不用数组下标** ——
下标会在增删账号时整体错位，是最经典的「A 的额度显示到 B 身上」。

## 3. 账号状态机

状态是**运行期派生**的，不会覆盖用户手动设置的 `enabled`：

| 状态 | 含义 | 是否停止派发 |
|---|---|---|
| `available` | 一切正常 | 否 |
| `quota_warning` | 最紧张的窗口 ≥ 警戒阈值（默认 90%） | **否**（只降优先级） |
| `quota_exhausted` | 官方窗口明确耗尽，或上游明确返回额度错误 | 是 |
| `rate_limited` | 短期 RPM/并发限制（带 `Retry-After`） | 是（到期自动解除） |
| `proxy_unavailable` | 该账号的出站代理不可用（仅严格绑定会触发） | 是 |
| `auth_invalid` | 上游明确拒绝认证，需要人工处理 | 是 |
| `quota_unknown` | 没查到 / 数据过期 / 缺关键字段 | 默认**否**（可配 `quotaUnknownBlock`） |
| `manually_disabled` | 用户手动禁用 | 是 |

判定顺序：`手动禁用 > 鉴权失效 > 额度耗尽 > 限流 > 代理 > 未知 > 警告 > 可用`。

**为什么「额度未知」默认不封锁**：未知 ≠ 已满。把未知当已满，第一次部署就会因为
上游额度接口抖动而全站停服；把它当 100% 可用也不对 —— 所以它只被**排到最后**。

## 4. 恢复逻辑

额度耗尽后**不会**靠固定冷却「假设已恢复」：

1. 若官方给了 `resetAt`，就在 `resetAt` 之后触发一次额度刷新（`checkRecoveries`，上限 30 秒一次）；
2. 只有这次刷新**成功**且官方数据不再显示耗尽，账号才回到 `available`；
3. 官方没给 `resetAt` 时，用一个有界重试窗口（默认 5 分钟，`quotaFallbackCooldownMs`），
   到点同样要等一次成功刷新才解封；
4. 上游在推理时报的额度错误（`USAGE_EXCEEDED` 等）额外记一份带期限的封锁，
   **不受**官方快照冲刷（官方统计常滞后），只能等到期或被一次真实成功解除；
5. 后台可手动「清除运行期封锁」立即恢复（`POST /admin/api/quota/reset`）。

## 4.1 五小时窗口预热（开窗）

开启 `quotaAutoWarmup` 后（默认开启），后台会定期检查并发送一条极轻量请求
（`max_tokens: 16`）激活 5 小时窗口：

- 官方给了 `resetAt` 且已到点 → 重置后开下一轮（`auto_reset`）；
- 官方**没给** `resetAt`（实测未开窗时返回 `resetAt: 0`）→ 视为冷账号主动开窗（`auto_open`）。
  这类账号没有重置时间可等，只认 `resetAt` 会永远停在「重置时间未知」；
- 开窗后官方仍不给 `resetAt` 时，按「预热时间 + 5 小时」给出估算重置时间
  （标记 `resetEstimated`，前端显示「按预热时间估算」），同时按 5 小时窗口寿命兜底再开一次；
- 同一账号 30 分钟内不重复开窗，失败按指数退避（60s 起，上限 30 分钟）；
- 窗口已明确耗尽、代理不可用、鉴权失效或限流中都不预热；
- 冷窗口的开窗判断**不依赖**额度快照是否「过期」——采集间隔可以长于过期阈值，
  且冷窗口不会因为上次采集失败自己打开；
- 自动预热并发上限为 2，多个冷账号会分轮开窗。

手动入口：`POST /admin/api/quota/warmup`（`{ id }` 单个，空 body 全部）。

## 4.2 月度窗口口径

`/alpha/billing/credits` 返回的 `credits.monthlyCredits` 是**本月剩余额度**，不是上限。
月度百分比的分母优先级：

1. 套餐注册表里的总额度（`individual-go-v1` = 10，见 `lib/quota.mjs` 的 `PLAN_TOTAL_CREDITS`）；
2. 没有套餐信息时，用官方已用（`usage/summary` 的 `totalMonthlyCredits`）+ 剩余合成；
3. 两者都没有时保持 `null`，显示「部分未知」，不拿剩余额度冒充 100%。

已用 = 总额度 − 剩余额度，因此 `individual-go-v1` 会显示 `2.206 / 10`（22%），
与官方页面的 Monthly Limit 一致；重置时间仍取订阅的 `currentPeriodEnd`。

## 5. 调度优先级

```
手动禁用 → 已失效（鉴权） → 额度封锁 → 限流 → 严格代理不可用
        → 额度感知排序（可用 > 接近上限 > 未知）
        → 会话粘性（quota_sticky 且映射命中）
```

额度感知排序（`lib/quota-policy.mjs` 的 `rankAccount`）按「剩余额度」计算，
剩余比例先量化成 5% 一档，再按窗口分层（五小时 300 / 周 8 / 月 0.3），顺序固定为：

1. **五小时窗口剩余比例**（第一优先级）：五小时多一档，永远排在周/月更宽松的账号前面；
2. 五小时同档时看周窗口剩余比例；
3. 五小时、周都同档时看月 / 订阅窗口剩余比例；
4. 同档内：在途请求更少的账号优先 —— 并发不会全压在一个 Key 上；
5. 仍同档时（额度与在途都相同），优先更久没用过的账号，把流量在账号间摊开；
6. 官方采样预测「按当前速度会在重置前烧完」的账号在同档内降权（`forecastPenalty`）。

窗口缺失按中性值 0.5 参与计算：既不当成已用完，也不当成满额。
官方只返回百分比（没有 `used`/`cap`）时，按 `percentUsed` 计算剩余比例。
这套排序只在 `quota_aware` / `quota_sticky` 下生效；**不会**替换或改写
用户已有的 `round_robin / random / fill`。

「避免打爆 Key」还有三道独立保护：`accountMaxConcurrency` 限制单账号并发
（0 = 不限，建议多账号时设 2~4，对所有策略都生效）；同档内优先空闲账号；
上游 429 会记入运行期限流，短时间不再派发。

## 6. 当前请求内的自动换号

只有满足下面**全部**条件才允许跨账号重试：

- 上游以 HTTP 状态码拒绝（还没开始流式输出）；
- 下游尚未收到任何字节；
- 该账号是第一次在本请求里被尝试（每个候选账号最多一次）；
- `crossAccountRetry` 未被关闭。

已经输出 SSE 正文、已经产生工具调用、或上游可能已成功处理但响应丢失时，**一律不重放**。
流内早期 `error` 事件由各协议处理器的 `started` 标志把关，不在这一层处理。

## 7. 全部账号不可用时的响应

| 原因 | 状态码 | 说明 |
|---|---|---|
| 全部额度耗尽 / 限流 | **429** | 附 `Retry-After`（按最早官方重置时间，1..3600 秒） |
| 全部代理不可用 | **503** | 明确不是额度问题 |
| 全部鉴权失效 | **503** | 提示需要管理员处理 |
| 混合 | 429 或 503 | 依据是否含额度耗尽 |

三种协议的响应体形状各自符合其约定：OpenAI 用 `{error:{message,type,...}}`，
Anthropic 用 `{type:'error',error:{type:'rate_limit_error'|'overloaded_error',...}}`。

## 8. 严格代理绑定（`strict_bind`）

| 模式 | 语义 |
|---|---|
| `auto` | 静态分配 + 故障时转移到最空闲的健康代理（历史行为） |
| `bind` | 固定到某条；代理故障时**临时迁移**，恢复后迁回（历史行为） |
| `strict_bind` | **只能**用这一条：代理不可用 → 该账号停止派发（不迁移、不直连） |
| `rotate` | 每次尝试换一条健康代理 |

严格模式下，账号关联的**所有**上游请求都用同一个出口：
生成、指纹注册、生命周期事件、whoami、额度查询、模型目录、订阅查询。

目标被删除/停用时代码**保留**绑定并失败关闭（`routeFor()` 返回 `available: false`），
后台会显示「当前不可用：严格绑定的代理不存在或已被停用」。

## 9. 会话粘性

- 会话键来源：`x-session-id`、`x-claude-code-session-id`、`session_id`、`x-conversation-id`、`prompt_cache_key`（长度 ≥ 8）；
- 键带**客户端命名空间**（2API Key id / `shared`），不同客户端用同名 session id 也不会串号；
- 只存 `sessionId → keyId` 与时间戳，**不存 prompt / 正文 / 凭据**；
- 内存实现，TTL（默认 30 分钟）+ 容量上限（默认 5000）+ LRU 淘汰；重启后粘性丢失是预期行为；
- 账号不可用时映射自动迁移到新账号；**账号恢复后不强制迁回**。
- 命中粘性的会话优先使用绑定账号（利于 prompt cache）；要让并发更均匀，
  请配合 `accountMaxConcurrency`，达到上限后调度器会迁移到其他账号。
- 优先级编号 / `rank` 展示的是额度排序；会话粘性命中时实际派发以绑定账号为准。

## 10. 告警

默认关闭。配置 `alertsEnabled: true` + `alertsWebhookUrl` 后，会推送：

`quota_warning`、`quota_exhausted`、`quota_recovered`、`account_switched`、
`all_unavailable`、`auth_invalid`、`proxy_down`、`proxy_up`、`upstream_unhealthy`、`schema_changed`。

- 同一事件在去重窗口（默认 10 分钟）内只发一次；
- 发送在独立队列里，失败只记日志，**不影响推理**；
- payload 只含账号 id/脱敏名、窗口名、比例、时间，**绝不含** Key、代理口令、请求正文；
- Webhook 地址拒绝指向 loopback/私网/链路本地/云元数据地址，投递前会再做一次 DNS 校验（防 rebinding）；
  确需内网地址时显式开启 `alertsAllowPrivate`。

## 11. 新增配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `quotaRefreshIntervalMs` | 300000 | 后台刷新间隔（表单下限 30 秒） |
| `quotaTimeoutMs` | 10000 | 单次额度请求超时 |
| `quotaWarnRatio` | 0.9 | 软阈值（只降优先级） |
| `quotaUnknownBlock` | false | 额度未知是否也停派 |
| `quotaStaleMs` | 900000 | 超过即视为过期 |
| `quotaFallbackCooldownMs` | 300000 | 无官方 resetAt 时的重试窗口 |
| `quotaForecast` | true | 燃烧预测开关 |
| `quotaAutoWarmup` | true | 5 小时窗口预热：重置后自动开窗；`resetAt` 未知的冷账号也会主动开窗 |
| `accountMaxConcurrency` | 0 | 单账号并发上限（0 = 不限） |
| `crossAccountRetry` | true | 允许安全条件下的当前请求跨账号重试 |
| `sessionAffinity` | true | 会话粘性总开关 |
| `sessionAffinityTtlMs` | 1800000 | 会话映射 TTL |
| `sessionAffinityMax` | 5000 | 会话映射条数上限 |
| `alertsEnabled` | false | 告警总开关 |
| `alertsWebhookUrl` | `''` | Webhook 地址（后台不回显） |
| `alertsWebhookFormat` | `generic` | `generic` / `feishu` / `dingtalk` / `slack` |
| `alertsCooldownMs` | 600000 | 去重窗口 |
| `alertsTimeoutMs` | 8000 | 告警请求超时 |
| `alertsAllowPrivate` | false | 允许内网 Webhook（默认禁止） |

全部字段都可以缺省；旧配置文件无需改动即可启动。

## 12. 两账号分别使用各自代理的配置方法

1. 后台「🌐 代理池」添加 Proxy A、Proxy B（仅支持 HTTP CONNECT）；
2. 到「🔑 上游 Key」下方「代理绑定」把账号 A → `严格固定` + Proxy A，账号 B → `严格固定` + Proxy B；
3. 到「⚙️ 设置 → 官方额度与调度」把策略切到 `额度感知 + 会话粘性`（或 `quota_aware`）；
4. 「📈 用量 → 官方额度」点一次「刷新全部额度」，确认两个账号的五小时窗口都能读到。

等价的手工配置（`data/proxies.json`，指纹 = `sha256(代理地址)` 或 `sha256(上游 Key)` 的前 16 位十六进制）：

```json
{
  "version": 1,
  "entries": [
    { "id": "<sha256(ProxyA).slice(0,16)>", "value": "http://user:pass@1.2.3.4:8080", "enabled": true }
  ],
  "bindings": {
    "<sha256(账号A的Key).slice(0,16)>": { "mode": "strict_bind", "proxyId": "<ProxyA 的 id>" }
  }
}
```

## 13. 已知限制

- 额度接口的真实响应结构以线上为准；解析器对字段名/包装/时间格式做了兼容，但**新增**字段仍需适配；
- 无法预测「单个请求会花掉多少额度」，因此不做精确的超额预留，只做状态封锁 + 软阈值降权；
- 会话粘性不持久化（重启后从零开始），这是刻意的隐私/复杂度取舍；
- 燃烧预测依赖官方采样差值，窗口重置或统计回退时会主动返回「未知」。

## 14. 回滚

1. 把策略改回 `round_robin`（或其他原有策略）→ 额度感知立即停止参与调度；
2. 把需要恢复的账号绑定从 `strict_bind` 改回 `auto`/`bind`；
3. 需要彻底移除时回退到上一个镜像/提交即可：新增的 `data/quota.json` 会被旧版本忽略，
   旧版本也不会读取任何新配置字段（未知键被忽略）。
