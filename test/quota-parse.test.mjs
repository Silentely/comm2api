// 官方额度解析与采集服务：全部用假上游响应，不需要真实账号。
// 覆盖需求里点名的解析边界：camelCase/snake_case、data 包装、Unix 秒/毫秒/ISO、
// 字段缺失、null 与零的区别、接口部分失败、结构变动。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnapshot, parseCredits, parseIdentity, parseSubscriptions, parseUsageSummary,
  toTimeMs, forecastBurn, createQuotaService,
} from '../lib/quota.mjs';

// ── 时间归一化 ─────────────────────────────────────
test('时间：Unix 秒 / 毫秒 / ISO 都能识别，越界值一律视为不可信', () => {
  const iso = '2030-01-02T03:04:05.000Z';
  const ms = Date.parse(iso);
  assert.equal(toTimeMs(iso), ms);
  assert.equal(toTimeMs(Math.floor(ms / 1000)), ms, 'Unix 秒要乘 1000');
  assert.equal(toTimeMs(ms), ms, '毫秒原样使用');
  assert.equal(toTimeMs(String(Math.floor(ms / 1000))), ms, '数字字符串同样支持');
  // 1970 / 55000 年这类明显错误的值不能当成时间
  assert.equal(toTimeMs(0), null);
  assert.equal(toTimeMs(999999999999999), null);
  assert.equal(toTimeMs('not-a-date'), null);
  assert.equal(toTimeMs(null), null);
});

// ── 身份与套餐 ─────────────────────────────────────
test('whoami：data 包装 + snake_case 也能解析出账号与套餐', () => {
  const id = parseIdentity({ data: { user_id: 'u_1', email: 'a@b.c', plan_name: 'go' } });
  assert.equal(id.userId, 'u_1');
  assert.equal(id.email, 'a@b.c');
  assert.equal(id.plan, 'go');
});

test('whoami：字段全缺时返回空身份而不是抛错', () => {
  const id = parseIdentity({ data: { somethingElse: 1 } });
  assert.equal(id.userId, null);
  assert.equal(id.plan, null);
});

// ── 五小时窗口 ─────────────────────────────────────
test('窗口：camelCase 的 windowLimits.fiveHour 被识别为五小时窗口', () => {
  const s = buildSnapshot({
    usage: {
      data: {
        windowLimits: {
          fiveHour: { used: 40, cap: 100, resetAt: 1_900_000_000_000 },
          weekly: { used: 10, cap: 500, resetAt: 1_900_100_000_000 },
        },
      },
    },
  });
  assert.equal(s.windows.fiveHour.used, 40);
  assert.equal(s.windows.fiveHour.cap, 100);
  assert.equal(s.windows.fiveHour.percentUsed, 0.4);
  assert.equal(s.windows.fiveHour.exceeded, false);
  assert.equal(s.windows.weekly.cap, 500);
  assert.equal(s.windows.monthly, undefined, '没给的窗口不能凭空造出来');
});

test('窗口：snake_case 的 window_limits.five_hour 同样被识别', () => {
  const s = buildSnapshot({
    usage: { data: { window_limits: { five_hour: { used: 100, cap: 100, exceeded: true, reset_at: 1_900_000_000 } } } },
  });
  assert.equal(s.windows.fiveHour.used, 100);
  assert.equal(s.windows.fiveHour.exceeded, true);
  assert.equal(s.windows.fiveHour.resetAtMs, 1_900_000_000_000, 'Unix 秒被换算成毫秒');
});

test('窗口：只给百分比也能算，但不伪造 used/cap', () => {
  const s = buildSnapshot({ credits: { data: { fiveHourPercent: 87.5 } } });
  // fiveHourPercent 没有 used/cap，也没有窗口名 → 不该被当成一个窗口
  assert.equal(s.windows.fiveHour, undefined);
});

test('解析失败不得把额度显示成 0：缺字段就留 null', () => {
  const s = buildSnapshot({ usage: { data: { windowLimits: { fiveHour: { used: 12 } } } } });
  assert.equal(s.windows.fiveHour.used, 12);
  assert.equal(s.windows.fiveHour.cap, null);
  assert.equal(s.windows.fiveHour.percentUsed, null);
  assert.equal(s.windows.fiveHour.partial, true);
});

