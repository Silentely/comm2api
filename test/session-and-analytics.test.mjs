// 会话粘性 + 本地用量分析。两者都是纯内存组件，可完全确定性测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAffinity, resolveSessionId } from '../lib/session-affinity.mjs';
import { createUsageAnalytics, WINDOWS } from '../lib/usage-analytics.mjs';

// ── 会话粘性 ──────────────────────────────────────
test('粘性：同一会话记住账号，不同会话互不影响', () => {
  const aff = createSessionAffinity({ ttlMs: 60_000 });
  aff.set('ck:1', 'sess-a', 'keyA');
  assert.equal(aff.get('ck:1', 'sess-a'), 'keyA');
  assert.equal(aff.get('ck:1', 'sess-b'), null);
  aff.stop();
});

test('粘性：不同客户端命名空间不会串号（同名 session id 各归各）', () => {
  const aff = createSessionAffinity({ ttlMs: 60_000 });
  aff.set('ck:1', 'same-id', 'keyA');
  aff.set('ck:2', 'same-id', 'keyB');
  assert.equal(aff.get('ck:1', 'same-id'), 'keyA');
  assert.equal(aff.get('ck:2', 'same-id'), 'keyB');
  aff.stop();
});

test('粘性：TTL 到期后失效（不会把会话永久钉在旧账号上）', () => {
  let clock = 1_000_000;
  const aff = createSessionAffinity({ ttlMs: 1000, now: () => clock });
  aff.set('ns', 's1', 'keyA');
  clock += 500;
  assert.equal(aff.get('ns', 's1'), 'keyA');
  clock += 2000;
  assert.equal(aff.get('ns', 's1'), null);
  aff.stop();
});

test('粘性：容量上限触发 LRU 淘汰，内存有界', () => {
  const aff = createSessionAffinity({ ttlMs: 10 * 60_000, maxEntries: 3 });
  for (const id of ['s1', 's2', 's3']) aff.set('ns', id, 'keyA');
  aff.get('ns', 's1');          // 触碰 s1，最旧的变成 s2
  aff.set('ns', 's4', 'keyA');  // 触发淘汰
  assert.equal(aff.size, 3);
  assert.equal(aff.get('ns', 's2'), null, '最久未使用的被淘汰');
  assert.equal(aff.get('ns', 's1'), 'keyA');
  aff.stop();
});

test('粘性：账号被删除时可以一次性清掉所有指向它的映射', () => {
  const aff = createSessionAffinity({ ttlMs: 60_000 });
  aff.set('ns', 's1', 'keyA');
  aff.set('ns', 's2', 'keyA');
  aff.set('ns', 's3', 'keyB');
  assert.equal(aff.dropKey('keyA'), 2);
  assert.equal(aff.get('ns', 's1'), null);
  assert.equal(aff.get('ns', 's3'), 'keyB');
  aff.stop();
});

test('会话标识：从客户端 header 取，且带命名空间前缀', () => {
  const r1 = resolveSessionId({ 'x-session-id': 'abcdefgh' }, null, 'ck:1');
  assert.equal(r1.id, 'ck:1:abcdefgh');
  assert.equal(r1.source, 'x-session-id');
  const r2 = resolveSessionId({ 'x-claude-code-session-id': '12345678' }, null, 'ck:1');
  assert.equal(r2.id, 'ck:1:12345678');
  const r3 = resolveSessionId({}, 'prompt-cache-key-123', 'ck:1');
  assert.equal(r3.id, 'ck:1:prompt-cache-key-123');
});

test('会话标识：缺失或过短时退回普通调度（返回 null）', () => {
  assert.equal(resolveSessionId({}, null, 'ns').id, null);
  assert.equal(resolveSessionId({ 'x-session-id': 'short' }, null, 'ns').id, null,
    '过短的 id 很可能是噪声，不能用来绑会话');
});

