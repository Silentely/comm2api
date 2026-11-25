import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import {
  guardFetchUrl,
  executeWebFetch,
  createFetchCache,
  clearWebFetchCache,
  formatFetchOutput,
  decodeWebFetchResultBlocks,
  clampFetchTimeoutSeconds,
  WEB_FETCH_ROUTE,
  WEB_FETCH_SCHEMA,
} from '../lib/web-fetch.mjs';

const WEB_FETCH_TOOL = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 };
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };

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

async function messagesStream(s, body) {
  const r = await s.proxy.post('/v1/messages',
    { model: 'claude-3-7-sonnet', max_tokens: 200, stream: true, ...body },
    { 'x-api-key': 'user_test' });
  const text = await r.text();
  return { status: r.status, text, events: sseEvents(text) };
}

const blockStarts = (events) => events.filter(e => e.event === 'content_block_start').map(e => e.data);
const count = (events, name) => events.filter(e => e.event === name).length;

// ── 1. Unit Tests: SSRF URL Guard ────────────────────────────

test('guardFetchUrl: URL 格式与协议校验', () => {
  // 无效参数
  assert.equal(guardFetchUrl('').ok, false);
  assert.equal(guardFetchUrl('   ').ok, false);
  assert.equal(guardFetchUrl(null).ok, false);
  assert.equal(guardFetchUrl(undefined).ok, false);
  assert.equal(guardFetchUrl('not-a-url').ok, false);

  // 非 http/https 协议拒绝
  assert.equal(guardFetchUrl('ftp://example.com/file.txt').ok, false);
  assert.equal(guardFetchUrl('file:///etc/passwd').ok, false);
  assert.equal(guardFetchUrl('javascript:alert(1)').ok, false);
  assert.equal(guardFetchUrl('gopher://example.com').ok, false);

  // 内嵌账号密码拒绝
  assert.equal(guardFetchUrl('http://user:pass@example.com').ok, false);

  // 非公开单段主机名拒绝
  assert.equal(guardFetchUrl('http://internalhost/api').ok, false);
});

test('guardFetchUrl: 自动将 http:// 升级为 https:// 并保留公共合法 URL', () => {
  const upgraded = guardFetchUrl('http://example.com/page?query=1');
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.url, 'https://example.com/page?query=1');

  const kept = guardFetchUrl('https://docs.anthropic.com/en/home');
  assert.equal(kept.ok, true);
  assert.equal(kept.upgraded, false);
  assert.equal(kept.url, 'https://docs.anthropic.com/en/home');
});

