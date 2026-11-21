// 代理隔离深度验证测试套件：
// 1. P0-1: web_search 续写轮必须复用绑定代理，绝不绕过退回直连或全局代理
// 2. P0-2: 独占分配必须计入 auto 模式 Key 实际占用的代理，避免改绑到同一代理
// 3. P1-1: bind 故障转移后，sharedKeysCount 必须按实际出口统计，不漏报共用
// 4. P1-2: 搜索与续写轮使用实际服务 Key 而非入口 Key
// 5. P1-3: 独占分配排除 #pool 轮换池
// 6. M4: strict_bind 彻底禁止绑定 direct 或 #pool（空池/纯轮换池/显式绑定全拦截）
// 7. 前端测试: 真正挂载编译 ProxiesView.vue 组件，守住显示值变异（M3 写死 0 必红）
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { allocPort, closeServer, seedConfig, startMockUpstream, startProxy } from './helpers.mjs';

// 独立数据目录隔离
process.env.CC_DATA_DIR = mkdtempSync(join(tmpdir(), 'ccp-iso-suite-'));
process.env.CC_ENV_FILE = join(tmpdir(), 'ccp-no-dotenv');

const { createProxyPool, proxyFingerprint } = await import('../lib/proxies.mjs');

const nd = (...lines) => lines.map(l => JSON.stringify(l));

let portSeq = 21000;

function createCleanPool({ keys = ['user_1', 'user_2'], probe = async () => ({ reachable: true }) } = {}) {
  const pool = createProxyPool({
    log: () => {},
    keysProvider: () => keys,
    keyIdFor: (k) => k,
    probe,
  });
  // 清理已有 managed 代理
  for (const t of pool.list()) {
    if (t.managed) pool.remove([t.id]);
  }
  return pool;
}

// 本地录制代理（统计 CONNECT 隧道与 HTTP 转发）
async function startRecordingProxy() {
  const port = await allocPort();
  const hits = [];
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(405); res.end(); return; }
    hits.push({ kind: 'http', url: req.url, headers: req.headers });
    const up = http.request({
      host: target.hostname, port: target.port || 80,
      path: target.pathname + target.search, method: req.method, headers: req.headers,
    }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, clientSocket, head) => {
    hits.push({ kind: 'connect', url: req.url, headers: req.headers });
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p || 443), h, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
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

// ── P0-1: web_search 续写轮必须复用绑定代理 ──

test('P0-1: web_search 续写轮必须走绑定的代理，绝不绕过退回全局代理或直连', async () => {
  const boundRec = await startRecordingProxy();
  const fallbackRec = await startRecordingProxy();
  const ROUND1 = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'web_search', input: { query: 'test query' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 5 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 50, outputTokens: 5 } },
  );
  const ROUND2 = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'text-start' }, { type: 'text-delta', text: 'result response' }, { type: 'text-end' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 10 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 80, outputTokens: 10 } },
  );

  let generateCalls = 0;
  let webSearchCalls = 0;
  const upstream = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url === '/alpha/generate') {
        generateCalls++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const roundData = generateCalls === 1 ? ROUND1 : ROUND2;
        for (const l of roundData) res.write(l + '\n');
        res.end();
        return true;
      }
      if (req.url === '/alpha/web-search') {
        webSearchCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ query: 'test query', results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] }));
        return true;
      }
    },
  });

  const workdir = mkdtempSync(join(tmpdir(), 'ccp-p01-'));
  // 配置全局 fallback upstreamProxy；Key 绑定走 boundRec
  seedConfig(workdir, {
    apiBase: `http://127.0.0.1:${upstream.port}`,
    upstreamProxy: fallbackRec.url,
    webSearch: true,
    proxies: [boundRec.url],
  });

  const proxy = await startProxy({
    cwd: workdir,
    upstreamPort: upstream.port,
    env: { CC_WEB_SEARCH: '1', CC_DATA_DIR: join(workdir, 'data') },
  });

  try {
    const res = await proxy.post('/v1/messages', {
      model: 'm',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'search something' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }, { 'x-api-key': 'user_test' });

    const text = await res.text();
    assert.equal(res.status, 200, `请求应成功，得到: ${text}`);
    assert.equal(generateCalls, 2, '上游应收到 2 轮 generate 请求');
    assert.equal(webSearchCalls, 1, '上游应收到 1 次 web-search 请求');

    // 关键断言：第 2 轮续写必须继续走 bound 代理，绝不能退回全局 fallback 代理！
    assert.equal(fallbackRec.hits.length, 0, '续写轮绝不能退回全局代理，fallbackRec 命中数必须为 0');
    assert.ok(boundRec.hits.length >= 5, `首轮与续写必须全部经过绑定代理，boundRec 命中数: ${boundRec.hits.length}`);
  } finally {
    await proxy.kill();
    await upstream.close();
    await boundRec.close();
    await fallbackRec.close();
  }
});

