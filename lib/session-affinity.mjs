// ── 会话级粘性（Sticky Session）────────────────────────
// 目的：连续使用 Coding Agent 时，同一会话尽量落在同一个上游账号上 ——
// 上游的前缀缓存是按账号/会话命名空间存放的，换号等于缓存全部作废（又慢又贵）。
//
// 但优先级必须清楚：**账号可用性与额度 > 严格代理隔离 > 会话粘性 > 负载均衡**。
// 所以这里只负责「记住上次用谁」，绝不负责「保证还用谁」——
// 是否真的可用由调度层决定，本模块提供的是「偏好」，不是「约束」。
//
// 几条刻意设计：
//   1) 会话键带**客户端命名空间**：两个不同 2API Key 的客户端即使都传了
//      同一个 x-session-id，也不会互相串号（那会把 A 客户的会话绑定到 B 客户的账号上）；
//   2) 只存 { sessionId → keyId } 与时间戳，**不存 prompt / 消息正文 / 凭据**；
//   3) 有界：TTL + 容量上限 + LRU 淘汰，长时间运行不会无界增长；
//   4) 纯内存：重启后粘性丢失是**预期行为**（比写盘更安全，也不会多一份隐私落盘风险），
//      额度快照与严格绑定才是必须持久化的状态。

export function createSessionAffinity({
  ttlMs = 30 * 60 * 1000,
  maxEntries = 5000,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  /** key → { keyId, at }；Map 的插入顺序天然是 LRU 顺序（访问时重新插入） */
  const map = new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expired = 0;

  // ttlMs / maxEntries 允许传函数：后台改配置后无需重建实例（热更新）
  const LIMIT = () => {
    const raw = typeof maxEntries === 'function' ? maxEntries() : maxEntries;
    return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 5000;
  };
  const TTL = () => {
    const raw = typeof ttlMs === 'function' ? ttlMs() : ttlMs;
    return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 30 * 60 * 1000;
  };

  function composite(namespace, sessionId) {
    // 用 \u0000 分隔：sessionId 里出现任何字符都不会与 namespace 产生歧义
    return `${namespace || ''}\u0000${sessionId || ''}`;
  }

  function sweep() {
    const t = now();
    const limit = TTL();
    for (const [k, v] of map) {
      if (t - v.at > limit) { map.delete(k); expired++; }
      // 插入顺序即时间顺序：遇到未过期的就可以停了
      else break;
    }
  }

  function get(namespace, sessionId) {
    if (!sessionId) return null;
    const k = composite(namespace, sessionId);
    const hit = map.get(k);
    if (!hit) { misses++; return null; }
    if (now() - hit.at > TTL()) { map.delete(k); expired++; misses++; return null; }
    // 触碰 → 移到队尾
    map.delete(k);
    map.set(k, { ...hit, at: now() });
    hits++;
    return hit.keyId;
  }

  function set(namespace, sessionId, keyId) {
    if (!sessionId || !keyId) return false;
    const k = composite(namespace, sessionId);
    map.delete(k);
    map.set(k, { keyId, at: now() });
    const limit = LIMIT();
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
      evictions++;
    }
    return true;
  }

  function drop(namespace, sessionId) {
    return map.delete(composite(namespace, sessionId));
  }

  /** 账号被删除/禁用时清理指向它的绑定，避免下次选中一个已经不存在的 id。 */
  function dropKey(keyId) {
    let n = 0;
    for (const [k, v] of map) if (v.keyId === keyId) { map.delete(k); n++; }
    return n;
  }

  function stats() {
    sweep();
    return {
      size: map.size,
      max: LIMIT(),
      ttlMs: TTL(),
      hits, misses, evictions, expired,
      hitRate: hits + misses > 0 ? Number((hits / (hits + misses)).toFixed(4)) : 0,
    };
  }

  function clear() {
    map.clear();
    hits = 0; misses = 0; evictions = 0; expired = 0;
  }

  // 定期清理：低频（默认 1 分钟）且 unref，不会阻止进程退出
  const timer = setInterval(() => {
    try { sweep(); } catch (e) { log('warn', '会话映射清理出错', { error: e.message }); }
  }, 60 * 1000);
  timer.unref?.();

  return { get, set, drop, dropKey, stats, clear, sweep, stop: () => clearInterval(timer), get size() { return map.size; } };
}

/**
 * 从请求里取「客户端会话标识」，**不依赖已选账号的 API Key**。
 *
 * 这是需求里特别强调的一条：会话选择必须发生在账号选择之前。
 * 若拿 apiKey 参与派生，就变成「先用 A 算会话、再拿会话去选账号」的循环依赖，
 * 结果是会话永远绑在第一次命中的账号上，额度耗尽后也无法迁移。
 *
 * @param {object} headers        入站 header（已转小写）
 * @param {string|null} promptCacheKey  OpenAI 的 prompt_cache_key
 * @param {string} namespace      客户端身份命名空间（2API Key id / proxyKey 指纹 / 'anon'）
 * @returns {{ id: string|null, source: string }}
 */
export function resolveSessionId(headers = {}, promptCacheKey = null, namespace = '') {
  const candidates = [
    ['x-session-id', headers['x-session-id']],
    ['x-claude-code-session-id', headers['x-claude-code-session-id']],
    ['session_id', headers['session_id']],
    ['x-conversation-id', headers['x-conversation-id']],
    ['prompt_cache_key', promptCacheKey],
  ];
  for (const [source, raw] of candidates) {
    if (typeof raw === 'string' && raw.trim().length >= 8) {
      return { id: `${namespace}:${raw.trim()}`, source };
    }
  }
  return { id: null, source: 'none' };
}