test('guardFetchUrl: SSRF 防护 - 拒绝私网 IPv4、回环与云元数据', () => {
  // Loopback
  assert.equal(guardFetchUrl('http://127.0.0.1/').ok, false);
  assert.equal(guardFetchUrl('http://127.0.0.2:8080/').ok, false);
  assert.equal(guardFetchUrl('https://127.255.255.255/').ok, false);

  // RFC1918 Private IPv4
  assert.equal(guardFetchUrl('http://10.0.0.1/secret').ok, false);
  assert.equal(guardFetchUrl('http://10.254.0.1/').ok, false);
  assert.equal(guardFetchUrl('http://172.16.0.1/admin').ok, false);
  assert.equal(guardFetchUrl('http://172.31.255.255/').ok, false);
  assert.equal(guardFetchUrl('http://192.168.1.1/router').ok, false);
  assert.equal(guardFetchUrl('http://192.168.0.100/').ok, false);

  // Link-local & Cloud Metadata (169.254.0.0/16, AWS/GCP 169.254.169.254)
  assert.equal(guardFetchUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(guardFetchUrl('http://169.254.1.1/').ok, false);

  // 0.0.0.0 & Broadcast
  assert.equal(guardFetchUrl('http://0.0.0.0/').ok, false);
  assert.equal(guardFetchUrl('http://255.255.255.255/').ok, false);

  // CGNAT
  assert.equal(guardFetchUrl('http://100.64.0.1/').ok, false);
});

test('guardFetchUrl: SSRF 防护 - 拒绝私网 IPv6、回环与 IPv4 映射', () => {
  // Loopback IPv6
  assert.equal(guardFetchUrl('http://[::1]/').ok, false);
  assert.equal(guardFetchUrl('http://[::]/').ok, false);

  // RFC4193 Unique Local (fc00::/7)
  assert.equal(guardFetchUrl('http://[fc00::1]/').ok, false);
  assert.equal(guardFetchUrl('http://[fd12:3456:789a::1]/').ok, false);

  // Link-local IPv6 (fe80::/10)
  assert.equal(guardFetchUrl('http://[fe80::1]/').ok, false);

  // IPv4-mapped IPv6
  assert.equal(guardFetchUrl('http://[::ffff:127.0.0.1]/').ok, false);
  assert.equal(guardFetchUrl('http://[::ffff:169.254.169.254]/').ok, false);
  assert.equal(guardFetchUrl('http://[::ffff:10.0.0.1]/').ok, false);
  assert.equal(guardFetchUrl('http://[::ffff:192.168.1.1]/').ok, false);
});

test('guardFetchUrl: SSRF 防护 - 拒绝 localhost 及内网本地域名', () => {
  assert.equal(guardFetchUrl('http://localhost/').ok, false);
  assert.equal(guardFetchUrl('http://localhost:3000/').ok, false);
  assert.equal(guardFetchUrl('http://service.localhost/').ok, false);
  assert.equal(guardFetchUrl('http://myhost.local/').ok, false);
  assert.equal(guardFetchUrl('http://db.internal/').ok, false);
  assert.equal(guardFetchUrl('http://metadata.google.internal/').ok, false);
});

// ── 2. Unit Tests: executeWebFetch & Cache ───────────────────

test('createFetchCache: 15分钟 TTL、LRU 淘汰与单项 500KB 上限', () => {
  let virtualTime = 1000;
  const cache = createFetchCache({
    now: () => virtualTime,
    ttlMs: 15 * 60 * 1000,
    maxEntries: 3,
    maxEntryBytes: 500 * 1024,
  });

  cache.set('markdown:https://a.com', { content: 'AAA', url: 'https://a.com', status: 200 });
  cache.set('markdown:https://b.com', { content: 'BBB', url: 'https://b.com', status: 200 });
  cache.set('markdown:https://c.com', { content: 'CCC', url: 'https://c.com', status: 200 });

  assert.equal(cache.get('markdown:https://a.com')?.content, 'AAA');

  // 超出 maxEntries=3，淘汰最久未使用的 b.com（因为 a.com 刚刚被 get 访问过，最新访问顺序为 c, a）
  cache.set('markdown:https://d.com', { content: 'DDD', url: 'https://d.com', status: 200 });
  assert.equal(cache.get('markdown:https://b.com'), undefined);
  assert.equal(cache.get('markdown:https://a.com')?.content, 'AAA');
  assert.equal(cache.get('markdown:https://d.com')?.content, 'DDD');

  // 15 分钟 TTL 过期
  virtualTime += 15 * 60 * 1000 + 1;
  assert.equal(cache.get('markdown:https://a.com'), undefined);

  // 单项超过 500KB 不缓存
  const hugeContent = 'X'.repeat(500 * 1024 + 10);
  cache.set('markdown:https://huge.com', { content: hugeContent, url: 'https://huge.com', status: 200 });
  assert.equal(cache.get('markdown:https://huge.com'), undefined);
});

test('formatFetchOutput: 支持 startIndex 分片截取与超出长度校验', () => {
  const content = '0123456789ABCDEF';
  const out1 = formatFetchOutput({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    status: 200,
    content,
    startIndex: 5,
  });
  assert.equal(out1.ok, true);
  assert.ok(out1.text.includes('56789ABCDEF'));
  assert.ok(out1.text.includes('[Showing characters 5-16 of 16. End of content.]'));

  const outPast = formatFetchOutput({
    requestedUrl: 'https://example.com',
    finalUrl: 'https://example.com',
    status: 200,
    content,
    startIndex: 20,
  });
  assert.equal(outPast.ok, false);
  assert.ok(outPast.error.includes('is past the end of the content'));
});

// ── 3. Integration Tests: Proxy Web Fetch Server Tool ────────

const ROUND_FETCH = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'reasoning-start' }, { type: 'reasoning-delta', text: 'reading doc' }, { type: 'reasoning-end' },
  { type: 'text-start' }, { type: 'text-delta', text: 'Fetching documentation.' }, { type: 'text-end' },
  { type: 'tool-call', toolCallId: 'call_fetch_1', toolName: 'web_fetch', input: { url: 'https://example.com/api-doc', format: 'markdown' } },
  { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 80, outputTokens: 8, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 80, outputTokens: 8, cachedInputTokens: 0 } },
);

