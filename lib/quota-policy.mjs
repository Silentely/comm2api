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
  inflightPenalty: 6,          // 每个在途请求的排序惩罚：同档优先挑空闲账号，避免并发压满一个 Key
  forecastPenalty: 12,         // 预测会在重置前烧完的账号的排序惩罚（小于一个五小时档位，不跨档）
};

/**
 * 窗口层级权重：五小时 300、周 8、月 0.3。
 *
 * 只加权平均仍会出现「周余量足够大 → 压过五小时」的倒挂，所以先把窗口剩余
 * 量化成 20 档（每档 5%），再用一组**严格分层**的权重：五小时一档的差值
 * （15 分）大于周 + 月的全部权重（8.3 分），周的一档（0.4 分）大于月的全部
 * 权重（0.3 分）。效果是：
 *   五小时剩余多一档 → 永远排在前面，周/月再宽松也翻不过来；
 *   五小时同档 → 比周；周同档 → 比月。
 * 档位内的细微差别交给在途请求和「最久未用」来摊平，不需要连续分数。
 */
export const WINDOW_PRIORITY = { fiveHour: 300, weekly: 8, monthly: 0.3 };

/** 剩余比例量化档数：20 档 = 每档 5%。 */
export const WINDOW_BUCKETS = 20;

/** 窗口缺失时的中性压力：既不当成已用完（冤枉账号），也不当成满额（挤掉有真实数据的账号）。 */
const UNKNOWN_PRESSURE = 0.5;

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
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
 *   available      → 0 + 余量项 + 负载项
 *   quota_warning  → 1000（软阈值：往后排，但不封禁）
 *   quota_unknown  → 2000（未知不等于可用，排最后；但仍参与，避免自我制造停服）
 *
 * 余量项按窗口层级计算（见 WINDOW_PRIORITY / quotaRemainingScore）：五小时剩余
 * 一档（约 14.6 分）大于周 + 月的全部权重，所以短窗口永远优先，周/月只决定
 * 同一五小时档内的顺序。
 *
 * 负载项（在途请求数，最多计 4 个）与燃烧预测只做同档微调，不会跨过 1000 的状态档。
 */
export function rankAccount({
  state,
  ratio = null,
  snapshot = null,
  forecast = null,
  inflight = 0,
  policy = POLICY_DEFAULTS,
} = {}) {
  const base = state === 'available' ? 0 : state === 'quota_warning' ? 1000 : state === 'quota_unknown' ? 2000 : 10000;
  // 兼容旧调用：只给 ratio（最紧张的窗口）时，按「剩余 = 1 - ratio」参与排序。
  const remaining = snapshot
    ? quotaRemainingScore(snapshot)
    : (ratio === null ? null : 1 - clamp01(ratio));
  const pressure = remaining === null ? UNKNOWN_PRESSURE : clamp01(remaining);
  let score = base + (1 - pressure) * 300;

  // 在途请求：同一档里优先挑空闲账号，避免并发全压在一个 Key 上。
  // 最多计 4 个，避免负载项无限放大后盖过真实的额度差距。
  const perInflight = finite(policy?.inflightPenalty) ?? POLICY_DEFAULTS.inflightPenalty;
  if (inflight > 0) score += Math.min(inflight, 4) * perInflight;

  // 按当前速度会在重置前烧完的账号往后放 —— 有别的账号能撑到重置时先不用它。
  if (forecast?.status === 'ok' && forecast.willExhaustBeforeReset === true) {
    score += finite(policy?.forecastPenalty) ?? POLICY_DEFAULTS.forecastPenalty;
  }
  return score;
}

/**
 * 单个窗口的剩余比例（0..1）；官方没给任何可比值时返回 null。
 * 与 ratioOf / worstRatio 同源：优先用 percentUsed，再退回 used/cap ——
 * 官方有些端点只给百分比，不能因为缺 used/cap 就把它当成「未知」。
 */
export function remainingRatio(w) {
  const usedRatio = ratioOf(w);
  return usedRatio === null ? null : 1 - usedRatio;
}

/**
 * 多窗口剩余额度加权分（0..1，越大越宽裕）。
 *
 * 剩余比例先量化到 20 档（见 WINDOW_BUCKETS），再用 WINDOW_PRIORITY 加权求和。
 * 分层权重保证「五小时多一档」永远压过「周 + 月全部余量」，而加权平均做不到
 * （极端组合下会被周/月的大余量翻盘）。
 * 缺失的窗口按中性 0.5 计：既不当成已用完（冤枉账号），也不当成满额（挤掉有真实数据的账号）。
 */
export function quotaRemainingScore(snapshot) {
  let acc = 0;
  let total = 0;
  for (const [name, weight] of Object.entries(WINDOW_PRIORITY)) {
    const rem = remainingRatio(windowOf(snapshot, name));
    // 量化：同一档的细微差别交给在途请求数去摊平，不需要连续分数
    const level = rem === null ? UNKNOWN_PRESSURE : Math.round(clamp01(rem) * WINDOW_BUCKETS) / WINDOW_BUCKETS;
    acc += weight * level;
    total += weight;
  }
  return total > 0 ? acc / total : null;
}

/** 账号最紧张的窗口比例（0..1），用于展示；调度排序见 rankAccount。 */
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