// ── P0-2: 独占分配必须计入 auto 模式 Key 实际占用的代理 ──

test('P0-2: 独占分配必须避开已被 auto 模式 Key 占用的代理，防止同 IP 多 Key', () => {
  const pool = createCleanPool({ keys: ['user_auto_a', 'user_auto_b'] });

  const addr1 = `http://127.0.0.1:${portSeq++}`;
  const addr2 = `http://127.0.0.1:${portSeq++}`;
  const p1 = pool.add(addr1);
  const p2 = pool.add(addr2);
  const id1 = p1.entry.id;
  const id2 = p2.entry.id;

  const fpA = pool.fingerprintForKey('user_auto_a');
  const fpB = pool.fingerprintForKey('user_auto_b');

  // 初始两 Key 均为 auto：KeyA 占第 0 条 (addr1)，KeyB 占第 1 条 (addr2)
  const viewsInitial = pool.keyViews();
  assert.equal(viewsInitial[0].proxyAddress, addr1);
  assert.equal(viewsInitial[1].proxyAddress, addr2);

  // 此时将 KeyB 切换为 strict_bind（未传 proxyId，请求系统自动独占分配）
  // 审查者复现场景：若占用统计只算已绑定的，KeyA 会被忽略，导致 KeyB 从 addr2 被改绑到 KeyA 的 addr1！
  const rB = pool.setBinding(fpB, 'strict_bind');
  assert.equal(rB.ok, true);
  assert.equal(rB.autoPicked, true);
  assert.equal(rB.proxyId, id2, 'KeyB 切换 strict_bind 必须保留在空闲独占的 Proxy 2，绝不能抢占 KeyA 的 Proxy 1');
  assert.notEqual(rB.proxyId, id1, 'KeyB 绝不能与 KeyA 挤在同一条代理');
});

// ── P1-1: bind 故障转移后按实际出口统计 sharedKeysCount ──

test('P1-1: bind 故障转移后 sharedKeysCount 按实际出口统计，不漏报同 IP', async () => {
  let probeOk = true;
  const pool = createCleanPool({
    keys: ['user_1', 'user_2'],
    probe: async () => ({ reachable: probeOk }),
  });

  const addrA = `http://127.0.0.1:${portSeq++}`;
  const addrB = `http://127.0.0.1:${portSeq++}`;
  const pA = pool.add(addrA);
  const pB = pool.add(addrB);
  const idA = pA.entry.id;
  const idB = pB.entry.id;

  const fp1 = pool.fingerprintForKey('user_1');
  const fp2 = pool.fingerprintForKey('user_2');

  // Key1 绑定到 ProxyA，Key2 绑定到 ProxyB
  pool.setBinding(fp1, 'bind', idA);
  pool.setBinding(fp2, 'bind', idB);

  // 让 ProxyA 不健康，触发 Key1 故障转移到 ProxyB
  probeOk = false;
  await pool.test(idA);

  const route1 = pool.routeFor('user_1');
  assert.equal(route1.address, addrB, 'Key1 应故障转移到 ProxyB');

  const views = pool.keyViews();
  const v1 = views.find(v => v.keyId === 'user_1');
  const v2 = views.find(v => v.keyId === 'user_2');

  assert.equal(v1.failedOver, true);
  // 关键断言：实际出口相同，sharedKeysCount 必须是 2！
  assert.equal(v1.sharedKeysCount, 2, 'Key1 实际共用计数必须是 2');
  assert.equal(v2.sharedKeysCount, 2, 'Key2 实际共用计数必须是 2');
});

// ── P1-2: 搜索与续写轮使用实际服务 Key 而非入口 Key ──

