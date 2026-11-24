import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocPort, closeServer, seedConfig, startMockUpstream, startProxy, setup } from './helpers.mjs';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
const WEB_FETCH_TOOL = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 };

const nd = (...lines) => lines.map(l => JSON.stringify(l));

function sse(res, lines) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const l of lines) res.write(l + '\n');
  res.end();
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const sseEvents = (text) => text.split('\n\n').filter(Boolean).map(chunk => {
  const m = chunk.match(/^event: (\S+)\ndata: (.*)$/s);
  return m ? { event: m[1], data: JSON.parse(m[2]) } : null;
}).filter(Boolean);

const blockStarts = (events) => events.filter(e => e.event === 'content_block_start').map(e => e.data);
const count = (events, name) => events.filter(e => e.event === name).length;

async function messagesStream(proxy, body, headers = {}) {
  const r = await proxy.post('/v1/messages',
    { model: 'claude-3-7-sonnet', max_tokens: 500, stream: true, ...body },
    { 'x-api-key': 'user_test', ...headers });
  const text = await r.text();
  return { status: r.status, text, events: sseEvents(text) };
}

async function waitFor(conditionFn, timeoutMs = 3000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  assert.fail(`Condition timed out after ${timeoutMs}ms`);
}

async function waitForLog(proxy, pattern, count = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((proxy.logs().match(pattern) || []).length >= count) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail(`日志未出现 ${count} 次 ${pattern}\n实际日志:\n${proxy.logs()}`);
}

async function startRecordingProxy() {
  const port = await allocPort();
  const hits = [];
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(405); res.end(); return; }
    hits.push({ kind: 'http', url: req.url, path: target.pathname, headers: req.headers });
    const up = http.request({
      host: target.hostname, port: target.port || 80,
      path: target.pathname + target.search, method: req.method, headers: req.headers,
    }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, clientSocket, head) => {
    const entry = { kind: 'connect', url: req.url, path: '', headers: req.headers };
    hits.push(entry);
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p || 443), h, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) {
        const line = head.toString('utf8').split('\r\n')[0] || '';
        const match = line.match(/^[A-Z]+\s+(\S+)/);
        if (match) entry.path = match[1];
        up.write(head);
      }
      clientSocket.once('data', (d) => {
        const line = d.toString('utf8').split('\r\n')[0] || '';
        const match = line.match(/^[A-Z]+\s+(\S+)/);
        if (match) entry.path = match[1];
      });
      up.pipe(clientSocket); clientSocket.pipe(up);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, hits,
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

// ── 1. 跨模块全链路集成：web_search + web_fetch 服务端工具联动 ──────────────────

