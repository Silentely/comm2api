// ── 官方额度：采集 / 解析 / 缓存 / 预测 ──────────────────
// 目标：让后台看到的是**官方口径**的五小时 / 周 / 月额度，而不是用 token 数猜出来的数字。
//
// 三条硬规则（写在最前面，因为后续每一处实现都在守它们）：
//   1) 额度查询必须走**该账号绑定的出站代理** —— 出口不一致比不查更可疑；
//   2) 解析失败 ≠ 额度为零。缺失字段一律留 null，绝不用 0 冒充未知；
//   3) 一个接口失败不影响其它接口已经拿到的数据，但也绝不把旧快照标成「实时」。
//
// 数据结构（data/quota.json）：
//   accounts[keyId] = { 官方快照（windows / identity / credits / subscriptions / usage） }
//   runtime[keyId]  = { 运行期封锁（耗尽 / 限流 / 鉴权）+ 采样历史 }
// keyId 用 Key 池的稳定 id，**不用数组下标** —— 下标会在增删账号时整体错位，
// 那是最经典的「A 的额度显示到 B 身上」。
import { createHash } from 'crypto';
import { dataPath, readJSON, writeJSONAtomic, createDebouncedWriter } from './store.mjs';
import {
  POLICY_DEFAULTS, deriveAccountState, isHardBlocked, worstRatio, rankAccount, quotaRemainingScore,
} from './quota-policy.mjs';

export const QUOTA_PATH = dataPath('quota.json');
const FILE_VERSION = 2;

/** 行情端点。顺序即查询顺序（whoami 最便宜，先确认这个 Key 还能用）。 */
export const ENDPOINTS = {
  whoami: '/alpha/whoami',
  credits: '/alpha/billing/credits',
  subscriptions: '/alpha/billing/subscriptions',
  usage: '/alpha/usage/summary',
};

/**
 * 套餐月度总额度（官方 CLI 1.93.2 的套餐注册表）。
 *
 * `credits.monthlyCredits` 是**剩余**额度，官方页面的「月度已用百分比」
 * 按 `(套餐总额 - 剩余) / 套餐总额` 计算。没有这张表就只能把「剩余」
 * 当成「上限」，显示出 2.206 / 7.795 这种偏大的百分比。
 */
const PLAN_TOTAL_CREDITS = {
  'individual-go': 10,
  'individual-go-v1': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
};
const PLAN_IDS = Object.keys(PLAN_TOTAL_CREDITS).sort((a, b) => b.length - a.length);

/** 套餐 ID → 月度总额度；未知套餐返回 null。支持 `_`/大小写与带后缀的 ID。 */
export function planTotalCredits(planId) {
  if (!planId) return null;
  const n = String(planId).toLowerCase().replace(/_/g, '-');
  const hit = PLAN_IDS.find(id => n === id || n.startsWith(id));
  return hit ? PLAN_TOTAL_CREDITS[hit] : null;
}

const DEFAULT_TIMEOUT_MS = 10 * 1000;
const MAX_SAMPLES = 48;
// 5 小时窗口长度：官方没给 resetAt 时用它兜底计算下一次开窗时间
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
// 预热成功后的短防抖：只拦住同一时刻的重复成功，不要拖慢真正的窗口重置
const WARMUP_DEBOUNCE_MS = 2 * 60 * 1000;

// ── 基础取值工具 ────────────────────────────────────
/** 归一化字段名：大小写、下划线、连字符、空格都不敏感（camel/snake 一次覆盖）。 */
function norm(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim().replace(/,/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
  }
  return null;
}

/**
 * 时间归一化：Unix 秒 / 毫秒 / ISO 字符串 / 数字字符串。
 * 超出合理区间（2020..2100）一律当作**不可信**返回 null —— 上游把
 * 「秒」写成「毫秒」或反过来时，宁可显示「未知」也不要显示 1970 / 55000 年。
 */
export function toTimeMs(v) {
  const MIN = Date.UTC(2020, 0, 1);
  const MAX = Date.UTC(2100, 0, 1);
  if (v === null || v === undefined) return null;
  let ms = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 1e11 是秒/毫秒的分水岭：1e11 秒 ≈ 5138 年，1e11 毫秒 ≈ 1973 年
    ms = v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return toTimeMs(Number(s));
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === null) return null;
  if (ms < MIN || ms > MAX) return null;
  return ms;
}

/** 在一个对象里按「归一化名」找字段。多个别名按顺序取第一个有值的。 */
function field(node, aliases) {
  if (!isObj(node)) return undefined;
  const map = new Map();
  for (const [k, v] of Object.entries(node)) map.set(norm(k), v);
  for (const a of aliases) {
    const key = norm(a);
    if (map.has(key)) {
      const v = map.get(key);
      if (v !== null && v !== undefined) return v;
    }
  }
  return undefined;
}

/** 递归找第一个满足条件的值（有界，避免上游返回巨大结构时耗尽 CPU）。 */
function deepFind(node, predicate, { maxDepth = 6, budget = 3000 } = {}) {
  const stack = [{ node, depth: 0 }];
  while (stack.length > 0) {
    if (budget-- <= 0) return undefined;
    const { node: cur, depth } = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const hit = predicate(cur);
    if (hit !== undefined) return hit;
    if (depth >= maxDepth) continue;
    const values = Array.isArray(cur) ? cur : Object.values(cur);
    for (const v of values) if (v && typeof v === 'object') stack.push({ node: v, depth: depth + 1 });
  }
  return undefined;
}

// ── 窗口识别 ───────────────────────────────────────
const USED_ALIASES = ['used', 'usedAmount', 'usedCredits', 'usedUnits', 'consumed', 'spent', 'usage', 'current', 'usedTokens', 'utilized', 'usedQuota'];
const CAP_ALIASES = ['cap', 'limit', 'max', 'maximum', 'total', 'allowance', 'quota', 'capacity', 'maxCredits', 'limitCredits', 'hardLimit', 'totalCredits'];
const EXCEEDED_ALIASES = ['exceeded', 'isExceeded', 'exhausted', 'isExhausted', 'limitReached', 'blocked', 'overLimit'];
const RESET_ALIASES = ['resetAt', 'resetsAt', 'reset_at', 'resetTime', 'nextResetAt', 'resetAtMs', 'windowResetAt', 'endsAt', 'periodEnd', 'expiresAt', 'reset'];
const PERCENT_ALIASES = ['percentUsed', 'usedPercent', 'percent', 'percentage', 'utilization', 'usedRatio', 'ratio'];
const NAME_ALIASES = ['name', 'type', 'window', 'period', 'key', 'kind', 'label', 'scope', 'limitType'];

/** 窗口名 → 归一化种类。顺序重要：week 必须在 month 之前判（weekly 里也含 'w'）。 */
function classifyWindow(rawName) {
  const n = String(rawName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return null;
  if (/5h|5hour|fivehour|5hr|fiveh|fhr|short/.test(n)) return 'fiveHour';
  if (/week|weekly|7d|sevenday/.test(n)) return 'weekly';
  if (/month|monthly|30d|billing|subscription|cycle|period|plan/.test(n)) return 'monthly';
  return null;
}

function readWindowCandidate(node, path) {
  if (!isObj(node)) return null;
  const used = num(field(node, USED_ALIASES));
  const cap = num(field(node, CAP_ALIASES));
  const exceeded = bool(field(node, EXCEEDED_ALIASES));
  const resetAtMs = toTimeMs(field(node, RESET_ALIASES));
  const percentRaw = num(field(node, PERCENT_ALIASES));

  const ownName = field(node, NAME_ALIASES);
  const pathName = path.length ? path[path.length - 1] : '';
  const parentName = path.length > 1 ? path[path.length - 2] : '';
  const kind = classifyWindow(ownName) || classifyWindow(pathName) || classifyWindow(parentName);

  // 没有任何「像额度窗口」的信号 → 不是窗口
  if (kind === null && used === null && cap === null) return null;
  if (used === null && cap === null && exceeded !== true) return null;

  let percentUsed = null;
  if (percentRaw !== null) {
    // 0..1 与 0..100 两种口径都见过：>1.5 视为百分数
    percentUsed = percentRaw > 1.5 ? percentRaw / 100 : percentRaw;
    if (!Number.isFinite(percentUsed) || percentUsed < 0) percentUsed = null;
  } else if (used !== null && cap !== null && cap > 0) {
    percentUsed = used / cap;
  }

  return {
    kind: kind || 'other',
    label: typeof ownName === 'string' ? ownName : (pathName || ''),
    path: path.join('.'),
    used,
    cap,
    exceeded: exceeded === true || (used !== null && cap !== null && cap > 0 && used >= cap),
    resetAtMs,
    percentUsed,
  };
}

/** 遍历整棵响应，收集所有「像额度窗口」的对象。 */
function collectWindows(root, opts = {}) {
  const out = [];
  const seen = new Set();
  const stack = [{ node: root, path: [], depth: 0 }];
  let budget = opts.budget ?? 4000;
  while (stack.length > 0 && budget-- > 0) {
    const { node, path, depth } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => { if (v && typeof v === 'object') stack.push({ node: v, path: [...path, String(i)], depth: depth + 1 }); });
      continue;
    }
    const cand = readWindowCandidate(node, path);
    if (cand) out.push(cand);
    if (depth >= (opts.maxDepth ?? 7)) continue;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') stack.push({ node: v, path: [...path, k], depth: depth + 1 });
    }
  }
  return out;
}