test('P1-2: 换账号后 web_search 搜索与续写轮必须使用实际服务 Key，不能记错账号', async () => {
  const ROUND1 = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'call_1', toolName: 'web_search', input: { query: 'test query' } },
    { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 5 } },
    { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 50, outputTokens: 5 } },
  );
  const ROUND2 = nd(
    { type: 'start' }, { type: 'start-step' },
    { type: 'text-start' }, { type: 'text-delta', text: 'result response' }, { type: 'text-end' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 10 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 80, outputTokens: 10 } },
  );

  const authHeadersSeen = [];
  const upstream = await startMockUpstream({
    onRequest: (req, res) => {
      const auth = req.headers['authorization'];
      if (req.url === '/alpha/generate') {
        authHeadersSeen.push({ url: req.url, auth });
        if (auth === 'Bearer user_initial_bad') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid token' } }));
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const roundData = authHeadersSeen.filter(h => h.url === '/alpha/generate' && h.auth === 'Bearer user_failover_good').length === 1 ? ROUND1 : ROUND2;
        for (const l of roundData) res.write(l + '\n');
        res.end();
        return true;
      }
      if (req.url === '/alpha/web-search') {
        authHeadersSeen.push({ url: req.url, auth });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ query: 'test query', results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] }));
        return true;
      }
    },
  });

  const workdir = mkdtempSync(join(tmpdir(), 'ccp-p12-'));
  seedConfig(workdir, {
    apiBase: `http://127.0.0.1:${upstream.port}`,
    webSearch: true,
  });
  fs.mkdirSync(join(workdir, 'data'), { recursive: true });
  fs.writeFileSync(join(workdir, 'data', 'keys.json'), JSON.stringify({
    version: 1,
    keys: [
      { id: 'k_good', key: 'user_failover_good', enabled: true },
    ],
  }));

  const proxy = await startProxy({
    cwd: workdir,
    upstreamPort: upstream.port,
    env: { CC_WEB_SEARCH: '1', CC_DATA_DIR: join(workdir, 'data') },
  });

  try {
    const res = await proxy.post('/v1/messages', {
      model: 'm',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'search something' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }, { 'x-api-key': 'user_initial_bad' });

    const text = await res.text();
    assert.equal(res.status, 200, `请求应成功，得到: ${text}`);

    const searchCalls = authHeadersSeen.filter(h => h.url === '/alpha/web-search');
    assert.equal(searchCalls.length, 1);
    assert.equal(searchCalls[0].auth, 'Bearer user_failover_good', 'web-search 必须使用切换后的实际服务 Key');

    const generateCalls = authHeadersSeen.filter(h => h.url === '/alpha/generate');
    // 首轮 bad(401) + 首轮 good(200) + 续写轮 good(200) = 3 次
    assert.equal(generateCalls.length, 3);
    assert.equal(generateCalls[1].auth, 'Bearer user_failover_good');
    assert.equal(generateCalls[2].auth, 'Bearer user_failover_good', '续写轮必须使用切换后的实际服务 Key');
  } finally {
    await proxy.kill();
    await upstream.close();
  }
});

// ── P1-3: 独占分配必须排除 #pool 轮换池 ──

test('P1-3: strict_bind 默认分配必须排除轮换池 (#pool)，只选静态代理', () => {
  const pool = createCleanPool({ keys: ['user_solo'] });

  const addrPool = `http://127.0.0.1:${portSeq++}#pool`;
  const addrStatic = `http://127.0.0.1:${portSeq++}`;
  const pPool = pool.add(addrPool);
  const pStatic = pool.add(addrStatic);

  const fp = pool.fingerprintForKey('user_solo');
  const r = pool.setBinding(fp, 'strict_bind');
  assert.equal(r.ok, true);
  assert.equal(r.proxyId, pStatic.entry.id, '必须分配静态代理，绝不能分配轮换池');
  assert.notEqual(r.proxyId, pPool.entry.id, '严禁将 strict_bind 自动绑定到轮换池');
});

// ── M4: strict_bind 彻底禁止绑定 direct 或 #pool（空池/纯轮换池/显式绑定全拦截） ──

