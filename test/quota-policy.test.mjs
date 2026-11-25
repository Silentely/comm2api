// 账号状态机与「全部不可用」时的错误归因。
// 这一层全是纯函数，所以能把边界一次性穷举干净。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAccountState, isHardBlocked, rankAccount, worstRatio, remainingRatio, quotaRemainingScore,
  retryAfterSecFor, unavailabilitySummary, windowExhausted, POLICY_DEFAULTS,
} from '../lib/quota-policy.mjs';

const NOW = 1_800_000_000_000;

function snap(windows, fetchedAtMs = NOW - 60_000) {
  return { fetchedAtMs, windows };
}

test('窗口耗尽：exceeded 明确为真，或 used 达到 cap', () => {
  assert.equal(windowExhausted({ used: 100, cap: 100 }), true);
  assert.equal(windowExhausted({ used: 99, cap: 100 }), false);
  assert.equal(windowExhausted({ used: null, cap: 100 }), false, '缺 used 不能判耗尽');
  assert.equal(windowExhausted({ used: 5, cap: null }), false, '缺 cap 不能判耗尽');
  assert.equal(windowExhausted({ used: 5, cap: 0 }), false, 'cap=0 是脏数据，不是耗尽');
  assert.equal(windowExhausted({ used: null, cap: null, exceeded: true }), true);
});

test('状态：五小时满但周额度正常 → 仍然判定额度耗尽', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 100, cap: 100, exceeded: true }, weekly: { used: 10, cap: 500 } }),
    now: NOW,
  });
  assert.equal(st.state, 'quota_exhausted');
});

test('状态：周额度满 → 同样停止派发（不是只看五小时）', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 10, cap: 100 }, weekly: { used: 500, cap: 500, exceeded: true } }),
    now: NOW,
  });
  assert.equal(st.state, 'quota_exhausted');
});

test('状态：月度信用耗尽 → 排除该账号', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 1, cap: 100 }, monthly: { used: null, cap: null, exceeded: true } }),
    now: NOW,
  });
  assert.equal(st.state, 'quota_exhausted');
});

test('状态：90% 只是软阈值 → quota_warning，仍然可派发', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 90, cap: 100 } }),
    now: NOW,
    policy: { ...POLICY_DEFAULTS, warnRatio: 0.9 },
  });
  assert.equal(st.state, 'quota_warning');
  assert.equal(isHardBlocked(st.state), false);
});

test('状态：没有快照 / 没有窗口 / 数据过期 → quota_unknown，默认不封锁', () => {
  assert.equal(deriveAccountState({ snapshot: null, now: NOW }).state, 'quota_unknown');
  assert.equal(deriveAccountState({ snapshot: snap({}), now: NOW }).state, 'quota_unknown');
  const stale = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 1, cap: 100 } }, NOW - 60 * 60_000),
    now: NOW,
    policy: { ...POLICY_DEFAULTS, unknownStaleMs: 15 * 60_000 },
  });
  assert.equal(stale.state, 'quota_unknown');
  assert.equal(isHardBlocked(stale.state), false);
  assert.equal(isHardBlocked(stale.state, { unknownBlock: true }), true);
});

test('状态优先级：鉴权失效 > 额度耗尽 > 限流 > 代理', () => {
  const base = {
    snapshot: snap({ fiveHour: { used: 100, cap: 100, exceeded: true } }),
    now: NOW,
  };
  assert.equal(deriveAccountState({
    ...base,
    runtime: { authInvalidUntilMs: NOW + 1000, exhaustedUntilMs: NOW + 1000 },
  }).state, 'auth_invalid');
  assert.equal(deriveAccountState({
    ...base,
    runtime: { exhaustedUntilMs: NOW + 1000, rateLimitedUntilMs: NOW + 1000 },
  }).state, 'quota_exhausted');
  assert.equal(deriveAccountState({
    ...base,
    snapshot: null,
    runtime: { rateLimitedUntilMs: NOW + 1000 },
  }).state, 'rate_limited');
  assert.equal(deriveAccountState({
    ...base,
    snapshot: null,
    proxyStatus: { available: false, reason: '严格绑定的代理不可用' },
  }).state, 'proxy_unavailable');
});

