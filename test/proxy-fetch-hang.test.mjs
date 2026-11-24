// 回归测试：代理隧道（proxyFetch）与额度刷新/预热的挂死防护。
//
// 线上真实故障复盘：
//   1) Node 下 proxyFetch 的 TLS 握手阶段在 AbortController 超时后调用 socket.destroy()
//      （无 error 参数），Node 的 TLSSocket 只触发 close、不触发 error → Promise 永不 settle；
//   2) proxyFetch 在拿到响应头后立刻 cleanupAborts()，导致后续 res.text() / reader.read()
//      在响应体卡住时完全收不到 abort 信号 → Promise 永不 settle；
//   3) 一旦 refreshOne / warmupOne 的 Promise 永不 settle，inflight / inFlightWarmups 永久锁死：
//      账号长期显示「数据已过期」（refreshing=true），手动点击刷新卡死，点击预热一直「正在预热中」。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeServer, startProxy } from './helpers.mjs';
import { createQuotaService } from '../lib/quota.mjs';

const PASSWORD = 'hang-test-password';
const KEY_A = 'user_hangtest111111111111111111111';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const NDJSON_OK = [
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"ok"}',
  '{"type":"text-end"}',
  '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":5,"outputTokens":2}}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2,"cachedInputTokens":0}}',
];

async function loggedIn(proxy) {
  const r = await proxy.post('/admin/api/login', { password: PASSWORD });
  const cookie = (r.headers.getSetCookie?.()[0] || r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, '登录应返回会话 Cookie');
  const h = { Cookie: cookie, 'Content-Type': 'application/json' };
  return {
    get: (p) => proxy.get(`/admin/api${p}`, { headers: h }),
    post: (p, body) => proxy.post(`/admin/api${p}`, body, h),
  };
}

function seedWorkdir({ apiBase, proxyAddr, quotaTimeoutMs = 1000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-hang-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    proxyKey: 'client-key-hang',
    apiKey: '',
    apiBase,
    quotaEnabled: true,
    quotaTimeoutMs,
    quotaRefreshIntervalMs: 60 * 60 * 1000,
    quotaAutoWarmup: false,
    useProviderModels: false,
    useProviderModelsWithPlanFilter: false,
    logLevel: 'warn',
  }, null, 2) + '\n');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'keys.json'), JSON.stringify({
    version: 1,
    keys: [{ id: 'k_hang_a', key: KEY_A, label: 'hang@example.com', enabled: true }],
  }, null, 2) + '\n');
  const pid = sha(proxyAddr);
  writeFileSync(join(dir, 'data', 'proxies.json'), JSON.stringify({
    version: 1,
    entries: [{ id: pid, value: proxyAddr, enabled: true }],
    disabled: [],
    bindings: { [sha(KEY_A)]: { mode: 'strict_bind', proxyId: pid } },
  }, null, 2) + '\n');
  return dir;
}

/**
 * 可控 CONNECT 代理：
 *   mode === 'tls-hang' → 回 200 Connection Established 后静默挂死（复现 TLS 握手卡住）
 *   mode === 'tls-eof'  → 回 200 Connection Established 后立刻关闭连接（复现握手期对端 FIN）
 *   mode === 'tunnel'   → 正常透传到目标 TCP 端口
 */
