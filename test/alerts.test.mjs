import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, validateWebhookUrl, createAlerter } from '../lib/alerts.mjs';

test('isPrivateAddress: 准确识别内网与元数据地址', () => {
  // 回环与内网 IPv4
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('127.0.0.2'), true);
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true); // AWS/GCP 云元数据
  assert.equal(isPrivateAddress('100.64.0.1'), true);      // CGNAT
  assert.equal(isPrivateAddress('0.0.0.0'), true);

  // 回环与保留 IPv6
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('::'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);

  // IPv4-mapped IPv6（包含 WHATWG URL 规范解析后的十六进制格式，防 SSRF 绕过）
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('[::ffff:127.0.0.1]'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('[::ffff:7f00:1]'), true);
  assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateAddress('[::ffff:a9fe:a9fe]'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);

  // 本地域名与云元数据域名
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress('app.localhost'), true);
  assert.equal(isPrivateAddress('server.local'), true);
  assert.equal(isPrivateAddress('db.internal'), true);
  assert.equal(isPrivateAddress('metadata.google.internal'), true);
  assert.equal(isPrivateAddress('metadata'), true);

  // 公网地址应放行
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('api.feishu.cn'), false);
  assert.equal(isPrivateAddress('oapi.dingtalk.com'), false);
  assert.equal(isPrivateAddress('hooks.slack.com'), false);
});

test('validateWebhookUrl: URL 格式与内网拦截', () => {
  assert.ok(validateWebhookUrl(''));
  assert.ok(validateWebhookUrl('not-a-url'));
  assert.ok(validateWebhookUrl('ftp://example.com/webhook'));
  assert.ok(validateWebhookUrl('http://127.0.0.1:8080/hook'));
  assert.ok(validateWebhookUrl('http://[::1]:8080/hook'));
  assert.ok(validateWebhookUrl('http://[::ffff:127.0.0.1]:8080/hook'));
  assert.ok(validateWebhookUrl('http://localhost:3000/hook'));
  assert.ok(validateWebhookUrl('http://169.254.169.254/latest/meta-data'));

  // 显式允许私网时通过
  assert.equal(validateWebhookUrl('http://127.0.0.1:8080/hook', { allowPrivate: true }), null);

  // 合法公网地址通过
  assert.equal(validateWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/xxxx'), null);
  assert.equal(validateWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=xxxx'), null);
});

test('createAlerter: 未配置或禁用时零外部请求', () => {
  let fetched = false;
  const alerter = createAlerter({
    config: () => ({ alertsEnabled: false, alertsWebhookUrl: '' }),
    fetchImpl: async () => { fetched = true; return { ok: true }; },
  });

  assert.equal(alerter.enabled(), false);
  const res = alerter.emit('quota_warning', { account: 'test' });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(fetched, false);
});

test('createAlerter: 支持多渠道 payload 序列化与去重窗口', async () => {
  const sentPayloads = [];
  let currentTime = 1000000;

  const alerter = createAlerter({
    config: () => ({
      alertsEnabled: true,
      alertsWebhookUrl: 'https://example.com/webhook',
      alertsWebhookFormat: 'feishu',
      alertsCooldownMs: 60000,
    }),
    now: () => currentTime,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, options) => {
      sentPayloads.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(alerter.enabled(), true);

  // 发送第一条
  const r1 = alerter.emit('quota_exhausted', { keyId: 'k1', quota: '0%' });
  assert.equal(r1.sent, true);

  // 冷却期内重复发送相同内容应被去重
  const r2 = alerter.emit('quota_exhausted', { keyId: 'k1', quota: '0%' });
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, 'deduped');

  // 强制发送不受冷却限制
  const r3 = alerter.emit('quota_exhausted', { keyId: 'k1', quota: '0%' }, { force: true });
  assert.equal(r3.sent, true);

  // 等待队列消费
  await new Promise(r => setTimeout(r, 50));

  assert.ok(sentPayloads.length >= 1);
  const first = sentPayloads[0];
  assert.equal(first.options.redirect, 'error', '必须设置 redirect: error 防重定向 SSRF');
  assert.equal(first.body.msg_type, 'text');
  assert.ok(first.body.content.text.includes('账号额度耗尽'));
});

test('createAlerter: DNS 解析到内网 IP 时拦截投递 (防 DNS Rebinding)', async () => {
  let fetched = false;
  const alerter = createAlerter({
    config: () => ({
      alertsEnabled: true,
      alertsWebhookUrl: 'https://attacker.example.com/webhook',
    }),
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => {
      fetched = true;
      return { ok: true };
    },
  });

  alerter.emit('all_unavailable', { reason: 'test' });
  await new Promise(r => setTimeout(r, 50));

  assert.equal(fetched, false, '解析到云元数据/私网 IP 时绝不能发起 fetch');
  assert.equal(alerter.stats().failed, 1);
});