test('状态：代理挂了但额度充足 → proxy_unavailable，绝不是 quota_exhausted', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 5, cap: 100 } }),
    proxyStatus: { available: false, reason: '严格绑定的代理不可用' },
    now: NOW,
  });
  assert.equal(st.state, 'proxy_unavailable');
});

test('状态：手动禁用的账号永远是 manually_disabled（不会被额度状态覆盖）', () => {
  const st = deriveAccountState({ enabled: false, snapshot: null, now: NOW });
  assert.equal(st.state, 'manually_disabled');
});

test('状态：到重置时刻但没有重新确认 → 仍然封锁，并标记 awaitingRefresh', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 100, cap: 100, exceeded: true } }),
    runtime: { exhaustedUntilMs: NOW - 1000, pendingRecovery: true },
    now: NOW,
  });
  assert.equal(st.state, 'quota_exhausted');
  assert.equal(st.awaitingRefresh, true);
  assert.ok(st.untilMs > NOW);
});

test('Recovery：官方窗口恢复后状态变回 available', () => {
  const st = deriveAccountState({
    snapshot: snap({ fiveHour: { used: 3, cap: 100 } }),
    runtime: { exhaustedUntilMs: NOW - 1000, pendingRecovery: false },
    now: NOW,
  });
  assert.equal(st.state, 'available');
});

test('排序：可用 < 接近上限 < 未知，且同档内用量低的优先', () => {
  const a = rankAccount({ state: 'available', ratio: 0.1 });
  const b = rankAccount({ state: 'available', ratio: 0.5 });
  const warn = rankAccount({ state: 'quota_warning', ratio: 0.95 });
  const unknown = rankAccount({ state: 'quota_unknown', ratio: null });
  assert.ok(a < b, '用量低的优先');
  assert.ok(b < warn, '软阈值账号排在可用账号之后');
  assert.ok(warn < unknown, '未知额度排最后');
});

test('排序：月度窗口越快重置越优先，压过周与五小时额度差异', () => {
  const sooner = snap({
    monthly: { used: 90, cap: 100, resetAtMs: NOW + 24 * 60 * 60 * 1000 },
    weekly: { used: 95, cap: 100 }, fiveHour: { used: 95, cap: 100 },
  });
  const later = snap({
    monthly: { used: 10, cap: 100, resetAtMs: NOW + 25 * 24 * 60 * 60 * 1000 },
    weekly: { used: 10, cap: 100 }, fiveHour: { used: 10, cap: 100 },
  });
  assert.ok(
    rankAccount({ state: 'available', snapshot: sooner, now: NOW }) < rankAccount({ state: 'available', snapshot: later, now: NOW }),
    '月度重置更近的账号先使用，即使周和五小时余量更少',
  );
});

test('排序：月度窗口同档时按周余量，再按五小时余量', () => {
  const sameMonthly = { used: 50, cap: 100, resetAtMs: NOW + 10 * 24 * 60 * 60 * 1000 };
  const freshWeek = snap({ monthly: sameMonthly, weekly: { used: 10, cap: 100 }, fiveHour: { used: 90, cap: 100 } });
  const tightWeek = snap({ monthly: sameMonthly, weekly: { used: 90, cap: 100 }, fiveHour: { used: 10, cap: 100 } });
  assert.ok(
    rankAccount({ state: 'available', snapshot: freshWeek, now: NOW }) < rankAccount({ state: 'available', snapshot: tightWeek, now: NOW }),
    '月度相同时，周余量多的优先，即使五小时余量更少',
  );

  const sameWeek = { used: 50, cap: 100 };
  const freshFive = snap({ monthly: sameMonthly, weekly: sameWeek, fiveHour: { used: 10, cap: 100 } });
  const tightFive = snap({ monthly: sameMonthly, weekly: sameWeek, fiveHour: { used: 90, cap: 100 } });
  assert.ok(
    rankAccount({ state: 'available', snapshot: freshFive, now: NOW }) < rankAccount({ state: 'available', snapshot: tightFive, now: NOW }),
    '月度和周都相同时，五小时余量多的优先',
  );
});

