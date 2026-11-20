// strict_bind（严格固定代理）：只能用指定的一条，故障时失败关闭。
// 与现有 bind（故障时允许临时迁移）的行为必须互不影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 独立数据目录：不然会写到仓库的 data/proxies.json 里
process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-strict-'));
process.env.CC_ENV_FILE = join(tmpdir(), 'ccp-no-dotenv');

const { createProxyPool } = await import('../lib/proxies.mjs');

const A = 'http://127.0.0.1:19001';
const B = 'http://127.0.0.1:19002';
void A; void B;

let portSeq = 19100;

function makePool() {
  let probeResult = { reachable: true };
  const keys = ['user_a', 'user_b'];
  const pool = createProxyPool({
    log: () => {},
    keysProvider: () => keys,
    keyIdFor: (k) => (k === 'user_a' ? 'id_a' : 'id_b'),
    probe: async () => probeResult,
  });
  return { pool, setProbe: (v) => { probeResult = v; } };
}

function freshPool() {
  const { pool, setProbe } = makePool();
  const addrA = `http://127.0.0.1:${portSeq++}`;
  const addrB = `http://127.0.0.1:${portSeq++}`;
  const a = pool.add(addrA);
  const b = pool.add(addrB);
  assert.ok(a.ok, `添加 A 失败: ${a.error}`);
  assert.ok(b.ok, `添加 B 失败: ${b.error}`);
  return { pool, setProbe, idA: a.entry.id, idB: b.entry.id, addrA, addrB };
}

test('严格绑定：只用指定代理，绝不使用另一条', () => {
  const { pool, idA, addrA } = freshPool();
  const fp = pool.fingerprintForKey('user_a');
  const r = pool.setBinding(fp, 'strict_bind', idA);
  assert.equal(r.ok, true);
  assert.equal(r.strict, true);

  const route = pool.routeFor('user_a');
  assert.equal(route.available, true);
  assert.equal(route.address, addrA);
  assert.equal(route.mode, 'strict_bind');
  assert.equal(pool.bindingFor('user_a').mode, 'strict_bind');
});

test('严格绑定：代理不健康时失败关闭（不迁移、不直连）', async () => {
  const { pool, idA, setProbe } = freshPool();
  const fp = pool.fingerprintForKey('user_a');
  pool.setBinding(fp, 'strict_bind', idA);

  setProbe({ reachable: false, error: new Error('connect ECONNREFUSED') });
  await pool.test(idA);

  const route = pool.routeFor('user_a');
  assert.equal(route.available, false, '不能悄悄换一条代理');
  assert.equal(route.address, null, '更不能悄悄直连');
  assert.ok(route.reason.includes('不可用'));
  // 同一次请求内的第二次尝试也不能落到别的代理上
  assert.equal(pool.choose('user_a'), null);
});

test('严格绑定：代理恢复后账号自动恢复可用', async () => {
  const { pool, idA, addrA, setProbe } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  setProbe({ reachable: false, error: new Error('boom') });
  await pool.test(idA);
  assert.equal(pool.routeFor('user_a').available, false);

  setProbe({ reachable: true });
  await pool.test(idA);
  assert.equal(pool.routeFor('user_a').available, true);
  assert.equal(pool.routeFor('user_a').address, addrA);
});

test('严格绑定：目标被停用 → 失败关闭，且不会改成 auto', () => {
  const { pool, idA } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  pool.setEnabled([idA], false);

  const route = pool.routeFor('user_a');
  assert.equal(route.available, false);
  assert.equal(pool.bindingFor('user_a').mode, 'strict_bind', '绑定模式不能被静默改写');
});

test('严格绑定：目标被删除 → 绑定保留但失败关闭（不留悬空 auto）', () => {
  const { pool, idA } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  const del = pool.remove([idA]);
  assert.equal(del.ok, true);

  const route = pool.routeFor('user_a');
  assert.equal(route.available, false);
  assert.ok(route.reason.includes('不存在') || route.reason.includes('停用'));
  assert.equal(pool.bindingFor('user_a').mode, 'strict_bind');
  assert.equal(pool.bindingFor('user_a').proxyId, idA);
});

test('严格绑定：指定不存在的代理时直接拒绝', () => {
  const { pool } = freshPool();
  const r = pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', 'nope');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('原有 bind 语义不变：代理故障时仍允许临时迁移', async () => {
  const { pool, idA, addrA, setProbe } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_b'), 'bind', idA);
  setProbe({ reachable: false, error: new Error('boom') });
  await pool.test(idA);

  const route = pool.routeFor('user_b');
  assert.equal(route.available, true, 'bind 不能因为代理故障就把账号停掉');
  assert.ok(route.address, 'bind 会迁移到另一条健康代理');
  assert.notEqual(route.address, addrA);
  assert.equal(pool.bindingFor('user_b').proxyId, idA, '绑定目标仍是原来那条（迁移是临时的）');
});

test('严格绑定的账号与普通账号互不影响（B 不受 A 的代理故障拖累）', () => {
  const { pool, idA, idB, addrB } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  pool.setBinding(pool.fingerprintForKey('user_b'), 'strict_bind', idB);
  pool.setEnabled([idA], false);

  assert.equal(pool.routeFor('user_a').available, false);
  const routeB = pool.routeFor('user_b');
  assert.equal(routeB.available, true);
  assert.equal(routeB.address, addrB);
});

test('keyViews 暴露严格绑定与不可用原因，供后台区分三种固定模式', () => {
  const { pool, idA } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  pool.setEnabled([idA], false);
  const view = pool.keyViews().find(v => v.keyId === 'id_a');
  assert.equal(view.mode, 'strict_bind');
  assert.equal(view.strict, true);
  assert.equal(view.boundProxyId, idA);
  assert.ok(view.unavailableReason, '后台要能看到「为什么这个账号不出请求」');
});

test('strict_bind 持久化：重启后模式与目标都还在', async () => {
  const { pool, idA } = freshPool();
  pool.setBinding(pool.fingerprintForKey('user_a'), 'strict_bind', idA);
  pool.flush();

  const { createProxyPool: fresh } = await import('../lib/proxies.mjs?reload=1');
  const pool2 = fresh({ log: () => {}, keysProvider: () => ['user_a'] });
  assert.equal(pool2.bindingFor('user_a').mode, 'strict_bind');
  assert.equal(pool2.bindingFor('user_a').proxyId, idA);
});