test('全链路集成 1：web_search 与 web_fetch 链式联动、精准 token 汇总与零 tool_use 泄漏', async () => {
  let generateCalls = 0;
  let webSearchCalls = 0;
  let webFetchCalls = 0;

  const ROUND1_SEARCH = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'text-start' }, { type: 'text-delta', text: 'Searching docs...' }, { type: 'text-end' },
    { type: 'tool-call', toolCallId: 'call_srch_1', toolName: 'web_search', input: { query: 'nodejs api docs' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 10 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 0 } },
  );

  const ROUND2_FETCH = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'text-start' }, { type: 'text-delta', text: 'Fetching documentation page...' }, { type: 'text-end' },
    { type: 'tool-call', toolCallId: 'call_ftch_1', toolName: 'web_fetch', input: { url: 'https://example.com/nodejs-docs' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 120, outputTokens: 12 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 120, outputTokens: 12, cachedInputTokens: 0 } },
  );

  const ROUND3_ANSWER = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'text-start' }, { type: 'text-delta', text: 'Node.js 22 LTS documentation confirms the modern crypto API.' }, { type: 'text-end' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 18 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 200, outputTokens: 18, cachedInputTokens: 0 } },
  );

  const s = await setup({
    env: { CC_WEB_SEARCH: '1' },
    onRequest: (req, res, record) => {
      if (req.url === '/alpha/generate') {
        generateCalls++;
        if (generateCalls === 1) {
          sse(res, ROUND1_SEARCH);
        } else if (generateCalls === 2) {
          sse(res, ROUND2_FETCH);
        } else {
          sse(res, ROUND3_ANSWER);
        }
        return true;
      }
      if (req.url === '/alpha/web-search') {
        webSearchCalls++;
        json(res, {
          query: 'nodejs api docs',
          results: [{ title: 'Node.js Docs', url: 'https://example.com/nodejs-docs', snippet: 'Official reference' }],
        });
        return true;
      }
      if (req.url === '/alpha/web-fetch') {
        webFetchCalls++;
        json(res, {
          url: 'https://example.com/nodejs-docs',
          status: 200,
          content: '# Node.js 22 Documentation\nModern native crypto and fetch are standard.',
        });
        return true;
      }
      return false;
    },
  });

  try {
    const { status, text, events } = await messagesStream(s.proxy, {
      messages: [{ role: 'user', content: 'Search node docs and fetch details' }],
      tools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
    });

    assert.equal(status, 200);
    assert.equal(count(events, 'message_start'), 1, '多轮服务端工具循环只能发出恰好一个 message_start');
    assert.equal(count(events, 'message_stop'), 1, '多轮服务端工具循环只能发出恰好一个 message_stop');

    const starts = blockStarts(events);

    // 1. web_search 服务端工具块与其结果配对
    const searchSrv = starts.find(d => d.content_block.type === 'server_tool_use' && d.content_block.name === 'web_search');
    assert.ok(searchSrv, '必须下发 web_search 的 server_tool_use 块');
    assert.ok(searchSrv.content_block.id.startsWith('srvtoolu_'));
    const searchRes = starts.find(d => d.content_block.type === 'web_search_tool_result');
    assert.ok(searchRes, '必须下发 web_search_tool_result 块');
    assert.equal(searchRes.content_block.tool_use_id, searchSrv.content_block.id);

    // 2. web_fetch 服务端工具块与其结果配对
    const fetchSrv = starts.find(d => d.content_block.type === 'server_tool_use' && d.content_block.name === 'web_fetch');
    assert.ok(fetchSrv, '必须下发 web_fetch 的 server_tool_use 块');
    assert.ok(fetchSrv.content_block.id.startsWith('srvtoolu_'));
    const fetchRes = starts.find(d => d.content_block.type === 'web_fetch_tool_result');
    assert.ok(fetchRes, '必须下发 web_fetch_tool_result 块');
    assert.equal(fetchRes.content_block.tool_use_id, fetchSrv.content_block.id);
    assert.ok(typeof fetchRes.content_block.content === 'string' && fetchRes.content_block.content.includes('Node.js 22 Documentation'));

    // 3. 服务端工具绝不泄漏为客户端工具
    assert.ok(!starts.some(d => d.content_block.type === 'tool_use'), '服务端工具绝不能泄漏成普通客户端 tool_use');

    // 4. 最终模型回答正常下发
    assert.ok(text.includes('Node.js 22 LTS documentation confirms the modern crypto API.'));

    // 5. 跨轮累计 usage 汇报正确
    const delta = events.find(e => e.event === 'message_delta').data;
    assert.equal(delta.delta.stop_reason, 'end_turn');
    assert.deepEqual(delta.usage.server_tool_use, {
      web_search_requests: 1,
      web_fetch_requests: 1,
    });
    assert.equal(delta.usage.output_tokens, 10 + 12 + 18, 'output_tokens 跨三轮累加');
    assert.equal(delta.usage.input_tokens, 50 + 120 + 200, 'input_tokens 跨三轮累加');

    assert.equal(generateCalls, 3, '上游应发起 3 轮 generate');
    assert.equal(webSearchCalls, 1, '上游应收到 1 次 web-search');
    assert.equal(webFetchCalls, 1, '上游应收到 1 次 web-fetch');

    // 6. 验证送往上游各轮历史完整保真
    const calls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    const r2Messages = JSON.parse(calls[1].raw).params.messages;
    assert.ok(JSON.stringify(r2Messages).includes('call_srch_1'));

    const r3Messages = JSON.parse(calls[2].raw).params.messages;
    assert.ok(JSON.stringify(r3Messages).includes('call_ftch_1'));
    assert.ok(JSON.stringify(r3Messages).includes('Node.js 22 Documentation'));
  } finally {
    await s.close();
  }
});

// ── 2. 跨模块全链路集成：纯文本模型 + Vision Fallback + 流式输出 ──────────────────