test('接口部分失败：成功的片段保留，失败的记进 partial', () => {
  const s = buildSnapshot({
    usage: { data: { windowLimits: { fiveHour: { used: 10, cap: 100 } } } },
    whoami: { data: { user_id: 'u_9' } },
    errors: { credits: 'HTTP 500', subscriptions: 'network' },
  });
  assert.equal(s.identity.userId, 'u_9');
  assert.equal(s.windows.fiveHour.cap, 100);
  assert.deepEqual(s.partial.sort(), ['credits', 'subscriptions']);
  assert.equal(s.complete, false);
});

test('credits：remaining 为零且官方说耗尽 → 落成 monthly 窗口并标记 exceeded', () => {
  const c = parseCredits({ data: { remaining_credits: 0, total_credits: 20 } });
  assert.equal(c.remaining, 0);
  assert.equal(c.exhausted, true);
  const s = buildSnapshot({ credits: { data: { remaining_credits: 0, total_credits: 20 } } });
  assert.equal(s.windows.monthly.exceeded, true);
  assert.equal(s.windows.monthly.cap, 20);
});

test('credits：只有 used 没有 remaining 时不判耗尽（不能靠猜）', () => {
  const c = parseCredits({ data: { used_credits: 5 } });
  assert.equal(c.remaining, null);
  assert.equal(c.exhausted, false);
});

test('subscriptions：套餐周期结束时间可作周/月窗口重置时间的兜底', () => {
  const end = '2030-02-01T00:00:00.000Z';
  const subs = parseSubscriptions({ data: { subscriptions: [{ plan: 'go', status: 'active', current_period_end: end }] } });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].plan, 'go');
  assert.equal(subs[0].periodEndMs, Date.parse(end));
  const s = buildSnapshot({
    usage: { data: { windowLimits: { weekly: { used: 1, cap: 2 } } } },
    subscriptions: { data: { subscriptions: [{ plan: 'go', current_period_end: end }] } },
  });
  assert.equal(s.windows.weekly.resetAtMs, Date.parse(end));
});

test('usage summary：只提取数值，不保留任何正文', () => {
  const u = parseUsageSummary({ data: { requests: 12, input_tokens: 1000, output_tokens: 200, cost_usd: 0.5, prompt: 'SECRET' } });
  assert.equal(u.total.requests, 12);
  assert.equal(u.total.costUsd, 0.5);
  assert.equal(JSON.stringify(u).includes('SECRET'), false);
});

// ── 燃烧预测 ──────────────────────────────────────
test('预测：采样跨度足够时给出每小时消耗与耗尽时间', () => {
  const t0 = 1_900_000_000_000;
  const samples = [
    { t: t0, kind: 'fiveHour', used: 10, cap: 100, resetAtMs: t0 + 5 * 3600_000 },
    { t: t0 + 10 * 60_000, kind: 'fiveHour', used: 30, cap: 100, resetAtMs: t0 + 5 * 3600_000 },
  ];
  const f = forecastBurn(samples, { now: t0 + 10 * 60_000, minSpanMs: 60_000 });
  assert.equal(f.status, 'ok');
  assert.equal(f.burnPerHour, 120, '(30-10) 单位 / 10 分钟 → 120/小时');
  assert.equal(f.remaining, 70);
  assert.equal(f.willExhaustBeforeReset, true);
});

test('预测：窗口重置或统计回退时停止预测', () => {
  const t0 = 1_900_000_000_000;
  const reset = forecastBurn([
    { t: t0, kind: 'fiveHour', used: 10, cap: 100, resetAtMs: t0 + 1000 },
    { t: t0 + 600_000, kind: 'fiveHour', used: 20, cap: 100, resetAtMs: t0 + 999_999 },
  ], { now: t0 + 600_000, minSpanMs: 60_000 });
  assert.equal(reset.status, 'unknown');

  const regress = forecastBurn([
    { t: t0, kind: 'fiveHour', used: 50, cap: 100, resetAtMs: null },
    { t: t0 + 600_000, kind: 'fiveHour', used: 20, cap: 100, resetAtMs: null },
  ], { now: t0 + 600_000, minSpanMs: 60_000 });
  assert.equal(regress.status, 'unknown');
});

// ── 采集服务（假 HTTP）──────────────────────────────
function fakePool(keys) {
  return {
    all: () => keys,
    findById: (id) => keys.find(k => k.id === id) || null,
  };
}