test('M4: strict_bind 在空池、纯轮换池或显式指定时，坚决拒绝绑定 direct 或 #pool', () => {
  // Case A: 空池（只有系统默认兜底 direct）
  const emptyPool = createCleanPool({ keys: ['user_empty'] });
  const fpEmpty = emptyPool.fingerprintForKey('user_empty');
  const rEmpty = emptyPool.setBinding(fpEmpty, 'strict_bind');
  assert.equal(rEmpty.ok, false, '空池时 strict_bind 必须报错拒绝，绝不允许静默绑 direct');

  // Case B: 纯 #pool（池中只有 1 条轮换池代理）
  const poolOnly = createCleanPool({ keys: ['user_pool_only'] });
  const pOnly = poolOnly.add(`http://127.0.0.1:${portSeq++}#pool`);
  const fpPool = poolOnly.fingerprintForKey('user_pool_only');
  const rPool = poolOnly.setBinding(fpPool, 'strict_bind');
  assert.equal(rPool.ok, false, '纯轮换池时 strict_bind 必须报错拒绝，绝不允许绑定到轮换池');

  // Case C: 显式指定绑定到 direct
  const poolWithStatic = createCleanPool({ keys: ['user_explicit'] });
  const pStatic = poolWithStatic.add(`http://127.0.0.1:${portSeq++}`);
  const fpExplicit = poolWithStatic.fingerprintForKey('user_explicit');
  const directId = proxyFingerprint('direct');
  const rDirect = poolWithStatic.setBinding(fpExplicit, 'strict_bind', directId);
  assert.equal(rDirect.ok, false, '显式绑定 direct 时 strict_bind 必须拒绝');

  // Case D: 显式指定绑定到 #pool
  const poolEntry = poolWithStatic.add(`http://127.0.0.1:${portSeq++}#pool`);
  const rPoolExplicit = poolWithStatic.setBinding(fpExplicit, 'strict_bind', poolEntry.entry.id);
  assert.equal(rPoolExplicit.ok, false, '显式绑定 #pool 时 strict_bind 必须拒绝');
});

// ── 前端测试: 真实挂载编译 ProxiesView 组件，守住显示值变异（M3 写死 0 必红） ──

test('前端测试: 真实挂载 ProxiesView 组件渲染，咬住变异（显示值写死 0 即变红）', async () => {
  const vueCompilerPath = join(process.cwd(), 'web/node_modules/vue/compiler-sfc/index.js');
  if (!fs.existsSync(vueCompilerPath)) {
    execSync('pnpm --dir web install --frozen-lockfile', { stdio: 'inherit' });
  }

  const { parse, compileTemplate } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/vue/compiler-sfc/index.js')).href);
  const { createSSRApp } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/vue/dist/vue.esm-bundler.js')).href);
  const { renderToString } = await import(pathToFileURL(join(process.cwd(), 'web/node_modules/vue/server-renderer/index.mjs')).href);

  const vueFile = fs.readFileSync('web/src/views/ProxiesView.vue', 'utf8');

  // 1. 编译并渲染真实的 ProxiesView.vue 模板
  const renderProxiesViewTemplate = async (vueSource, bindings) => {
    const parsed = parse(vueSource);
    const compiled = compileTemplate({ source: parsed.descriptor.template.content, id: 'proxies-view-test', ssr: true });
    const serverRendererUrl = pathToFileURL(join(process.cwd(), 'web/node_modules/vue/server-renderer/index.mjs')).href;
    const code = compiled.code.replace(/from "vue\/server-renderer"/g, `from "${serverRendererUrl}"`);
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

    const Comp = {
      ssrRender: mod.ssrRender,
      setup() {
        return {
          state: { list: [], bindings, loaded: true },
          addForm: { value: '' }, busy: { rowId: '' }, editing: { id: '' },
          revealed: {}, testResults: {}, selected: [], bulkOpen: false, bulkText: '',
          keyIdOf: (b) => b.keyId, keyOf: (b) => ({ label: 'Account ' + b.keyId }),
          fmtNum: (n) => String(n), fmtDateTime: (d) => String(d), fmtLatency: (l) => String(l),
          healthyCount: 1, poolCount: 0, allSelected: false, someSelected: false,
        };
      },
    };
    return await renderToString(createSSRApp(Comp));
  };

  // Case A: 两个静态 Key 共用同一代理 -> 必须显示「⚠️ 2 Key 共用」
  const htmlWarnStatic = await renderProxiesViewTemplate(vueFile, [
    { keyId: 'k1', proxyAddress: 'http://127.0.0.1:8080', sharedKeysCount: 2, proxyPool: false },
  ]);
  assert.match(htmlWarnStatic, /⚠️ 2 Key 共用/, '共用 2 Key 时真实组件渲染必须包含 ⚠️ 2 Key 共用');

  // Case B: 两个 Key 共用轮换池 -> 必须分开提示「⚠️ 2 Key 共用轮换池」，不能被 proxyPool=true 静默吞掉
  const htmlWarnPool = await renderProxiesViewTemplate(vueFile, [
    { keyId: 'k2', proxyAddress: 'http://127.0.0.1:8081', sharedKeysCount: 2, proxyPool: true },
  ]);
  assert.match(htmlWarnPool, /⚠️ 2 Key 共用轮换池/, '轮换池有 2 Key 时真实组件必须提示 ⚠️ 2 Key 共用轮换池');

  // Case C: 独占静态代理 (sharedKeysCount = 1) -> 绝不展示共用警示
  const htmlSafe = await renderProxiesViewTemplate(vueFile, [
    { keyId: 'k3', proxyAddress: 'http://127.0.0.1:8082', sharedKeysCount: 1, proxyPool: false },
  ]);
  assert.doesNotMatch(htmlSafe, /Key 共用/, '独占 1 Key 时不展示共用警示');

  // Case D (变异敏感性自检): 若把源码中模板插值显示值强行写死为 0
  const mutantSource = vueFile.replace('{{ b.sharedKeysCount }}', '{{ 0 }}');
  const htmlMutant = await renderProxiesViewTemplate(mutantSource, [
    { keyId: 'k1', proxyAddress: 'http://127.0.0.1:8080', sharedKeysCount: 2, proxyPool: false },
  ]);
  assert.equal(/⚠️ 2 Key 共用/.test(htmlMutant), false, '模板显示值写死为 0 时正常判据必须失效变红');
});