const ROUND_ANSWER = nd(
  { type: 'start' }, { type: 'start-step' },
  { type: 'text-start' }, { type: 'text-delta', text: 'The API doc specifies port 8080.' }, { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 10, cachedInputTokens: 0 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 120, outputTokens: 10, cachedInputTokens: 0 } },
);

test('web_fetch：模型调用 → 拦截代执行 /alpha/web-fetch → server_tool_use + web_fetch_tool_result → 续写收尾', async () => {
  let fetchHits = 0;
  let genCount = 0;
  const upstream = {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        sse(res, (genCount++ === 0) ? ROUND_FETCH : ROUND_ANSWER);
      } else if (req.url === '/alpha/web-fetch') {
        fetchHits++;
        json(res, { url: 'https://example.com/api-doc', status: 200, content: '# API Documentation\nPort: 8080' });
      }
    },
  };

  const s = await setup(upstream);
  try {
    const { status, text, events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'fetch the api doc' }],
      tools: [WEB_FETCH_TOOL],
    });

    assert.equal(status, 200);
    assert.equal(count(events, 'message_start'), 1, '只能有一个 message_start');
    assert.equal(count(events, 'message_stop'), 1, '只能有一个 message_stop');

    const starts = blockStarts(events);
    const srv = starts.find(d => d.content_block.type === 'server_tool_use');
    assert.ok(srv, '必须发出 server_tool_use 块');
    assert.equal(srv.content_block.name, 'web_fetch');
    assert.ok(srv.content_block.id.startsWith('srvtoolu_'));

    const result = starts.find(d => d.content_block.type === 'web_fetch_tool_result');
    assert.ok(result, '必须发出 web_fetch_tool_result 块');
    assert.equal(result.content_block.tool_use_id, srv.content_block.id);
    assert.ok(typeof result.content_block.content === 'string' && result.content_block.content.includes('Port: 8080'));

    assert.ok(text.includes('The API doc specifies port 8080.'), '续写内容必须输出');

    const delta = events.find(e => e.event === 'message_delta').data;
    assert.equal(delta.delta.stop_reason, 'end_turn');
    assert.deepEqual(delta.usage.server_tool_use, { web_fetch_requests: 1 });

    // 检查第 2 轮送回上游的历史
    assert.equal(s.mock.generateCount(), 2);
    const second = s.mock.lastGenerate().body;
    const wire = JSON.stringify(second.params.messages);
    assert.ok(wire.includes('"toolCallId":"call_fetch_1"') && wire.includes('"toolName":"web_fetch"'));
    assert.ok(wire.includes('Port: 8080'), '抓取正文必须进入第 2 轮模型上下文');
  } finally {
    await s.close();
  }
});

test('web_fetch：未开 CC_WEB_SEARCH 时服务端工具被剥掉', async () => {
  const s = await setup({ ndjson: ROUND_ANSWER });
  try {
    const { status, events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEB_FETCH_TOOL],
    });
    assert.equal(status, 200);
    const tools = s.mock.lastGenerate().body.params.tools;
    assert.ok(!tools || !tools.some(t => t.name === 'web_fetch'));
    assert.equal(count(events, 'message_stop'), 1);
  } finally {
    await s.close();
  }
});

test('web_fetch：非流式 /v1/messages 不走工具循环，服务端工具被剥掉', async () => {
  const s = await setup({ ndjson: ROUND_ANSWER, env: { CC_WEB_SEARCH: '1' } });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], tools: [WEB_FETCH_TOOL] },
      { 'x-api-key': 'user_test' });
    assert.equal(r.status, 200);
    const tools = s.mock.lastGenerate().body.params.tools;
    assert.ok(!tools || !tools.some(t => t.name === 'web_fetch'));
  } finally {
    await s.close();
  }
});