/** 同一窗口有多个候选时打分：有 used+cap 优先，其次有 resetAt，其次路径更具体。 */
function scoreWindow(w) {
  let s = 0;
  if (w.used !== null && w.cap !== null) s += 10;
  else if (w.used !== null || w.cap !== null) s += 4;
  if (w.resetAtMs) s += 3;
  if (w.exceeded) s += 1;
  s += Math.min(w.path.split('.').length, 5) * 0.1;
  return s;
}

/** 把候选窗口压成 { fiveHour, weekly, monthly }，同种类取分最高的一个。 */
function pickWindows(candidates) {
  const best = new Map();
  for (const c of candidates) {
    if (c.kind === 'other') continue;
    const cur = best.get(c.kind);
    if (!cur || scoreWindow(c) > scoreWindow(cur)) best.set(c.kind, c);
  }
  const out = {};
  for (const [kind, w] of best) {
    out[kind] = {
      used: w.used,
      cap: w.cap,
      percentUsed: w.percentUsed,
      exceeded: w.exceeded,
      resetAtMs: w.resetAtMs,
      label: w.label,
      path: w.path,
      // 部分字段缺失是常态（例如只给 used 不给 cap），标记出来供 UI 显示「部分未知」
      partial: w.used === null || w.cap === null,
    };
  }
  return out;
}

// ── 各端点解析 ─────────────────────────────────────
function unwrap(payload) {
  if (!isObj(payload)) return payload;
  // 顶层对象 / data 包装对象两种形态都见过。合并不是替换：有些响应同时在顶层
  // 放了 success/code，只在 data 里放业务数据。
  if (isObj(payload.data)) return { ...payload, ...payload.data };
  return payload;
}

/** whoami → 账号身份（脱敏：只留 id / 邮箱 / 套餐名，不保存任何 token）。 */
export function parseIdentity(payload) {
  const root = unwrap(payload);
  if (!isObj(root)) return null;
  const src = isObj(root.user) ? { ...root, ...root.user } : root;
  const id = field(src, ['id', 'userId', 'user_id', 'sub', 'accountId', 'uid']);
  const email = field(src, ['email', 'mail', 'userEmail']);
  // 实测 /alpha/whoami 返回 user.name / user.userName，**没有** plan 字段 ——
  // 套餐名要从 /alpha/billing/subscriptions 的 planId 拿（见 buildSnapshot）。
  const name = field(src, ['name', 'displayName', 'username', 'userName']);
  const plan = field(src, ['plan', 'planName', 'planType', 'tier', 'subscription', 'product', 'package']);
  const planObj = isObj(plan) ? plan : null;
  const planName = planObj
    ? (field(planObj, ['name', 'id', 'slug', 'type', 'tier']) ?? null)
    : (typeof plan === 'string' ? plan : null);
  return {
    userId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    email: typeof email === 'string' ? email : null,
    name: typeof name === 'string' ? name : null,
    plan: planName ? String(planName) : null,
    planKind: String(field(src, ['planKind', 'kind', 'accountType']) ?? '') || null,
    organization: (() => {
      const o = field(src, ['organization', 'org', 'company']);
      if (typeof o === 'string') return o;
      if (isObj(o)) { const n = field(o, ['name', 'id']); return typeof n === 'string' ? n : null; }
      return null;
    })(),
  };
}

/**
 * billing/credits → 余额与月度额度。
 *
 * 实测结构（2026-11）是嵌套的：
 *   { credits: { monthlyCredits, purchasedCredits, freeCredits, belowThreshold, creditThreshold },
 *     windowLimits: { fiveHour, weekly, limited, exceeded }, sandboxAccess }
 * `monthlyCredits` 是**本月剩余**（官方 CLI 也按 remaining 使用），不是上限；
 * 月度上限要么来自套餐注册表，要么由「剩余 + 已用」合成。这里只如实采集原始数字。
 */
export function parseCredits(payload) {
  const root = unwrap(payload);
  if (!isObj(root)) return null;
  // 余额/额度可能包在 credits 子对象里（实测如此），也可能平铺在顶层
  const bag = isObj(root.credits) ? { ...root, ...root.credits } : root;
  const remainingRaw = field(bag, ['remaining', 'remainingCredits', 'balance', 'available', 'creditsRemaining', 'creditBalance']);
  const totalRaw = field(bag, ['total', 'cap', 'limit', 'creditsTotal', 'totalCredits', 'allowance']);
  const usedRaw = field(bag, ['used', 'usedCredits', 'consumed', 'spent']);
  const currency = field(bag, ['currency', 'unit', 'denomination']);
  const exhausted = bool(field(bag, ['exhausted', 'isExhausted', 'limitReached', 'depleted']));

  const monthlyRemaining = num(field(bag, ['monthlyCredits', 'monthlyCredit', 'monthlyAllowance']));
  const purchased = num(field(bag, ['purchasedCredits']));
  const free = num(field(bag, ['freeCredits']));
  const belowThreshold = bool(field(bag, ['belowThreshold']));
  const threshold = num(field(bag, ['creditThreshold']));

  let remaining = num(remainingRaw);
  let total = num(totalRaw);
  const used = num(usedRaw);
  if (remaining === null && total !== null && used !== null) remaining = total - used;
  if (remaining === null && used === null && total === null && exhausted === null && monthlyRemaining === null) return null;

  return {
    remaining,
    total,
    used,
    currency: typeof currency === 'string' ? currency : null,
    // 「明确耗尽」只认官方信号或「余额已知且 <= 0」，绝不用「没查到」推断
    exhausted: exhausted === true || (remaining !== null && remaining <= 0),
    monthlyRemaining: monthlyRemaining ?? remaining,
    purchasedCredits: purchased,
    freeCredits: free,
    belowThreshold: belowThreshold === true,
    threshold,
  };
}

/** billing/subscriptions → 套餐周期。 */
export function parseSubscriptions(payload) {
  const root = unwrap(payload);
  if (!root) return null;
  const listRaw = Array.isArray(root) ? root
    : (Array.isArray(field(root, ['subscriptions', 'items', 'data', 'plans'])) ? field(root, ['subscriptions', 'items', 'data', 'plans']) : null);
  const single = !listRaw && isObj(root) ? root : null;
  const items = listRaw || (single ? [single] : []);
  const out = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    // 实测字段是 planId: "individual-go-v1"（而不是 plan.name）
    const plan = field(it, ['plan', 'planName', 'planId', 'product', 'sku', 'tier', 'name']);
    const status = field(it, ['status', 'state', 'subscriptionStatus']);
    const planName = isObj(plan) ? field(plan, ['name', 'id', 'slug']) : plan;
    const startAt = toTimeMs(field(it, ['currentPeriodStart', 'periodStart', 'startAt', 'startedAt', 'startDate', 'createdAt']));
    const endAt = toTimeMs(field(it, ['currentPeriodEnd', 'periodEnd', 'endAt', 'endsAt', 'expiresAt', 'renewsAt', 'nextBillingDate', 'expiryDate']));
    const cancel = bool(field(it, ['cancelAtPeriodEnd', 'cancelAt', 'cancelled', 'canceled']));
    if (!planName && !status && !endAt) continue;
    out.push({
      plan: planName ? String(planName) : null,
      status: typeof status === 'string' ? status : null,
      periodStartMs: startAt,
      periodEndMs: endAt,
      cancelAtPeriodEnd: cancel === true,
    });
  }
  return out.length ? out : null;
}