// ── M5: bind 模式在空池与纯 #pool 时必须可用，不套用 strict_bind 的拒绝策略 ──

test('M5: bind 模式在空池与纯 #pool 时必须可用，不套用 strict_bind 的拒绝策略', () => {
  // Case A: 空池时，bind 模式自动兜底至 direct，正常可用
  const emptyPool = createCleanPool({ keys: ['user_bind_empty'] });
  const fpEmpty = emptyPool.fingerprintForKey('user_bind_empty');
  const rEmpty = emptyPool.setBinding(fpEmpty, 'bind');
  assert.equal(rEmpty.ok, true, '空池时 bind 模式必须成功（200），不被错误拒绝');
  const directId = proxyFingerprint('direct');
  assert.equal(rEmpty.proxyId, directId, '空池时 bind 模式落点为 direct');

  // 实跑 routeFor 确认正常产出 direct 出口路由
  const routeEmpty = emptyPool.routeFor('user_bind_empty');
  assert.equal(routeEmpty.available, true, '空池 bind 路由必须可用');
  assert.equal(routeEmpty.address, 'direct', '空池 bind 路由出口为 direct');

  // Case B: 纯 #pool 时，bind 模式自动兜底至 #pool，正常可用且绝不报错「代理池为空」
  const poolOnly = createCleanPool({ keys: ['user_bind_pool'] });
  const pOnly = poolOnly.add(`http://127.0.0.1:${portSeq++}#pool`);
  const fpPool = poolOnly.fingerprintForKey('user_bind_pool');
  const rPool = poolOnly.setBinding(fpPool, 'bind');
  assert.equal(rPool.ok, true, '纯 #pool 时 bind 模式必须成功，不被错误拒绝');
  assert.equal(rPool.proxyId, pOnly.entry.id, '纯 #pool 时 bind 模式落点为该轮换池');

  // 实跑 routeFor 确认正常产出轮换池出口路由
  const routePool = poolOnly.routeFor('user_bind_pool');
  assert.equal(routePool.available, true, '纯 #pool bind 路由必须可用');
  assert.equal(routePool.address, pOnly.entry.value.replace(/#pool$/, ''), '纯 #pool bind 路由出口为轮换池地址');

  // 对照组：strict_bind 在同样场景下必须被严格拒绝
  const rStrictEmpty = emptyPool.setBinding(fpEmpty, 'strict_bind');
  assert.equal(rStrictEmpty.ok, false, '空池 strict_bind 仍必须被拒绝');
  const rStrictPool = poolOnly.setBinding(fpPool, 'strict_bind');
  assert.equal(rStrictPool.ok, false, '纯 #pool strict_bind 仍必须被拒绝');
});