test('排序：在途请求和燃烧预测不会跨过额度窗口档位', () => {
  const nearerReset = snap({
    monthly: { used: 50, cap: 100, resetAtMs: NOW + 24 * 60 * 60 * 1000 },
    weekly: { used: 50, cap: 100 }, fiveHour: { used: 50, cap: 100 },
  });
  const fartherReset = snap({
    monthly: { used: 50, cap: 100, resetAtMs: NOW + 3 * 24 * 60 * 60 * 1000 },
    weekly: { used: 50, cap: 100 }, fiveHour: { used: 50, cap: 100 },
  });
  assert.ok(
    rankAccount({ state: 'available', snapshot: nearerReset, now: NOW, inflight: 4,
      forecast: { status: 'ok', willExhaustBeforeReset: true } })
      < rankAccount({ state: 'available', snapshot: fartherReset, now: NOW }),
    '额度窗口排序优先于在途请求与燃烧预测',
  );
});

test('排序：窗口缺失按中性处理，不会因为缺数据被排到最前或最后', () => {
  const monthly = { used: 50, cap: 100, resetAtMs: NOW + 10 * 24 * 60 * 60 * 1000 };
  const weekly = { used: 50, cap: 100 };
  const healthy = snap({ monthly, weekly, fiveHour: { used: 10, cap: 100 } });
  const missingFive = snap({ monthly, weekly });
  const tight = snap({ monthly, weekly, fiveHour: { used: 90, cap: 100 } });

  const s = o => rankAccount({ state: 'available', snapshot: o, now: NOW });
  // 五小时低优先级同档：已知宽松 > 未知（中性 0.5）> 明确紧张
  assert.ok(s(healthy) < s(missingFive), '五小时真实余量足于同档优先');
  assert.ok(s(missingFive) < s(tight), '五小时未知不等于已用完，排在明确紧张之前');
});

test('排序：同档内优先空闲账号，避免并发把单个 Key 打爆', () => {
  const s = snap({ fiveHour: { used: 10, cap: 100 }, weekly: { used: 10, cap: 100 } });
  const idle = rankAccount({ state: 'available', snapshot: s, inflight: 0 });
  const busy = rankAccount({ state: 'available', snapshot: s, inflight: 2 });
  assert.ok(idle < busy, '在途请求多的账号往后排');
});

test('排序：预测会在重置前烧完的账号往后放', () => {
  const s = snap({ fiveHour: { used: 10, cap: 100 } });
  const ok = rankAccount({ state: 'available', snapshot: s, forecast: { status: 'ok', willExhaustBeforeReset: false } });
  const burning = rankAccount({ state: 'available', snapshot: s, forecast: { status: 'ok', willExhaustBeforeReset: true } });
  const unknown = rankAccount({ state: 'available', snapshot: s, forecast: { status: 'unknown' } });
  assert.ok(ok < burning, '预计撑不到重置的账号降权');
  assert.equal(unknown, ok, '预测未知不改变排序');
});

test('worstRatio：取所有窗口里最紧张的那个', () => {
  assert.equal(worstRatio(snap({ fiveHour: { used: 10, cap: 100 }, weekly: { used: 400, cap: 500 } })), 0.8);
  assert.equal(worstRatio(snap({})), null);
});