async function startControllableConnectProxy(ctl) {
  const openSockets = new Set();
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    hits++;
    openSockets.add(clientSocket);
    clientSocket.on('close', () => openSockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    if (ctl.mode === 'tls-hang') {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      return;
    }
    if (ctl.mode === 'tls-eof') {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.end();
      return;
    }
    const [host, rawPort] = req.url.split(':');
    const upstream = net.connect(Number(rawPort) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    openSockets.add(upstream);
    upstream.on('close', () => openSockets.delete(upstream));
    upstream.on('error', () => { try { clientSocket.destroy(); } catch {} });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    addr: `http://127.0.0.1:${port}`,
    get hits() { return hits; },
    async close() {
      for (const s of openSockets) { try { s.destroy(); } catch {} }
      await closeServer(server);
    },
  };
}

// ── 单元测试：quotaService 自身的硬超时兜底 ──────────────

test('quotaService：底层 request 永不 settle 时，硬超时兜底释放 inflight 且后续刷新能恢复', async () => {
  let hang = true;
  const svc = createQuotaService({
    keyPool: {
      all: () => [{ id: 'a', key: KEY_A, enabled: true }],
      findById: (id) => (id === 'a' ? { id: 'a', key: KEY_A, enabled: true } : null),
    },
    request: () => {
      if (hang) return new Promise(() => {}); // 永不 settle
      return Promise.resolve({
        ok: true,
        status: 200,
        json: { data: { windowLimits: { fiveHour: { used: 1, cap: 3, resetAt: Date.now() + 3600_000 } } } },
      });
    },
    config: () => ({ apiBase: 'http://quota.local', quotaTimeoutMs: 1000, quotaHardTimeoutMs: 120 }),
    log: () => {},
    persistence: false,
  });

  const t0 = Date.now();
  const r1 = await svc.refreshOne('a', { reason: 'manual', force: true });
  assert.equal(r1.ok, false, '挂死的请求必须在硬超时后失败返回');
  assert.ok(Date.now() - t0 < 2000, '硬超时不应长时间阻塞');

  const viewAfterFail = svc.list()[0];
  assert.equal(viewAfterFail.refreshing, false, 'inflight 必须被清理，不能永久卡在 refreshing=true');
  assert.equal(viewAfterFail.runtime.failures, 1);
  assert.ok(viewAfterFail.runtime.lastFailure, '应记录失败原因');

  hang = false;
  const r2 = await svc.refreshOne('a', { reason: 'manual', force: true });
  assert.equal(r2.ok, true, '恢复后后续手动刷新应正常成功');
  assert.equal(svc.list()[0].refreshing, false);
});

test('quotaService：底层 warmup 永不 settle 时，硬超时兜底释放 inFlightWarmups 且后续预热可执行', async () => {
  let hang = true;
  let calls = 0;
  const svc = createQuotaService({
    keyPool: {
      all: () => [{ id: 'a', key: KEY_A, enabled: true }],
      findById: (id) => (id === 'a' ? { id: 'a', key: KEY_A, enabled: true } : null),
    },
    request: async () => ({ ok: true, status: 200, json: {} }),
    warmup: () => {
      calls++;
      if (hang) return new Promise(() => {});
      return Promise.resolve({ ok: true, model: 'deepseek/deepseek-v4-flash' });
    },
    config: () => ({ apiBase: 'http://quota.local', quotaWarmupTimeoutMs: 120 }),
    log: () => {},
    persistence: false,
  });

  const r1 = await svc.warmupOne('a', { reason: 'manual' });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /超时/);

  hang = false;
  const r2 = await svc.warmupOne('a', { reason: 'manual' });
  assert.equal(r2.ok, true, 'inFlightWarmups 释放后，再次预热不能被卡在「正在预热中」');
  assert.equal(calls, 2);
});

// ── 端到端回归：proxyFetch TLS 握手挂死 & 对端关闭 ────────

