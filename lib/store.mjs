// ── 原子持久化（本地文件 + 可选 Redis 云端存储）──────────────
// 本地模式：所有写盘走「临时文件 + rename」：rename 在同一文件系统内是原子的，
// 进程在写到一半被杀（OOM、docker stop 超时）只会留下一个 tmp 文件，
// 不会把 .json 截断成半个对象 —— 那会让下次启动读回坏配置。
//
// Redis 模式（配置 REDIS_URL / CC_REDIS_URL 或 REDIS_HOST 后自动启用）：
//   - 启动时从 Redis Hash（默认 comm2api:state）一次性 HGETALL 水合全部持久化数据到内存；
//   - 每次写入立即更新内存镜像并异步串行 HSET 写回 Redis（同时尽力写一份本地镜像，
//     在云端只读/临时文件系统下本地写失败不报错）；
//   - 进程退出前（SIGTERM/SIGINT）调用 flushStore() 确保全部待写入数据落库。
//
// 读取一律容错：文件缺失/损坏都返回 fallback 并留有告警钩子，
// 绝不让一个坏文件或短暂网络抖动把服务带崩（宁可回退默认值，也不拒绝启动）。
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'fs';
import { dirname, resolve, join, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { parseRedisConfig, createRedisClient } from './redis.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// .env 文件位置：项目根目录，可用 CC_ENV_FILE 指定别处。
// 必须在解析 DATA_DIR 与 Redis 配置之前加载，确保 .env 中的 CC_DATA_DIR / REDIS_URL 生效。
export const DOTENV_PATH = process.env.CC_ENV_FILE
  ? resolve(process.env.CC_ENV_FILE)
  : resolve(ROOT, '.env');

/**
 * 载入 .env 到 process.env。
 * 语义：**真实环境变量优先** —— 已存在的键一律不覆盖。
 */
export function loadDotEnv(file = DOTENV_PATH) {
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return { found: false, path: file, keys: [] };
  }
  const keys = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;   // 真实环境变量优先
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const a = val[0], b = val[val.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) val = val.slice(1, -1);
    }
    if (val === '') continue;   // 空值等同于没配，避免用空串覆盖别的层
    process.env[key] = val;
    keys.push(key);
  }
  return { found: true, path: file, keys };
}

export const DOTENV = loadDotEnv();

// 数据目录：Key 池 / 后台密码 / 模型测试结论 / 配置项都落在这里。
// 用 CC_DATA_DIR 可外挂到卷；无持久卷的云端部署可配置 REDIS_URL 走 Redis 持久化。
export const DATA_DIR = process.env.CC_DATA_DIR
  ? resolve(process.env.CC_DATA_DIR)
  : resolve(ROOT, 'data');

// ── Redis 存储状态 ─────────────────────────────────────────
let redisConfig = null;
let redisClient = null;
const memCache = new Map();        // field (相对 DATA_DIR 的路径) -> JSON 字符串
const dirtyFields = new Set();     // 待同步至 Redis 的 field 集合
let drainPromise = null;
let retryTimer = null;
let retryDelayMs = 1000;
let lastWarnAt = 0;

const redisState = {
  enabled: false,
  connected: false,
  hydrated: false,
  lastSyncAt: null,
  lastError: null,
  configError: null,
};