function serviceWith(keys, responder, extra = {}) {
  const calls = [];
  const svc = createQuotaService({
    keyPool: fakePool(keys),
    request: async (opts) => { calls.push(opts.url); return responder(opts); },
    config: () => ({ apiBase: 'http://quota.local', quotaRefreshIntervalMs: 60000, quotaWarnRatio: 0.9, ...extra }),
    log: () => {},
    persistence: false,
  });
  return { svc, calls };
}

const KEY_A = { id: 'a', key: 'user_a', label: 'A', enabled: true };
const KEY_B = { id: 'b', key: 'user_b', label: 'B', enabled: true };

test('采集：同一账号并发刷新只打一轮上游（singleflight）', async () => {
  let hits = 0;
  const { svc } = serviceWith([KEY_A], async (o) => {
    hits++;
    await new Promise(r => setTimeout(r, 30));
    return { ok: true, status: 200, json: o.url.endsWith('/whoami') ? { data: { user_id: 'u_a' } } : { data: {} } };
  });
  await Promise.all([svc.refreshOne('a'), svc.refreshOne('a'), svc.refreshOne('a')]);
  assert.equal(hits, 4, '四个端点各一次，不能因三次并发调用变成 12 次');
});

test('采集：全部接口失败时保留旧快照，并记下失败原因（不把旧数据当实时）', async () => {
  let mode = 'ok';
  const { svc } = serviceWith([KEY_A], async () => {
    if (mode === 'ok') return { ok: true, status: 200, json: { data: { windowLimits: { fiveHour: { used: 10, cap: 100 } } } } };
    return { ok: false, status: 500, text: 'boom' };
  });
  const first = await svc.refreshOne('a');
  assert.equal(first.ok, true);
  mode = 'fail';
  const second = await svc.refreshOne('a', { force: true });
  assert.equal(second.ok, false);
  const snap = svc.raw.accounts.a;
  assert.equal(snap.windows.fiveHour.cap, 100, '旧快照必须还在');
  const view = svc.list().find(a => a.keyId === 'a');
  assert.ok(view.runtime.lastFailure, '必须记下上次查询失败，供后台展示');
  assert.ok(Object.keys(view.runtime.lastFailure.errors).length >= 1);
  // 数据一过期就必须报 quota_unknown，而不是继续当实时额度用
  let clock = Date.now();
  const stale = createQuotaService({
    keyPool: fakePool([KEY_A]),
    request: async () => ({ ok: true, status: 200, json: { data: { windowLimits: { fiveHour: { used: 10, cap: 100 } } } } }),
    config: () => ({ apiBase: 'http://quota.local', quotaStaleMs: 60_000 }),
    log: () => {}, persistence: false,
    now: () => clock,
  });
  await stale.refreshOne('a');
  assert.equal(stale.stateOf('a').state, 'available');
  clock += 5 * 60_000;   // 五分钟没有任何成功刷新
  assert.equal(stale.stateOf('a').state, 'quota_unknown');
});

test('采集：接口返回 404 视为端点未开放，不当成故障退避', async () => {
  const { svc } = serviceWith([KEY_A], async (o) => {
    if (o.url.endsWith('/whoami')) return { ok: true, status: 200, json: { data: { user_id: 'u_a' } } };
    return { ok: false, status: 404, text: 'not found' };
  });
  const r = await svc.refreshOne('a');
  assert.equal(r.ok, true);
  assert.deepEqual(svc.raw.accounts.a.unsupported.sort(), ['credits', 'subscriptions', 'usage']);
  assert.deepEqual(svc.raw.accounts.a.partial, [], '端点未开放不算「数据拿不到」');
  assert.equal(svc.stateOf('a').state, 'quota_unknown', '没有窗口就是未知，不是可用');
});

test('采集：官方说五小时已满 → 账号进入 quota_exhausted 并被封锁', async () => {
  const { svc } = serviceWith([KEY_A], async (o) => {
    if (o.url.endsWith('/usage/summary')) {
      return { ok: true, status: 200, json: { data: { windowLimits: { fiveHour: { used: 100, cap: 100, exceeded: true, resetAt: Date.now() + 3600_000 } } } } };
    }
    return { ok: true, status: 200, json: { data: {} } };
  });
  await svc.refreshOne('a');
  assert.equal(svc.stateOf('a').state, 'quota_exhausted');
  assert.ok(svc.blockReason('a'), '耗尽的账号必须被封锁');
  assert.equal(svc.summary().exhausted, 1);
});

