// ── 上游 Key 池 ───────────────────────────────────────
// 一个 Key = 一个 Command Code 账号（`user_` 开头的静态 Key，没有 refresh token）。
//
// 三种来源，合并成一个轮询池：
//   ui     后台添加 → 存在 data/keys.json，可增删改、可启停
//   config 来自 config.json 的 apiKey（历史字段）→ 只读
//   env    来自 CC_API_KEY 环境变量（优先级最高）→ 只读
// 只读来源不允许在后台删除/禁用（会明确报错），但可以「导入」为 ui 来源。
//
// 热加载：池的状态全在内存，后台任何写操作立即改内存 + 防抖落盘，
// 下一个请求就能用到 —— 不需要重启，也不需要 fs.watch。
import { randomBytes, createHash } from 'crypto';
import { dataPath, readJSON, writeJSONAtomic, createDebouncedWriter, DATA_DIR, ensureDir } from './store.mjs';
import { CFG, ENV_LOCKED, normalizeApiKeyList } from './config.mjs';

export const KEYS_PATH = dataPath('keys.json');
const FILE_VERSION = 1;

export const STRATEGY_LABELS = {
  round_robin: '轮询',
  random: '随机',
  fill: '填满（固定用第一个可用）',
  quota_aware: '额度感知（优先额度充足的账号）',
  quota_sticky: '额度感知 + 会话粘性',
};

// 冷却时长：按失败性质区分。
// 注意 not_in_plan 是「模型不在套餐内」，属于模型维度结论 —— 绝不能把 Key 罚下场，
// 否则测一个套餐外模型就会让整个 Key 停摆 10 分钟。
export const COOLDOWN_MS = {
  quota: 10 * 60 * 1000,        // 额度用尽：换个 Key 还有救，稍后自动恢复
  unauthorized: 30 * 60 * 1000, // Key 失效：多半要人工换，但保持自愈能力
  network: 5 * 60 * 1000,       // 网络抖动：短冷却
  error: 0,                     // 其它上游错误：不冷却，只计数
  not_in_plan: 0,
};

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 输入 token 拆成三桶（上游本来就分开发，只是以前没采集）：
//   cacheRead  缓存命中 / 缓存读取（便宜，最能反映前缀缓存有没有生效）
//   cacheWrite 写入缓存（首次建立缓存，计费口径通常又不同）
//   cacheMiss  既未命中也没写入（真正的"新"输入）
// 三者相加 === 输入总数（实测 noCacheTokens + cacheReadTokens + cacheWriteTokens === inputTokens）
function newUsage() {
  return {
    date: today(),
    requestsToday: 0, requestsTotal: 0,
    failedToday: 0, failedTotal: 0,
    tokensInToday: 0, tokensInTotal: 0,          // 输入总数（含缓存）
    cacheReadToday: 0, cacheReadTotal: 0,        // 其中：缓存命中
    cacheWriteToday: 0, cacheWriteTotal: 0,      // 其中：写入缓存
    cacheMissToday: 0, cacheMissTotal: 0,        // 其中：未命中
    tokensOutToday: 0, tokensOutTotal: 0,
  };
}

/** 跨天时把 today 类计数清零（在每次读取/写入前调用，避免依赖定时任务） */
function rollUsage(u) {
  const t = today();
  if (u.date !== t) {
    u.date = t;
    u.requestsToday = 0;
    u.failedToday = 0;
    u.tokensInToday = 0;
    u.cacheReadToday = 0;
    u.cacheWriteToday = 0;
    u.cacheMissToday = 0;
    u.tokensOutToday = 0;
  }
  return u;
}

function newStats() {
  return {
    usage: newUsage(),
    health: { status: 'unknown', checkedAt: null, latencyMs: null, message: '' },
    cooldownUntil: null,
    lastError: null,
    lastUsedAt: null,
  };
}