function toDataField(file) {
  const abs = resolve(file);
  const rel = relative(DATA_DIR, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

function warnThrottled(msg) {
  const now = Date.now();
  if (now - lastWarnAt < 10000) return;
  lastWarnAt = now;
  console.error(msg);
}

function scheduleRetry() {
  if (retryTimer || !redisState.enabled || dirtyFields.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, 30000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    drainRedisWrites().catch(() => {});
  }, delay);
  retryTimer.unref?.();
}

function drainRedisWrites() {
  if (!redisState.enabled || !redisClient) return Promise.resolve();
  if (drainPromise) return drainPromise;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  drainPromise = (async () => {
    while (dirtyFields.size > 0) {
      const batch = [...dirtyFields];
      let failed = false;
      for (const field of batch) {
        const payload = memCache.get(field);
        if (payload === undefined) {
          dirtyFields.delete(field);
          continue;
        }
        try {
          await redisClient.hset(redisConfig.hashKey, field, payload);
          // 仅当写回期间没有更新的值覆盖该字段时，才清除脏标记
          if (memCache.get(field) === payload) {
            dirtyFields.delete(field);
          }
          if (!redisState.connected) {
            console.log(`[store] Redis 连接已恢复 (${redisConfig.redactedUrl})，数据同步继续正常进行`);
          }
          redisState.connected = true;
          redisState.lastSyncAt = Date.now();
          redisState.lastError = null;
          retryDelayMs = 1000;
        } catch (err) {
          redisState.connected = false;
          redisState.lastError = err?.message || String(err);
          warnThrottled(`[store] Redis 同步失败 (${redisConfig.redactedUrl}, field=${field}): ${redisState.lastError}`);
          failed = true;
          break;
        }
      }
      if (failed) {
        scheduleRetry();
        break;
      }
    }
  })().finally(() => {
    drainPromise = null;
    // 若在收尾间隙又有新脏数据且未在重试退避中，立即继续刷出
    if (dirtyFields.size > 0 && !retryTimer) {
      drainRedisWrites().catch(() => {});
    }
  });

  return drainPromise;
}

/**
 * 首次启用 Redis 且远程 Hash 为空时，自动将本地 DATA_DIR 中已有的合法 .json 文件迁入 Redis，
 * 避免用户从本地部署切换到 Redis 时丢失已有密钥与配置。
 */
async function seedLocalFilesToRedis() {
  if (!existsSync(DATA_DIR)) return 0;
  let entries;
  try {
    entries = readdirSync(DATA_DIR);
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
    const fullPath = join(DATA_DIR, name);
    try {
      const st = statSync(fullPath);
      if (!st.isFile()) continue;
      const text = readFileSync(fullPath, 'utf-8');
      JSON.parse(text);   // 只迁移合法 JSON
      memCache.set(name, text);
      await redisClient.hset(redisConfig.hashKey, name, text);
      migrated++;
    } catch {
      // 忽略损坏或无权限的本地文件
    }
  }
  return migrated;
}

async function initRedisStore() {
  try {
    redisConfig = parseRedisConfig(process.env);
  } catch (err) {
    redisState.configError = err?.message || String(err);
    redisState.lastError = redisState.configError;
    console.error(`[store] Redis 配置无效，已回退本地文件存储: ${redisState.configError}`);
    return;
  }
  if (!redisConfig) return;

  redisState.enabled = true;
  redisClient = createRedisClient(redisConfig);

  try {
    const remote = await redisClient.hgetall(redisConfig.hashKey);
    const keys = Object.keys(remote);
    for (const field of keys) {
      memCache.set(field, remote[field]);
    }
    let seeded = 0;
    if (keys.length === 0) {
      seeded = await seedLocalFilesToRedis();
    }
    redisState.connected = true;
    redisState.hydrated = true;
    redisState.lastSyncAt = Date.now();
    redisState.lastError = null;
    console.log(
      `[store] Redis 持久化已启用并连接成功 (${redisConfig.redactedUrl})，已从 Hash "${redisConfig.hashKey}" 水合 ${keys.length} 项数据` +
      (seeded > 0 ? `（本地首次自动迁入 ${seeded} 项）` : "")
    );
  } catch (err) {
    redisState.connected = false;
    redisState.hydrated = false;
    redisState.lastError = err?.message || String(err);
    console.error(
      `[store] Redis 启动连接失败 (${redisConfig.redactedUrl}): ${redisState.lastError}；` +
      '服务将继续运行，后续配置变更会在 Redis 恢复后自动重试同步',
    );
  }
}

// 顶层 await：ESM 模块图在求值 lib/config.mjs、lib/keys.mjs、lib/api-keys.mjs 等之前
// 会先完成 Redis 水合；未配置 Redis 时立刻返回，零开销。
await initRedisStore();

export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

export function fileExists(file) {
  if (redisState.enabled) {
    const field = toDataField(file);
    if (field && memCache.has(field)) return true;
  }
  try { return existsSync(file); } catch { return false; }
}

/** 文件 mtime（毫秒）；不存在或读不到返回 0。用于「外部改配置文件」的热加载探测。 */
export function fileMtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * 读 JSON。任何异常（不存在、权限、截断、非法 JSON）都返回 fallback。
 * Redis 模式下优先从水合/内存镜像读取 DATA_DIR 下的文件，未命中再回退本地文件。
 */
export function readJSON(file, fallback = null, onError = null) {
  if (redisState.enabled) {
    const field = toDataField(file);
    if (field && memCache.has(field)) {
      try {
        return JSON.parse(memCache.get(field));
      } catch (e) {
        if (onError) onError(file, e);
        return fallback;
      }
    }
  }
  try {
    const text = readFileSync(file, 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e?.code !== 'ENOENT' && onError) onError(file, e);
    return fallback;
  }
}

function writeLocalFileAtomic(file, text, mode = 0o600) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeFileAtomic(file, text, mode = 0o600) {
  if (redisState.enabled) {
    const field = toDataField(file);
    if (field) {
      memCache.set(field, text);
      dirtyFields.add(field);
      // 立即异步刷入 Redis；本地落盘改为尽力而为（云端容器文件系统可能是只读或临时盘）
      drainRedisWrites().catch(() => {});
      try { writeLocalFileAtomic(file, text, mode); } catch {}
      return true;
    }
  }
  return writeLocalFileAtomic(file, text, mode);
}

export function writeJSONAtomic(file, obj, mode = 0o600) {
  return writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

/**
 * 等待所有待写入的 Redis 持久化操作完成（有界超时，用于优雅退出与测试）。
 */
export async function flushStore(timeoutMs = 5000) {
  if (!redisState.enabled || !redisClient) {
    return { ok: true, pending: 0, error: null };
  }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const task = drainRedisWrites();
  let timer = null;
  try {
    await Promise.race([
      task,
      new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    ok: dirtyFields.size === 0 && !redisState.lastError,
    pending: dirtyFields.size,
    error: redisState.lastError,
  };
}

/**
 * 关闭底层 Redis 连接（用于优雅退出）。
 */
export async function closeStore() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (redisClient) {
    try { await redisClient.close(); } catch {}
  }
}

/**
 * 返回当前持久化后端状态（URL 已脱敏，不含任何密码），供启动日志、管理后台与监控使用。
 */
export function getStorageStatus() {
  return {
    mode: redisState.enabled ? 'redis' : 'file',
    dataDir: DATA_DIR,
    redis: {
      enabled: redisState.enabled,
      connected: redisState.enabled ? (redisState.connected && !!redisClient?.isConnected()) : false,
      hydrated: redisState.hydrated,
      url: redisConfig?.redactedUrl || '',
      prefix: redisConfig?.prefix || '',
      hashKey: redisConfig?.hashKey || '',
      keysCount: memCache.size,
      pendingWrites: dirtyFields.size,
      lastSyncAt: redisState.lastSyncAt,
      lastError: redisState.lastError,
    },
  };
}

/**
 * 防抖落盘器：用量计数每个请求都会变，逐次写盘既费 IO 又无意义。
 * 攒 maxDelayMs 落一次；进程退出时调用 flush() 补最后一次。
 */
export function createDebouncedWriter(file, getValue, { maxDelayMs = 5000, onError = null } = {}) {
  let timer = null;
  let dirty = false;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    try {
      writeJSONAtomic(file, getValue());
    } catch (e) {
      if (onError) onError(e);
    }
  };

  return {
    /** 标记为脏；到达 maxDelayMs 后自动落盘 */
    markDirty() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => { timer = null; flush(); }, maxDelayMs);
      timer.unref?.();
    },
    flush,
    get pending() { return dirty; },
  };
}

export function dataPath(name) {
  return join(DATA_DIR, name);
}