test('采集：官方数据恢复后自动解封（不需要人工干预）', async () => {
  let exhausted = true;
  const { svc } = serviceWith([KEY_A], async (o) => {
    if (o.url.endsWith('/usage/summary')) {
      const fiveHour = exhausted
        ? { used: 100, cap: 100, exceeded: true, resetAt: Date.now() + 1800_000 }
        : { used: 10, cap: 100, exceeded: false, resetAt: Date.now() + 3600_000 };
      return { ok: true, status: 200, json: { data: { windowLimits: { fiveHour } } } };
    }
    return { ok: true, status: 200, json: { data: {} } };
  });
  await svc.refreshOne('a');
  assert.ok(svc.blockReason('a'));
  exhausted = false;
  await svc.refreshOne('a', { force: true });
  assert.equal(svc.stateOf('a').state, 'available');
  assert.equal(svc.blockReason('a'), null);
});

test('采集：到达重置时刻但官方还没恢复 → 仍然不派发，等下一次成功刷新', async () => {
  const { svc } = serviceWith([KEY_A], async () => ({ ok: false, status: 500, text: 'down' }));
  svc.markExhausted('a', { reason: 'test', resetAtMs: Date.now() + 50 });
  await new Promise(r => setTimeout(r, 80));
  const st = svc.stateOf('a');
  assert.equal(st.state, 'quota_exhausted');
  assert.equal(st.awaitingRefresh, true);
  assert.ok(svc.blockReason('a'), '没有重新确认之前不能解封');
});

test('采购：额度未知不被当成已满，但也不会被当成百分之百可用', async () => {
  const { svc } = serviceWith([KEY_A], async () => ({ ok: false, status: 500, text: 'down' }));
  await svc.refreshOne('a');
  const st = svc.stateOf('a');
  assert.equal(st.state, 'quota_unknown');
  assert.equal(svc.blockReason('a'), null, '默认不封锁');
  const blocked = createQuotaService({
    keyPool: fakePool([KEY_A]),
    request: async () => ({ ok: false, status: 500, text: 'down' }),
    config: () => ({ apiBase: 'http://quota.local', quotaUnknownBlock: true }),
    log: () => {}, persistence: false,
  });
  await blocked.refreshOne('a');
  assert.ok(blocked.blockReason('a'), '开启 unknownBlock 后才封锁');
});

test('采集：401 → 鉴权失效（不是额度耗尽，也不该靠换代理解决）', async () => {
  const { svc } = serviceWith([KEY_A], async () => ({ ok: false, status: 401, text: 'unauthorized' }));
  await svc.refreshOne('a');
  const st = svc.stateOf('a');
  assert.equal(st.state, 'auth_invalid');
});

test('采集：代理不可用时跳过查询，不把失败算到额度上', async () => {
  let hits = 0;
  const svc = createQuotaService({
    keyPool: fakePool([KEY_A]),
    request: async () => { hits++; return { ok: true, status: 200, json: {} }; },
    proxyStatus: () => ({ available: false, reason: '严格绑定的代理不可用' }),
    config: () => ({ apiBase: 'http://quota.local' }),
    log: () => {}, persistence: false,
  });
  const r = await svc.refreshOne('a');
  assert.equal(r.ok, false);
  assert.equal(r.proxyUnavailable, true);
  assert.equal(hits, 0, '代理不通时一个请求都不该发出去');
  assert.equal(svc.stateOf('a').state, 'proxy_unavailable');
});

test('采集：账号删除后状态被清理，不会串到新账号上', async () => {
  const keys = [KEY_A, KEY_B];
  const { svc } = serviceWith(keys, async (o) => {
    if (o.key === 'user_a' && o.url.endsWith('/usage/summary')) {
      return { ok: true, status: 200, json: { data: { windowLimits: { fiveHour: { used: 100, cap: 100, exceeded: true } } } } };
    }
    if (o.key === 'user_b' && o.url.endsWith('/usage/summary')) {
      return { ok: true, status: 200, json: { data: { windowLimits: { fiveHour: { used: 10, cap: 100 } } } } };
    }
    return { ok: true, status: 200, json: { data: { user_id: o.key === 'user_a' ? 'u_a' : 'u_b' } } };
  });
  await svc.refreshAll({ force: true });
  assert.equal(svc.stateOf('a').state, 'quota_exhausted');
  assert.equal(svc.stateOf('b').state, 'available');
  svc.forget('a');
  keys.splice(0, 1);
  assert.equal(svc.raw.accounts.a, undefined);
  assert.equal(svc.stateOf('b').state, 'available', 'B 的状态不受影响');
});