test('web_fetch：LRU 缓存生效，相同 URL 与格式不重复请求 /alpha/web-fetch', async () => {
  let fetchCount = 0;
  let genCount = 0;
  const upstream = {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        sse(res, (genCount++ % 2 === 0) ? ROUND_FETCH : ROUND_ANSWER);
      } else if (req.url === '/alpha/web-fetch') {
        fetchCount++;
        json(res, { url: 'https://example.com/api-doc', status: 200, content: '# Cached Content' });
      }
    },
  };

  const s = await setup(upstream);
  try {
    // 第一次请求
    await messagesStream(s, {
      messages: [{ role: 'user', content: 'fetch 1' }],
      tools: [WEB_FETCH_TOOL],
    });
    assert.equal(fetchCount, 1, '首轮调用应请求上游 web-fetch');

    // 第二次完全相同的抓取
    s.mock.seen.length = 0;
    await messagesStream(s, {
      messages: [{ role: 'user', content: 'fetch 2' }],
      tools: [WEB_FETCH_TOOL],
    });
    assert.equal(fetchCount, 1, '命中缓存后不应增加上游 web-fetch 请求');
  } finally {
    await s.close();
  }
});

test('web_fetch：多轮历史回放包含 web_fetch_tool_result 不重复触发抓取', async () => {
  let fetchCount = 0;
  const upstream = {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        sse(res, ROUND_ANSWER);
      } else if (req.url === '/alpha/web-fetch') {
        fetchCount++;
        json(res, { status: 200, content: 'should not be called' });
      }
    },
  };

  const s = await setup(upstream);
  try {
    const { status } = await messagesStream(s, {
      tools: [WEB_FETCH_TOOL],
      messages: [
        { role: 'user', content: 'fetch doc' },
        { role: 'assistant', content: [
          { type: 'text', text: 'fetching' },
          { type: 'server_tool_use', id: 'srvtoolu_old', name: 'web_fetch', input: { url: 'https://example.com/api-doc' } },
          { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_old', content: 'Old fetched content' },
          { type: 'text', text: 'I fetched it.' },
        ] },
        { role: 'user', content: 'now summarize' },
      ],
    });
    assert.equal(status, 200);
    assert.equal(fetchCount, 0, '客户端带回的历史结果绝不能触发网络抓取');

    const msgs = s.mock.lastGenerate().body.params.messages;
    const has = (m, str) => JSON.stringify(m).includes(str);
    const iCall = msgs.findIndex(m => m.role === 'assistant' && has(m, '"toolCallId":"srvtoolu_old"'));
    const iResult = msgs.findIndex(m => m.role === 'tool' && has(m, '"toolCallId":"srvtoolu_old"'));
    assert.ok(iCall >= 0 && iResult >= 0 && iCall < iResult, '正确转换为 assistant tool-call 与 tool-result');
  } finally {
    await s.close();
  }
});

test('web_fetch 与 web_search 统一调度：同轮并行调用分配与共享预算封顶', async () => {
  const ROUND_MULTI = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'call_s1', toolName: 'web_search', input: { query: 'test' } },
    { type: 'tool-call', toolCallId: 'call_f1', toolName: 'web_fetch', input: { url: 'https://example.com/test' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 90, outputTokens: 8 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 90, outputTokens: 8 } },
  );

  let searchCalls = 0;
  let fetchCalls = 0;
  let genCount = 0;
  const upstream = {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        sse(res, (genCount++ === 0) ? ROUND_MULTI : ROUND_ANSWER);
      } else if (req.url === '/alpha/web-search') {
        searchCalls++;
        json(res, { query: 'test', results: [{ title: 'T', url: 'https://example.com/test', snippet: 'S' }] });
      } else if (req.url === '/alpha/web-fetch') {
        fetchCalls++;
        json(res, { url: 'https://example.com/test', status: 200, content: 'Fetch result' });
      }
    },
  };

  const s = await setup(upstream);
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'search and fetch' }],
      tools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
    });

    assert.equal(searchCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(count(events, 'message_stop'), 1);

    const delta = events.find(e => e.event === 'message_delta').data;
    assert.deepEqual(delta.usage.server_tool_use, {
      web_search_requests: 1,
      web_fetch_requests: 1,
    });
  } finally {
    await s.close();
  }
});

