// 展示层格式化与枚举映射（全部中文）。

export const STRATEGY_OPTIONS = [
  { value: 'round_robin', label: '轮询 (round_robin)' },
  { value: 'random', label: '随机 (random)' },
  { value: 'fill', label: '填满 (fill)' },
  { value: 'quota_aware', label: '额度感知 (quota_aware)' },
  { value: 'quota_sticky', label: '额度感知 + 会话粘性 (quota_sticky)' },
]

export const STRATEGY_LABELS = {
  round_robin: '轮询',
  random: '随机',
  fill: '填满',
  quota_aware: '额度感知',
  quota_sticky: '额度感知 + 会话粘性',
}

export const LEVEL_OPTIONS = [
  { value: 'debug', label: 'debug' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
]

export const SOURCE_LABELS = {
  ui: '后台添加',
  config: '配置文件',
  env: '环境变量',
}

export const QUOTA_STATE_TONES = {
  available: 'ok',
  quota_warning: 'warn',
  quota_exhausted: 'danger',
  rate_limited: 'warn',
  proxy_unavailable: 'danger',
  auth_invalid: 'danger',
  manually_disabled: 'muted',
  quota_unknown: 'muted',
}

export const QUOTA_STATE_LABELS = {
  available: '可用',
  quota_warning: '接近上限',
  quota_exhausted: '额度耗尽',
  rate_limited: '限流中',
  proxy_unavailable: '代理不可用',
  auth_invalid: '鉴权失效',
  manually_disabled: '已禁用',
  quota_unknown: '额度未知',
}

export function quotaStateTone(q) {
  if (!q || !q.state) return 'muted'
  return QUOTA_STATE_TONES[q.state] || 'muted'
}

export function quotaStateLabel(q) {
  if (!q) return '未采集'
  // 数据过期时直接说明原因；只显示「额度未知」会让人以为从来没采集到过。
  if (q.state === 'quota_unknown') {
    if (!q.fetchedAt) return '尚未采集'
    if (q.stale) return '数据已过期'
  }
  return QUOTA_STATE_LABELS[q.state] || q.state || '未知'
}

// category 枚举同时用于 health.status 与测试结果
export const CATEGORY_LABELS = {
  ok: '正常',
  unauthorized: 'Key 无效',
  quota: '额度用尽',
  not_in_plan: '不在套餐内',
  network: '网络异常',
  proxy: '出站代理不可用',
  error: '上游错误',
  unknown: '未检测',
}

export const CATEGORY_TONES = {
  ok: 'ok',
  unauthorized: 'danger',
  quota: 'warn',
  not_in_plan: 'warn',
  network: 'danger',
  proxy: 'danger',
  error: 'danger',
  unknown: 'muted',
}

export const CATEGORY_ORDER = ['ok', 'unauthorized', 'quota', 'not_in_plan', 'network', 'error']

export function categoryLabel(category) {
  if (!category) return CATEGORY_LABELS.unknown
  return CATEGORY_LABELS[category] || String(category)
}

export function categoryTone(category) {
  if (!category) return 'muted'
  return CATEGORY_TONES[category] || 'muted'
}

/** not_in_plan 是模型维度的结论，不代表 Key 失效。 */
export function categoryDetail(category, fallback) {
  if (category === 'not_in_plan') return 'Key 有效，但该模型不在套餐内'
  return fallback || categoryLabel(category)
}

const MISSING = '-'

function isMissing(v) {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))
}

export function fmtNum(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  return num.toLocaleString('zh-CN')
}

/** 大数字缩写：1000000 → 1M，200000 → 200K。 */
export function fmtTokens(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  if (Math.abs(num) >= 1000000) return trimZero((num / 1000000).toFixed(2)) + 'M'
  if (Math.abs(num) >= 1000) return trimZero((num / 1000).toFixed(1)) + 'K'
  return String(num)
}

function trimZero(s) {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

/** 模型上下文长度：1000000 → 1M，200000 → 200K。 */
/** 0.6712 → "67.1%"（缓存命中率这类比例用） */
export function fmtPct(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return '-'
  return `${(n * 100).toFixed(1)}%`
}

export function fmtContext(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return MISSING
  return fmtTokens(num)
}

export function fmtDateTime(v) {
  if (isMissing(v)) return MISSING
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function fmtTime(v) {
  if (isMissing(v)) return MISSING
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 格式化重置时间戳为直观的日期与时间（当年显示 MM-DD HH:mm，跨年显示 YYYY-MM-DD HH:mm）。
 * 示例：1764136140000 -> "11-26 05:49"
 */
export function fmtResetTime(v) {
  if (isMissing(v)) return ""
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ""
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const date = String(d.getDate()).padStart(2, "0")
  const hour = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  const nowYear = new Date().getFullYear()
  return year === nowYear ? `${month}-${date} ${hour}:${min}` : `${year}-${month}-${date} ${hour}:${min}`
}

export function fmtLatency(ms) {
  if (isMissing(ms)) return MISSING
  const num = Number(ms)
  if (!Number.isFinite(num)) return MISSING
  return num >= 1000 ? `${(num / 1000).toFixed(2)} s` : `${num} ms`
}

/** 运行时长：1234 → 20分 34秒。 */
export function fmtUptime(sec) {
  if (isMissing(sec)) return MISSING
  let s = Math.max(0, Math.floor(Number(sec) || 0))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const parts = []
  if (d) parts.push(`${d}天`)
  if (h) parts.push(`${h}小时`)
  if (m) parts.push(`${m}分`)
  if (!d) parts.push(`${s}秒`)
  return parts.join(' ')
}

/** 冷却剩余秒数；无常驻冷却返回 0。 */
export function remainingSeconds(cooldownUntil, nowMs) {
  if (isMissing(cooldownUntil)) return 0
  const until = new Date(cooldownUntil).getTime()
  if (Number.isNaN(until)) return 0
  const left = Math.ceil((until - nowMs) / 1000)
  return left > 0 ? left : 0
}

export function fmtRemaining(left) {
  const s = Math.max(0, Math.floor(left))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000

/** 预热记录是否仍落在当前 5 小时窗口内；超过 5 小时的旧记录不再当作「已开窗」。 */
export function isRecentWarm(warmedAt, now = Date.now()) {
  if (!warmedAt) return false
  const ms = Date.parse(warmedAt)
  return Number.isFinite(ms) && now - ms < FIVE_HOUR_MS
}

/** 预热是否发生在官方重置时间之后，且仍是当前窗口内的记录。 */
export function isWarmedAfterReset(w, warmedAt, now = Date.now()) {
  if (!w || !w.resetAtMs || !isRecentWarm(warmedAt, now)) return false
  return Date.parse(warmedAt) >= w.resetAtMs
}

export function fmtDurationMs(ms) {
  if (isMissing(ms)) return MISSING
  const num = Number(ms)
  if (!Number.isFinite(num)) return MISSING
  if (num >= 1000) return `${(num / 1000).toFixed(2)}s`
  return `${num}ms`
}

export function fmtBytes(n) {
  if (isMissing(n)) return MISSING
  const num = Number(n)
  if (!Number.isFinite(num)) return MISSING
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = num
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`
}

/** 日志 data 字段格式化：对象 → 缩进 JSON。 */
export function fmtPayload(data) {
  if (data === null || data === undefined || data === '') return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

export function truncate(s, max = 40) {
  if (isMissing(s)) return MISSING
  const str = String(s)
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

export function sumBy(items, pick) {
  return (items || []).reduce((acc, it) => acc + (Number(pick(it)) || 0), 0)
}