// ── 真实响应结构（2026-11 实测，身份字段已脱敏）────────────────
// 这组 fixture 来自真实 /alpha/* 响应，专门锁住三个曾经解析失败的点：
//   1) 余额与额度包在 credits 子对象里（不是平铺在顶层）；
//   2) 月度窗口需要 credits.monthlyCredits + usage.totalMonthlyCredits 组合；
//   3) 套餐名在 subscriptions.planId，whoami 里根本没有 plan 字段。
const REAL_WHOAMI = {
  success: true,
  user: { id: '00000000-0000-0000-0000-000000000000', name: 'testuser', email: 't***@example.com', userName: 'testuser' },
  org: null,
};
const REAL_CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 6.256775474, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
    weekly: { used: 1.50219342, cap: 6, exceeded: false, resetAt: 1_795_524_195_609 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
};
const REAL_SUBSCRIPTIONS = {
  success: true,
  data: {
    id: 'sub_test', status: 'active', planId: 'individual-go-v1',
    cancelAtPeriodEnd: false,
    currentPeriodStart: '2026-10-26T06:00:16.000Z',
    currentPeriodEnd: '2026-11-26T06:00:16.000Z',
  },
};
const REAL_USAGE = {
  totalCount: 1499, totalCost: 3.743224526, successRate: 100, completedCount: 1499, failedCount: 0,
  totalTokensIn: 131_426_962, totalTokensOut: 1_209_759,
  totalMonthlyCredits: 3.743224526, totalCredits: 3.743224526,
  periodBasis: 'billing-period', periodStart: '2026-10-26T06:00:16.000Z', daily: [],
};

test('真实结构：credits 嵌套子对象也能读出月度额度上限', () => {
  const c = parseCredits(REAL_CREDITS);
  assert.ok(c, '不能因为字段在 credits 子对象里就返回 null');
  assert.equal(c.monthlyCap, 6.256775474);
  assert.equal(c.remaining, null, '官方没有 remaining，就不能编一个出来');
  assert.equal(c.exhausted, false, 'remaining 未知不等于耗尽');
});

test('真实结构：月度窗口由 monthlyCredits + totalMonthlyCredits 合成', () => {
  const s = buildSnapshot({
    whoami: REAL_WHOAMI, credits: REAL_CREDITS,
    subscriptions: REAL_SUBSCRIPTIONS, usage: REAL_USAGE,
    fetchedAt: 1_795_000_000_000, errors: {},
  });
  assert.ok(s.windows.monthly, '月度窗口必须能出来');
  assert.equal(s.windows.monthly.cap, 6.256775474);
  assert.equal(s.windows.monthly.used, 3.743224526);
  assert.equal(s.windows.monthly.partial, false, '两个数字都有 → 不算部分未知');
  assert.ok(Math.abs(s.windows.monthly.percentUsed - 0.59827) < 0.001);
  assert.equal(s.windows.monthly.exceeded, false);
  // 重置时间取订阅周期结束
  assert.equal(s.windows.monthly.resetAtMs, Date.parse('2026-11-26T06:00:16.000Z'));
});

test('真实结构：套餐名来自 subscriptions.planId（whoami 没有 plan）', () => {
  const s = buildSnapshot({
    whoami: REAL_WHOAMI, credits: REAL_CREDITS,
    subscriptions: REAL_SUBSCRIPTIONS, usage: REAL_USAGE, errors: {},
  });
  assert.equal(s.plan, 'individual-go-v1');
  assert.equal(parseIdentity(REAL_WHOAMI).plan, null, 'whoami 本身确实没有套餐字段');
});

test('真实结构：五小时窗口 resetAt=0 视为未知，而不是 1970 年', () => {
  const s = buildSnapshot({ credits: REAL_CREDITS, usage: REAL_USAGE, errors: {} });
  assert.equal(s.windows.fiveHour.used, 0);
  assert.equal(s.windows.fiveHour.cap, 3);
  assert.equal(s.windows.fiveHour.resetAtMs, null, '0 不是有效时间戳');
  assert.equal(s.windows.weekly.resetAtMs, 1_795_524_195_609);
});

