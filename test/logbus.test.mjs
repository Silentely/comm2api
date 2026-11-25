// 日志总线的去重 id：GET /logs 历史与 SSE 补发/重连都靠它判断「同一条」，
// 因此必须是进程内单调递增、且不会被入参里的业务 id 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogBus } from '../lib/logbus.mjs';

test('logbus: 每条日志都带单调递增的顶层 id', () => {
  const bus = createLogBus({ max: 3 });
  bus.push({ level: 'info', msg: 'a' });
  bus.push({ level: 'info', msg: 'b' });
  bus.push({ level: 'warn', msg: 'c' });

  assert.deepEqual(bus.recent(10).map(e => e.id), [3, 2, 1]);
  assert.deepEqual(bus.recent(10).map(e => e.msg), ['c', 'b', 'a']);
});

test('logbus: 入参自带的 id 不覆盖去重 id，且环形缓冲按 max 截断', () => {
  const bus = createLogBus({ max: 2 });
  bus.push({ level: 'info', msg: 'first', id: 'request-id' });
  bus.push({ level: 'info', msg: 'second' });
  bus.push({ level: 'info', msg: 'third' });

  assert.deepEqual(bus.recent(10).map(e => e.id), [3, 2]);
  assert.deepEqual(bus.recent(10).map(e => e.msg), ['third', 'second']);
  assert.equal(bus.size, 2);
});

test('logbus: 订阅者收到带 id 的同一条条目', () => {
  const bus = createLogBus();
  const seen = [];
  const off = bus.subscribe(e => seen.push(e));
  bus.push({ level: 'error', msg: 'boom' });
  off();
  bus.push({ level: 'info', msg: 'ignored' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 1);
  assert.equal(seen[0].msg, 'boom');
});