test('全链路集成 2：纯文本模型 + 多模态图像输入 + Vision Fallback 辅助转写与流式最终输出', async () => {
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // Helper 识图流式响应
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(JSON.stringify({ type: 'text-start' }) + '\n');
          res.write(JSON.stringify({ type: 'text-delta', text: 'Architecture diagram showing API Gateway and Worker Nodes.' }) + '\n');
          res.write(JSON.stringify({ type: 'finish', finishReason: 'stop' }) + '\n');
          res.end();
          return true;
        }
        if (body?.params?.model === 'deepseek/deepseek-v4.1-flash') {
          // 纯文本目标模型流式响应
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(JSON.stringify({ type: 'text-start' }) + '\n');
          res.write(JSON.stringify({ type: 'text-delta', text: 'The diagram shows a distributed architecture with API Gateway.' }) + '\n');
          res.write(JSON.stringify({ type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 140, outputTokens: 15 } }) + '\n');
          res.write(JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 140, outputTokens: 15, cachedInputTokens: 0 } }) + '\n');
          res.end();
          return true;
        }
      }
      return false;
    },
  });

  try {
    const res = await s.proxy.post('/v1/messages', {
      model: 'deepseek/deepseek-v4.1-flash',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe what is depicted:' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: TINY_PNG_BASE64,
              },
            },
          ],
        },
      ],
      max_tokens: 200,
    }, { 'x-api-key': 'user_test' });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = sseEvents(text);

    assert.equal(count(events, 'message_start'), 1);
    assert.equal(count(events, 'message_stop'), 1);
    assert.ok(text.includes('The diagram shows a distributed architecture with API Gateway.'));

    const genCalls = s.mock.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(genCalls.length, 2, '必须先调用 helper 识图再调用纯文本模型');

    // 检查第 1 轮 helper 识图请求
    const helperBody = JSON.parse(genCalls[0].raw);
    assert.equal(helperBody.params.model, 'gpt-5.6-luna');
    assert.equal(helperBody.params.messages[0].content.some(c => c.type === 'image'), true);

    // 检查第 2 轮主请求：图像块已被替换为转写描述标签
    const mainBody = JSON.parse(genCalls[1].raw);
    assert.equal(mainBody.params.model, 'deepseek/deepseek-v4.1-flash');
    const hasImage = mainBody.params.messages.some(m => m.content.some(c => c.type === 'image'));
    assert.equal(hasImage, false, '发往下游纯文本模型的请求中不得包含 image 块');

    const userText = mainBody.params.messages[0].content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    assert.match(userText, /<image_description index="1">/);
    assert.match(userText, /Architecture diagram showing API Gateway and Worker Nodes\./);
  } finally {
    await s.close();
  }
});

// ── 3. 跨模块全链路集成：客户端提前断连中断级联传播 ──────────────────────────────

test('全链路集成 3a：客户端提前断连时 Vision Fallback 辅助识图请求被安全打断', async () => {
  let helperAborted = false;
  const s = await setup({
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
    },
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // 挂起 helper 请求以模拟长耗时识图
          res.on('close', () => { helperAborted = true; });
          return true;
        }
      }
      return false;
    },
  });

  try {
    const ac = new AbortController();
    const reqPromise = fetch(`${s.proxy.base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'user_test' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4.1-flash',
        stream: true,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze image:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
          ],
        }],
      }),
      signal: ac.signal,
    }).catch(() => {});

    // 等待 helper 请求到达上游
    await waitFor(() => s.mock.seen.some(x => {
      if (x.url !== '/alpha/generate') return false;
      try { return JSON.parse(x.raw)?.params?.model === 'gpt-5.6-luna'; } catch { return false; }
    }), 2000);

    // 客户端提前中断连接
    ac.abort();
    await reqPromise;

    // 断言 helper 连接被级联打断
    await waitFor(() => helperAborted, 2000);
    assert.equal(helperAborted, true, '客户端断连必须打断 Vision Fallback 辅助连接');

    await waitForLog(s.proxy, /Client disconnected/, 1, 3000);
  } finally {
    await s.close();
  }
});

test('全链路集成 3b：客户端提前断连时 web_fetch 辅助抓取请求被安全打断', async () => {
  let fetchAborted = false;
  const s = await setup({
    env: { CC_WEB_SEARCH: '1' },
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        sse(res, nd(
          { type: 'start' }, { type: 'start-step' },
          { type: 'tool-call', toolCallId: 'call_f1', toolName: 'web_fetch', input: { url: 'https://example.com/hang' } },
          { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 5 } },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 50, outputTokens: 5 } },
        ));
        return true;
      }
      if (req.url === '/alpha/web-fetch') {
        res.on('close', () => { fetchAborted = true; });
        // 挂起 web-fetch 连接
        return true;
      }
      return false;
    },
  });

  try {
    const ac = new AbortController();
    const reqPromise = fetch(`${s.proxy.base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'user_test' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'fetch slow doc' }],
        tools: [WEB_FETCH_TOOL],
      }),
      signal: ac.signal,
    }).catch(() => {});

    await waitFor(() => s.mock.seen.some(x => x.url === '/alpha/web-fetch'), 2000);

    // 客户端提前中断连接
    ac.abort();
    await reqPromise;

    // 断言 web-fetch 辅助连接被级联打断
    await waitFor(() => fetchAborted, 2000);
    assert.equal(fetchAborted, true, '客户端断连必须打断 web_fetch 辅助连接');

    await waitForLog(s.proxy, /Client disconnected/, 1, 3000);
  } finally {
    await s.close();
  }
});

