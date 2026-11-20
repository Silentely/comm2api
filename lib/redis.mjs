// ── 轻量零依赖 Redis 客户端（RESP2 / TCP + TLS）──────────────
// 为无持久化本地卷的云端部署（Zeabur / Railway / Render / Fly.io / Serverless 等）
// 提供配置与密钥持久化能力。刻意不引入外部 npm 依赖，保持整个运行时零第三方依赖。
//
// 支持的连接方式：
//   - REDIS_URL / CC_REDIS_URL:
//       redis://[:password@]host[:port][/db]
//       redis://username:password@host[:port][/db]
//       rediss://username:password@host[:port][/db]   (自动开启 TLS + SNI)
//   - 独立环境变量兜底：
//       REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD / REDIS_DB / REDIS_TLS
//       （均同时接受 CC_REDIS_* 前缀，CC_REDIS_* 优先于 REDIS_*）
//   - 命名空间与超时：
//       REDIS_PREFIX / CC_REDIS_PREFIX（默认 comm2api:，Hash 键名为 <prefix>state）
//       REDIS_TIMEOUT_MS / CC_REDIS_TIMEOUT_MS（默认 5000ms）
//       REDIS_TLS_REJECT_UNAUTHORIZED / CC_REDIS_TLS_REJECT_UNAUTHORIZED（默认 true）
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const CRLF_BUF = Buffer.from(CRLF);

function pickEnv(env, ...names) {
  for (const name of names) {
    const val = env?.[name];
    if (val !== undefined && String(val).trim() !== '') return String(val).trim();
  }
  return '';
}

function parseBoolEnv(val, fallback) {
  if (!val) return fallback;
  const s = String(val).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function safeDecode(str) {
  if (!str) return '';
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * 脱敏展示 Redis 地址：绝不泄露密码或用户名明文。
 * 示例：rediss://***@us1-demo.upstash.io:6379/0
 */
export function redactRedisConfig(cfg) {
  if (!cfg) return '';
  const proto = cfg.tls ? 'rediss' : 'redis';
  const auth = (cfg.password || cfg.username) ? '***@' : '';
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
  const dbPart = cfg.db ? `/${cfg.db}` : '/0';
  return `${proto}://${auth}${host}:${cfg.port}${dbPart}`;
}

/**
 * 从环境变量解析 Redis 连接配置；未配置返回 null。
 */
export function parseRedisConfig(env = process.env) {
  const rawUrl = pickEnv(env, 'CC_REDIS_URL', 'REDIS_URL');
  const rawHost = pickEnv(env, 'CC_REDIS_HOST', 'REDIS_HOST');
  if (!rawUrl && !rawHost) return null;

  let host = rawHost || '127.0.0.1';
  let port = 6379;
  let username = '';
  let password = '';
  let db = 0;
  let useTls = false;

  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      throw new Error(`无效的 REDIS_URL 格式: ${e.message}`);
    }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`不支持的 Redis 协议 "${parsed.protocol}"，仅支持 redis:// 或 rediss://`);
    }
    useTls = parsed.protocol === 'rediss:';
    if (parsed.hostname) host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.port) {
      const p = Number.parseInt(parsed.port, 10);
      if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
    }
    if (parsed.username) username = safeDecode(parsed.username);
    if (parsed.password) password = safeDecode(parsed.password);
    if (parsed.pathname && parsed.pathname !== '/') {
      const dbStr = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      const n = Number.parseInt(dbStr, 10);
      if (Number.isFinite(n) && n >= 0) db = n;
    }
    const qDb = parsed.searchParams.get('db');
    if (qDb !== null && qDb !== '') {
      const n = Number.parseInt(qDb, 10);
      if (Number.isFinite(n) && n >= 0) db = n;
    }
    const qTls = parsed.searchParams.get('tls');
    if (qTls !== null) useTls = parseBoolEnv(qTls, useTls);
  }

  // 独立环境变量作为补充/覆盖（当 URL 中未包含或仅使用分项配置时）
  const envPort = pickEnv(env, 'CC_REDIS_PORT', 'REDIS_PORT');
  if (envPort && !rawUrl) {
    const p = Number.parseInt(envPort, 10);
    if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
  }
  const envUser = pickEnv(env, 'CC_REDIS_USERNAME', 'REDIS_USERNAME');
  if (envUser && !username) username = envUser;
  const envPass = pickEnv(env, 'CC_REDIS_PASSWORD', 'REDIS_PASSWORD');
  if (envPass && !password) password = envPass;
  const envDb = pickEnv(env, 'CC_REDIS_DB', 'REDIS_DB');
  if (envDb && (!rawUrl || db === 0)) {
    const n = Number.parseInt(envDb, 10);
    if (Number.isFinite(n) && n >= 0) db = n;
  }
  const envTls = pickEnv(env, 'CC_REDIS_TLS', 'REDIS_TLS');
  if (envTls) useTls = parseBoolEnv(envTls, useTls);

  const rejectUnauthorized = parseBoolEnv(
    pickEnv(env, 'CC_REDIS_TLS_REJECT_UNAUTHORIZED', 'REDIS_TLS_REJECT_UNAUTHORIZED'),
    true,
  );

  const rawPrefix = pickEnv(env, 'CC_REDIS_PREFIX', 'REDIS_PREFIX');
  const prefix = rawPrefix || 'comm2api:';
  const hashKey = `${prefix}state`;

  const rawTimeout = pickEnv(env, 'CC_REDIS_TIMEOUT_MS', 'REDIS_TIMEOUT_MS');
  let timeoutMs = 5000;
  if (rawTimeout) {
    const n = Number.parseInt(rawTimeout, 10);
    if (Number.isFinite(n)) timeoutMs = Math.min(Math.max(n, 500), 60000);
  }

  const cfg = {
    host,
    port,
    username,
    password,
    db,
    tls: useTls,
    rejectUnauthorized,
    prefix,
    hashKey,
    timeoutMs,
  };
  cfg.redactedUrl = redactRedisConfig(cfg);
  return cfg;
}

