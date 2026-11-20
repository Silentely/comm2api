// ── 告警（可选 Webhook）──────────────────────────────
// 设计约束（都是需求里明确要求的）：
//   1) **默认关闭**：没配 URL 就什么都不做，不产生任何网络请求；
//   2) 告警失败绝不影响推理：所有发送都在 fire-and-forget 队列里，异常只进日志；
//   3) 去重：同一个事件在冷却窗口内只发一次（额度耗尽这种事会在几十个并发请求里重复触发）；
//   4) 不泄露：payload 只放 keyId / 脱敏名 / 比例 / 时间，**禁止**任何 Key、代理口令、请求正文；
//   5) URL 安全校验：拒绝指向 loopback / 私网 / 链路本地 / 云元数据地址的地址，
//      并在真正投递前再做一次 DNS 解析校验（防 DNS rebinding）。
import { lookup } from 'dns/promises';

export const ALERT_TYPES = {
  quota_warning: '额度接近上限',
  quota_exhausted: '账号额度耗尽',
  account_switched: '账号自动切换',
  all_unavailable: '全部账号不可用',
  quota_recovered: '账号额度恢复',
  proxy_down: '严格绑定代理异常',
  proxy_up: '严格绑定代理恢复',
  upstream_unhealthy: '上游连续异常',
  schema_changed: '官方响应结构变化',
  auth_invalid: '账号鉴权失效',
};

const MAX_QUEUE = 100;

/** 字面量私网/保留地址判断（不解析 DNS）。 */
export function isPrivateAddress(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;           // 链路本地 / 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                          // 组播/保留
    return false;
  }
  // IPv6：::1 / fc00::/7（ULA）/ fe80::/10（链路本地）
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    return false;
  }
  return false;
}

/** Webhook URL 基础校验。返回 null 表示通过，否则返回错误说明。 */
export function validateWebhookUrl(raw, { allowPrivate = false } = {}) {
  const s = String(raw || '').trim();
  if (!s) return '未配置 Webhook 地址';
  let u;
  try { u = new URL(s); } catch { return 'Webhook 地址不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Webhook 只支持 http:// 或 https://';
  if (!allowPrivate && isPrivateAddress(u.hostname)) {
    return 'Webhook 不允许指向本机或内网地址（如需放行，请显式开启 alertsAllowPrivate）';
  }
  return null;
}

export function createAlerter({
  log = () => {},
  fetchImpl = globalThis.fetch,
  config = null,
  now = () => Date.now(),
} = {}) {
  const cfg = () => (typeof config === 'function' ? config() : (config || {}));
  const lastSent = new Map();   // dedupeKey → 上次发送时间
  const queue = [];
  let draining = false;
  const counters = { sent: 0, failed: 0, deduped: 0, dropped: 0 };

  function enabled() {
    const c = cfg();
    return !!c.alertsEnabled && !!String(c.alertsWebhookUrl || '').trim();
  }

  function cooldownMs() {
    const v = Number(cfg().alertsCooldownMs);
    return Number.isFinite(v) && v >= 5000 ? v : 10 * 60 * 1000;
  }

  function formatPayload(type, payload, format) {
    const title = ALERT_TYPES[type] || type;
    const lines = [`[comm2api] ${title}`];
    const p = payload || {};
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined || v === '') continue;
      lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    const text = lines.join('\n');
    if (format === 'feishu') return { msg_type: 'text', content: { text } };
    if (format === 'dingtalk') return { msgtype: 'text', text: { content: text } };
    if (format === 'slack') return { text };
    return { source: 'comm2api', type, title, text, payload: p, at: new Date(now()).toISOString() };
  }

  async function deliver(job) {
    const c = cfg();
    const urlError = validateWebhookUrl(c.alertsWebhookUrl, { allowPrivate: !!c.alertsAllowPrivate });
    if (urlError) { log('warn', '告警未发送：Webhook 配置不合法', { error: urlError }); counters.failed++; return; }

    let u;
    try { u = new URL(String(c.alertsWebhookUrl).trim()); } catch { counters.failed++; return; }

    // DNS 层再校验一次（防 rebinding）：字面量 IP 已经在上一步拦过，这里只查域名
    if (!c.alertsAllowPrivate && !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && !u.hostname.includes(':')) {
      try {
        const list = await lookup(u.hostname, { all: true });
        if (list.some(a => isPrivateAddress(a.address))) {
          log('warn', '告警未发送：Webhook 域名解析到内网地址');
          counters.failed++;
          return;
        }
      } catch (e) {
        log('warn', '告警未发送：Webhook 域名解析失败', { error: e.message });
        counters.failed++;
        return;
      }
    }

    const timeoutMs = Number(c.alertsTimeoutMs) > 0 ? Number(c.alertsTimeoutMs) : 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetchImpl(u.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formatPayload(job.type, job.payload, c.alertsWebhookFormat)),
        signal: controller.signal,
      });
      if (!res || !res.ok) {
        counters.failed++;
        log('warn', '告警发送失败', { status: res?.status ?? null, type: job.type });
      } else {
        counters.sent++;
      }
    } catch (e) {
      counters.failed++;
      log('warn', '告警发送异常', { error: String(e?.message || e), type: job.type });
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try { await deliver(job); } catch { /* deliver 内部已兜底 */ }
      }
    } finally {
      draining = false;
    }
  }

  /**
   * 发一条告警（非阻塞）。
   * @param {string} type       ALERT_TYPES 里的类型
   * @param {object} payload    只允许放非敏感、可枚举的字段
   * @param {object} [opts]     { dedupeKey, force }
   */
  function emit(type, payload = {}, opts = {}) {
    if (!enabled()) return { sent: false, reason: 'disabled' };
    const dedupeKey = opts.dedupeKey || `${type}:${JSON.stringify(payload).slice(0, 120)}`;
    if (!opts.force) {
      const last = lastSent.get(dedupeKey) || 0;
      if (now() - last < cooldownMs()) { counters.deduped++; return { sent: false, reason: 'deduped' }; }
    }
    if (queue.length >= MAX_QUEUE) { counters.dropped++; return { sent: false, reason: 'queue_full' }; }
    lastSent.set(dedupeKey, now());
    // 去重表本身也要有界
    if (lastSent.size > 500) {
      const oldest = lastSent.keys().next();
      if (!oldest.done) lastSent.delete(oldest.value);
    }
    queue.push({ type, payload });
    // 不 await：告警永远不能拖慢请求处理
    drain().catch(() => {});
    return { sent: true };
  }

  function stats() {
    return { enabled: enabled(), queue: queue.length, ...counters, cooldownMs: cooldownMs() };
  }

  /** 后台「测试通知」用：跳过去重，但依旧受 URL 校验与超时约束。 */
  async function testSend() {
    const urlError = validateWebhookUrl(cfg().alertsWebhookUrl, { allowPrivate: !!cfg().alertsAllowPrivate });
    if (urlError) return { ok: false, error: urlError };
    await deliver({ type: 'upstream_unhealthy', payload: { 说明: '这是一条测试通知', 时间: new Date(now()).toISOString() } });
    return { ok: true };
  }

  return { emit, stats, testSend, enabled };
}
