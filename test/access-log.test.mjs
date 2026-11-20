// 访问日志：每个 /v1 请求结束都留一行「客户端到底拿到了什么」。
//
// 为什么需要它：流式请求的 HTTP 状态码会**撒谎** —— 响应头在 200 时就发出去了，
// 之后无论是正常收尾、被空闲看门狗掐断，还是上游报错，状态码都还是 200。
// 只记 status 的话，「200 + 错误事件 + 零输出」与「200 + 完整回答」在日志里
// 毫无区别，于是线上看到的现象（客户端报错/上层 503）在服务端查不到任何证据。
// 这组用例锁住的就是「终态必须与状态码分开记」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

/** 从日志里取出所有访问日志行，解析成对象 */
function accessRows(proxy) {
  return proxy.logs()
    .split('\n')
    .filter(l => l.includes('HTTP request'))
    .map(l => {
      const body = l.slice(l.indexOf('HTTP request') + 'HTTP request'.length).trim();
      try { return JSON.parse(body); } catch { return null; }
    })
    .filter(Boolean);
}

/** 等访问日志落地（emit 挂在 finish/close 上，与客户端读完 body 有个竞态） */
const settle = () => new Promise(r => setTimeout(r, 250));

test('访问日志：三条协议的成功请求都记 status=200 + outcome=ok，并带上模型与出网字节', async () => {
  const s = await setup();
  try {
    const cases = [
      ['/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }],
      ['/v1/responses', { model: 'm', input: 'hi', stream: true }],
      ['/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true }],
    ];
    for (const [path, body] of cases) {
      const r = await s.proxy.post(path, body, AUTH);
      await r.text();
    }
    await settle();

    const rows = accessRows(s.proxy);
    assert.equal(rows.length, 3, `三条请求应各记一行，实际 ${rows.length} 行`);
    for (const path of cases.map(c => c[0])) {
      const row = rows.find(x => x.path === path);
      assert.ok(row, `${path} 应有一行访问日志`);
      assert.equal(row.status, 200);
      assert.equal(row.outcome, 'ok', `${path} 正常完成应标 ok`);
      assert.equal(row.model, 'm', '应带上模型名，否则定位不到是哪个模型出问题');
      assert.equal(row.streaming, true);
      assert.equal(typeof row.durationMs, 'number');
      assert.ok(row.bytesOut > 0, '应统计出网字节（「发了多少就断了」是关键线索）');
    }
  } finally { await s.close(); }
});

test('访问日志：流式空闲超时必须记成 stream_idle_timeout —— 状态码仍是 200，正是需要被记下来的谎言', async () => {
  // 上游接了请求就挂住，不写任何字节 → 触发空闲看门狗
  const s = await setup({
    env: { CC_STREAM_IDLE_MS: '250' },
    onRequest: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      return true;
    },
  });
  try {
    const r = await s.proxy.post('/v1/responses', { model: 'm', input: 'hi', stream: true }, AUTH);
    await r.text().catch(() => {});
    await settle();

    const row = accessRows(s.proxy).find(x => x.path === '/v1/responses');
    assert.ok(row, '应有访问日志');
    assert.equal(row.status, 200, '响应头早已发出，所以状态码就是 200 —— 这正是要单独记终态的原因');
    assert.equal(row.outcome, 'stream_idle_timeout',
      '终态必须与状态码分开记，否则「200 但失败」在日志里与成功无法区分');
  } finally { await s.close(); }
});

test('访问日志：零输出记成 zero_output，且状态码是真实的 429', async () => {
  const s = await setup({
    ndjson: [
      '{"type":"text-start"}',
      '{"type":"text-end"}',
      '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":0}}',
    ],
  });
  try {
    const r = await s.proxy.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH);
    await r.text();
    await settle();

    const row = accessRows(s.proxy).find(x => x.path === '/v1/chat/completions');
    assert.ok(row);
    assert.equal(row.outcome, 'zero_output');
    assert.equal(row.status, 429, '非流式的状态码是真实的，可以直接据此判断');
  } finally { await s.close(); }
});

test('访问日志：鉴权失败也要留痕（早退分支不能被漏掉）', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {});
    assert.equal(r.status, 401);
    await r.text();
    await settle();

    const row = accessRows(s.proxy).find(x => x.path === '/v1/chat/completions');
    assert.ok(row, '早退分支同样要记 —— 否则「客户端根本没认证成功」在服务端毫无痕迹');
    assert.equal(row.status, 401);
  } finally { await s.close(); }
});

test('/health 与后台请求不写访问日志（避免探活把日志刷满）', async () => {
  const s = await setup();
  try {
    await s.proxy.get('/health');
    await settle();
    const rows = accessRows(s.proxy);
    assert.equal(rows.filter(x => x.path === '/health').length, 0, '/health 不该进访问日志');
  } finally { await s.close(); }
});

test('空闲超时默认值已放宽到 180s（30s 会误杀长推理）', async () => {
  const s = await setup();
  try {
    const banner = s.proxy.logs();
    assert.match(banner, /stream 180000ms/,
      '默认流式空闲预算必须是 180s：实测推理模型会在 reasoning-delta 之后静默 30~70s');
  } finally { await s.close(); }
});