test('真实结构：只有上限没有已用时，月度窗口标记 partial 而不是补 0', () => {
  const s = buildSnapshot({ credits: REAL_CREDITS, errors: {} });
  assert.equal(s.windows.monthly.cap, 6.256775474);
  assert.equal(s.windows.monthly.used, null);
  assert.equal(s.windows.monthly.partial, true);
  assert.equal(s.windows.monthly.percentUsed, null, '不能把未知已用算成 0%');
});

test('真实结构：用量汇总的 totalTokensIn/Out 与总花费都能读到', () => {
  const u = parseUsageSummary(REAL_USAGE);
  assert.equal(u.total.requests, 1499);
  assert.equal(u.total.inputTokens, 131_426_962);
  assert.equal(u.total.outputTokens, 1_209_759);
  assert.equal(u.total.costUsd, 3.743224526);
  assert.equal(u.period.endMs, null, 'usage 只给了 periodStart，没有结束时间');
});

test('预热：warmupOne 与 warmupAll 能够正确调用执行器并记录运行期状态', async () => {
  const calls = [];
  let clock = 1_000_000;
  const svc = createQuotaService({
    keyPool: fakePool([KEY_A, KEY_B]),
    request: async () => ({ ok: true, status: 200, json: { data: {} } }),
    warmup: async (keyId, opts) => {
      calls.push({ keyId, ...opts });
      if (keyId === 'b') throw new Error('warmup failed for B');
      return { ok: true, model: 'claude-haiku-4-5-20251001' };
    },
    now: () => clock,
    persistence: false,
    config: () => ({ quotaAutoWarmup: true }),
  });

  // 测试单账号成功
  const resA = await svc.warmupOne('a', { reason: 'manual' });
  assert.equal(resA.ok, true);
  assert.equal(resA.model, 'claude-haiku-4-5-20251001');
  const viewA = svc.list().find(x => x.keyId === 'a');
  assert.equal(viewA.runtime.lastWarmedAt, new Date(clock).toISOString());
  assert.equal(viewA.runtime.lastWarmupError, null);

  // 测试单账号失败
  const resB = await svc.warmupOne('b', { reason: 'manual' });
  assert.equal(resB.ok, false);
  assert.match(resB.error, /warmup failed for B/);
  const viewB = svc.list().find(x => x.keyId === 'b');
  assert.equal(viewB.runtime.lastWarmupError, 'warmup failed for B');

  // 测试全量 warmupAll
  const allRes = await svc.warmupAll({ reason: 'all_test' });
  assert.equal(allRes.length, 2);
  assert.equal(allRes[0].ok, true);
  assert.equal(allRes[1].ok, false);
});

test('自动预热：到达 5 小时窗口 resetAtMs 后自动触发预热开窗', async () => {
  const warmups = [];
  let clock = 1_800_000_000_000;
  const svc = createQuotaService({
    keyPool: fakePool([KEY_A]),
    request: async () => ({
      ok: true, status: 200,
      json: {
        data: {
          windowLimits: {
            fiveHour: { used: 10, cap: 100, resetAt: (clock + 5000) / 1000 }
          }
        }
      }
    }),
    warmup: async (keyId, opts) => {
      warmups.push({ keyId, t: clock, ...opts });
      return { ok: true, model: 'claude-haiku' };
    },
    now: () => clock,
    persistence: false,
    config: () => ({ quotaAutoWarmup: true }),
  });

  // 先拉一次额度建立快照（resetAtMs = clock + 5000）
  await svc.refreshOne('a');
  assert.equal(warmups.length, 0);

  // 还没到 resetAtMs
  svc.checkRecoveries();
  assert.equal(warmups.length, 0);

  // 跨过 resetAtMs 时触发 checkRecoveries
  clock += 6000;
  svc.checkRecoveries();
  // 等待 microtask
  await new Promise(r => setTimeout(r, 10));
  assert.equal(warmups.length, 1);
  assert.equal(warmups[0].keyId, 'a');
  assert.equal(warmups[0].reason, 'auto_reset');

  // 防重复：30 分钟内不会再次预热
  clock += 1000;
  svc.checkRecoveries();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(warmups.length, 1, '30分钟内防重复生效');
});