/**
 * 将 Redis 命令与参数编码为 RESP2 Array of Bulk Strings。
 * 严格按 UTF-8 字节长度计算 `$len`，正确处理中文与任意二进制安全字符。
 */
export function encodeRespCommand(args) {
  const parts = [Buffer.from(`*${args.length}${CRLF}`, 'ascii')];
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${buf.length}${CRLF}`, 'ascii'));
    parts.push(buf);
    parts.push(CRLF_BUF);
  }
  return Buffer.concat(parts);
}

/**
 * 流式 RESP2 解析器：支持 TCP 任意分片、粘包、嵌套数组、$-1 / *-1 空值。
 */
export class RespParser {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  feed(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._buf = this._buf.length === 0 ? incoming : Buffer.concat([this._buf, incoming]);
    const results = [];
    let offset = 0;
    while (offset < this._buf.length) {
      const parsed = this._parseAt(offset);
      if (!parsed) break;
      results.push(parsed.result);
      offset = parsed.next;
    }
    if (offset > 0) {
      this._buf = offset === this._buf.length ? Buffer.alloc(0) : this._buf.subarray(offset);
    }
    return results;
  }

  reset() {
    this._buf = Buffer.alloc(0);
  }

  _parseAt(offset) {
    if (offset >= this._buf.length) return null;
    const prefix = this._buf[offset];
    const lineEnd = this._buf.indexOf(CRLF_BUF, offset + 1);
    if (lineEnd === -1) return null;

    const line = this._buf.subarray(offset + 1, lineEnd).toString('utf8');
    const afterLine = lineEnd + 2;

    switch (prefix) {
      case 0x2b: // '+' Simple String
        return { result: { ok: true, value: line }, next: afterLine };
      case 0x2d: // '-' Error
        return { result: { ok: false, error: new Error(line) }, next: afterLine };
      case 0x3a: // ':' Integer
        return { result: { ok: true, value: Number.parseInt(line, 10) }, next: afterLine };
      case 0x24: { // '$' Bulk String
        const len = Number.parseInt(line, 10);
        if (len === -1) return { result: { ok: true, value: null }, next: afterLine };
        if (!Number.isFinite(len) || len < 0) {
          return { result: { ok: false, error: new Error(`Invalid RESP bulk length: ${line}`) }, next: afterLine };
        }
        const bodyEnd = afterLine + len;
        if (this._buf.length < bodyEnd + 2) return null;
        const val = this._buf.subarray(afterLine, bodyEnd).toString('utf8');
        return { result: { ok: true, value: val }, next: bodyEnd + 2 };
      }
      case 0x2a: { // '*' Array
        const count = Number.parseInt(line, 10);
        if (count === -1) return { result: { ok: true, value: null }, next: afterLine };
        if (!Number.isFinite(count) || count < 0) {
          return { result: { ok: false, error: new Error(`Invalid RESP array count: ${line}`) }, next: afterLine };
        }
        const items = [];
        let cursor = afterLine;
        for (let i = 0; i < count; i++) {
          const elem = this._parseAt(cursor);
          if (!elem) return null;
          items.push(elem.result.ok ? elem.result.value : elem.result.error);
          cursor = elem.next;
        }
        return { result: { ok: true, value: items }, next: cursor };
      }
      default:
        return {
          result: { ok: false, error: new Error(`Unexpected RESP prefix byte: 0x${prefix.toString(16)}`) },
          next: afterLine,
        };
    }
  }
}

/**
 * 创建 Redis 客户端（单连接自动重连 + 命令串行排队 + 超时保护）。
 */
export function createRedisClient(config) {
  let socket = null;
  let connected = false;
  let connectPromise = null;
  let closed = false;
  const parser = new RespParser();
  const pending = [];

  function updateSocketRef() {
    if (!socket || socket.destroyed) return;
    if (pending.length > 0) socket.ref?.();
    else socket.unref?.();
  }

  function failAllPending(err) {
    while (pending.length > 0) {
      const item = pending.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
    updateSocketRef();
  }

  function cleanupSocket(err) {
    connected = false;
    const sock = socket;
    socket = null;
    parser.reset();
    if (sock) {
      sock.removeAllListeners();
      try { sock.destroy(); } catch {}
    }
    if (pending.length > 0) {
      failAllPending(err || new Error('Redis 连接已断开'));
    }
  }

  function sendRaw(sock, args) {
    return new Promise((resolve, reject) => {
      if (!sock || sock.destroyed) {
        return reject(new Error('Redis socket 不可用'));
      }
      const timer = setTimeout(() => {
        const idx = pending.findIndex(p => p.timer === timer);
        if (idx !== -1) pending.splice(idx, 1);
        const err = new Error(`Redis 命令超时 (${config.timeoutMs}ms): ${args[0]}`);
        cleanupSocket(err);
        reject(err);
      }, config.timeoutMs);
      timer.unref?.();

      pending.push({ resolve, reject, timer });
      updateSocketRef();
      try {
        sock.write(encodeRespCommand(args));
      } catch (e) {
        const idx = pending.findIndex(p => p.timer === timer);
        if (idx !== -1) pending.splice(idx, 1);
        clearTimeout(timer);
        cleanupSocket(e);
        reject(e);
      }
    });
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, sock) => {
        if (settled) return;
        settled = true;
        clearTimeout(connTimer);
        if (err) {
          try { sock?.destroy(); } catch {}
          reject(err);
        } else {
          resolve(sock);
        }
      };

      const sock = config.tls
        ? tls.connect({
            host: config.host,
            port: config.port,
            servername: net.isIP(config.host) ? undefined : config.host,
            rejectUnauthorized: config.rejectUnauthorized,
          })
        : net.createConnection({ host: config.host, port: config.port });

      const connTimer = setTimeout(() => {
        done(new Error(`连接 Redis 超时 (${config.timeoutMs}ms): ${config.redactedUrl}`), sock);
      }, config.timeoutMs);
      connTimer.unref?.();

      const onReadyEvent = config.tls ? 'secureConnect' : 'connect';
      sock.once(onReadyEvent, () => {
        sock.setNoDelay?.(true);
        sock.setKeepAlive?.(true, 30000);
        done(null, sock);
      });
      sock.once('error', (err) => {
        done(err, sock);
      });
      sock.once('close', () => {
        done(new Error('Redis 连接在握手完成前关闭'), sock);
      });
    });
  }

  async function ensureConnected() {
    if (closed) throw new Error('Redis 客户端已关闭');
    if (connected && socket && !socket.destroyed) return socket;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      const sock = await openSocket();
      socket = sock;
      parser.reset();

      sock.on('data', (chunk) => {
        const replies = parser.feed(chunk);
        for (const r of replies) {
          const item = pending.shift();
          if (!item) continue;
          clearTimeout(item.timer);
          if (r.ok) item.resolve(r.value);
          else item.reject(r.error);
        }
        updateSocketRef();
      });

      sock.on('error', (err) => {
        cleanupSocket(err);
      });

      sock.on('close', () => {
        cleanupSocket(new Error('Redis 连接已关闭'));
      });

      try {
        if (config.password) {
          if (config.username) {
            try {
              await sendRaw(sock, ['AUTH', config.username, config.password]);
            } catch (e) {
              // 兼容 Redis < 6（不支持 ACL 双参数 AUTH，仅接受 AUTH password）
              if (/wrong number of arguments|ERR syntax|invalid password/i.test(e.message) && config.username === 'default') {
                await sendRaw(sock, ['AUTH', config.password]);
              } else if (/wrong number of arguments/i.test(e.message)) {
                await sendRaw(sock, ['AUTH', config.password]);
              } else {
                throw e;
              }
            }
          } else {
            await sendRaw(sock, ['AUTH', config.password]);
          }
        }
        if (config.db > 0) {
          await sendRaw(sock, ['SELECT', String(config.db)]);
        }
        connected = true;
        updateSocketRef();
        return sock;
      } catch (e) {
        cleanupSocket(e);
        throw e;
      }
    })();

    try {
      return await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function command(...args) {
    const sock = await ensureConnected();
    return sendRaw(sock, args);
  }

  async function connect() {
    await ensureConnected();
    return command('PING');
  }

  async function ping() {
    return command('PING');
  }

  async function hgetall(key) {
    const res = await command('HGETALL', key);
    const map = {};
    if (Array.isArray(res)) {
      for (let i = 0; i + 1 < res.length; i += 2) {
        const k = res[i];
        const v = res[i + 1];
        if (typeof k === 'string' && typeof v === 'string') {
          map[k] = v;
        }
      }
    }
    return map;
  }

  async function hset(key, field, value) {
    return command('HSET', key, field, value);
  }

  async function hdel(key, field) {
    return command('HDEL', key, field);
  }

  async function close() {
    closed = true;
    const sock = socket;
    if (sock && !sock.destroyed && connected) {
      try {
        await Promise.race([
          sendRaw(sock, ['QUIT']).catch(() => {}),
          new Promise(r => setTimeout(r, 300)),
        ]);
      } catch {}
    }
    cleanupSocket(new Error('Redis 客户端已关闭'));
  }

  return {
    config,
    connect,
    command,
    ping,
    hgetall,
    hset,
    hdel,
    close,
    isConnected: () => connected && !!socket && !socket.destroyed,
  };
}