test('全链路集成 3c：客户端流中途断开触发上游 reader 安全释放无悬挂', async () => {
  let upstreamClosed = false;
  const s = await setup({
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(JSON.stringify({ type: 'text-start' }) + '\n');
        res.write(JSON.stringify({ type: 'text-delta', text: 'initial stream chunk' }) + '\n');
        res.on('close', () => { upstreamClosed = true; });
        // 挂起不再发送后续内容
        return true;
      }
      return false;
    },
  });

  try {
    const ac = new AbortController();
    const res = await fetch(`${s.proxy.base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'user_test' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      signal: ac.signal,
    });

    assert.equal(res.status, 200);

    // 读出首块数据
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.ok(value && value.length > 0);

    // 客户端断开连接
    ac.abort();
    try { await reader.cancel(); } catch {}

    // 断言上游连接已被安全关闭
    await waitFor(() => upstreamClosed, 2000);
    assert.equal(upstreamClosed, true, '客户端中断流必须触发 upstream reader 释放与连接关闭');

    await waitForLog(s.proxy, /Client disconnected/, 1, 3000);
  } finally {
    await s.close();
  }
});

// ── 4. 跨模块全链路集成：出站代理一致性保证 ──────────────────────────────────

test('全链路集成 4a：出站代理一致性 - Vision Fallback 识图辅助请求复用当前 Key 分配的代理出口', async () => {
  const boundProxy = await startRecordingProxy();
  const fallbackProxy = await startRecordingProxy();

  const upstream = await startMockUpstream({
    onRequest: async (req, res, record) => {
      if (req.url === '/alpha/generate') {
        const body = JSON.parse(record.raw);
        if (body?.params?.model === 'gpt-5.6-luna') {
          // Helper 识图响应
          sse(res, nd(
            { type: 'text-start' },
            { type: 'text-delta', text: 'Transcribed icon description.' },
            { type: 'finish', finishReason: 'stop' },
          ));
          return true;
        }
        if (body?.params?.model === 'deepseek/deepseek-v4.1-flash') {
          // 纯文本主响应
          sse(res, nd(
            { type: 'text-start' },
            { type: 'text-delta', text: 'Analysis of icon complete.' },
            { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 5 } },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 50, outputTokens: 5 } },
          ));
          return true;
        }
      }
      return false;
    },
  });

  const workdir = mkdtempSync(join(tmpdir(), 'ccp-peer-route-a-'));
  seedConfig(workdir, {
    apiBase: `http://127.0.0.1:${upstream.port}`,
    upstreamProxy: fallbackProxy.url,
    proxies: [boundProxy.url],
    visionFallbackModel: 'gpt-5.6-luna',
  });

  const proxy = await startProxy({
    cwd: workdir,
    upstreamPort: upstream.port,
    env: {
      CC_VISION_FALLBACK_MODEL: 'gpt-5.6-luna',
      CC_DATA_DIR: join(workdir, 'data'),
    },
  });

  try {
    const rVision = await proxy.post('/v1/messages', {
      model: 'deepseek/deepseek-v4.1-flash',
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe icon:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } },
        ],
      }],
      max_tokens: 100,
    }, { 'x-api-key': 'user_test' });

    assert.equal(rVision.status, 200);
    const visionText = await rVision.text();
    assert.ok(visionText.includes('Analysis of icon complete.'));

    // 全局 fallbackProxy 绝不能收到任何请求
    assert.equal(fallbackProxy.hits.length, 0, 'Vision Fallback helper 绝不能回退到全局 fallbackProxy');
    // boundProxy 必须收到请求（CONNECT 隧道）
    assert.ok(boundProxy.hits.length >= 2, 'Vision Fallback helper 与主请求均必须经由分配的出站代理 boundProxy');
    // 上游必须收到 2 次 generate 请求（helper + 主请求）
    const generateCalls = upstream.seen.filter(x => x.url === '/alpha/generate');
    assert.equal(generateCalls.length, 2, '上游必须收到 helper 与主模型两次请求');
  } finally {
    await proxy.kill();
    await upstream.close();
    await boundProxy.close();
    await fallbackProxy.close();
  }
});

