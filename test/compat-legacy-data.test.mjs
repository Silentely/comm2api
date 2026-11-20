// 数据兼容：用「升级前」的数据目录直接启动新版本，账号/Key/代理/设置都不能丢。
// 这一条对应需求里的 #39 #40 #41 #43：老配置能直接跑、新功能关闭时行为不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startProxy, startMockUpstream } from './helpers.mjs';

const LEGACY_KEY = 'user_legacy00000000000000000000000001';
const LEGACY_KEY_2 = 'user_legacy00000000000000000000000002';

function seedLegacyDir({ strategy = 'round_robin' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-compat-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    proxyKey: '',
    apiKey: '',
    apiBase: 'https://api.commandcode.ai',
    useProviderModels: false,
    logLevel: 'warn',
    strategy,              // 老版本的策略值：必须原样生效，不能被新功能悄悄改掉
    upstreamProxy: '',
    proxies: [],
  }, null, 2) + '\n');

  mkdirSync(join(dir, 'data'), { recursive: true });
  // 老版 keys.json（version 1，含历史用量与冷却字段）
  writeFileSync(join(dir, 'data', 'keys.json'), JSON.stringify({
    version: 1,
    keys: [
      { id: 'k_legacy_1', key: LEGACY_KEY, label: '主力', enabled: true, createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 'k_legacy_2', key: LEGACY_KEY_2, label: '备用', enabled: true, createdAt: '2025-01-02T00:00:00.000Z' },
    ],
    stats: {
      k_legacy_1: {
        usage: {
          date: '2025-01-03', requestsToday: 7, requestsTotal: 42, failedToday: 1, failedTotal: 3,
          tokensInToday: 1000, tokensInTotal: 9000, tokensOutToday: 100, tokensOutTotal: 900,
          cacheReadToday: 400, cacheReadTotal: 2000, cacheWriteToday: 100, cacheWriteTotal: 500,
          cacheMissToday: 500, cacheMissTotal: 6500,
        },
        health: { status: 'ok', checkedAt: '2025-01-03T00:00:00.000Z', latencyMs: 120, message: '' },
        cooldownUntil: null, lastError: null, lastUsedAt: '2025-01-03T00:00:00.000Z',
      },
    },
  }, null, 2) + '\n');

  // 老版 proxies.json：一条代理（已停用，避免测试把请求真的送进死代理）+ 空绑定表
  writeFileSync(join(dir, 'data', 'proxies.json'), JSON.stringify({
    version: 1,
    entries: [{ id: 'abc123def4567890', value: 'http://127.0.0.1:19999', enabled: false, createdAt: '2025-01-01T00:00:00.000Z' }],
    disabled: [],
    bindings: {},
  }, null, 2) + '\n');

  // 老版 settings.json：只覆盖了策略与日志级别
  writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({
    strategy, logLevel: 'warn',
  }, null, 2) + '\n');

  return dir;
}

test('旧数据目录直接启动：账号、策略、代理都在，数据面照常可用', async () => {
  const mock = await startMockUpstream();
  const dir = seedLegacyDir();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const health = await proxy.get('/health');
    assert.equal(health.ok, true);

    // 老 Key 仍然有效：透传模式下客户端带上游 Key，直接可用
    const r = await proxy.post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, { Authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(r.status, 200);
    await r.text();

    await sleep(200);
    // 老策略没有被新功能改写
    const settings = JSON.parse(readFileSync(join(dir, 'data', 'settings.json'), 'utf8'));
    assert.equal(settings.strategy, 'round_robin');
    // 老 Key 池原样保留（含历史用量）
    const keys = JSON.parse(readFileSync(join(dir, 'data', 'keys.json'), 'utf8'));
    assert.equal(keys.keys.length, 2);
    assert.equal(keys.stats.k_legacy_1.usage.requestsTotal, 42);
    // 代理条目与绑定没有被清空
    const proxies = JSON.parse(readFileSync(join(dir, 'data', 'proxies.json'), 'utf8'));
    assert.equal(proxies.entries.length, 1);
  } finally {
    await proxy.kill();
    await mock.close();
  }
});

test('新版本会生成额度快照文件，但不改动任何旧文件的结构', async () => {
  const mock = await startMockUpstream();
  const dir = seedLegacyDir({ strategy: 'quota_aware' });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    await sleep(2600);   // 等启动后的那一轮额度采集
  } finally {
    // 退出时会 flush 额度快照（与 Key 池用量同一套防抖落盘机制）
    await proxy.kill();
    await mock.close();
  }
  const quotaFile = join(dir, 'data', 'quota.json');
  assert.equal(existsSync(quotaFile), true, '额度快照应落盘，重启后可恢复');
  const quota = JSON.parse(readFileSync(quotaFile, 'utf8'));
  assert.equal(typeof quota, 'object');
  assert.ok(quota.accounts, '快照按账号 id 索引');
  assert.ok(quota.runtime, '运行期状态（耗尽/限流）同样持久化');
  // 旧文件依旧是旧结构
  const keys = JSON.parse(readFileSync(join(dir, 'data', 'keys.json'), 'utf8'));
  assert.equal(keys.version, 1);
});