/** usage/summary → 官方汇总用量（只保留数值，不保留任何正文）。 */
export function parseUsageSummary(payload) {
  const root = unwrap(payload);
  if (!isObj(root)) return null;
  const total = {
    requests: num(field(root, ['requests', 'requestCount', 'totalRequests', 'calls', 'totalCount', 'completedCount'])),
    inputTokens: num(field(root, ['inputTokens', 'input_tokens', 'promptTokens', 'tokensIn', 'totalTokensIn'])),
    outputTokens: num(field(root, ['outputTokens', 'output_tokens', 'completionTokens', 'tokensOut', 'totalTokensOut'])),
    cacheReadTokens: num(field(root, ['cacheReadTokens', 'cachedInputTokens', 'cacheRead'])),
    costUsd: num(field(root, ['costUsd', 'cost', 'totalCost', 'spendUsd', 'amountUsd', 'spend', 'totalCredits'])),
    // 本期**已使用的月度信用额度**：与套餐总额度（或 credits.monthlyCredits 剩余）合起来才是月度窗口
    monthlyCredits: num(field(root, ['totalMonthlyCredits', 'monthlyCreditsUsed', 'monthlyUsed'])),
  };
  const windows = parseWindows(root);
  const period = {
    startMs: toTimeMs(field(root, ['periodStart', 'currentPeriodStart'])),
    endMs: toTimeMs(field(root, ['periodEnd', 'currentPeriodEnd'])),
    basis: (() => {
      const v = field(root, ['periodBasis']);
      return typeof v === 'string' ? v : null;
    })(),
  };
  const hasTotals = Object.values(total).some(v => v !== null);
  // 没有汇总数字、也没有窗口 → 这个响应确实没有可用信息
  if (!hasTotals && Object.keys(windows).length === 0) return null;
  return { total: hasTotals ? total : null, windows, period };
}

/** 把一个端点响应解析成窗口集合（导出是为了可单测）。 */
export function parseWindows(payload) {
  return pickWindows(collectWindows(unwrap(payload)));
}

/**
 * 合并四个端点的响应 → 一份快照。
 * 每个端点独立成败：失败的那个把字段留空并记进 `partial`，成功的照常保留。
 */
export function buildSnapshot({ whoami, credits, subscriptions, usage, fetchedAt = Date.now(), errors = {} } = {}) {
  const windows = {};
  const pushWindows = (w, source) => {
    for (const [k, v] of Object.entries(w || {})) {
      // 已有更完整的数据时不覆盖（先到先得会让 whoami 的空窗口盖掉 credits 的真窗口）
      if (windows[k] && (windows[k].used !== null || windows[k].cap !== null)) continue;
      windows[k] = { ...v, source };
    }
  };

  const identity = whoami ? parseIdentity(whoami) : null;
  const creditInfo = credits ? parseCredits(credits) : null;
  const subs = subscriptions ? parseSubscriptions(subscriptions) : null;
  const usageInfo = usage ? parseUsageSummary(usage) : null;

  if (whoami) pushWindows(parseWindows(whoami), 'whoami');
  if (credits) pushWindows(parseWindows(credits), 'credits');
  if (subscriptions) pushWindows(parseWindows(subscriptions), 'subscriptions');
  if (usage) pushWindows(usageInfo?.windows || parseWindows(usage), 'usage');

  // 套餐周期结束时间：既是月度窗口的重置时间，也是周/月窗口 resetAt 的兜底
  const periodEnd = (subs || []).map(s => s.periodEndMs).filter(Boolean).sort((a, b) => a - b)[0]
    ?? usageInfo?.period?.endMs ?? null;

  // 订阅的 planId 是官方计费套餐；whoami 里的 plan 只作兜底。
  const planId = subs?.[0]?.plan || identity?.plan || null;

  /**
   * 月度窗口：官方没有单独的 monthly 窗口对象，数字分散在 credits / usage 两个端点。
   *
   * `credits.monthlyCredits` 是**剩余**额度（官方 CLI 同样按 remaining 使用），
   * 所以不能拿它当分母。分母按以下优先级确定：
   *   1) 套餐注册表里的总额度（individual-go-v1 = 10）；已用 = 总额 - 剩余
   *   2) 没有套餐信息时，用「已用 + 剩余」合成总额度
   * 这样 individual-go-v1 会显示 2.206 / 10（22%），而不是 2.206 / 7.795（28%）。
   */
  const monthlyUsed = usageInfo?.total?.monthlyCredits ?? usageInfo?.total?.costUsd ?? null;
  const monthlyRemaining = creditInfo?.monthlyRemaining ?? null;
  const extraCredits = (creditInfo?.purchasedCredits || 0) + (creditInfo?.freeCredits || 0);
  const planTotal = planTotalCredits(planId);
  const prevMonthly = windows.monthly || {};
  const prevComplete = prevMonthly.used !== null && prevMonthly.used !== undefined
    && prevMonthly.cap !== null && prevMonthly.cap !== undefined;

  if (!prevComplete && (monthlyUsed !== null || monthlyRemaining !== null || planTotal !== null)) {
    let used = null;
    let cap = null;
    if (planTotal !== null && planTotal > 0) {
      cap = planTotal;
      used = monthlyRemaining !== null ? Math.max(0, planTotal - monthlyRemaining) : monthlyUsed;
    } else if (monthlyUsed !== null && monthlyRemaining !== null) {
      used = monthlyUsed;
      cap = monthlyUsed + monthlyRemaining + extraCredits;
    } else if (creditInfo?.total !== null && creditInfo?.total !== undefined
      && creditInfo?.remaining !== null && creditInfo?.remaining !== undefined) {
      // 接口明确给了总额度与余额：直接相减，仍然是官方数字。
      cap = creditInfo.total;
      used = monthlyUsed !== null ? monthlyUsed : Math.max(0, creditInfo.total - creditInfo.remaining);
    } else {
      used = monthlyUsed ?? prevMonthly.used ?? null;
      cap = prevMonthly.cap ?? null;
    }
    const exceeded = prevMonthly.exceeded === true || creditInfo?.exhausted === true
      || (used !== null && cap !== null && cap > 0 && used >= cap);
    windows.monthly = {
      used,
      cap,
      percentUsed: used !== null && cap !== null && cap > 0
        ? Math.min(used / cap, 1)
        : (prevMonthly.percentUsed ?? null),
      exceeded,
      resetAtMs: prevMonthly.resetAtMs ?? periodEnd ?? null,
      label: prevMonthly.label || (planTotal !== null ? 'plan' : 'credits+usage'),
      path: planTotal !== null ? 'credits+plan' : 'credits+usage',
      partial: used === null || cap === null,
      source: planTotal !== null ? 'credits+plan' : 'credits+usage',
    };
  } else if (prevComplete && creditInfo?.exhausted === true) {
    windows.monthly = { ...prevMonthly, exceeded: true };
  } else if (creditInfo && creditInfo.exhausted && !windows.monthly) {
    // 没有月度额度数字，但官方明确说耗尽 → 仍然要封锁，只是数值未知
    windows.monthly = {
      used: creditInfo.total !== null && creditInfo.remaining !== null ? creditInfo.total - creditInfo.remaining : null,
      cap: creditInfo.total,
      percentUsed: creditInfo.total !== null && creditInfo.total > 0 && creditInfo.remaining !== null
        ? 1 - creditInfo.remaining / creditInfo.total : null,
      exceeded: true,
      resetAtMs: periodEnd,
      label: 'credits',
      path: 'credits',
      partial: true,
      source: 'credits',
    };
  }

  if (periodEnd) {
    for (const kind of ['weekly', 'monthly']) {
      if (windows[kind] && !windows[kind].resetAtMs) windows[kind].resetAtMs = periodEnd;
    }
  }

  const failed = Object.keys(errors).filter(k => errors[k]);
  return {
    fetchedAtMs: fetchedAt,
    fetchedAt: new Date(fetchedAt).toISOString(),
    identity,
    plan: planId,
    windows,
    credits: creditInfo,
    subscriptions: subs,
    usage: usageInfo?.total || null,
    errors: { ...errors },
    partial: failed,
    complete: failed.length === 0,
  };
}

// ── 燃烧预测 ───────────────────────────────────────
/**
 * 用官方采样差值估算「按当前速度会不会在重置前烧完」。
 *
 * 只在样本足够、且同一窗口（resetAt 不变）时才算：
 *   - 窗口刚重置 → 采样跨度不足，返回 unknown
 *   - 官方统计回退（used 变小）→ 停止预测，而不是给出负速度
 * 绝不用本地 token 统计冒充官方用量。
 */