test('全链路集成 4b：出站代理一致性 - web_fetch 抓取辅助请求复用当前 Key 分配的代理出口', async () => {
  const boundProxy = await startRecordingProxy();
  const fallbackProxy = await startRecordingProxy();

  let genRound = 0;
  const upstream = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        genRound++;
        if (genRound === 1) {
          // Round 1: Model issues web_fetch tool call
          sse(res, nd(
            { type: 'start' }, { type: 'start-step' },
            { type: 'tool-call', toolCallId: 'call_wf1', toolName: 'web_fetch', input: { url: 'https://example.com/api-doc' } },
            { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 60, outputTokens: 6 } },
            { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 60, outputTokens: 6 } },
          ));
        } else {
          // Round 2: Final answer after fetch
          sse(res, nd(
            { type: 'start' }, { type: 'start-step' },
            { type: 'text-start' }, { type: 'text-delta', text: 'API doc fetched and explained.' }, { type: 'text-end' },
            { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 90, outputTokens: 8 } },
            { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 90, outputTokens: 8 } },
          ));
        }
        return true;
      }
      if (req.url === '/alpha/web-fetch') {
        json(res, { url: 'https://example.com/api-doc', status: 200, content: '# API Specification' });
        return true;
      }
      return false;
    },
  });

  const workdir = mkdtempSync(join(tmpdir(), 'ccp-peer-route-b-'));
  seedConfig(workdir, {
    apiBase: `http://127.0.0.1:${upstream.port}`,
    upstreamProxy: fallbackProxy.url,
    proxies: [boundProxy.url],
    webSearch: true,
  });

  const proxy = await startProxy({
    cwd: workdir,
    upstreamPort: upstream.port,
    env: {
      CC_WEB_SEARCH: '1',
      CC_DATA_DIR: join(workdir, 'data'),
    },
  });

  try {
    const rFetch = await proxy.post('/v1/messages', {
      model: 'claude-3-7-sonnet',
      stream: true,
      messages: [{ role: 'user', content: 'fetch api doc' }],
      tools: [WEB_FETCH_TOOL],
      max_tokens: 100,
    }, { 'x-api-key': 'user_test' });

    assert.equal(rFetch.status, 200);
    const fetchText = await rFetch.text();
    assert.ok(fetchText.includes('API doc fetched and explained.'));

    // 全局 fallbackProxy 绝不能收到任何请求
    assert.equal(fallbackProxy.hits.length, 0, 'web_fetch 辅助请求绝不能回退到全局 fallbackProxy');
    // boundProxy 必须收到所有请求（首轮 generate + web-fetch + 续写轮 generate 等）
    assert.ok(boundProxy.hits.length >= 2, 'web_fetch 辅助请求与生成请求必须全部经由 boundProxy');
    // 上游必须确实执行了 /alpha/web-fetch
    const webFetchCalls = upstream.seen.filter(x => x.url === '/alpha/web-fetch');
    assert.equal(webFetchCalls.length, 1, '上游必须实际收到并执行 /alpha/web-fetch 请求');
    // 如果 CONNECT 隧道拦截到了 path，验证其包含 /alpha/web-fetch
    const fetchHit = boundProxy.hits.find(h => h.path?.includes('/alpha/web-fetch') || h.url?.includes('/alpha/web-fetch'));
    assert.ok(fetchHit, 'boundProxy 出站代理必须捕获到 web-fetch 调用');
  } finally {
    await proxy.kill();
    await upstream.close();
    await boundProxy.close();
    await fallbackProxy.close();
  }
});