test('proxyFetch：CONNECT 后 TLS 握手挂死时，额度刷新按时超时并释放 refreshing', async () => {
  const ctl = { mode: 'tls-hang' };
  const connectProxy = await startControllableConnectProxy(ctl);
  const workdir = seedWorkdir({
    apiBase: 'https://api.commandcode.test',
    proxyAddr: connectProxy.addr,
    quotaTimeoutMs: 1000,
  });
  const proxy = await startProxy({
    upstreamPort: 1,
    cwd: workdir,
    env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '', CC_API_BASE: 'https://api.commandcode.test' },
  });
  try {
    const api = await loggedIn(proxy);
    const t0 = Date.now();
    const r = await api.post('/quota/refresh', { id: 'k_hang_a' });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(connectProxy.hits > 0, '必须真正发起了 CONNECT 隧道请求');
    assert.ok(elapsed >= 900, `TLS 挂死应等到 quotaTimeoutMs(~1s) 才超时，实际 ${elapsed}ms`);
    assert.equal(body.data.results[0].ok, false, 'TLS 握手卡死时刷新应失败而非挂死');
    assert.match(Object.values(body.data.results[0].errors || {}).join(' '), /abort/i, '应由 AbortController 超时中止');
    assert.ok(elapsed < 6000, `应在超时窗口内返回，实际耗时 ${elapsed}ms`);

    const q = await (await api.get('/quota')).json();
    const acc = q.data.accounts.find((a) => a.keyId === 'k_hang_a');
    assert.equal(acc.refreshing, false, 'refreshing 必须回到 false');
    assert.ok(acc.runtime.lastFailure, '应记录上次查询失败原因');
  } finally {
    await proxy.kill();
    await connectProxy.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('proxyFetch：CONNECT 后 TLS 握手期对端直接断开（EOF）时立刻失败，不挂死', async () => {
  const ctl = { mode: 'tls-eof' };
  const connectProxy = await startControllableConnectProxy(ctl);
  const workdir = seedWorkdir({
    apiBase: 'https://api.commandcode.test',
    proxyAddr: connectProxy.addr,
    quotaTimeoutMs: 5000,
  });
  const proxy = await startProxy({
    upstreamPort: 1,
    cwd: workdir,
    env: { ADMIN_PASSWORD: PASSWORD, CC_API_KEY: '', CC_API_BASE: 'https://api.commandcode.test' },
  });
  try {
    const api = await loggedIn(proxy);
    const t0 = Date.now();
    const r = await api.post('/quota/refresh', { id: 'k_hang_a' });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(connectProxy.hits > 0, '必须真正发起了 CONNECT 隧道请求');
    assert.equal(body.data.results[0].ok, false);
    assert.match(Object.values(body.data.results[0].errors || {}).join(' '), /closed|TLS|disconnect|hang up/i, '应明确报 TLS 握手连接断开');
    assert.ok(elapsed < 3000, `对端 EOF 应快速失败（不该等到 5s 超时或永久挂死），实际 ${elapsed}ms`);

    const q = await (await api.get('/quota')).json();
    assert.equal(q.data.accounts.find((a) => a.keyId === 'k_hang_a').refreshing, false);
  } finally {
    await proxy.kill();
    await connectProxy.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

// ── 端到端回归：拿到 HTTP 200 响应头后响应体卡死 ──────────

test('proxyFetch + consumeProbeStream：经代理拿到 200 响应头后响应体卡死，刷新与预热均能超时退出并恢复', async () => {
  const state = { stallQuota: true, stallWarmup: true };
  const stalledRes = new Set();

  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.endsWith('/alpha/fingerprint/record') || req.url.endsWith('/alpha/lifecycle-events')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
        return;
      }
      if (req.url.includes('/alpha/whoami') || req.url.includes('/alpha/billing/') || req.url.includes('/alpha/usage/summary')) {
        if (state.stallQuota) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"partial":');
          stalledRes.add(res);
          res.on('close', () => stalledRes.delete(res));
          return; // 故意不 end，模拟响应体卡死
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.includes('/alpha/usage/summary')) {
          res.end(JSON.stringify({
            data: { windowLimits: { fiveHour: { used: 0.5, cap: 3, exceeded: false, resetAt: Date.now() + 3600_000 } } },
          }));
        } else {
          res.end(JSON.stringify({ data: { user_id: 'u_hang', plan: 'individual-go-v1' } }));
        }
        return;
      }
      if (req.url.includes('/alpha/generate')) {
        if (state.stallWarmup) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.flushHeaders();
          stalledRes.add(res);
          res.on('close', () => stalledRes.delete(res));
          return; // 故意不发任何流数据
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const line of NDJSON_OK) res.write(line + '\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const { port: upstreamPort } = upstream.address();

  const connectProxy = await startControllableConnectProxy({ mode: 'tunnel' });
  const apiBase = `http://127.0.0.1:${upstreamPort}`;
  const workdir = seedWorkdir({ apiBase, proxyAddr: connectProxy.addr, quotaTimeoutMs: 1000 });
  const proxy = await startProxy({
    upstreamPort,
    cwd: workdir,
    env: {
      ADMIN_PASSWORD: PASSWORD,
      CC_API_KEY: '',
      CC_API_BASE: apiBase,
      CC_WARMUP_TIMEOUT_MS: '1000',
    },
  });
  try {
    const api = await loggedIn(proxy);

    // 1) 刷新：响应体卡死 → 必须在 ~1s 内超时返回，不锁死 refreshing
    const t0 = Date.now();
    const r1 = await api.post('/quota/refresh', { id: 'k_hang_a' });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.data.results[0].ok, false, '响应体卡死时刷新应按超时失败');
    assert.ok(Date.now() - t0 < 5000, '响应体卡死时不应挂死');
    const q1 = await (await api.get('/quota')).json();
    assert.equal(q1.data.accounts.find((a) => a.keyId === 'k_hang_a').refreshing, false);

    // 2) 恢复上游后，再次点击刷新应立刻成功拿到最新数据
    state.stallQuota = false;
    const r2 = await api.post('/quota/refresh', { id: 'k_hang_a' });
    const b2 = await r2.json();
    assert.equal(b2.data.results[0].ok, true, '恢复后手动刷新应成功');

    // 3) 预热：200 流卡死 → 必须在 ~1s 内报超时并释放 inFlightWarmups
    const t1 = Date.now();
    const w1 = await api.post('/quota/warmup', { id: 'k_hang_a' });
    assert.equal(w1.status, 502, '预热超时应返回 502 错误');
    const wb1 = await w1.json();
    assert.match(wb1.error || wb1.message || '', /超时/, '应明确提示预热超时');
    assert.ok(Date.now() - t1 < 5000, '预热流卡死时不应挂死');

    // 4) 恢复上游后，再次点击预热不能被卡在「正在预热中」，必须成功
    state.stallWarmup = false;
    const w2 = await api.post('/quota/warmup', { id: 'k_hang_a' });
    assert.equal(w2.status, 200);
    const wb2 = await w2.json();
    assert.equal(wb2.data.results[0].ok, true, '预热释放后再次点击应正常成功');
  } finally {
    for (const r of stalledRes) { try { r.destroy(); } catch {} }
    await proxy.kill();
    await connectProxy.close();
    await closeServer(upstream);
    rmSync(workdir, { recursive: true, force: true });
  }
});