test('剩余比例：官方只给 percentUsed 时也要参与排序', () => {
  // 部分端点只回百分比，没有 used/cap —— 不能当成「未知」中性处理。
  assert.equal(remainingRatio({ percentUsed: 0.25 }), 0.75);
  assert.equal(remainingRatio({ used: 75, cap: 100 }), 0.25);
  // percentUsed 与 used/cap 都在时，两者等价
  assert.equal(remainingRatio({ used: 25, cap: 100, percentUsed: 0.25 }), 0.75);
  assert.equal(remainingRatio({}), null);
  assert.equal(remainingRatio({ used: 5, cap: 0 }), null);

  const percentOnly = snap({ fiveHour: { percentUsed: 0.95 } });
  const known = snap({ fiveHour: { used: 50, cap: 100 } });
  assert.ok(
    rankAccount({ state: 'available', snapshot: known }) < rankAccount({ state: 'available', snapshot: percentOnly }),
    '只给百分比的紧张窗口不能排到已知宽松的账号前面',
  );
  // 五小时已用满、周/月未知 → 低于「全部未知」的中性 0.5
  assert.ok(quotaRemainingScore(snap({ fiveHour: { percentUsed: 1 } })) < 0.5);
  assert.equal(quotaRemainingScore(snap({})), 0.5, '全部缺失时就是中性值');
});

test('排序：五小时剩余只在月度和周窗口同档时决定顺序', () => {
  const monthly = { used: 50, cap: 100, resetAtMs: NOW + 10 * 24 * 60 * 60 * 1000 };
  const weekly = { used: 50, cap: 100 };
  const moreFive = snap({ monthly, weekly, fiveHour: { used: 10, cap: 100 } });
  const lessFive = snap({ monthly, weekly, fiveHour: { used: 90, cap: 100 } });
  assert.ok(
    rankAccount({ state: 'available', snapshot: moreFive, now: NOW }) < rankAccount({ state: 'available', snapshot: lessFive, now: NOW }),
    '月度与周都同档时，五小时余量更多的账号优先',
  );
});

test('排序：负载与预测只会同档微调，不能跨过状态档', () => {
  const s = snap({ fiveHour: { used: 50, cap: 100 }, weekly: { used: 50, cap: 100 } });
  const worstAvailable = rankAccount({
    state: 'available', snapshot: s, inflight: 100,
    forecast: { status: 'ok', willExhaustBeforeReset: true },
  });
  const bestWarning = rankAccount({ state: 'quota_warning', snapshot: s });
  const bestUnknown = rankAccount({ state: 'quota_unknown', snapshot: s });
  assert.ok(worstAvailable < bestWarning, '可用档再忙也要排在警戒档之前');
  assert.ok(bestWarning < bestUnknown, '警戒档排在未知档之前');
});

test('Retry-After：全部额度耗尽时按最早的官方重置时间计算，并有界', () => {
  const sec = retryAfterSecFor([
    { state: 'quota_exhausted', untilMs: NOW + 90_000 },
    { state: 'quota_exhausted', untilMs: NOW + 600_000 },
  ], { now: NOW });
  assert.equal(sec, 90);

  const capped = retryAfterSecFor([{ state: 'quota_exhausted', untilMs: NOW + 10 * 3600_000 }], { now: NOW });
  assert.equal(capped, 3600, '超过一小时必须收敛，不能给客户端一个荒唐的等待时间');

  assert.equal(retryAfterSecFor([{ state: 'proxy_unavailable' }], { now: NOW }), null);
});

test('不可用归因：全额度耗尽 → quota；有代理故障 → 不能报额度耗尽', () => {
  assert.equal(unavailabilitySummary([{ state: 'quota_exhausted' }, { state: 'quota_exhausted' }]).kind, 'quota');
  assert.equal(unavailabilitySummary([{ state: 'proxy_unavailable' }, { state: 'proxy_unavailable' }]).kind, 'proxy');
  assert.equal(unavailabilitySummary([{ state: 'auth_invalid' }]).kind, 'auth');
  assert.equal(unavailabilitySummary([{ state: 'rate_limited' }]).kind, 'rate_limit');
  const mixed = unavailabilitySummary([{ state: 'quota_exhausted' }, { state: 'proxy_unavailable' }]);
  assert.equal(mixed.kind, 'mixed');
  assert.deepEqual(mixed.kinds.sort(), ['proxy_unavailable', 'quota_exhausted']);
});