test('web_fetch：超过 max_uses → max_uses_exceeded 错误块并移出定义', async () => {
  const ROUND_FETCH_2 = ROUND_FETCH.map(l => l.replace('"call_fetch_1"', '"call_fetch_2"'));
  let fetchCalls = 0;
  let genCount = 0;
  const upstream = {
    env: { CC_WEB_SEARCH: '1' },
    onRequest(req, res) {
      if (req.url === '/alpha/generate') {
        const rounds = [ROUND_FETCH, ROUND_FETCH_2, ROUND_ANSWER];
        sse(res, rounds[Math.min(genCount++, rounds.length - 1)]);
      } else if (req.url === '/alpha/web-fetch') {
        fetchCalls++;
        json(res, { url: 'https://example.com/api-doc', status: 200, content: 'Doc' });
      }
    },
  };

  const s = await setup(upstream);
  try {
    const { events } = await messagesStream(s, {
      messages: [{ role: 'user', content: 'fetch' }],
      tools: [{ ...WEB_FETCH_TOOL, max_uses: 1 }],
    });

    const results = blockStarts(events)
      .filter(d => d.content_block.type === 'web_fetch_tool_result').map(d => d.content_block);
    assert.equal(results.length, 2);
    assert.ok(typeof results[0].content === 'string');
    assert.deepEqual(results[1].content, { type: 'web_fetch_tool_result_error', error_code: 'max_uses_exceeded' });
    assert.equal(fetchCalls, 1, '超额不再打上游');
    assert.equal(count(events, 'message_stop'), 1);
  } finally {
    await s.close();
  }
});

test('DNS rebinding：解析两次给不同 IP，必须拒绝', async () => {
  // 模拟 DNS Rebinding：第一次解析为合法公网 IP，第二次解析重绑定为 127.0.0.1
  let callCount = 0;
  const mockRebindingLookup = async (hostname) => {
    callCount++;
    if (callCount === 1) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    return [{ address: '127.0.0.1', family: 4 }];
  };

  const res = await executeWebFetch({
    url: 'https://evil-rebind.com/page',
  }, 'markdown', 'test_key', { address: null, available: true }, null, {
    lookupImpl: mockRebindingLookup,
    upstreamFetch: async () => ({ ok: true, status: 200, json: async () => ({ content: 'secret' }) }),
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('DNS rebinding') || res.error.includes('blocked IP'));
  assert.equal(res.errorCode, 'invalid_input');

  // 对照组：解析两次为稳定相同公网 IP，顺利放行
  const mockStableLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const resOk = await executeWebFetch({
    url: 'https://legit-domain.com/page',
  }, 'markdown', 'test_key', { address: null, available: true }, null, {
    lookupImpl: mockStableLookup,
    upstreamFetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ content: 'safe content' })));
          controller.close();
        },
      }),
    }),
  });
  assert.equal(resOk.ok, true);
});

test('redirect 到内网：必须拒绝', async () => {
  const mockLookup = async (hostname) => {
    if (hostname.includes('internal') || hostname.includes('localhost') || hostname === '127.0.0.1') {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  };

  // 模拟上游返回 302 重定向到内网地址
  const mockFetchWith302ToInternal = async (url, opts) => {
    if (opts.redirect !== 'manual') {
      throw new Error('fetcher must be called with redirect: manual');
    }
    return {
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://127.0.0.1/admin/secret' }),
    };
  };

  const res = await executeWebFetch({
    url: 'https://external-entry.com/redirect',
  }, 'markdown', 'test_key', { address: null, available: true }, null, {
    lookupImpl: mockLookup,
    upstreamFetch: mockFetchWith302ToInternal,
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Redirect') || res.error.includes('blocked'));
  assert.equal(res.errorCode, 'invalid_input');
});

test('响应体上限：超出上限或恶意大响应拒绝并流式打断', async () => {
  const mockLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  // 1. Content-Length 超限预先拦截
  const resHeader = await executeWebFetch({
    url: 'https://huge-file.com/data',
  }, 'markdown', 'test_key', { address: null, available: true }, null, {
    lookupImpl: mockLookup,
    upstreamFetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }), // 10MB
    }),
  });
  assert.equal(resHeader.ok, false);
  assert.ok(resHeader.error.includes('size limit') || resHeader.error.includes('too large'));

  // 2. 流式读取累计字节超限并打断 reader
  let canceled = false;
  const chunk = new Uint8Array(512 * 1024); // 512KB
  const hugeStream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });

  const resStream = await executeWebFetch({
    url: 'https://stream-bomb.com/data',
  }, 'markdown', 'test_key', { address: null, available: true }, null, {
    lookupImpl: mockLookup,
    upstreamFetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: hugeStream,
    }),
  });
  assert.equal(resStream.ok, false);
  assert.ok(resStream.error.includes('size limit') || resStream.error.includes('exceeded'));
  assert.equal(canceled, true, '流式超限必须立即 cancel reader 释放资源');
});