export function forecastBurn(samples, { now = Date.now(), kind = 'fiveHour', minSpanMs = 90 * 1000 } = {}) {
  const points = (samples || [])
    .filter(s => s && s.kind === kind)
    .filter(s => Number.isFinite(s.t) && Number.isFinite(s.used))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) return { status: 'unknown', reason: '采样不足' };

  const first = points[0];
  const last = points[points.length - 1];
  const span = last.t - first.t;
  if (span < minSpanMs) return { status: 'unknown', reason: '采样跨度太短' };
  if (last.resetAtMs && first.resetAtMs && last.resetAtMs !== first.resetAtMs) {
    return { status: 'unknown', reason: '窗口已重置，样本跨了两个周期' };
  }

  const delta = last.used - first.used;
  if (delta < 0) return { status: 'unknown', reason: '官方统计回退，暂停预测' };
  const perMs = delta / span;
  if (!(perMs > 0)) return { status: 'idle', reason: '这段时间没有消耗', burnPerHour: 0 };

  const burnPerHour = perMs * 3600 * 1000;
  const cap = Number.isFinite(last.cap) && last.cap > 0 ? last.cap : null;
  const remaining = cap !== null ? Math.max(0, cap - last.used) : null;
  const etaMs = remaining !== null && perMs > 0 ? Math.round(remaining / perMs) : null;
  const resetAtMs = last.resetAtMs || null;
  const willExhaustBeforeReset = etaMs !== null && resetAtMs !== null ? (now + etaMs) < resetAtMs : null;

  return {
    status: 'ok',
    window: kind,
    burnPerHour: Math.round(burnPerHour * 100) / 100,
    remaining,
    etaMs,
    etaAt: etaMs !== null ? new Date(now + etaMs).toISOString() : null,
    resetAtMs,
    willExhaustBeforeReset,
    samples: points.length,
    spanMs: span,
    confidence: points.length >= 4 && span >= 10 * 60 * 1000 ? 'high' : 'low',
  };
}

// ── 服务 ───────────────────────────────────────────
/**
 * @param {object} deps
 * @param {object} deps.keyPool        lib/keys.mjs 的池（提供 all()/findById()）
 * @param {Function} deps.request      注入的 HTTP 实现：({ key, keyId, url, timeoutMs }) => { ok, status, json, text, error }
 * @param {Function} [deps.proxyStatus] (keyId) => { available, reason, mode }  严格绑定失败关闭时这里为 false
 * @param {Function} [deps.log]
 * @param {Function} [deps.onEvent]    (event) => void —— 供告警使用
 * @param {object} [deps.config]       取配置的 getter（默认直读 CFG）
 */
