// ── 用量分析：时间窗聚合 ─────────────────────────────
// 与 lib/keys.mjs 的 usage 分工：
//   keys.mjs  记的是**账号累计**（今天/总计两档），用来回答「这个号用了多少」；
//   本模块记的是**逐请求明细的滑动窗口**，用来回答「最近 5 分钟 / 1 小时 / 5 小时是谁在打」。
//
// 三条约束：
//   1) 有界：固定容量的环形缓冲，长跑不涨内存（不引入 Redis/数据库）；
//   2) 零正文：只记时间、账号 id、模型名、协议、状态码、token 数、耗时 ——
//      **绝不记录 prompt / 消息正文 / 任何凭据**；
//   3) 本地统计与官方额度严格分开：本模块的数字永远带 `source: 'local'`，
//      官方额度在 lib/quota.mjs，两者绝不互相冒充。

export const WINDOWS = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '5h': 5 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function createUsageAnalytics({
  maxRecords = 20000,
  priceOf = null,          // (model) => { input, output, cacheRead } | null（USD / 1M tokens）
  now = () => Date.now(),
} = {}) {
  const cap = Math.max(100, Number(maxRecords) || 20000);
  const records = [];      // 环形：超过 cap 时从头部丢弃
  let dropped = 0;

  function record(rec) {
    if (!rec) return;
    const entry = {
      t: Number(rec.t) || now(),
      keyId: rec.keyId || null,
      model: rec.model || null,
      protocol: rec.protocol || null,
      streaming: !!rec.streaming,
      status: rec.status || 'ok',       // ok | error | aborted | switched
      httpStatus: Number.isFinite(rec.httpStatus) ? rec.httpStatus : null,
      tokensIn: Number(rec.tokensIn) || 0,
      tokensOut: Number(rec.tokensOut) || 0,
      cacheRead: Number(rec.cacheRead) || 0,
      cacheWrite: Number(rec.cacheWrite) || 0,
      latencyMs: Number.isFinite(rec.latencyMs) ? rec.latencyMs : null,
      ttftMs: Number.isFinite(rec.ttftMs) ? rec.ttftMs : null,
    };
    // 成本：只有注入了价目表才算，并且一律带 estimated 标记（官方没给可信费用）
    if (typeof priceOf === 'function') {
      try {
        const p = priceOf(entry.model);
        if (p && (Number.isFinite(p.input) || Number.isFinite(p.output))) {
          const inCost = (Math.max(0, entry.tokensIn - entry.cacheRead) / 1e6) * (Number(p.input) || 0);
          const cacheCost = (entry.cacheRead / 1e6) * (Number(p.cacheRead ?? p.input) || 0);
          const outCost = (entry.tokensOut / 1e6) * (Number(p.output) || 0);
          entry.costUsd = Number((inCost + cacheCost + outCost).toFixed(6));
          entry.costEstimated = true;
        }
      } catch { /* 价目表出错不影响统计 */ }
    }
    records.push(entry);
    if (records.length > cap) {
      const over = records.length - cap;
      records.splice(0, over);
      dropped += over;
    }
  }

  function slice(sinceMs) {
    const t = now() - sinceMs;
    // 记录是按时间递增的：从尾部回溯，遇到早于窗口的就停
    let i = records.length - 1;
    const out = [];
    while (i >= 0 && records[i].t >= t) { out.push(records[i]); i--; }
    return out;
  }

  function aggregate(list) {
    const acc = {
      requests: list.length,
      success: 0, failed: 0, aborted: 0, switched: 0,
      tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
      costUsd: 0, costEstimated: false,
    };
    const latencies = [];
    const ttfts = [];
    for (const r of list) {
      if (r.status === 'ok') acc.success++;
      else if (r.status === 'aborted') acc.aborted++;
      else if (r.status === 'switched') { acc.switched++; acc.success++; }
      else acc.failed++;
      acc.tokensIn += r.tokensIn;
      acc.tokensOut += r.tokensOut;
      acc.cacheRead += r.cacheRead;
      acc.cacheWrite += r.cacheWrite;
      if (Number.isFinite(r.costUsd)) { acc.costUsd += r.costUsd; acc.costEstimated = true; }
      if (Number.isFinite(r.latencyMs)) latencies.push(r.latencyMs);
      if (Number.isFinite(r.ttftMs)) ttfts.push(r.ttftMs);
    }
    latencies.sort((a, b) => a - b);
    ttfts.sort((a, b) => a - b);
    acc.successRate = acc.requests > 0 ? Number((acc.success / acc.requests).toFixed(4)) : 0;
    acc.cacheHitRate = acc.tokensIn > 0 ? Number((acc.cacheRead / acc.tokensIn).toFixed(4)) : 0;
    acc.costUsd = Number(acc.costUsd.toFixed(6));
    acc.latency = {
      avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    };
    acc.ttft = {
      avg: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      p50: percentile(ttfts, 50),
      p95: percentile(ttfts, 95),
    };
    // 缓存收益：按「命中价 vs 输入价」的差额估算（只有价目表存在时才有意义）
    acc.cacheSavingUsd = null;
    if (typeof priceOf === 'function' && acc.cacheRead > 0) {
      try {
        acc.cacheSavingUsd = null;   // 单模型维度在 groupBy 里给，这里不混算
      } catch { /* ignore */ }
    }
    return acc;
  }

  function groupBy(list, field) {
    const map = new Map();
    for (const r of list) {
      const k = r[field] ?? '(unknown)';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return [...map.entries()]
      .map(([key, items]) => ({ key, ...aggregate(items) }))
      .sort((a, b) => b.requests - a.requests);
  }

  /**
   * 报告。默认给全部时间窗 + 三个维度。
   * @param {object} [opts] { window: '5m'|'1h'|'5h'|'24h'|'7d', by: ['account','model','protocol','status'] }
   */
  function report({ window = '1h', by = ['account', 'model', 'protocol', 'status'] } = {}) {
    const span = WINDOWS[window] || WINDOWS['1h'];
    const list = slice(span);
    const field = { account: 'keyId', model: 'model', protocol: 'protocol', status: 'status' };
    const out = {
      source: 'local',
      window,
      windowMs: span,
      from: new Date(now() - span).toISOString(),
      to: new Date(now()).toISOString(),
      totals: aggregate(list),
      dimensions: {},
      capacity: { max: cap, stored: records.length, dropped },
    };
    for (const dim of by) {
      if (!field[dim]) continue;
      out.dimensions[dim] = groupBy(list, field[dim]);
    }
    return out;
  }

  /** 所有时间窗的精简概览（仪表盘用，避免前端拉 5 次全量） */
  function overview() {
    const out = {};
    for (const w of Object.keys(WINDOWS)) {
      const a = aggregate(slice(WINDOWS[w]));
      out[w] = {
        requests: a.requests, successRate: a.successRate,
        tokensIn: a.tokensIn, tokensOut: a.tokensOut,
        cacheHitRate: a.cacheHitRate, latencyP95: a.latency.p95,
        costUsd: a.costEstimated ? a.costUsd : null,
      };
    }
    return { source: 'local', windows: out, capacity: { max: cap, stored: records.length, dropped } };
  }

  function reset() { records.length = 0; dropped = 0; }

  return { record, report, overview, reset, get size() { return records.length; } };
}
