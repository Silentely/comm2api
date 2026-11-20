// Redis 持久化端到端与单元测试（使用内置 mock RESP2 TCP 服务器，零外部依赖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  parseRedisConfig,
  redactRedisConfig,
  encodeRespCommand,
  RespParser,
  createRedisClient,
} from '../lib/redis.mjs';
import { allocPort, startMockUpstream, startProxy } from './helpers.mjs';

function encodeBulk(str) {
  if (str === null || str === undefined) return Buffer.from('$-1\r\n', 'ascii');
  const buf = Buffer.from(String(str), 'utf8');
  return Buffer.concat([Buffer.from(`$${buf.length}\r\n`, 'ascii'), buf, Buffer.from('\r\n', 'ascii')]);
}

function encodeArray(items) {
  const parts = [Buffer.from(`*${items.length}\r\n`, 'ascii')];
  for (const item of items) parts.push(encodeBulk(item));
  return Buffer.concat(parts);
}

/**
 * 极简内存版 mock RESP2 服务器：支持 AUTH（单/双参数与旧版回退）、SELECT、PING、HGETALL、HSET、HDEL、QUIT。
 */
async function startMockRedis({ username = '', password = '', legacyAuthOnly = false } = {}) {
  const dbs = new Map();
  const sockets = new Set();
  const history = [];

  const getDb = (idx) => {
    if (!dbs.has(idx)) dbs.set(idx, new Map());
    return dbs.get(idx);
  };

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));

    const parser = new RespParser();
    let authed = !password;
    let dbIndex = 0;

    sock.on('data', (chunk) => {
      const frames = parser.feed(chunk);
      for (const f of frames) {
        if (!f.ok || !Array.isArray(f.value) || f.value.length === 0) {
          sock.write('-ERR protocol error\r\n');
          continue;
        }
        const cmd = String(f.value[0]).toUpperCase();
        const args = f.value.slice(1);
        history.push({ cmd, args, db: dbIndex });

        if (cmd === 'QUIT') {
          sock.write('+OK\r\n');
          sock.end();
          return;
        }

        if (cmd === 'AUTH') {
          if (legacyAuthOnly && args.length > 1) {
            sock.write("-ERR wrong number of arguments for 'auth' command\r\n");
            continue;
          }
          if (args.length === 1) {
            if (args[0] === password) {
              authed = true;
              sock.write('+OK\r\n');
            } else {
              sock.write('-WRONGPASS invalid username-password pair\r\n');
            }
          } else if (args.length === 2) {
            const userOk = !username || args[0] === username;
            if (userOk && args[1] === password) {
              authed = true;
              sock.write('+OK\r\n');
            } else {
              sock.write('-WRONGPASS invalid username-password pair\r\n');
            }
          } else {
            sock.write("-ERR wrong number of arguments for 'auth' command\r\n");
          }
          continue;
        }

        if (!authed) {
          sock.write('-NOAUTH Authentication required.\r\n');
          continue;
        }

        if (cmd === 'PING') {
          sock.write(args[0] ? encodeBulk(args[0]) : '+PONG\r\n');
        } else if (cmd === 'SELECT') {
          dbIndex = Number.parseInt(args[0], 10) || 0;
          sock.write('+OK\r\n');
        } else if (cmd === 'HSET') {
          const [key, field, value] = args;
          const db = getDb(dbIndex);
          if (!db.has(key)) db.set(key, new Map());
          const hash = db.get(key);
          const isNew = hash.has(field) ? 0 : 1;
          hash.set(field, value);
          sock.write(`:${isNew}\r\n`);
        } else if (cmd === 'HGETALL') {
          const [key] = args;
          const db = getDb(dbIndex);
          const hash = db.get(key);
          if (!hash) {
            sock.write('*0\r\n');
          } else {
            const flat = [];
            for (const [k, v] of hash.entries()) flat.push(k, v);
            sock.write(encodeArray(flat));
          }
        } else if (cmd === 'HDEL') {
          const [key, field] = args;
          const db = getDb(dbIndex);
          const hash = db.get(key);
          const deleted = hash && hash.delete(field) ? 1 : 0;
          sock.write(`:${deleted}\r\n`);
        } else {
          sock.write(`-ERR unknown command '${cmd}'\r\n`);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    port,
    history,
    getHash(dbIdx, key) {
      const hash = dbs.get(dbIdx)?.get(key);
      return hash ? Object.fromEntries(hash.entries()) : {};
    },
    dropAllClients() {
      for (const s of sockets) s.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function login(proxy, password) {
  const res = await proxy.post('/admin/api/login', { password });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const body = await res.json();
  return { status: res.status, cookie, body };
}

test('parseRedisConfig 解析 URL / 分项环境变量并严格脱敏密码', () => {
  assert.equal(parseRedisConfig({}), null);

  const cfg1 = parseRedisConfig({
    REDIS_URL: 'rediss://alice:p%40ss%2Fword@us1.upstash.io:6380/3',
    REDIS_PREFIX: 'prod:',
  });
  assert.equal(cfg1.tls, true);
  assert.equal(cfg1.host, 'us1.upstash.io');
  assert.equal(cfg1.port, 6380);
  assert.equal(cfg1.username, 'alice');
  assert.equal(cfg1.password, 'p@ss/word');
  assert.equal(cfg1.db, 3);
  assert.equal(cfg1.prefix, 'prod:');
  assert.equal(cfg1.hashKey, 'prod:state');
  assert.equal(cfg1.redactedUrl, 'rediss://***@us1.upstash.io:6380/3');
  assert.ok(!cfg1.redactedUrl.includes('p@ss'));
  assert.ok(!cfg1.redactedUrl.includes('alice'));

  const cfg2 = parseRedisConfig({
    CC_REDIS_HOST: '10.0.0.8',
    CC_REDIS_PORT: '16379',
    CC_REDIS_PASSWORD: 'secret-value',
    CC_REDIS_DB: '2',
    CC_REDIS_TLS: 'true',
  });
  assert.equal(cfg2.host, '10.0.0.8');
  assert.equal(cfg2.port, 16379);
  assert.equal(cfg2.password, 'secret-value');
  assert.equal(cfg2.db, 2);
  assert.equal(cfg2.tls, true);
  assert.equal(redactRedisConfig(cfg2), 'rediss://***@10.0.0.8:16379/2');

  assert.throws(() => parseRedisConfig({ REDIS_URL: 'http://127.0.0.1:6379' }), /不支持的 Redis 协议/);
});

test('RespParser 支持逐字节 TCP 分片、UTF-8 中文与嵌套数组', () => {
  const parser = new RespParser();
  const cmdBuf = encodeRespCommand(['HSET', 'comm2api:state', 'keys.json', '{"label":"云端主力🚀"}']);
  // 逐字节喂入解析器，验证分片鲁棒性
  const out = [];
  for (let i = 0; i < cmdBuf.length; i++) {
    out.push(...parser.feed(cmdBuf.subarray(i, i + 1)));
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[0].value, ['HSET', 'comm2api:state', 'keys.json', '{"label":"云端主力🚀"}']);

  const mixed = Buffer.from('+PONG\r\n:42\r\n$-1\r\n-ERR boom\r\n', 'utf8');
  const replies = parser.feed(mixed);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].value, 'PONG');
  assert.equal(replies[1].value, 42);
  assert.equal(replies[2].value, null);
  assert.equal(replies[3].ok, false);
  assert.match(replies[3].error.message, /ERR boom/);
});

test('createRedisClient 支持 ACL/旧版 AUTH、SELECT、中文 HSET/HGETALL 与断线自动重连', async () => {
  const redis = await startMockRedis({ password: 'my-secret-pass', legacyAuthOnly: true });
  const cfg = parseRedisConfig({
    REDIS_URL: `redis://default:my-secret-pass@127.0.0.1:${redis.port}/4`,
    REDIS_PREFIX: 'unit:',
  });
  const client = createRedisClient(cfg);
  try {
    assert.equal(await client.connect(), 'PONG');
    await client.hset(cfg.hashKey, 'keys.json', JSON.stringify({ note: '中文测试🎯' }));
    const all = await client.hgetall(cfg.hashKey);
    assert.deepEqual(JSON.parse(all['keys.json']), { note: '中文测试🎯' });

    // 模拟服务端主动断开连接，验证下次命令自动重连成功
    redis.dropAllClients();
    await sleep(30);
    await client.hset(cfg.hashKey, 'settings.json', JSON.stringify({ strategy: 'fill' }));
    const all2 = await client.hgetall(cfg.hashKey);
    assert.equal(JSON.parse(all2['settings.json']).strategy, 'fill');
    assert.equal(redis.getHash(4, 'unit:state')['settings.json'], '{"strategy":"fill"}');
  } finally {
    await client.close();
    await redis.close();
  }
});

test('端到端：云端无持久卷重启（清空 CC_DATA_DIR）后全部密钥、配置、代理与管理密码均从 Redis 完整恢复', async () => {
  const redis = await startMockRedis({ password: 'cloud-redis-pass' });
  const upstream = await startMockUpstream();
  const dataDir1 = mkdtempSync(join(tmpdir(), 'ccp-redis-d1-'));
  const dataDir2 = mkdtempSync(join(tmpdir(), 'ccp-redis-d2-'));
  const redisUrl = `redis://:cloud-redis-pass@127.0.0.1:${redis.port}/2`;

  let proxy1;
  let proxy2;
  try {
    // ── 实例 1：在空白数据目录启动并写入各类配置 ──
    proxy1 = await startProxy({
      upstreamPort: upstream.port,
      env: {
        CC_DATA_DIR: dataDir1,
        ADMIN_PASSWORD: 'init-admin-password',
        REDIS_URL: redisUrl,
        REDIS_PREFIX: 'cloudtest:',
      },
    });

    const login1 = await login(proxy1, 'init-admin-password');
    assert.equal(login1.status, 200);
    const headers1 = { Cookie: login1.cookie };

    // 1) 验证 /admin/api/config 与 /admin/api/stats 正确展示脱敏后的 Redis 状态
    const cfgRes1 = await (await proxy1.get('/admin/api/config', { headers: headers1 })).json();
    assert.equal(cfgRes1.data.storage.mode, 'redis');
    assert.equal(cfgRes1.data.storage.redis.connected, true);
    assert.equal(cfgRes1.data.storage.redis.hashKey, 'cloudtest:state');
    assert.ok(!JSON.stringify(cfgRes1).includes('cloud-redis-pass'), 'Redis 密码绝不可出现在管理接口响应中');
    assert.ok(!proxy1.logs().includes('cloud-redis-pass'), 'Redis 密码绝不可出现在启动日志中');

    const statsRes1 = await (await proxy1.get('/admin/api/stats', { headers: headers1 })).json();
    assert.equal(statsRes1.data.admin.storage.mode, 'redis');
    assert.equal(statsRes1.data.admin.storage.redis.connected, true);

    // 2) 添加上游 Command Code Key
    const addKeyRes = await proxy1.post('/admin/api/keys', {
      key: 'user_cloud_persist_key_001',
      label: '云端主力账号',
    }, headers1);
    assert.equal(addKeyRes.status, 200);

    // 3) 签发 2API Key
    const addApiKeyRes = await proxy1.post('/admin/api/apikeys', {
      label: '生产客户端密钥',
    }, headers1);
    assert.equal(addApiKeyRes.status, 200);
    const apiKeyJson = await addApiKeyRes.json();
    const issued2ApiKey = apiKeyJson.data.plainKey;
    assert.ok(issued2ApiKey && issued2ApiKey.length > 10);

    // 4) 更新运行时设置（选用内置目录中的真实模型 ID）
    const modelsRes = await (await proxy1.get('/admin/api/models', { headers: headers1 })).json();
    const targetModel = modelsRes.data.models[0].id;
    const updateCfgRes = await proxy1.post('/admin/api/config/update', {
      strategy: 'fill',
      defaultModel: targetModel,
      zdr: true,
    }, headers1);
    assert.equal(updateCfgRes.status, 200);

    // 5) 添加出站代理
    const addProxyRes = await proxy1.post('/admin/api/proxies', {
      value: 'http://127.0.0.1:18080',
    }, headers1);
    assert.equal(addProxyRes.status, 200);

    // 6) 在网页修改管理员密码
    const chPwRes = await proxy1.post('/admin/api/password', {
      current: 'init-admin-password',
      new: 'cloud-new-password-888',
    }, headers1);
    assert.equal(chPwRes.status, 200);

    // 停止实例 1（触发 SIGTERM -> flushStore -> closeStore）
    await proxy1.kill();
    proxy1 = null;

    // 彻底删除实例 1 的本地数据目录，模拟云端无持久卷容器重建！
    rmSync(dataDir1, { recursive: true, force: true });

    // 验证 Redis DB 2 中已完整保存全部持久化文件
    const saved = redis.getHash(2, 'cloudtest:state');
    assert.ok(saved['keys.json'], 'keys.json 应已写入 Redis');
    assert.ok(saved['api-keys.json'], 'api-keys.json 应已写入 Redis');
    assert.ok(saved['settings.json'], 'settings.json 应已写入 Redis');
    assert.ok(saved['proxies.json'], 'proxies.json 应已写入 Redis');
    assert.ok(saved['.admin-auth.json'], '.admin-auth.json 应已写入 Redis');

    // ── 实例 2：全新空本地目录 + 相同 Redis 重启 ──
    proxy2 = await startProxy({
      upstreamPort: upstream.port,
      env: {
        CC_DATA_DIR: dataDir2,
        ADMIN_PASSWORD: 'init-admin-password', // 即使环境变量仍是旧密码，Redis 中的改密记录应生效
        REDIS_URL: redisUrl,
        REDIS_PREFIX: 'cloudtest:',
      },
    });

    // 1) 旧密码不可登，新密码（来自 Redis）可登
    const oldLogin = await login(proxy2, 'init-admin-password');
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(proxy2, 'cloud-new-password-888');
    assert.equal(newLogin.status, 200);
    const headers2 = { Cookie: newLogin.cookie };

    // 2) 上游 Key 已恢复
    const keys2 = await (await proxy2.get('/admin/api/keys', { headers: headers2 })).json();
    assert.equal(keys2.data.keys.length, 1);
    assert.equal(keys2.data.keys[0].label, '云端主力账号');

    // 3) 2API Key 已恢复
    const apiKeys2 = await (await proxy2.get('/admin/api/apikeys', { headers: headers2 })).json();
    assert.equal(apiKeys2.data.keys.length, 1);
    assert.equal(apiKeys2.data.keys[0].label, '生产客户端密钥');

    // 4) 运行时配置项已恢复
    const cfg2 = await (await proxy2.get('/admin/api/config', { headers: headers2 })).json();
    assert.equal(cfg2.data.strategy, 'fill');
    assert.equal(cfg2.data.defaultModel, targetModel);
    assert.equal(cfg2.data.zdr, true);

    // 5) 出站代理池已恢复（校验后将其停用，以便下方直连 mock 上游验证 2API Key + 上游 Key 通路）
    const proxies2 = await (await proxy2.get('/admin/api/proxies', { headers: headers2 })).json();
    const restoredProxy = proxies2.data.proxies.find((p) => String(p.address || p.url || p.value || '').includes('18080'));
    assert.ok(restoredProxy, '应从 Redis 恢复出站代理');
    const disableProxyRes = await proxy2.post('/admin/api/proxies/enabled', { id: restoredProxy.id, enabled: false }, headers2);
    assert.equal(disableProxyRes.status, 200);

    // 6) 用恢复后的 2API Key 真实调用数据面，能通过鉴权并携带恢复后的上游 Key 访问上游
    const chatRes = await proxy2.post('/v1/chat/completions', {
      model: targetModel,
      messages: [{ role: 'user', content: 'ping' }],
    }, { Authorization: `Bearer ${issued2ApiKey}` });
    assert.equal(chatRes.status, 200);
    const lastGen = upstream.lastGenerate();
    assert.equal(lastGen.headers.authorization, 'Bearer user_cloud_persist_key_001');
  } finally {
    if (proxy1) await proxy1.kill();
    if (proxy2) await proxy2.kill();
    await upstream.close();
    await redis.close();
    rmSync(dataDir1, { recursive: true, force: true });
    rmSync(dataDir2, { recursive: true, force: true });
  }
});

test('首次启用 Redis 且远程为空时，自动迁移本地已有数据目录配置至 Redis', async () => {
  const redis = await startMockRedis();
  const upstream = await startMockUpstream();
  const dataDir = mkdtempSync(join(tmpdir(), 'ccp-redis-mig-'));
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ strategy: 'random', zdr: true }) + '\n');
  writeFileSync(join(dataDir, 'keys.json'), JSON.stringify({
    version: 1,
    keys: [{ id: 'k1', key: 'user_migrated_local_key', label: '本地迁移号', enabled: true, addedAt: Date.now() }],
  }) + '\n');

  let proxy;
  try {
    proxy = await startProxy({
      upstreamPort: upstream.port,
      env: {
        CC_DATA_DIR: dataDir,
        ADMIN_PASSWORD: 'mig-password-123',
        REDIS_URL: `redis://127.0.0.1:${redis.port}/0`,
        REDIS_PREFIX: 'migrate:',
      },
    });
    const saved = redis.getHash(0, 'migrate:state');
    assert.ok(saved['settings.json'], '本地 settings.json 应已自动迁入 Redis');
    assert.ok(saved['keys.json'], '本地 keys.json 应已自动迁入 Redis');
    assert.equal(JSON.parse(saved['settings.json']).strategy, 'random');
    assert.equal(JSON.parse(saved['keys.json']).keys[0].label, '本地迁移号');
  } finally {
    if (proxy) await proxy.kill();
    await upstream.close();
    await redis.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Redis 不可达时优雅降级启动，不阻塞健康检查并在后台接口暴露错误状态', async () => {
  const closedPort = await allocPort();
  const upstream = await startMockUpstream();
  const dataDir = mkdtempSync(join(tmpdir(), 'ccp-redis-down-'));

  let proxy;
  try {
    proxy = await startProxy({
      upstreamPort: upstream.port,
      env: {
        CC_DATA_DIR: dataDir,
        ADMIN_PASSWORD: 'down-password-123',
        REDIS_URL: `redis://127.0.0.1:${closedPort}/0`,
        REDIS_TIMEOUT_MS: '600',
      },
    });

    const health = await proxy.get('/health');
    assert.equal(health.status, 200);

    const auth = await login(proxy, 'down-password-123');
    assert.equal(auth.status, 200);
    const cfg = await (await proxy.get('/admin/api/config', { headers: { Cookie: auth.cookie } })).json();
    assert.equal(cfg.data.storage.mode, 'redis');
    assert.equal(cfg.data.storage.redis.connected, false);
    assert.ok(cfg.data.storage.redis.lastError, '应记录最近一次连接错误');
  } finally {
    if (proxy) await proxy.kill();
    await upstream.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
