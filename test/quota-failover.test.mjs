// 额度感知调度的端到端测试：真进程 + 假上游（含四个官方额度端点）。
//
// 覆盖需求里最重要的验收场景：
//   A 五小时额度满、B 正常 → 后续新请求全部走 B，B 仍走自己的代理；
//   两账号都满 → 三种协议各自返回正确的 429 + Retry-After；
//   严格绑定代理不可用 → 503（不能误报额度耗尽）；
//   上游明确 USAGE_EXCEEDED → 同一请求内（尚未输出任何内容）安全切到 B。
//
// 注意：这里的上游全是 mock，**不代表**已完成真实 Command Code 联调。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startProxy, closeServer } from './helpers.mjs';
import { allocPort } from './helpers.mjs';

const KEY_A = 'user_aaa1111111111111111111111111';
const KEY_B = 'user_bbb2222222222222222222222222';

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const NDJSON_OK = [
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"hello"}',
  '{"type":"text-end"}',
  '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":9,"outputTokens":3}}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":9,"outputTokens":3,"cachedInputTokens":0}}',
];

/**
 * 假上游。ctl 控制每个账号的额度窗口与 generate 行为。
 *   ctl.windows[key] = { used, cap, exceeded, resetAt }
 *   ctl.generate[key] = 'ok' | 'usage-exceeded' | 'rate-limit'
 *   ctl.quotaDown = true → 四个额度端点全部 500
 */
async function startQuotaUpstream(ctl) {
  const port = await allocPort();
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const auth = String(req.headers.authorization || '');
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      seen.push({ url: req.url, key, headers: req.headers, raw });

      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.url.endsWith('/alpha/fingerprint/record') || req.url.endsWith('/alpha/lifecycle-events')) {
        return json(200, { success: true });
      }
      if (req.url.includes('/alpha/whoami')) {
        if (ctl.quotaDown) return json(500, { error: { message: 'quota api down' } });
        return json(200, { data: { user_id: `u_${key.slice(-4)}`, plan: 'go' } });
      }
      if (req.url.includes('/alpha/billing/')) {
        if (ctl.quotaDown) return json(500, { error: { message: 'quota api down' } });
        return json(404, { error: { message: 'not found' } });
      }
      if (req.url.includes('/alpha/usage/summary')) {
        if (ctl.quotaDown) return json(500, { error: { message: 'quota api down' } });
        const w = ctl.windows[key] || {};
        const win = (spec, fallbackCap) => ({
          used: spec?.used ?? 0,
          cap: spec?.cap ?? fallbackCap,
          exceeded: !!spec?.exceeded,
          resetAt: spec?.resetAt ?? Date.now() + 3600_000,
        });
        const windowLimits = { fiveHour: win(w, 100) };
        if (w.weekly) windowLimits.weekly = win(w.weekly, 600);
        if (w.monthly) windowLimits.monthly = win(w.monthly, 1000);
        return json(200, { data: { windowLimits } });
      }

      if (req.url.includes('/alpha/generate')) {
        const mode = ctl.generate[key] || 'ok';
        if (mode === 'usage-exceeded') {
          return json(429, { success: false, error: { code: 'USAGE_EXCEEDED', message: 'Usage limit reached for this window' } });
        }
        if (mode === 'rate-limit') {
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
          return res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'too many requests' } }));
        }
        const sendOk = () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const line of NDJSON_OK) res.write(line + '\n');
          res.end();
        };
        // ctl.delay[key] 毫秒：让请求在上游停留一段时间，用来验证并发上限。
        const delayMs = Number(ctl.delay?.[key]) || 0;
        if (delayMs > 0) { setTimeout(sendOk, delayMs); return; }
        return sendOk();
      }

      return json(404, { error: { message: 'unknown route' } });
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port,
    seen,
    generates: () => seen.filter(s => s.url.includes('/alpha/generate')),
    close: () => closeServer(server),
  };
}

function workdirWith(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-quota-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    proxyKey: CLIENT_KEY, apiKey: '', apiBase: 'https://api.commandcode.ai',
    useProviderModels: false, useProviderModelsWithPlanFilter: false, logLevel: 'warn',
    ...overrides,
  }, null, 2) + '\n');
  return dir;
}

/** 预置严格绑定：账号 → 指定代理，模式 strict_bind。 */
function seedStrictBindings(workdir, mapping) {
  const entries = [];
  const bindings = {};
  for (const [key, addr] of Object.entries(mapping)) {
    const pid = sha(addr);
    if (!entries.some(e => e.id === pid)) entries.push({ id: pid, value: addr, enabled: true });
    bindings[sha(key)] = { mode: 'strict_bind', proxyId: pid };
  }
  mkdirSync(join(workdir, 'data'), { recursive: true });
  writeFileSync(join(workdir, 'data', 'proxies.json'),
    JSON.stringify({ version: 1, entries, disabled: [], bindings }, null, 2) + '\n');
}