// ── 用量分析 ──────────────────────────────────────
test('分析：按时间窗聚合，窗口外的记录不计入', () => {
  let clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock });
  a.record({ t: clock - 10 * 60_000, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 100, tokensOut: 10 });
  a.record({ t: clock - 2 * 60_000, keyId: 'B', model: 'm2', protocol: 'messages', status: 'error', httpStatus: 429 });
  a.record({ t: clock - 1000, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 50, tokensOut: 5 });

  const five = a.report({ window: '5m' });
  assert.equal(five.totals.requests, 2);
  assert.equal(five.totals.tokensIn, 50);
  const hour = a.report({ window: '1h' });
  assert.equal(hour.totals.requests, 3);
  assert.equal(hour.totals.failed, 1);
  assert.equal(hour.source, 'local', '本地统计必须标明来源');
});

test('分析：按账号/模型/协议/状态分组', () => {
  let clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock });
  a.record({ t: clock, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 10, tokensOut: 1, latencyMs: 100 });
  a.record({ t: clock, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 20, tokensOut: 2, latencyMs: 300 });
  a.record({ t: clock, keyId: 'B', model: 'm2', protocol: 'responses', status: 'error', latencyMs: 50 });

  const r = a.report({ window: '5m' });
  const byAccount = r.dimensions.account;
  assert.equal(byAccount[0].key, 'A');
  assert.equal(byAccount[0].requests, 2);
  assert.equal(byAccount[0].latency.p50, 100);
  assert.equal(byAccount[0].latency.p95, 300);
  assert.equal(r.dimensions.protocol.length, 2);
  assert.equal(r.dimensions.status.some(g => g.key === 'error'), true);
});

test('分析：缓存命中率与成本只在有依据时给出', () => {
  const clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock });
  a.record({ t: clock, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 100, tokensOut: 10, cacheRead: 40 });
  const r = a.report({ window: '5m' });
  assert.equal(r.totals.cacheHitRate, 0.4);
  assert.equal(r.totals.costEstimated, false, '没有价目表就不该显示成本');

  const priced = createUsageAnalytics({ now: () => clock, priceOf: () => ({ input: 3, output: 15, cacheRead: 0.3 }) });
  priced.record({ t: clock, keyId: 'A', model: 'm1', protocol: 'chat', status: 'ok', tokensIn: 1_000_000, tokensOut: 100_000 });
  const pr = priced.report({ window: '5m' });
  assert.equal(pr.totals.costEstimated, true, '估算必须带标记');
  assert.ok(pr.totals.costUsd > 0);
});

test('分析：容量有界，超出后丢弃最旧的记录', () => {
  const clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock, maxRecords: 100 });
  for (let i = 0; i < 250; i++) a.record({ t: clock - (250 - i) * 1000, keyId: 'A', protocol: 'chat', status: 'ok' });
  assert.equal(a.size, 100);
  const r = a.report({ window: '7d' });
  assert.equal(r.capacity.dropped, 150);
});

test('分析：只收数值字段，不会记录正文（结构上就无法泄露 prompt）', () => {
  const clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock });
  a.record({ t: clock, keyId: 'A', protocol: 'chat', status: 'ok', prompt: 'SECRET-PROMPT', body: 'x' });
  const dump = JSON.stringify(a.report({ window: '5m' }));
  assert.equal(dump.includes('SECRET-PROMPT'), false);
});

test('分析：overview 覆盖全部时间窗且结构稳定', () => {
  const clock = 1_800_000_000_000;
  const a = createUsageAnalytics({ now: () => clock });
  a.record({ t: clock, keyId: 'A', protocol: 'chat', status: 'ok', tokensIn: 5, tokensOut: 1 });
  const o = a.overview();
  assert.deepEqual(Object.keys(o.windows).sort(), Object.keys(WINDOWS).sort());
  assert.equal(o.windows['5m'].requests, 1);
  assert.equal(o.source, 'local');
});
