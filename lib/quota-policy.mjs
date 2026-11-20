// ── 额度策略：账号运行期状态机 + 调度排序 ────────────────
// 这一层是**纯函数**：不读盘、不发网络、不认识 Key 池的内部结构。
// 输入是「账号信号」（官方额度快照、运行期封锁时间、代理健康、手动启停），
// 输出是「账号状态 + 是否参与调度 + 排序得分」。
//
// 为什么要把状态机独立出来：
//   1) 状态是**运行期派生**的，绝不能被写回用户手设的 enabled 字段 ——
//      否则一次额度耗尽会让账号在后台看起来像「被自己关了」，管理员摸不着头脑；
//   2) 额度耗尽 / 限流 / 代理不可用 / 鉴权失效的处置完全不同（前者等重置，
//      后者要人工处理），混成一个 cooldown 只会让恢复时机变成瞎猜；
//   3) 纯函数可以穷举测试，包括「全部账号耗尽」「额度未知」这些边界。

/** 账号状态。与需求文档一一对应，不要随意增删（UI 与告警都按这些值分支）。 */
export const ACCOUNT_STATES = {
  available: '可用',
  quota_warning: '接近额度上限',
  quota_exhausted: '额度已耗尽',
  rate_limited: '短期限流中',
  proxy_unavailable: '出站代理不可用',
  auth_invalid: '鉴权失效',
  manually_disabled: '已手动禁用',
  quota_unknown: '额度未知',
};

/** 明确「这一刻绝对不能派发请求」的状态。quota_unknown 刻意不在其中。 */
const HARD_BLOCKING = new Set(['manually_disabled', 'quota_exhausted', 'rate_limited', 'proxy_unavailable', 'auth_invalid']);

/** 默认可调参数。全部来自 CFG，缺省值只在这里定义一份。 */
export const POLICY_DEFAULTS = {
  warnRatio: 0.9,              // 软阈值：只降优先级，不封禁
  hardRatio: 1,                // 硬上限：官方明确达到即停止派发
  unknownBlock: false,         // 额度未知时默认仍然放行（但排序靠后）
  unknownStaleMs: 15 * 60 * 1000,  // 超过此时长没有成功刷新 → 视为数据过期
  fallbackCooldownMs: 5 * 60 * 1000, // 额度耗尽但没有官方 resetAt 时的重试窗口（不是「已恢复」）
  minRetryAfterSec: 5,
  maxRetryAfterSec: 3600,
};

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** 取窗口对象（parse 阶段的产物）。null 表示「官方没给这个窗口」。 */
function windowOf(snapshot, name) {
  return snapshot?.windows?.[name] || null;
}

function ratioOf(w) {
  if (!w) return null;
  const pct = finite(w.percentUsed);
  if (pct !== null) return Math.min(Math.max(pct, 0), 1);
  const used = finite(w.used);
  const cap = finite(w.cap);
  if (used === null || cap === null || cap <= 0) return null;
  return Math.min(Math.max(used / cap, 0), 1);
}

/**
 * 一个窗口是否「明确耗尽」。
 * 只有在 **exceeded 明确为真** 或 **used/cap 都有效且达到上限** 时才算。
 * 缺字段、cap 为 0、只有 used 没有 cap —— 都不是耗尽，一律返回 false。
 */
export function windowExhausted(w) {
  if (!w) return false;
  if (w.exceeded === true) return true;
  const used = finite(w.used);
  const cap = finite(w.cap);
  if (used === null || cap === null || cap <= 0) return false;
  return used >= cap;
}

/** 窗口重置时间（毫秒）；没有可信值返回 null。 */
export function windowResetMs(w) {
  const ms = finite(w?.resetAtMs);
  return ms !== null && ms > 0 ? ms : null;
}

/**
 * 派生账号状态。优先级：手动禁用 > 鉴权 > 额度耗尽 > 限流 > 代理 > 未知 > 警告 > 可用。
 *
 * 注意顺序里「额度」排在「代理」之前：一个账号既额度耗尽又代理挂了时，
 * 它确实不该被派发请求，但**原因**要报成额度耗尽 —— 否则管理员会去修代理，
 * 而真正的问题五小时后会自己恢复。反过来，代理挂了但额度充足时绝不能报额度耗尽。
 */