const CHAT_BODY = (extra = {}) => ({
  model: 'deepseek/deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

// 数据面访问口令：用池里的上游账号做转发（未设 proxyKey 且没签发 2API Key 时
// 走的是「透传」模式，客户端自带上游 Key —— 那条路不经过账号池）
const CLIENT_KEY = 'test-proxy-key-123';
const AUTH = { Authorization: `Bearer ${CLIENT_KEY}` };

// ── 主验收场景 ────────────────────────────────────
test('A 五小时额度已满、B 正常：后续新请求全部走 B（不会先撞 A 再切）', async () => {
  const ctl = {
    windows: {
      [KEY_A]: { used: 100, cap: 100, exceeded: true, resetAt: Date.now() + 1800_000 },
      [KEY_B]: { used: 20, cap: 100 },
    },
    generate: {},
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    // 等启动时的那一轮额度采集跑完（1.5s 延迟 + 请求本身）
    await sleep(2600);

    const r1 = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r1.status, 200);
    await r1.text();
    const r2 = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r2.status, 200);
    await r2.text();

    const gens = mock.generates();
    assert.equal(gens.length, 2);
    assert.ok(gens.every(g => g.key === KEY_B), '所有生成请求都必须落在 B 上');
    // 额度查询也必须是按账号、按各自代理发出的
    const quotaCalls = mock.seen.filter(s => s.url.includes('/alpha/usage/summary'));
    assert.ok(quotaCalls.some(s => s.key === KEY_A), '启动时应当查过 A 的官方额度');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('多 Key 调度：五小时剩余优先于周/月，并把流量分摊到同档账号', async () => {
  const KEY_C = 'user_ccc3333333333333333333333333';
  const ctl = {
    windows: {
      // A：五小时快满了，但周很空 —— 不能因为周余量多就优先它
      [KEY_A]: { used: 80, cap: 100, weekly: { used: 10, cap: 100 } },
      // B / C：五小时充足，周较紧张；两个账号同档，应该在它们之间分摊
      [KEY_B]: { used: 20, cap: 100, weekly: { used: 80, cap: 100 } },
      [KEY_C]: { used: 20, cap: 100, weekly: { used: 80, cap: 100 } },
    },
    generate: {},
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B, KEY_C],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    for (let i = 0; i < 4; i++) {
      const r = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
      assert.equal(r.status, 200);
      await r.text();
    }

    const gens = mock.generates();
    assert.equal(gens.length, 4);
    assert.equal(gens.filter(g => g.key === KEY_A).length, 0, '五小时剩余更少的账号不应被优先选中');
    const usedB = gens.filter(g => g.key === KEY_B).length;
    const usedC = gens.filter(g => g.key === KEY_C).length;
    assert.ok(usedB > 0 && usedC > 0, `同档账号应分摊流量（B=${usedB} C=${usedC}）`);
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('内置策略也遵守单账号并发上限（在途计数不依赖额度策略）', async () => {
  const ctl = {
    windows: {
      [KEY_A]: { used: 10, cap: 100 },
      [KEY_B]: { used: 10, cap: 100 },
    },
    generate: {},
    // A 的上游响应挂住 600ms，制造「A 仍在途」的窗口
    delay: { [KEY_A]: 600 },
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'fill',           // 内置策略：默认永远压满第一个可用账号
    accountMaxConcurrency: 1,
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    const [r1, r2] = await Promise.all([
      proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH),
      proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    await Promise.all([r1.text(), r2.text()]);

    const gens = mock.generates();
    assert.equal(gens.length, 2);
    const keys = [...new Set(gens.map(g => g.key))].sort();
    assert.deepEqual(keys, [KEY_A, KEY_B].sort(), '第二个并发请求应避开已达到并发上限的 A');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('两账号都明确耗尽：三种协议各自返回 429 + Retry-After，且不再打上游', async () => {
  const resetAt = Date.now() + 900_000;
  const ctl = {
    windows: {
      [KEY_A]: { used: 100, cap: 100, exceeded: true, resetAt },
      [KEY_B]: { used: 100, cap: 100, exceeded: true, resetAt },
    },
    generate: {},
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    const before = mock.generates().length;

    const chat = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(chat.status, 429);
    const chatBody = await chat.json();
    assert.equal(chatBody.error.type, 'rate_limit_error');
    assert.ok(Number(chat.headers.get('retry-after')) > 0, '必须有 Retry-After');

    const messages = await proxy.post('/v1/messages', {
      model: 'claude-sonnet-4-6', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, AUTH);
    assert.equal(messages.status, 429);
    const msgBody = await messages.json();
    assert.equal(msgBody.type, 'error');
    assert.equal(msgBody.error.type, 'rate_limit_error');

    const responses = await proxy.post('/v1/responses', { model: 'gpt-5.5', input: 'hi' }, AUTH);
    assert.equal(responses.status, 429);
    const respBody = await responses.json();
    assert.equal(respBody.error.type, 'rate_limit_error');

    assert.equal(mock.generates().length, before, '确认耗尽之后一个生成请求都不该发出去');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('严格绑定代理不可用：返回 503（不是 429，也不是额度耗尽）', async () => {
  const ctl = {
    // 额度很充足：唯一的失败原因是代理
    windows: { [KEY_A]: { used: 1, cap: 100 } },
    generate: {},
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
    // 端口 1 上没有任何服务 → CONNECT 必然失败
  });
  seedStrictBindings(workdir, { [KEY_A]: 'http://127.0.0.1:1' });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    const r = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.error.code, 'proxy_unavailable');
    assert.equal(mock.generates().length, 0, '严格绑定失效时绝不能有任何请求从别的出口发出去');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('上游明确 USAGE_EXCEEDED：未输出任何内容时安全切到 B，后续请求也不再回 A', async () => {
  const ctl = {
    // 官方额度接口显示两个账号都还有额度（模拟「官方还没更新」）
    windows: { [KEY_A]: { used: 10, cap: 100 }, [KEY_B]: { used: 10, cap: 100 } },
    generate: { [KEY_A]: 'usage-exceeded' },
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    const r = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r.status, 200, '应当由 B 完成这次请求');
    const text = await r.text();
    assert.ok(text.includes('hello'));

    const gens = mock.generates();
    assert.equal(gens.filter(g => g.key === KEY_A).length, 1, 'A 只应被尝试一次');
    assert.equal(gens.filter(g => g.key === KEY_B).length, 1);

    // 后续请求：A 已被标记耗尽 → 不再被尝试
    const r2 = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r2.status, 200);
    await r2.text();
    assert.equal(mock.generates().filter(g => g.key === KEY_A).length, 1, '确认耗尽的账号不能被反复撞限');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('官方额度接口全部不可用：不把额度当 0，服务照常可推理', async () => {
  const ctl = { quotaDown: true, windows: {}, generate: {} };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'quota_aware',
    quotaRefreshIntervalMs: 60_000,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  try {
    await sleep(2600);
    const r = await proxy.post('/v1/chat/completions', CHAT_BODY(), AUTH);
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(mock.generates().length, 1);
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

// ── 会话粘性 ──────────────────────────────────────
test('quota_sticky：会话固定在 A；A 满后自动迁到 B 并保持；A 恢复也不抢回', async () => {
  const resetAt = Date.now() + 1800_000;
  const ctl = {
    windows: { [KEY_A]: { used: 10, cap: 100 }, [KEY_B]: { used: 10, cap: 100 } },
    generate: {},
  };
  const mock = await startQuotaUpstream(ctl);
  const workdir = workdirWith({
    apiKey: [KEY_A, KEY_B],
    strategy: 'quota_sticky',
    quotaRefreshIntervalMs: 5000,
    sessionAffinity: true,
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir });
  const session = { ...AUTH, 'x-session-id': 'sess-abcdefgh-1234' };
  try {
    await sleep(2600);

    const r1 = await proxy.post('/v1/chat/completions', CHAT_BODY(), session);
    assert.equal(r1.status, 200);
    await r1.text();
    const firstKey = mock.generates()[0].key;
    assert.equal(firstKey, KEY_A, '首次选择应稳定地落在 A 上');

    // 同一会话再来一次 → 仍然 A（粘性命中）
    const r2 = await proxy.post('/v1/chat/completions', CHAT_BODY(), session);
    await r2.text();
    assert.equal(mock.generates()[1].key, KEY_A);

    // A 满 → 下一次刷新后应该自动迁到 B
    ctl.windows[KEY_A] = { used: 100, cap: 100, exceeded: true, resetAt };
    await sleep(6500);
    const r3 = await proxy.post('/v1/chat/completions', CHAT_BODY(), session);
    assert.equal(r3.status, 200);
    await r3.text();
    assert.equal(mock.generates()[2].key, KEY_B, '会话应被迁移到 B');

    // A 恢复（官方数据变回有额度）→ 会话不强制抢回 A
    ctl.windows[KEY_A] = { used: 5, cap: 100 };
    await sleep(6500);
    const r4 = await proxy.post('/v1/chat/completions', CHAT_BODY(), session);
    await r4.text();
    assert.equal(mock.generates()[3].key, KEY_B, '已迁到 B 的活跃会话不应被抢回');
  } finally {
    await proxy.kill();
    await mock.close();
  }
});