test('timeout 钳制：参数与环境变量 CC_WEB_FETCH_TIMEOUT_MS 超限时必须夹在 [1s, 60s]', async () => {
  const origEnv = process.env.CC_WEB_FETCH_TIMEOUT_MS;
  try {
    process.env.CC_WEB_FETCH_TIMEOUT_MS = '999999';
    assert.equal(clampFetchTimeoutSeconds(), 60, '环境变量 999999ms 必须被钳制为 60s');
    assert.equal(clampFetchTimeoutSeconds(undefined), 60);

    assert.equal(clampFetchTimeoutSeconds(120), 60, '入参 120s 必须被钳制为 60s');
    assert.equal(clampFetchTimeoutSeconds(0.2), 1, '入参 0.2s 必须被钳制为 1s');
    assert.equal(clampFetchTimeoutSeconds(-10), 60, '非法负数回退环境变量并钳制为 60s');

    delete process.env.CC_WEB_FETCH_TIMEOUT_MS;
    assert.equal(clampFetchTimeoutSeconds(), 15, '缺省时为 15s');
    assert.equal(clampFetchTimeoutSeconds(30), 30, '合法中间值保持不变');
  } finally {
    if (origEnv !== undefined) {
      process.env.CC_WEB_FETCH_TIMEOUT_MS = origEnv;
    } else {
      delete process.env.CC_WEB_FETCH_TIMEOUT_MS;
    }
  }
});

test('端口限制补偿：非标准端口必须被 guardFetchUrl 明确拒绝', () => {
  assert.equal(guardFetchUrl('http://example.com:8080/path').ok, false);
  assert.equal(guardFetchUrl('https://example.com:6379/').ok, false);
  assert.equal(guardFetchUrl('http://example.com:22/').ok, false);
  assert.equal(guardFetchUrl('http://example.com:80/path').ok, true);
  assert.equal(guardFetchUrl('https://example.com:443/path').ok, true);
  assert.equal(guardFetchUrl('https://example.com/path').ok, true);
});

test('历史回放：官方 web_fetch_result 的嵌套 document 形态必须解出正文', () => {
  assert.equal(
    decodeWebFetchResultBlocks({
      type: 'web_fetch_result',
      url: 'https://example.com/doc',
      content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'nested document body' } },
    }),
    'nested document body',
  );
  assert.equal(
    decodeWebFetchResultBlocks([
      { type: 'text', text: 'first' },
      { type: 'web_fetch_result', content: { type: 'document', source: { type: 'text', data: 'second' } } },
    ]),
    'first\nsecond',
  );
  assert.equal(
    decodeWebFetchResultBlocks({ type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }),
    'Fetch failed: url_not_accessible',
  );
  assert.equal(decodeWebFetchResultBlocks('plain string'), 'plain string');
});

test('缺 route 时 executeWebFetch 必须抛错阻断（而不是返回错误块）', async () => {
  await assert.rejects(
    async () => {
      await executeWebFetch({ url: 'https://example.com' }, 'markdown', 'key');
    },
    (err) => {
      assert.equal(err.code, 'PROXY_ROUTE_UNAVAILABLE');
      return true;
    }
  );
});