export function deriveAccountState({
  enabled = true,
  snapshot = null,
  runtime = null,
  proxyStatus = null,      // { available:boolean, mode, reason }
  now = Date.now(),
  policy = POLICY_DEFAULTS,
} = {}) {
  if (!enabled) return { state: 'manually_disabled', reason: '账号已被手动禁用', untilMs: null };

  const rt = runtime || {};
  const authInvalidUntil = finite(rt.authInvalidUntilMs);
  if (authInvalidUntil && now < authInvalidUntil) {
    return { state: 'auth_invalid', reason: rt.authInvalidReason || '上游明确拒绝认证', untilMs: authInvalidUntil };
  }

  const exhaustedUntil = finite(rt.exhaustedUntilMs);
  const exhaustedNow = exhaustedUntil && now < exhaustedUntil;
  const exhaustedWindows = ['fiveHour', 'weekly', 'monthly']
    .map(n => windowOf(snapshot, n))
    .filter(w => windowExhausted(w));
  const officialReset = exhaustedWindows
    .map(w => windowResetMs(w))
    .filter(Boolean)
    .sort((a, b) => a - b)[0] ?? null;

  // ① 上游明确判过额度耗尽（HTTP 429 / USAGE_EXCEEDED 等）。
  // 这类封锁的解除条件比官方快照更严：官方统计常常滞后，用「官方说还有额度」
  // 立刻解封等于对着已限流的账号反复撞限。只等它自己到期，或被一次真实成功解除。
  const upstreamUntil = finite(rt.upstreamExhaustedUntilMs);
  if (upstreamUntil && now < upstreamUntil) {
    return {
      state: 'quota_exhausted',
      reason: rt.exhaustedReason || '上游明确判定额度耗尽',
      untilMs: upstreamUntil,
      window: rt.exhaustedWindow || null,
      fromUpstream: true,
    };
  }

  // ② 运行期封锁已到期（且官方 resetAt 不在未来）→ 必须等一次成功刷新才解封。
  // 用旧数据赌「它应该已经恢复了」会让请求白白撞一次限额。
  if (exhaustedUntil && now >= exhaustedUntil && rt.pendingRecovery
      && (officialReset === null || officialReset <= now)) {
    return {
      state: 'quota_exhausted',
      reason: '已到预计重置时间，等待官方额度重新确认',
      untilMs: now + policy.fallbackCooldownMs,
      awaitingRefresh: true,
    };
  }

  if (exhaustedNow || exhaustedWindows.length > 0) {
    // ③ 官方 resetAt 已过、但还没有一次新的成功刷新 → 数据已经“过期于窗口”，同样等重确认
    if (!exhaustedNow && officialReset !== null && officialReset <= now) {
      return {
        state: 'quota_exhausted',
        reason: '已到官方重置时间，等待重新确认额度',
        untilMs: now + policy.fallbackCooldownMs,
        awaitingRefresh: true,
      };
    }
    // 优先用官方 resetAt；没有就退到我们有界算的重试窗口（措辞明确是「重试」，不是「已恢复」）
    const untilMs = exhaustedNow ? exhaustedUntil : (officialReset ?? now + policy.fallbackCooldownMs);
    return {
      state: 'quota_exhausted',
      reason: rt.exhaustedReason || '官方额度窗口已耗尽',
      untilMs,
      window: rt.exhaustedWindow || null,
    };
  }

  const rateLimitedUntil = finite(rt.rateLimitedUntilMs);
  if (rateLimitedUntil && now < rateLimitedUntil) {
    return { state: 'rate_limited', reason: rt.rateLimitedReason || '上游短期限流', untilMs: rateLimitedUntil };
  }

  if (proxyStatus && proxyStatus.available === false) {
    return { state: 'proxy_unavailable', reason: proxyStatus.reason || '出站代理不可用', untilMs: null };
  }

  const fetchedAt = finite(snapshot?.fetchedAtMs);
  const hasWindow = !!(windowOf(snapshot, 'fiveHour') || windowOf(snapshot, 'weekly') || windowOf(snapshot, 'monthly'));
  const stale = !fetchedAt || (now - fetchedAt) > (policy.unknownStaleMs || POLICY_DEFAULTS.unknownStaleMs);
  if (!snapshot || !hasWindow || stale) {
    return {
      state: 'quota_unknown',
      reason: !snapshot ? '尚未取得官方额度' : (!hasWindow ? '官方响应里没有可用的额度窗口' : '额度数据已过期'),
      untilMs: null,
      stale,
    };
  }

  const ratios = ['fiveHour', 'weekly', 'monthly'].map(n => ratioOf(windowOf(snapshot, n))).filter(v => v !== null);
  const warnRatio = finite(policy.warnRatio) ?? POLICY_DEFAULTS.warnRatio;
  const worst = ratios.length ? Math.max(...ratios) : null;
  if (worst !== null && worst >= warnRatio) {
    return { state: 'quota_warning', reason: `最紧张的额度窗口已用 ${(worst * 100).toFixed(1)}%`, untilMs: null };
  }
  return { state: 'available', reason: '', untilMs: null };
}