export function createQuotaService({
  keyPool, request, proxyStatus = null, log = () => {}, onEvent = null,
  config = null, now = () => Date.now(),
  persistence = true,
  warmup = null,
} = {}) {
  const cfg = () => (typeof config === 'function' ? config() : (config || {}));

  const state = {
    version: FILE_VERSION,
    accounts: {},   // keyId → 官方快照
    runtime: {},    // keyId → 运行期封锁 + 采样
  };

  if (persistence) {
    const loaded = readJSON(QUOTA_PATH, null, (file, err) => {
      log('error', 'quota.json 解析失败，已按空快照启动（原文件未被覆盖）', { file, error: err.message });
    });
    if (loaded && typeof loaded === 'object') {
      if (isObj(loaded.accounts)) state.accounts = loaded.accounts;
      if (isObj(loaded.runtime)) state.runtime = loaded.runtime;
      log('info', '额度快照已加载', { accounts: Object.keys(state.accounts).length });
    }
  }

  const writer = persistence
    ? createDebouncedWriter(QUOTA_PATH, () => state, {
      maxDelayMs: 5000,
      onError: (e) => log('error', 'quota.json 写盘失败', { error: e.message }),
    })
    : { markDirty() {}, flush() {}, get pending() { return false; } };

  function persistNow() {
    if (!persistence) return;
    try { writeJSONAtomic(QUOTA_PATH, state, 0o600); } catch (e) { log('error', 'quota.json 写盘失败', { error: e.message }); }
  }

  function emptyRuntime() {
    return {
      exhaustedUntilMs: null,
      exhaustedReason: '',
      exhaustedWindow: null,
      pendingRecovery: false,
      upstreamExhaustedUntilMs: null,
      rateLimitedUntilMs: null,
      rateLimitedReason: '',
      authInvalidUntilMs: null,
      authInvalidReason: '',
      failures: 0,
      nextAttemptAt: 0,
      samples: [],
      lastWarmedAtMs: null,
      lastWarmupError: null,
      lastWarmupAttemptAtMs: null,
      warmupFailures: 0,
    };
  }

  function runtimeOf(keyId) {
    if (!state.runtime[keyId]) {
      state.runtime[keyId] = emptyRuntime();
    }
    const rt = state.runtime[keyId];
    // 从旧版本升级上来的 runtime 可能缺字段
    if (!Array.isArray(rt.samples)) rt.samples = [];
    if (rt.nextAttemptAt === undefined) rt.nextAttemptAt = 0;
    if (rt.failures === undefined) rt.failures = 0;
    if (rt.lastWarmedAtMs === undefined) rt.lastWarmedAtMs = null;
    if (rt.lastWarmupError === undefined) rt.lastWarmupError = null;
    if (rt.lastWarmupAttemptAtMs === undefined) rt.lastWarmupAttemptAtMs = null;
    if (rt.warmupFailures === undefined) rt.warmupFailures = 0;
    return rt;
  }

  function warmupBackoffMs(rt) {
    if (!rt.warmupFailures || !rt.lastWarmupAttemptAtMs) return 0;
    const exp = Math.min(5, rt.warmupFailures - 1);
    const delay = Math.min(30 * 60 * 1000, 60_000 * (2 ** exp));
    const passed = now() - rt.lastWarmupAttemptAtMs;
    return Math.max(0, delay - passed);
  }

  function keyEntry(keyId) {
    const found = typeof keyPool.findById === 'function' ? keyPool.findById(keyId) : null;
    return found || null;
  }

  function policyOf() {
    const c = cfg();
    return {
      ...POLICY_DEFAULTS,
      warnRatio: Number.isFinite(Number(c.quotaWarnRatio)) ? Number(c.quotaWarnRatio) : POLICY_DEFAULTS.warnRatio,
      unknownBlock: !!c.quotaUnknownBlock,
      unknownStaleMs: Number.isFinite(Number(c.quotaStaleMs)) && Number(c.quotaStaleMs) > 0
        ? Number(c.quotaStaleMs) : POLICY_DEFAULTS.unknownStaleMs,
      fallbackCooldownMs: Number.isFinite(Number(c.quotaFallbackCooldownMs)) && Number(c.quotaFallbackCooldownMs) > 0
        ? Number(c.quotaFallbackCooldownMs) : POLICY_DEFAULTS.fallbackCooldownMs,
    };
  }

  /** 该账号的代理可用性（严格绑定失败关闭时 accounting 不参与调度） */
  function proxyStateOf(keyId) {
    if (typeof proxyStatus !== 'function') return null;
    try { return proxyStatus(keyId) || null; } catch { return null; }
  }

  /**
   * 5 小时窗口的展示/判定用快照。
   *
   * 官方对未开窗的窗口返回 resetAt=0；预热成功后窗口确实已经打开，官方页面也会
   * 倒计时，但额度接口可能还没上报 resetAt。此时用「预热时间 + 5h」作为估算值，
   * 并标记 resetEstimated，避免显示成「等待官方刷新数据」，也让耗尽恢复等到正确时点。
   */
  function effectiveWindows(snapshot, rt, t = now()) {
    const windows = snapshot?.windows || {};
    const fh = windows.fiveHour;
    if (!fh) return windows;
    const officialReset = Number.isFinite(fh.resetAtMs) && fh.resetAtMs > 0 ? fh.resetAtMs : null;
    const warmedAt = rt?.lastWarmedAtMs ?? null;
    // 官方 resetAt 晚于本次预热 → 它属于当前窗口或更新的窗口，是权威值。
    if (officialReset !== null && (!warmedAt || officialReset > warmedAt)) return windows;
    const estimated = warmedAt ? warmedAt + FIVE_HOUR_MS : null;
    if (estimated === null || estimated <= t) return windows;
    return { ...windows, fiveHour: { ...fh, resetAtMs: estimated, resetEstimated: true, resetSource: 'warmup' } };
  }

  /** 派生状态（不落盘） */
  function stateOf(keyId) {
    const entry = keyEntry(keyId);
    const snapshot = state.accounts[keyId] || null;
    const rt = runtimeOf(keyId);
    const windows = snapshot ? effectiveWindows(snapshot, rt) : null;
    return deriveAccountState({
      enabled: entry ? entry.enabled !== false : true,
      snapshot: snapshot && windows !== snapshot.windows ? { ...snapshot, windows } : snapshot,
      runtime: rt,
      proxyStatus: proxyStateOf(keyId),
      now: now(),
      policy: policyOf(),
    });
  }

  /**
   * 是否应当**禁止**把新请求派给这个账号。
   * keys.mjs 的 candidates() 只认这个返回值 —— 状态机的判断全部在这里，避免两处口径不一致。
   */
  function blockReason(keyId) {
    const st = stateOf(keyId);
    const policy = policyOf();
    if (!isHardBlocked(st.state, { unknownBlock: policy.unknownBlock })) return null;
    return { state: st.state, reason: st.reason, untilMs: st.untilMs ?? null };
  }

  function markExhausted(keyId, { reason = '', window = null, resetAtMs = null, source = 'upstream' } = {}) {
    const rt = runtimeOf(keyId);
    const policy = policyOf();
    const until = resetAtMs && resetAtMs > now() ? resetAtMs : now() + policy.fallbackCooldownMs;
    rt.exhaustedUntilMs = until;
    rt.exhaustedReason = reason || '官方额度已耗尽';
    rt.exhaustedWindow = window;
    rt.pendingRecovery = true;   // 到点后必须有一次成功刷新才解封
    if (source === 'upstream-error') {
      // 上游亲口说的耗尽：单独记一份带期限的封锁。
      // 它**不受**官方快照刷新影响（官方统计滞后），只等到期或被一次真实成功解除。
      rt.upstreamExhaustedUntilMs = until;
    }
    rt.failures = 0;
    rt.nextAttemptAt = Math.min(rt.nextAttemptAt || 0, until);
    writer.markDirty();
    log('warn', '账号额度耗尽，暂停派发', {
      keyId, window: window || '(unknown)', reason: rt.exhaustedReason,
      until: new Date(until).toISOString(), source,
    });
    noteEvent({ type: 'quota_exhausted', keyId, window: window || null, reason: rt.exhaustedReason, untilMs: until, source });
    emit({ type: 'quota_exhausted', keyId, window, reason: rt.exhaustedReason, untilMs: until, source });
    return { untilMs: until };
  }

  function markRateLimited(keyId, { retryAfterMs = 30 * 1000, reason = '' } = {}) {
    const rt = runtimeOf(keyId);
    const ms = Math.max(1000, Math.min(Number(retryAfterMs) || 30000, 30 * 60 * 1000));
    rt.rateLimitedUntilMs = now() + ms;
    rt.rateLimitedReason = reason || '上游限流';
    writer.markDirty();
    log('warn', '账号短期限流', { keyId, retryAfterSec: Math.round(ms / 1000) });
    return { untilMs: rt.rateLimitedUntilMs };
  }

  function markAuthInvalid(keyId, { reason = '', cooldownMs = 30 * 60 * 1000 } = {}) {
    const rt = runtimeOf(keyId);
    rt.authInvalidUntilMs = now() + cooldownMs;
    rt.authInvalidReason = reason || '上游明确拒绝认证';
    writer.markDirty();
    log('error', '账号鉴权失效，需要管理员处理', { keyId, reason: rt.authInvalidReason });
    emit({ type: 'auth_invalid', keyId, reason: rt.authInvalidReason });
  }

  function markHealthy(keyId) {
    const rt = runtimeOf(keyId);
    const wasExhausted = !!rt.exhaustedUntilMs || !!rt.upstreamExhaustedUntilMs;
    rt.rateLimitedUntilMs = null;
    rt.rateLimitedReason = '';
    rt.authInvalidUntilMs = null;
    rt.authInvalidReason = '';
    rt.upstreamExhaustedUntilMs = null;
    rt.failures = 0;
    rt.nextAttemptAt = 0;
    if (wasExhausted) {
      rt.exhaustedUntilMs = null;
      rt.exhaustedReason = '';
      rt.exhaustedWindow = null;
      rt.pendingRecovery = false;
      log('info', '账号额度已恢复，重新加入调度池', { keyId });
      noteEvent({ type: 'quota_recovered', keyId });
      emit({ type: 'quota_recovered', keyId });
    }
    writer.markDirty();
  }

  function emit(event) {
    if (typeof onEvent !== 'function') return;
    try { onEvent(event); } catch (e) { log('warn', '额度事件回调出错', { error: e.message }); }
  }

  // ── 最近的事件环（内存，不对盘）──────────────────
  // 后台需要看到「最近一次额度耗尽 / 账号切换」发生了什么，
  // 但日志是文本流，不适合在仪表盘上做结构渲染。这里只留最近 50 条。
  const recentEvents = [];

  function noteEvent(evt) {
    if (!evt) return;
    recentEvents.push({ at: now(), ...evt });
    if (recentEvents.length > 50) recentEvents.splice(0, recentEvents.length - 50);
  }

  function events() {
    return recentEvents.slice().reverse();
  }

  // ── 采集 ────────────────────────────────────────
  const inflight = new Map();   // keyId → Promise（singleflight）

  function timeoutMs() {
    const v = Number(cfg().quotaTimeoutMs);
    return Number.isFinite(v) && v >= 1000 ? v : DEFAULT_TIMEOUT_MS;
  }

  function withHardTimeout(promise, ms, message) {
    const p = Promise.resolve().then(() => promise);
    p.catch(() => {}); // 防止超时后原 Promise 迟到 reject 触发 UnhandledRejection
    let t = null;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => {
        const err = new Error(message);
        err.name = 'TimeoutError';
        reject(err);
      }, ms);
    });
    return Promise.race([p, timeout]).finally(() => {
      if (t) clearTimeout(t);
    });
  }

  function fetchHardTimeoutMs(tMs) {
    // 防御兜底：即使底层 request 未能正确响应 timeoutMs，也绝不允许把 singleflight 永久锁死。
    const override = Number(cfg().quotaHardTimeoutMs);
    if (Number.isFinite(override) && override >= 50) return override;
    const extra = Math.min(3000, Math.max(250, Math.round(tMs * 0.5)));
    return tMs + extra;
  }

  function warmupHardTimeoutMs() {
    const override = Number(cfg().quotaWarmupTimeoutMs);
    if (Number.isFinite(override) && override >= 50) return override;
    return Math.max(45 * 1000, timeoutMs() + 35 * 1000);
  }

  async function fetchOne(keyId, key, name) {
    const url = `${String(cfg().apiBase || '').replace(/\/+$/, '')}${ENDPOINTS[name]}`;
    const started = now();
    const tMs = timeoutMs();
    try {
      const res = await withHardTimeout(
        request({ key, keyId, url, name, timeoutMs: tMs }),
        fetchHardTimeoutMs(tMs),
        `quota request timeout (${tMs}ms)`,
      );
      const durationMs = now() - started;
      if (!res) return { name, ok: false, kind: 'network', error: 'no response' };
      if (res.proxyUnavailable) return { name, ok: false, kind: 'proxy', error: res.error || 'proxy unavailable' };

      const status = res.status ?? 0;
      // 401/403：明确鉴权问题，不能靠换代理解决
      if (status === 401 || status === 403) return { name, ok: false, kind: 'auth', status, error: `HTTP ${status}` };
      if (status === 429) return { name, ok: false, kind: 'rate_limit', status, retryAfterMs: res.retryAfterMs, error: 'HTTP 429' };
      // 404/405/501：端点不存在或未开放 —— 记为 unsupported，不当作「额度为零」也不触发退避
      if (status === 404 || status === 405 || status === 501) return { name, ok: false, kind: 'unsupported', status, error: `HTTP ${status}` };
      if (!res.ok) return { name, ok: false, kind: 'http', status, error: `HTTP ${status}` };

      let json = res.json;
      if (json === undefined && typeof res.text === 'string' && res.text) {
        try { json = JSON.parse(res.text); } catch { json = null; }
      }
      if (!json || typeof json !== 'object') return { name, ok: false, kind: 'parse', status, error: 'response is not JSON' };
      return { name, ok: true, status, json, durationMs };
    } catch (e) {
      const durationMs = now() - started;
      const kind = e?.code === 'QUOTA_PROXY_UNAVAILABLE' ? 'proxy' : 'network';
      return { name, ok: false, kind, error: String(e?.message || e), durationMs };
    }
  }

  /** 采集一个账号。force=false 时受退避窗口与「已在进行中」约束。 */
  async function refreshOne(keyId, { reason = 'manual', force = false } = {}) {
    const entry = keyEntry(keyId);
    if (!entry) return { ok: false, error: '账号不存在' };
    if (inflight.has(keyId)) return inflight.get(keyId);

    const rt = runtimeOf(keyId);
    if (!force && rt.nextAttemptAt && now() < rt.nextAttemptAt) {
      return { ok: false, skipped: true, error: '退避中', nextAttemptAt: rt.nextAttemptAt };
    }

    const p = (async () => {
      const proxy = proxyStateOf(keyId);
      if (proxy && proxy.available === false) {
        // 严格绑定失败关闭 / 代理不可达：这一轮不查，也不记「额度失败」
        log('warn', '账号出站代理不可用，跳过额度查询', { keyId, reason: proxy.reason });
        return { ok: false, error: 'proxy_unavailable', proxyUnavailable: true };
      }

      const results = await Promise.all(['whoami', 'credits', 'subscriptions', 'usage']
        .map(name => fetchOne(keyId, entry.key, name)));

      const byName = {};
      const errors = {};
      const unsupported = [];
      let proxyDown = false;
      let authDown = false;
      let rateLimited = null;
      for (const r of results) {
        if (r.ok) byName[r.name] = r.json;
        else {
          // unsupported 不算故障（端点可能本就不存在），但也要如实记下，
          // 否则 UI 会以为「这个端点返回了空数据」而不是「这个端点没有开放」。
          if (r.kind === 'unsupported') unsupported.push(r.name);
          else errors[r.name] = r.error || r.kind;
          if (r.kind === 'proxy') proxyDown = true;
          if (r.kind === 'auth') authDown = true;
          if (r.kind === 'rate_limit') rateLimited = r;
        }
      }

      const anyOk = results.some(r => r.ok);
      if (!anyOk) {
        rt.failures += 1;
        const base = 30 * 1000;
        const delay = Math.min(base * Math.pow(2, Math.min(rt.failures - 1, 5)), 30 * 60 * 1000);
        rt.nextAttemptAt = now() + delay + Math.floor(Math.random() * 5000);
        // 失败原因要能看见：否则「额度一直是旧值」在后台看起来就像「额度没变过」
        rt.lastFailure = { at: now(), errors: { ...errors }, proxyDown, authDown, rateLimited: !!rateLimited };
        if (proxyDown) log('warn', '额度查询因代理不可达失败', { keyId });
        else if (authDown) {
          log('error', '额度查询被上游拒绝认证', { keyId });
          markAuthInvalid(keyId, { reason: errors.whoami || 'HTTP 401/403' });
        } else if (rateLimited) markRateLimited(keyId, { retryAfterMs: rateLimited.retryAfterMs });
        else log('warn', '额度查询全部失败，保留旧快照', { keyId, errors });
        writer.markDirty();
        return { ok: false, error: 'all_failed', errors, nextAttemptAt: rt.nextAttemptAt };
      }

      const prev = state.accounts[keyId] || null;
      const snapshot = buildSnapshot({
        whoami: byName.whoami, credits: byName.credits,
        subscriptions: byName.subscriptions, usage: byName.usage,
        fetchedAt: now(), errors,
      });
      // 部分接口失败：把上一次成功取得的对应片段接回来，但要保留 partial 标记，
      // 让 UI 知道「这几项不是本次刷新拿到的」。
      if (prev) {
        if (!byName.whoami && prev.identity) snapshot.identity = prev.identity;
        if (!byName.credits && prev.credits) snapshot.credits = prev.credits;
        if (!byName.subscriptions && prev.subscriptions) snapshot.subscriptions = prev.subscriptions;
        if (!byName.usage && prev.usage) snapshot.usage = prev.usage;
        for (const [kind, w] of Object.entries(prev.windows || {})) {
          if (!snapshot.windows[kind]) snapshot.windows[kind] = w;
        }
      }
      snapshot.keyFingerprint = createHash('sha256').update(String(entry.key)).digest('hex').slice(0, 16);
      snapshot.unsupported = unsupported;
      state.accounts[keyId] = snapshot;

      // 采样（只取官方数字，且同窗口内才有意义）
      pushSample(keyId, snapshot);

      // 采集成功即认为这一轮是健康的：清掉限流/鉴权封锁
      rt.failures = 0;
      rt.nextAttemptAt = 0;
      rt.lastFailure = null;

      // 所有端点都返回成功，但一个窗口都没解析出来 → 官方响应结构很可能变了。
      // 这不是「额度为 0」，而是「我们读不懂了」，必须让人看见。
      if (unsupported.length < 4 && Object.keys(snapshot.windows || {}).length === 0) {
        emit({ type: 'schema_changed', keyId, detail: '额度接口返回成功但未解析到任何额度窗口' });
      }
      rt.rateLimitedUntilMs = null;
      rt.authInvalidUntilMs = null;

      // 官方明确恢复：解除耗尽封锁（这是唯一的解封路径之一，另一条是人工清状态）
      const exhaustedNow = ['fiveHour', 'weekly', 'monthly']
        .map(k => snapshot.windows?.[k]).filter(w => w && w.exceeded === true);
      if (exhaustedNow.length > 0) {
        const earliest = exhaustedNow.map(w => w.resetAtMs).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
        const w = exhaustedNow[0];
        markExhausted(keyId, {
          reason: `官方额度窗口已耗尽（${w.label || 'window'}）`,
          window: w.label || null,
          resetAtMs: earliest,
          source: 'quota-api',
        });
      } else if (rt.exhaustedUntilMs) {
        // 官方数据说没耗尽 → 解掉**官方**那一份封锁。
        // 但上游亲口报的封锁（upstreamExhaustedUntilMs）不能因此解除：
        // 官方统计滞后时，这正是「反复撞限」的来源。
        rt.exhaustedUntilMs = null;
        rt.exhaustedReason = '';
        rt.exhaustedWindow = null;
        rt.pendingRecovery = false;
        if (!rt.upstreamExhaustedUntilMs) {
          log('info', '官方额度已恢复，账号重新可用', { keyId });
          noteEvent({ type: 'quota_recovered', keyId });
          emit({ type: 'quota_recovered', keyId });
        }
      }

      writer.markDirty();
      return { ok: true, snapshot, partial: snapshot.partial };
    })().finally(() => { inflight.delete(keyId); });

    inflight.set(keyId, p);
    return p;
  }

  function pushSample(keyId, snapshot) {
    const rt = runtimeOf(keyId);
    for (const kind of ['fiveHour', 'weekly', 'monthly']) {
      const w = snapshot.windows?.[kind];
      if (!w || w.used === null || w.cap === null) continue;
      rt.samples.push({ t: snapshot.fetchedAtMs, kind, used: w.used, cap: w.cap, resetAtMs: w.resetAtMs ?? null });
    }
    // 有界：按时间裁剪，避免长跑后无限增长
    if (rt.samples.length > MAX_SAMPLES * 3) {
      rt.samples.sort((a, b) => a.t - b.t);
      rt.samples = rt.samples.slice(-MAX_SAMPLES * 3);
    }
  }

  /** 全部账号刷新。并发上限 2 —— 额度刷新是后台任务，不能把出口带宽/上游 QPS 打满。 */
  async function refreshAll({ reason = 'timer', force = false, concurrency = 2 } = {}) {
    const entries = (typeof keyPool.all === 'function' ? keyPool.all() : []).filter(e => e.enabled !== false);
    const queue = [...entries];
    const out = [];
    const workers = [];
    for (let i = 0; i < Math.max(1, Math.min(concurrency, 4)); i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const e = queue.shift();
          try { out.push({ keyId: e.id, ...(await refreshOne(e.id, { reason, force })) }); }
          catch (err) { out.push({ keyId: e.id, ok: false, error: String(err?.message || err) }); }
        }
      })());
    }
    await Promise.all(workers);
    return out;
  }

  // ── 定时器 ──────────────────────────────────────
  let timer = null;
  let recoveryTimer = null;

  function intervalMs() {
    const v = Number(cfg().quotaRefreshIntervalMs);
    // 下限只做「防手滑」：后台表单校验要求 ≥ 30s；手工改 config.json 时可以更短
    // （测试与小规模部署需要），但绝不允许 0/负数造成忙等。
    return Number.isFinite(v) && v >= 5000 ? v : 5 * 60 * 1000;
  }

  function start() {
    if (timer) return;
    // 启动后异步刷新：不阻塞监听端口，也不和首个请求抢带宽
    setTimeout(() => {
      refreshAll({ reason: 'startup' }).catch(e => log('warn', '启动额度刷新失败', { error: e.message }));
    }, 1500).unref?.();
    timer = setInterval(() => {
      refreshAll({ reason: 'timer' }).catch(e => log('warn', '定时额度刷新失败', { error: e.message }));
    }, intervalMs());
    timer.unref?.();
    // 重置时刻的主动复查：比固定间隔更贴合官方窗口（上限 30s 一次，低频）
    const recoveryEvery = Math.min(Math.max(intervalMs(), 5000), 30 * 1000);
    recoveryTimer = setInterval(() => {
      try { checkRecoveries(); } catch (e) { log('warn', '额度恢复检查异常', { error: e.message }); }
    }, recoveryEvery);
    recoveryTimer.unref?.();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
  }

  const inFlightWarmups = new Set();

  /** 执行单账号 5 小时额度窗口预热（发送极轻量请求激活开窗） */
  async function warmupOne(keyId, { reason = 'manual' } = {}) {
    if (typeof warmup !== 'function') return { ok: false, error: '预热执行器未配置' };
    const entry = keyEntry(keyId);
    if (!entry) return { ok: false, error: '账号不存在' };
    if (entry.enabled === false) return { ok: false, error: '账号已禁用' };
    if (inFlightWarmups.has(keyId)) return { ok: false, skipped: true, error: '正在预热中' };
    inFlightWarmups.add(keyId);
    const rt = runtimeOf(keyId);
    rt.lastWarmupAttemptAtMs = now();
    try {
      log('info', '开始执行 5 小时额度窗口预热', { keyId, reason });
      const hardMs = warmupHardTimeoutMs();
      const res = await withHardTimeout(
        warmup(keyId, { reason }),
        hardMs,
        `预热执行超时（${Math.round(hardMs / 1000)}s）`,
      );
      rt.lastWarmedAtMs = now();
      rt.lastWarmupError = null;
      rt.warmupFailures = 0;
      writer.markDirty();
      const detail = '5 小时额度窗口已预热开窗（原因: ' + reason + '，模型: ' + (res?.model || 'default') + '）';
      emit({ type: 'window_warmed', keyId, detail });
      noteEvent({ type: 'window_warmed', keyId, detail });
      return { ok: true, model: res?.model };
    } catch (err) {
      rt.warmupFailures = (rt.warmupFailures || 0) + 1;
      rt.lastWarmupError = err.message || String(err);
      writer.markDirty();
      log('warn', '5 小时额度窗口预热失败', { keyId, error: rt.lastWarmupError, reason, failures: rt.warmupFailures });
      return { ok: false, error: rt.lastWarmupError };
    } finally {
      inFlightWarmups.delete(keyId);
    }
  }

  async function warmupAll({ reason = 'manual' } = {}) {
    const entries = typeof keyPool.all === 'function' ? keyPool.all() : [];
    const targets = entries.filter(e => e.enabled !== false);
    const results = [];
    const CONCURRENCY = 2;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const chunk = targets.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (entry) => {
          const r = await warmupOne(entry.id, { reason });
          return { keyId: entry.id, ...r };
        })
      );
      results.push(...chunkResults);
    }
    return results;
  }

  /**
   * 自动预热检查：让每个账号的 5 小时窗口保持「已开窗」。
   *
   * 两条触发路径：
   *   1) 官方给了 resetAt 且已到点 → 重置后开下一轮；
   *   2) 官方没给 resetAt（实测未开窗时返回 resetAt: 0）→ 冷账号永远等不到
   *      resetAt，必须主动打一次开窗，否则会一直停在「重置时间未知」。
   *      开窗后官方仍不给 resetAt 时，按 5 小时窗口寿命兜底再开一次。
   */
  function checkAutoWarmups() {
    if (cfg().quotaAutoWarmup === false) return;
    if (typeof warmup !== 'function') return;
    const t = now();
    let entries = [];
    try {
      entries = typeof keyPool.all === 'function' ? keyPool.all() : [];
    } catch (e) {
      log('warn', '自动预热读取账号列表失败', { error: e.message });
      return;
    }

    const due = [];
    const policy = policyOf();
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      const keyId = entry.id;
      const rt = runtimeOf(keyId);
      const snap = state.accounts[keyId];
      const w = snap?.windows?.fiveHour;

      // 快照存在但官方没有五小时窗口（套餐不含 / 响应结构变化）：不猜，避免每 5 小时
      // 白打一次上游。完全没有快照的冷账号仍要主动开窗，见下面 resetAt 未知的分支。
      if (snap && !w) continue;

      const resetAt = w?.resetAtMs ?? null;
      const fetchedAt = snap?.fetchedAtMs ?? 0;
      const snapStale = !fetchedAt || (t - fetchedAt) > policy.unknownStaleMs;
      // 只有「当前窗口」的耗尽才阻止预热：exceeded 为真且 resetAt 还没到。
      // 如果 resetAt 已经过去，或者快照本身已经过期断更，这个 exceeded 很可能是
      // 上一个窗口的残留；继续跳过会让账号在重置后一直开不了窗。
      const resetPassed = resetAt !== null && resetAt <= t;
      if (w?.exceeded === true && !resetPassed && !snapStale) continue;

      // 周/月窗口仍处于耗尽状态时，单独开五小时窗口没有意义（上游仍会拒绝）。
      // 这里同样只信任「重置时间还没到」的耗尽信号，避免旧数据把账号永久拦住。
      const otherBlocked = ['weekly', 'monthly'].some((kind) => {
        const x = snap?.windows?.[kind];
        return x?.exceeded === true && (!x.resetAtMs || x.resetAtMs > t);
      });
      if (otherBlocked) continue;

      // 本轮应该开窗的时刻：有 resetAt 就等它；没有（未开窗/官方没给）就立刻开。
      // 已经开过窗且官方一直不更新 resetAt 时，按 5 小时窗口寿命兜底下一轮。
      let warmAt = resetAt;
      if (warmAt !== null) {
        if (rt.lastWarmedAtMs && rt.lastWarmedAtMs >= warmAt) {
          warmAt = rt.lastWarmedAtMs + FIVE_HOUR_MS;
        } else if (rt.lastWarmedAtMs) {
          // 官方 resetAt 可能是历史旧时间戳，也可能是异常的未来时间。两种情况都用
          // 「最近一次实际预热 + 5h」作为上界，保证心跳不会被坏数据永久拖住。
          const cap = rt.lastWarmedAtMs + FIVE_HOUR_MS;
          if (warmAt > cap) warmAt = cap;
        }
      } else {
        // 重置时间未知 = 窗口尚未开（或官方没给/快照缺失），直接开窗。
        // 这里**不**依赖快照新鲜度：采集间隔可以比 unknownStaleMs 更长，
        // 而且冷窗口不会因为「上次采集失败」自己打开；防抖与失败退避已经
        // 能避免反复打上游。
        warmAt = rt.lastWarmedAtMs ? rt.lastWarmedAtMs + FIVE_HOUR_MS : 0;
      }
      if (t < warmAt) continue;

      // 短防抖：只拦住刚预热成功后的重复触发；不要用 30 分钟窗口，否则手动预热
      // 或时钟偏差会把真正的重置开窗推迟半小时。
      if (rt.lastWarmedAtMs && t - rt.lastWarmedAtMs < WARMUP_DEBOUNCE_MS) continue;

      // 失败退避：失败后按指数退避等待，避免死循环打上游
      if (warmupBackoffMs(rt) > 0) continue;

      // 代理不可用时不打上游（用 proxyStateOf 安全防御）
      const ps = proxyStateOf(keyId);
      if (ps && ps.available === false) continue;

      // 鉴权失效或限流中不预热
      if (rt.authInvalidUntilMs && t < rt.authInvalidUntilMs) continue;
      if (rt.rateLimitedUntilMs && t < rt.rateLimitedUntilMs) continue;

      const isReset = !!w?.resetAtMs && warmAt === w.resetAtMs;
      due.push({ keyId, warmAt, isReset, reason: isReset ? 'auto_reset' : 'auto_open' });
    }

    // 升级后可能所有冷账号同时到期：限制并发，剩下的下一轮（≤30s 后）再开。
    // 真正的窗口重置优先于「从未开窗」，同类里先到期的先开。
    due.sort((a, b) => (a.isReset === b.isReset ? a.warmAt - b.warmAt : (a.isReset ? -1 : 1)));
    const slots = Math.max(0, 2 - inFlightWarmups.size);
    for (const item of due.slice(0, slots)) {
      warmupOne(item.keyId, { reason: item.reason }).catch(e => {
        log('warn', '自动预热调用未捕获异常', { keyId: item.keyId, error: e.message });
      });
    }
  }

  /** 到达预计重置时刻 → 主动刷新一次并检查是否需要预热开窗。 */
  function checkRecoveries() {
    const t = now();
    for (const [keyId, rt] of Object.entries(state.runtime)) {
      if (!rt) continue;
      if (rt.exhaustedUntilMs && t >= rt.exhaustedUntilMs && rt.pendingRecovery) {
        // 已删除 / 禁用的账号不再反复刷新。不要用 force：refreshOne 的普通路径会
        // 遵守 nextAttemptAt，上游持续失败时按指数退避重试，而不是每 30 秒一轮。
        const entry = keyEntry(keyId);
        if (entry && entry.enabled !== false) {
          refreshOne(keyId, { reason: 'reset-window' }).catch(() => {});
        }
      }
      // 限流到点：只清状态，不额外打上游
      if (rt.rateLimitedUntilMs && t >= rt.rateLimitedUntilMs) {
        rt.rateLimitedUntilMs = null;
        rt.rateLimitedReason = '';
        writer.markDirty();
      }
      if (rt.authInvalidUntilMs && t >= rt.authInvalidUntilMs) {
        rt.authInvalidUntilMs = null;
        rt.authInvalidReason = '';
        writer.markDirty();
      }
    }
    checkAutoWarmups();
  }

  // ── 视图 ───────────────────────────────────────
  function forecastOf(keyId) {
    const rt = runtimeOf(keyId);
    const enabledForecast = cfg().quotaForecast !== false;
    if (!enabledForecast) return { status: 'disabled' };
    return forecastBurn(rt.samples, { now: now(), kind: 'fiveHour' });
  }

  function accountView(entry) {
    const keyId = entry.id;
    const snapshot = state.accounts[keyId] || null;
    const rt = runtimeOf(keyId);
    const st = stateOf(keyId);
    const policy = policyOf();
    const fetchedAtMs = snapshot?.fetchedAtMs ?? null;
    const staleMs = policy.unknownStaleMs;
    const inflightNow = inflight.has(keyId);
    // 与调度器同源的另外两个输入：在途请求数、燃烧预测。
    // 这里一并算进 rank，后台看到的顺序才和实际派发顺序一致（会话粘性除外）。
    const forecast = forecastOf(keyId);
    const inflightRequests = typeof keyPool?.inFlightOf === 'function' ? keyPool.inFlightOf(keyId) : 0;
    const windows = snapshot ? effectiveWindows(snapshot, rt) : {};
    return {
      keyId,
      label: entry.label || '',
      // all() 不返回脱敏串（只有 list() 才有），这里自己派生：
      // 前 7 位 + 后 4 位足够分辨是哪个账号，且永不回传完整 Key。
      keyMasked: entry.keyMasked || entry.masked || (entry.key ? `${entry.key.slice(0, 7)}…${entry.key.slice(-4)}` : null),
      enabled: entry.enabled !== false,
      source: entry.source || 'ui',
      plan: snapshot?.plan || null,
      identity: snapshot?.identity || null,
      windows,
      credits: snapshot?.credits || null,
      subscriptions: snapshot?.subscriptions || null,
      usage: snapshot?.usage || null,
      state: st.state,
      stateLabel: st.reason || '',
      stateUntil: st.untilMs ? new Date(st.untilMs).toISOString() : null,
      blockReason: blockReason(keyId),
      ratio: worstRatio(snapshot),
      // 多窗口剩余额度加权分（1 = 全新）：5 小时优先，周/月次之。
      remainingScore: quotaRemainingScore(snapshot),
      // 当前在途请求数（调度时的「空闲优先」依据）
      inflightRequests,
      fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
      fetchedAtMs,
      stale: !fetchedAtMs || (now() - fetchedAtMs) > staleMs,
      ageSec: fetchedAtMs ? Math.round((now() - fetchedAtMs) / 1000) : null,
      lastError: snapshot?.partial?.length ? snapshot.errors : null,
      partial: snapshot?.partial || [],
      unsupported: snapshot?.unsupported || [],
      complete: snapshot?.complete ?? null,
      refreshing: inflightNow,
      forecast,
      proxy: proxyStateOf(keyId),
      rank: rankAccount({ state: st.state, snapshot, inflight: inflightRequests, forecast }),
      runtime: {
        exhaustedUntil: rt.exhaustedUntilMs ? new Date(rt.exhaustedUntilMs).toISOString() : null,
        upstreamExhaustedUntil: rt.upstreamExhaustedUntilMs ? new Date(rt.upstreamExhaustedUntilMs).toISOString() : null,
        exhaustedReason: rt.exhaustedReason || '',
        rateLimitedUntil: rt.rateLimitedUntilMs ? new Date(rt.rateLimitedUntilMs).toISOString() : null,
        authInvalidUntil: rt.authInvalidUntilMs ? new Date(rt.authInvalidUntilMs).toISOString() : null,
        nextAttemptAt: rt.nextAttemptAt ? new Date(rt.nextAttemptAt).toISOString() : null,
        failures: rt.failures,
        lastFailure: rt.lastFailure || null,
        lastWarmedAt: rt.lastWarmedAtMs ? new Date(rt.lastWarmedAtMs).toISOString() : null,
        lastWarmupError: rt.lastWarmupError || null,
      },
    };
  }

  function list() {
    const entries = typeof keyPool.all === 'function' ? keyPool.all() : [];
    return entries.map(accountView);
  }

  function summary() {
    const accounts = list();
    const counts = {};
    for (const a of accounts) counts[a.state] = (counts[a.state] || 0) + 1;
    const usable = accounts.filter(a => !a.blockReason).length;
    return {
      total: accounts.length,
      usable,
      exhausted: accounts.filter(a => a.state === 'quota_exhausted').length,
      warning: accounts.filter(a => a.state === 'quota_warning').length,
      unknown: accounts.filter(a => a.state === 'quota_unknown').length,
      proxyDown: accounts.filter(a => a.state === 'proxy_unavailable').length,
      counts,
      lastRefreshedAt: accounts.map(a => a.fetchedAtMs).filter(Boolean).sort((a, b) => b - a)[0] || null,
    };
  }

  /** 供调度使用：一次快照，避免同一请求里多次派生状态导致前后不一致。 */
  function snapshotStates() {
    const entries = typeof keyPool.all === 'function' ? keyPool.all() : [];
    const map = new Map();
    for (const e of entries) map.set(e.id, stateOf(e.id));
    return map;
  }

  function clearRuntime(keyId) {
    const prev = state.runtime[keyId] || {};
    state.runtime[keyId] = {
      ...emptyRuntime(),
      lastWarmedAtMs: prev.lastWarmedAtMs ?? null,
      lastWarmupError: prev.lastWarmupError ?? null,
      lastWarmupAttemptAtMs: prev.lastWarmupAttemptAtMs ?? null,
      warmupFailures: prev.warmupFailures || 0,
    };
    writer.markDirty();
    log('info', '账号运行期额度状态已手动重置', { keyId });
    return { ok: true };
  }

  /** 账号被删除时清理 —— 否则 keyId 复用（同名导入）会把旧封锁带过去。 */
  function forget(keyId) {
    if (state.accounts[keyId]) delete state.accounts[keyId];
    if (state.runtime[keyId]) delete state.runtime[keyId];
    writer.markDirty();
  }

  return {
    start, stop, checkRecoveries,
    refreshOne, refreshAll,
    warmupOne, warmupAll,
    list, summary, stateOf, blockReason, snapshotStates,
    markExhausted, markRateLimited, markAuthInvalid, markHealthy,
    clearRuntime, forget, noteEvent, events,
    forecastOf,
    get raw() { return state; },
    flush: () => writer.flush(),
    flushSync: persistNow,
    get path() { return QUOTA_PATH; },
  };
}

export { deriveAccountState, isHardBlocked, worstRatio, rankAccount, quotaRemainingScore, POLICY_DEFAULTS };