/** 外部来源的 Key 需要一个跨重启稳定的 id（用量统计要挂在它上面） */
function externalId(key) {
  return 'ext_' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function newId() {
  return `k_${Date.now()}_${randomBytes(3).toString('hex')}`;
}

/** 脱敏展示：`user_abcd…wxyz`。完整值只能走 reveal 接口单条取。 */
export function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return s.slice(0, 2) + '…';
  if (s.length <= 16) return s.slice(0, 4) + '…' + s.slice(-2);
  return s.slice(0, 9) + '…' + s.slice(-4);
}

export function isValidKeyFormat(key) {
  return typeof key === 'string' && key.trim().length > 0 && key.trim().startsWith('user_');
}

export function createKeyPool({ log = () => {}, onPersistError = null, runtime = null } = {}) {
  ensureDir(DATA_DIR);

  // 运行期封锁提供者（由 lib/quota.mjs 注入）：{ blockReason(keyId) => {state,reason,untilMs}|null }
  // 刻意用「注入」而不是 import：keys.mjs 不该认识额度模块，否则两个模块互相依赖，
  // 也会让「关闭额度功能 → 行为回到原样」这件事变得不可验证。
  let runtimeProvider = runtime;
  // 调度器钩子：当策略是 quota_aware / quota_sticky 时由 proxy.mjs 装上。
  // 未装 → 完全走原有 round_robin / random / fill 逻辑，行为与升级前一致。
  let scheduler = null;

  const state = {
    version: FILE_VERSION,
    keys: [],    // UI 管理：{ id, key, label, enabled, createdAt }
    stats: {},   // id → { usage, health, cooldownUntil, lastError, lastUsedAt }
  };

  // 加载
  const loaded = readJSON(KEYS_PATH, null, (file, err) => {
    log('error', 'keys.json 解析失败，已按空池启动（原文件未被覆盖）', { file, error: err.message });
  });
  if (loaded && typeof loaded === 'object' && Array.isArray(loaded.keys)) {
    state.keys = loaded.keys
      .filter(k => k && typeof k.key === 'string' && k.key.trim())
      .map(k => ({
        id: typeof k.id === 'string' && k.id ? k.id : newId(),
        key: k.key.trim(),
        label: typeof k.label === 'string' ? k.label : '',
        enabled: k.enabled !== false,
        createdAt: k.createdAt || new Date().toISOString(),
      }));
    if (loaded.stats && typeof loaded.stats === 'object') {
      for (const [id, s] of Object.entries(loaded.stats)) {
        const base = newStats();
        state.stats[id] = {
          ...base,
          ...s,
          usage: { ...base.usage, ...(s?.usage || {}) },
          health: { ...base.health, ...(s?.health || {}) },
        };
      }
    }
    log('info', 'Key 池已加载', { uiKeys: state.keys.length, dataDir: DATA_DIR });
  }

  const writer = createDebouncedWriter(KEYS_PATH, () => state, {
    maxDelayMs: 5000,
    onError: (e) => {
      log('error', 'keys.json 写盘失败', { error: e.message });
      if (onPersistError) onPersistError(e);
    },
  });

  function persistNow() {
    try {
      writeJSONAtomic(KEYS_PATH, state, 0o600);
    } catch (e) {
      log('error', 'keys.json 写盘失败', { error: e.message });
    }
  }

  function statsOf(id) {
    if (!state.stats[id]) state.stats[id] = newStats();
    const s = state.stats[id];
    rollUsage(s.usage);
    // 冷却到期自动恢复
    if (s.cooldownUntil && Date.now() >= new Date(s.cooldownUntil).getTime()) {
      s.cooldownUntil = null;
    }
    return s;
  }

  /** 只读来源：一组 { key, source } */
  function externalKeys() {
    const source = ENV_LOCKED.has('apiKey') ? 'env' : 'config';
    return normalizeApiKeyList(CFG.apiKeyList).map(key => ({ key, source }));
  }

  /**
   * 合并视图：UI Key + 外部 Key（同串去重，UI 优先）。
   * `entry` 里带 `readOnly` 与 `source`，供后台决定按钮可用性。
   */
  function all() {
    const uiKeys = new Set(state.keys.map(k => k.key));
    const out = state.keys.map(k => ({
      id: k.id, key: k.key, label: k.label || '', enabled: k.enabled !== false,
      source: 'ui', readOnly: false, createdAt: k.createdAt,
    }));
    for (const { key, source } of externalKeys()) {
      if (uiKeys.has(key)) continue;
      out.push({
        id: externalId(key), key, label: source === 'env' ? '（环境变量 CC_API_KEY）' : '（config.json apiKey）',
        enabled: true, source, readOnly: true, createdAt: null,
      });
    }
    return out;
  }

  /** 后台列表项：脱敏 + 用量 + 健康 + 冷却 */
  function list() {
    return all().map(e => {
      const s = statsOf(e.id);
      return {
        id: e.id,
        label: e.label,
        keyMasked: maskKey(e.key),
        source: e.source,
        enabled: e.enabled,
        readOnly: e.readOnly,
        createdAt: e.createdAt,
        lastUsedAt: s.lastUsedAt,
        cooldownUntil: s.cooldownUntil,
        lastError: s.lastError,
        usage: { ...s.usage },
        health: { ...s.health },
      };
    });
  }

  /**
   * 可参与轮询的 Key。排除：被禁用、冷却中、以及本轮已试过的（exclude）。
   *
   * 两级兜底，都是刻意的：
   *  1) 若「仅被 exclude 排除」导致池空 → 退回全集。多 Key 全失败时还要能给出
   *     最后一次响应，而不是直接报「无可用 Key」。
   *  2) 若所有 Key 都在冷却 → 退而选「冷却最早结束」的那个。冷却是我们自己的
   *     启发式，不是上游的权威判定；因为启发式而拒绝服务等于自造故障。
   */
  /**
   * 候选池。
   *
   * 与升级前的关键差异：多了一层**硬封锁**（额度耗尽 / 鉴权失效 / 代理不可用 / 短期限流）。
   * 硬封锁的账号**绝不**参与下面两级兜底 —— 否则「额度已耗尽」会被
   * 「所有 Key 都在冷却 → 退而选冷却最早结束的那个」这条兜底悄悄复活，
   * 变成对着已经耗尽的账号反复撞限（需求里明令禁止的行为）。
   */
  // 在途请求计数（按账号 id）：用于 accountMaxConcurrency 的轻量限制。
  // 只用于「尽量不把单个账号压满」，不是精确的配额器 —— 一个请求可能跨账号
  // 重试，这里记的是**初次选定**的那个账号。
  const inflight = new Map();

  function beginRequest(key) {
    const id = idForKey(key);
    inflight.set(id, (inflight.get(id) || 0) + 1);
  }

  function endRequest(key) {
    const id = idForKey(key);
    const cur = inflight.get(id) || 0;
    if (cur <= 1) inflight.delete(id);
    else inflight.set(id, cur - 1);
  }

  function inFlightOf(id) {
    return inflight.get(id) || 0;
  }

  function candidates(exclude = null, ctx = null) {
    const now = Date.now();
    const enabled = all().filter(e => e.enabled);
    const provider = (ctx && ctx.runtime) || runtimeProvider;
    const blocked = new Map();

    const hardEnabled = enabled.filter(e => {
      if (!provider || typeof provider.blockReason !== 'function') return true;
      let b = null;
      try { b = provider.blockReason(e.id); } catch { b = null; }
      if (b) { blocked.set(e.id, b); return false; }
      return true;
    });

    const usable = hardEnabled.filter(e => {
      const s = statsOf(e.id);
      return !(s.cooldownUntil && now < new Date(s.cooldownUntil).getTime());
    });

    // 单账号并发上限：优先选还有余量的账号；全部满额时仍然放行（
    // 因为「把请求拒掉」比「暂时超过并发上限」严重得多 —— 后者只是变慢）。
    const maxPerAccount = Number(CFG.accountMaxConcurrency) || 0;
    let pool = usable;
    if (maxPerAccount > 0) {
      const within = usable.filter(e => inFlightOf(e.id) < maxPerAccount);
      if (within.length > 0) pool = within;
    }
    let reason = 'ok';

    if (exclude && exclude.size > 0) {
      // 注意用 pool（已按并发上限缩过）而不是 usable：否则本轮重试会把
      // 已满额的账号又放回候选池，并发上限形同虚设。
      const fresh = pool.filter(e => !exclude.has(e.key));
      if (fresh.length > 0) pool = fresh;
      else if (pool.length > 0) reason = 'exclude-exhausted';
    }

    if (pool.length === 0 && hardEnabled.length > 0) {
      // 全部冷却中（但都没被硬封锁）：按冷却结束时间升序，尽早恢复可用
      pool = [...hardEnabled].sort((a, b) => {
        const ta = statsOf(a.id).cooldownUntil ? new Date(statsOf(a.id).cooldownUntil).getTime() : 0;
        const tb = statsOf(b.id).cooldownUntil ? new Date(statsOf(b.id).cooldownUntil).getTime() : 0;
        return ta - tb;
      });
      reason = 'all-cooling';
    } else if (pool.length === 0 && enabled.length > 0) {
      // 启用着、但全部被硬封锁 → 不能返回任何 Key
      reason = 'all-blocked';
    } else if (enabled.length === 0) {
      reason = 'none-enabled';
    }

    return { pool, reason, blocked };
  }

  let cursor = 0;
  let lastPicked = null;
  let consecutiveSame = 0;
  let lastCoolingWarnAt = 0;

  /** 按策略选一个 Key。exclude 为本轮已失败过的 Key 字符串集合。 */
  function pick(exclude = null, ctx = null) {
    return pickDetailed(exclude, ctx).entry;
  }

  /**
   * 与 pick 相同，但同时返回「为什么没选出来」。
   * 调度层靠 reason 区分「全部额度耗尽」（→429 + Retry-After）与
   * 「全部代理不可达」（→503），这正是需求里要求分开的两种错误。
   */
  function pickDetailed(exclude = null, ctx = null) {
    const { pool, reason, blocked } = candidates(exclude, ctx);
    if (pool.length === 0) return { entry: null, reason, blocked };

    // 额度感知 / 粘性策略：交给注入的调度器（它只在显式启用时才存在）
    if (typeof scheduler === 'function') {
      let chosen = null;
      try { chosen = scheduler({ pool, exclude, ctx, reason }); } catch (e) { log('warn', '调度器出错，回退内置策略', { error: e.message }); }
      if (chosen) {
        consecutiveSame = (lastPicked && chosen.key === lastPicked.key) ? consecutiveSame + 1 : 1;
        lastPicked = chosen;
        return { entry: chosen, reason };
      }
    }

    if (reason === 'all-cooling') {
      // 限流日志：避免每个请求刷一条
      if (Date.now() - lastCoolingWarnAt > 60000) {
        lastCoolingWarnAt = Date.now();
        log('warn', '所有 Key 均在冷却中，退化为按冷却结束时间优先选择', { count: pool.length });
      }
    }

    if (pool.length === 1) {
      lastPicked = pool[0];
      consecutiveSame = 1;
      return { entry: pool[0], reason };
    }

    let chosen;
    if (CFG.strategy === 'fill') {
      chosen = pool[0];
    } else if (CFG.strategy === 'random') {
      // 随机 + 避让连续重复：纯随机会出现「连续几次全撞同一个 Key」，
      // 在额度受限场景下等于把一个号打穿。连续 8 次后不再避让，兜底打破死锁。
      let p = pool;
      if (consecutiveSame < 8 && lastPicked) {
        const avoided = pool.filter(e => e.key !== lastPicked.key);
        if (avoided.length > 0) p = avoided;
      }
      chosen = p[Math.floor(Math.random() * p.length)];
    } else {
      if (cursor >= pool.length) cursor = 0;
      chosen = pool[cursor];
      cursor = (cursor + 1) % pool.length;
    }

    consecutiveSame = (lastPicked && chosen.key === lastPicked.key) ? consecutiveSame + 1 : 1;
    lastPicked = chosen;
    return { entry: chosen, reason };
  }

  function idForKey(key) {
    const ui = state.keys.find(k => k.key === key);
    if (ui) return ui.id;
    return externalId(key);
  }

  // ── 写操作 ─────────────────────────────────────────
  function add({ key, label = '' }) {
    const k = String(key || '').trim();
    if (!isValidKeyFormat(k)) return { ok: false, error: 'Key 格式不正确（应以 user_ 开头）' };
    if (all().some(e => e.key === k)) return { ok: false, error: '该 Key 已存在' };
    const entry = { id: newId(), key: k, label: String(label || '').trim(), enabled: true, createdAt: new Date().toISOString() };
    state.keys.push(entry);
    state.stats[entry.id] = newStats();
    persistNow();   // 新增/删除属于低频且重要的变更，立即落盘
    log('info', 'Key 已添加', { id: entry.id, keyMasked: maskKey(k), label: entry.label });
    return { ok: true, entry };
  }

  function update({ id, label, enabled }) {
    const entry = state.keys.find(k => k.id === id);
    if (!entry) {
      const ext = all().find(e => e.id === id);
      if (ext?.readOnly) return { ok: false, error: `该 Key 来自 ${ext.source === 'env' ? '环境变量' : 'config.json'}，不可修改；可先「导入」再编辑` };
      return { ok: false, error: 'Key 不存在' };
    }
    if (label !== undefined) entry.label = String(label || '').trim();
    if (enabled !== undefined) entry.enabled = !!enabled;
    persistNow();
    return { ok: true, entry };
  }

  function remove(id) {
    const idx = state.keys.findIndex(k => k.id === id);
    if (idx === -1) {
      const ext = all().find(e => e.id === id);
      if (ext?.readOnly) return { ok: false, error: `该 Key 来自 ${ext.source === 'env' ? '环境变量' : 'config.json'}，不可删除；可先「导入」再管理` };
      return { ok: false, error: 'Key 不存在' };
    }
    const [gone] = state.keys.splice(idx, 1);
    delete state.stats[gone.id];
    persistNow();
    log('info', 'Key 已删除', { id: gone.id, keyMasked: maskKey(gone.key) });
    return { ok: true };
  }

  function reveal(id) {
    const e = all().find(x => x.id === id);
    if (!e) return { ok: false, error: 'Key 不存在' };
    return { ok: true, key: e.key };
  }

  /** 把只读来源的 Key 复制成 UI 可管理的条目 */
  function importExternal() {
    let imported = 0;
    for (const { key, source } of externalKeys()) {
      if (state.keys.some(k => k.key === key)) continue;
      const entry = {
        id: newId(), key, enabled: true, createdAt: new Date().toISOString(),
        label: source === 'env' ? '导入自 CC_API_KEY' : '导入自 config.json',
      };
      state.keys.push(entry);
      state.stats[entry.id] = newStats();
      imported++;
    }
    if (imported) persistNow();
    return { ok: true, imported };
  }

  // ── 用量与健康记录 ──────────────────────────────────
  function recordRequest(key, { ok }) {
    const s = statsOf(idForKey(key));
    const u = rollUsage(s.usage);
    u.requestsToday++; u.requestsTotal++;
    if (!ok) { u.failedToday++; u.failedTotal++; }
    s.lastUsedAt = new Date().toISOString();
    writer.markDirty();
  }

  /**
   * 记一次 token 用量。输入按缓存三个桶分别累加。
   * cacheRead / cacheWrite 缺失时（老上游或没给明细）全部归入"未命中"，
   * 保证 命中 + 写 + 未命中 === 输入总数 恒成立。
   */
  function recordTokens(key, { tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
    if (!key) return;
    const tIn = Number(tokensIn) || 0;
    const tOut = Number(tokensOut) || 0;
    if (tIn <= 0 && tOut <= 0) return;

    const read = Math.min(Math.max(Number(cacheRead) || 0, 0), Math.max(tIn, 0));
    const write = Math.min(Math.max(Number(cacheWrite) || 0, 0), Math.max(tIn - read, 0));
    const miss = Math.max(0, tIn - read - write);

    const s = statsOf(idForKey(key));
    const u = rollUsage(s.usage);
    u.tokensInToday += tIn; u.tokensInTotal += tIn;
    u.cacheReadToday += read; u.cacheReadTotal += read;
    u.cacheWriteToday += write; u.cacheWriteTotal += write;
    u.cacheMissToday += miss; u.cacheMissTotal += miss;
    u.tokensOutToday += tOut; u.tokensOutTotal += tOut;
    writer.markDirty();
  }

  /** 记录一次失败并（按性质）把 Key 放进冷却 */
  function recordFailure(key, { category = 'error', message = '' } = {}) {
    const id = idForKey(key);
    const s = statsOf(id);
    s.lastError = { category, message: String(message || '').slice(0, 300), at: new Date().toISOString() };
    const ms = COOLDOWN_MS[category] ?? 0;
    if (ms > 0) {
      s.cooldownUntil = new Date(Date.now() + ms).toISOString();
      log('warn', 'Key 进入冷却', { category, keyMasked: maskKey(key), cooldownMin: Math.round(ms / 60000) });
    }
    writer.markDirty();
  }

  function setHealth(key, { category, latencyMs = null, message = '' }) {
    if (!key) return;
    const s = statsOf(idForKey(key));
    s.health = {
      status: category,
      checkedAt: new Date().toISOString(),
      latencyMs,
      message: String(message || '').slice(0, 300),
    };
    writer.markDirty();
  }

  /** 探测成功 → 解除冷却（手工测试通过即代表这个 Key 现在可用） */
  function clearCooldown(key) {
    if (!key) return;
    const s = statsOf(idForKey(key));
    s.cooldownUntil = null;
    s.lastError = null;
    writer.markDirty();
  }

  function resetUsage(id, scope = 'today') {
    const s = statsOf(id);
    if (scope === 'all') {
      s.usage = newUsage();
    } else {
      const u = rollUsage(s.usage);
      u.requestsToday = 0; u.failedToday = 0;
      u.tokensInToday = 0; u.cacheReadToday = 0; u.cacheWriteToday = 0; u.cacheMissToday = 0;
      u.tokensOutToday = 0;
    }
    persistNow();
    return { ok: true };
  }

  function usageReport() {
    const items = list().map(e => {
      const u = e.usage;
      return {
        keyId: e.id, label: e.label, keyMasked: e.keyMasked,
        source: e.source, enabled: e.enabled,
        requestsToday: u.requestsToday, requestsTotal: u.requestsTotal,
        failedToday: u.failedToday, failedTotal: u.failedTotal,
        successToday: u.requestsToday - u.failedToday,
        successTotal: u.requestsTotal - u.failedTotal,
        tokensInToday: u.tokensInToday, tokensInTotal: u.tokensInTotal,
        // 输入明细：命中（缓存读取）/ 写缓存 / 未命中
        cacheReadToday: u.cacheReadToday, cacheReadTotal: u.cacheReadTotal,
        cacheWriteToday: u.cacheWriteToday, cacheWriteTotal: u.cacheWriteTotal,
        // 未命中**按差额推导**而不是存一个独立计数：这样「三桶之和 === 输入总数」
        // 恒成立 —— 包括本功能上线前留下的历史数据（那时只记了输入总数，
        // 若把未命中当成独立计数就会是 0，三者对不上）。
        cacheMissToday: Math.max(0, u.tokensInToday - u.cacheReadToday - u.cacheWriteToday),
        cacheMissTotal: Math.max(0, u.tokensInTotal - u.cacheReadTotal - u.cacheWriteTotal),
        // 命中率（按 token 计），便于一眼看出前缀缓存有没有生效
        cacheHitRateToday: u.tokensInToday > 0
          ? Number((u.cacheReadToday / u.tokensInToday).toFixed(4)) : 0,
        cacheHitRateTotal: u.tokensInTotal > 0
          ? Number((u.cacheReadTotal / u.tokensInTotal).toFixed(4)) : 0,
        tokensOutToday: u.tokensOutToday, tokensOutTotal: u.tokensOutTotal,
        lastUsedAt: e.lastUsedAt,
      };
    });
    const summary = items.reduce((a, i) => ({
      requestsToday: a.requestsToday + i.requestsToday,
      requestsTotal: a.requestsTotal + i.requestsTotal,
      failedToday: a.failedToday + i.failedToday,
      failedTotal: a.failedTotal + i.failedTotal,
      inToday: a.inToday + i.tokensInToday,
      inTotal: a.inTotal + i.tokensInTotal,
      cacheReadToday: a.cacheReadToday + i.cacheReadToday,
      cacheReadTotal: a.cacheReadTotal + i.cacheReadTotal,
      cacheWriteToday: a.cacheWriteToday + i.cacheWriteToday,
      cacheWriteTotal: a.cacheWriteTotal + i.cacheWriteTotal,
      cacheMissToday: a.cacheMissToday + i.cacheMissToday,
      cacheMissTotal: a.cacheMissTotal + i.cacheMissTotal,
      outToday: a.outToday + i.tokensOutToday,
      outTotal: a.outTotal + i.tokensOutTotal,
    }), {
      requestsToday: 0, requestsTotal: 0, failedToday: 0, failedTotal: 0,
      inToday: 0, inTotal: 0,
      cacheReadToday: 0, cacheReadTotal: 0, cacheWriteToday: 0, cacheWriteTotal: 0,
      cacheMissToday: 0, cacheMissTotal: 0,
      outToday: 0, outTotal: 0,
    });
    summary.cacheHitRateToday = summary.inToday > 0
      ? Number((summary.cacheReadToday / summary.inToday).toFixed(4)) : 0;
    summary.cacheHitRateTotal = summary.inTotal > 0
      ? Number((summary.cacheReadTotal / summary.inTotal).toFixed(4)) : 0;
    return { items, summary };
  }

  function countByState() {
    const now = Date.now();
    const list_ = list();
    return {
      total: list_.length,
      enabled: list_.filter(e => e.enabled).length,
      cooldown: list_.filter(e => e.cooldownUntil && now < new Date(e.cooldownUntil).getTime()).length,
      unhealthy: list_.filter(e => e.health?.status && !['ok', 'unknown'].includes(e.health.status)).length,
    };
  }

  /** 供 authenticate / 统计使用：当前可用的上游 Key 数量 */
  function size() {
    return all().filter(e => e.enabled).length;
  }

  function findById(id) {
    return all().find(e => e.id === id) || null;
  }

  return {
    list, all, pick, pickDetailed, idForKey, findById, size, countByState,
    candidates: (exclude = null, ctx = null) => candidates(exclude, ctx).pool,
    // 装/换运行期封锁提供者 + 调度器（proxy.mjs 在装配阶段调用一次）
    setRuntimeProvider: (p) => { runtimeProvider = p; },
    setScheduler: (fn) => { scheduler = typeof fn === 'function' ? fn : null; },
    get hasScheduler() { return typeof scheduler === 'function'; },
    beginRequest, endRequest, inFlightOf,
    statsOf: (id) => statsOf(id),
    hasCooldown: (key) => {
      const s = statsOf(idForKey(key));
      return !!(s.cooldownUntil && Date.now() < new Date(s.cooldownUntil).getTime());
    },
    add, update, remove, reveal, importExternal,
    recordRequest, recordTokens, recordFailure, setHealth, clearCooldown, resetUsage,
    usageReport,
    flush: () => { writer.flush(); },
    flushSync: persistNow,
    get path() { return KEYS_PATH; },
  };
}