/** 该状态是否禁止派发（quota_unknown 由配置决定）。 */
export function isHardBlocked(state, { unknownBlock = false } = {}) {
  if (HARD_BLOCKING.has(state)) return true;
  if (state === 'quota_unknown') return !!unknownBlock;
  return false;
}

/**
 * 排序得分（越小越优先）。仅在「都允许派发」的候选里用。
 *   available      → 0 + 负载项
 *   quota_warning  → 100（软阈值：往后排，但不封禁）
 *   quota_unknown  → 200（未知不等于可用，排最后；但仍参与，避免自我制造停服）
 */
export function rankAccount({ state, ratio = null }) {
  const base = state === 'available' ? 0 : state === 'quota_warning' ? 100 : state === 'quota_unknown' ? 200 : 1000;
  // 已用比例越低越优先（权重刻意小于 1，不会跨档）
  const load = ratio === null ? 0 : Math.min(Math.max(ratio, 0), 1) * 10;
  return base + load;
}

/** 账号最紧张的窗口比例（0..1），用于展示与排序。 */
export function worstRatio(snapshot) {
  const ratios = ['fiveHour', 'weekly', 'monthly']
    .map(n => ratioOf(windowOf(snapshot, n)))
    .filter(v => v !== null);
  return ratios.length ? Math.max(...ratios) : null;
}

/**
 * 全部账号都不可用时的 Retry-After。
 * 只有「额度耗尽」这一类才有可信恢复时间；代理不可达不该说「额度用完了」，
 * 由调用方按 503 处理（这里仍然给出一个有界退避值，避免客户端立刻重打）。
 */
export function retryAfterSecFor(accounts, { now = Date.now(), policy = POLICY_DEFAULTS } = {}) {
  const pool = (accounts || []).filter(a => a && a.state === 'quota_exhausted');
  if (pool.length === 0) return null;
  const waits = pool.map(a => (finite(a.untilMs) ?? now + policy.fallbackCooldownMs) - now)
    .filter(ms => Number.isFinite(ms));
  if (waits.length === 0) return null;
  const sec = Math.ceil(Math.min(...waits) / 1000);
  return Math.min(Math.max(sec, policy.minRetryAfterSec || 1), policy.maxRetryAfterSec || 3600);
}

/**
 * 汇总一组账号状态的「不可用原因」，用于给下游返回**正确**的错误类型：
 *   quota  → 429（额度耗尽，附 Retry-After）
 *   proxy  → 503（出口不通）
 *   auth   → 503（上游鉴权失效，需要管理员处理）
 *   mixed / none → 由调用方兜底
 * 只要还有账号处于「额度耗尽」以外的硬封锁状态，就不能报「额度用尽」——
 * 那会让运维去充值，而真正的问题是代理挂了。
 */
export function unavailabilitySummary(states) {
  const list = (states || []).filter(Boolean);
  if (list.length === 0) return { kind: 'none', detail: '' };
  const kinds = new Set(list.map(s => s.state));
  if (kinds.size === 1 && kinds.has('quota_exhausted')) {
    return { kind: 'quota', detail: '全部账号的官方额度均已耗尽' };
  }
  if (!kinds.has('quota_exhausted')) {
    if (kinds.has('proxy_unavailable')) return { kind: 'proxy', detail: '全部账号的出站代理均不可用' };
    if (kinds.has('auth_invalid')) return { kind: 'auth', detail: '全部账号的上游鉴权均失效' };
    if (kinds.has('rate_limited')) return { kind: 'rate_limit', detail: '全部账号正处于上游短期限流' };
    return { kind: 'unknown', detail: '没有可用的上游账号' };
  }
  // 混合：有耗尽也有别的 → 如实说明，但用额度耗尽作为主因（它同样导致无可用账号）
  return {
    kind: 'mixed',
    detail: '没有任何可用账号（额度耗尽 / 代理不可用 / 鉴权失效混合）',
    kinds: [...kinds],
  };
}
