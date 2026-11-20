<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { loadStats } from '../store'
import { toast } from '../toast'
import { SOURCE_LABELS, fmtDateTime, fmtNum, fmtPct, fmtTokens } from '../utils'
import StatCard from '../components/StatCard.vue'

const data = ref(null)
const loading = ref(false)
const error = ref('')
const busy = reactive({})

// 官方额度（与上面的本地统计**完全分开**：两者绝不互相冒充）
const quota = ref(null)
const quotaLoading = ref(false)
const quotaBusy = ref('')

async function loadQuota(silent = false) {
  if (!silent) quotaLoading.value = true
  try {
    const res = await api('GET', '/quota')
    quota.value = res.data || null
  } catch (e) {
    if (!silent) toast.error('加载官方额度失败：' + e.message)
  } finally {
    quotaLoading.value = false
  }
}

async function refreshQuota(keyId) {
  quotaBusy.value = keyId || 'all'
  try {
    const res = await api('POST', '/quota/refresh', keyId ? { id: keyId } : {})
    toast.success(res.message || '额度已刷新')
    await loadQuota(true)
  } catch (e) {
    toast.error('刷新失败：' + e.message)
  } finally {
    quotaBusy.value = ''
  }
}

function qWindow(acc, name) {
  return (acc && acc.windows && acc.windows[name]) || null
}

function qPct(w) {
  if (!w || w.percentUsed === null || w.percentUsed === undefined) return null
  return Math.round(w.percentUsed * 1000) / 10
}

function qText(w) {
  if (!w) return '官方未返回'
  if (w.used === null || w.used === undefined || w.cap === null || w.cap === undefined) {
    const p = qPct(w)
    return p === null ? '部分未知' : `${p}%`
  }
  return `${fmtNum(w.used)} / ${fmtNum(w.cap)}`
}

function qResetLeft(w) {
  if (!w || !w.resetAtMs) return null
  const sec = Math.round((w.resetAtMs - Date.now()) / 1000)
  return sec > 0 ? sec : 0
}

function qResetText(w) {
  const sec = qResetLeft(w)
  if (sec === null) return '重置时间未知'
  if (sec <= 0) return '已到重置时间（等待重新确认）'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分后重置` : `${m} 分后重置`
}

function quoteStateTone(acc) {
  const map = { available: 'ok', quota_warning: 'warn', quota_exhausted: 'danger', rate_limited: 'warn', proxy_unavailable: 'danger', auth_invalid: 'danger', quota_unknown: 'muted', manually_disabled: 'muted' }
  return map[acc.state] || 'muted'
}

function quotaStateText(acc) {
  const map = {
    available: '可用', quota_warning: '接近上限', quota_exhausted: '额度耗尽',
    rate_limited: '限流中', proxy_unavailable: '代理不可用', auth_invalid: '鉴权失效',
    quota_unknown: '额度未知', manually_disabled: '已禁用',
  }
  return map[acc.state] || acc.state
}

// 时间区间统计（本地口径）：5m / 1h / 5h / 24h / 7d
const analytics = ref(null)

async function loadAnalytics(silent = true) {
  try {
    const res = await api('GET', '/analytics?window=1h')
    analytics.value = res.data || null
  } catch (e) {
    if (!silent) toast.error('加载区间统计失败：' + e.message)
  }
}

const ANALYTICS_ROWS = [
  ['5m', '最近 5 分钟'],
  ['1h', '最近 1 小时'],
  ['5h', '最近 5 小时'],
  ['24h', '最近 24 小时'],
  ['7d', '最近 7 天'],
]

const items = computed(() => (data.value && data.value.items) || [])
const summary = computed(() => (data.value && data.value.summary) || {})

async function loadUsage(silent = false) {
  if (!silent) loading.value = true
  try {
    const res = await api('GET', '/usage')
    data.value = res.data || null
    error.value = ''
  } catch (e) {
    error.value = e.message
    if (!silent) toast.error('加载用量失败：' + e.message)
  } finally {
    loading.value = false
  }
}

function failPercent(it) {
  const total = Number(it.requestsToday) || 0
  const failed = Number(it.failedToday) || 0
  if (!total || !failed) return 0
  return Math.round((failed / total) * 100)
}

async function resetUsage(it, scope) {
  const message =
    scope === 'all'
      ? '确定重置用量吗？\n将重置该 Key 的【全部】用量，累计数据也会被清空，不可恢复。'
      : '确定重置用量吗？\n将重置该 Key 的【今日】用量，累计数据不受影响。'
  if (!window.confirm(message)) return
  const id = it.keyId
  const flag = `${id}:${scope}`
  busy[flag] = true
  try {
    const res = await api('POST', '/usage/reset', { keyId: id, scope })
    toast.success(res.message || (scope === 'all' ? '全部用量已重置' : '今日用量已重置'))
    await loadUsage(true)
    loadStats(true)
  } catch (e) {
    toast.error('重置失败：' + e.message)
  } finally {
    busy[flag] = false
  }
}

onMounted(() => {
  loadUsage()
  loadQuota(true)
  loadAnalytics(true)
})
</script>

<template>
  <div>
    <h2>
      📈 用量
      <span class="probe-pill">统计来自本代理本地计数</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="loading" @click="loadUsage()">
        <span v-if="loading" class="loading"></span>
        {{ loading ? '加载中…' : '🔄 刷新' }}
      </button>
    </h2>

    <div v-if="error" class="result-box result-box-danger">
      <div class="title text-danger">❌ 用量加载失败</div>
      <div class="hint">{{ error }}</div>
    </div>

    <div class="cards">
      <StatCard :value="fmtNum(summary.requestsToday)" label="今日请求" tone="blue" :sub="`累计 ${fmtNum(summary.requestsTotal)}`" />
      <StatCard :value="fmtNum(summary.failedToday)" label="今日失败" tone="red" :sub="`累计失败 ${fmtNum(summary.failedTotal)}`" />
      <StatCard
        :value="`${fmtTokens(summary.cacheReadToday)} / ${fmtTokens(summary.cacheMissToday)}`"
        label="今日输入（缓存命中 / 未命中）"
        tone="green"
        :sub="`命中率 ${fmtPct(summary.cacheHitRateToday)} · 输入合计 ${fmtTokens(summary.inToday)}${summary.cacheWriteToday ? ' · 写缓存 ' + fmtTokens(summary.cacheWriteToday) : ''}`"
      />
      <StatCard
        :value="fmtTokens(summary.outToday)"
        label="今日输出"
        tone="yellow"
        :sub="`累计输入 ${fmtTokens(summary.inTotal)}（命中 ${fmtTokens(summary.cacheReadTotal)}）· 累计输出 ${fmtTokens(summary.outTotal)}`"
      />
      <StatCard :value="fmtNum(items.length)" label="统计中的 Key" tone="green" sub="按 Key 维度统计" />
    </div>

    <div class="section">
      <div class="section-title">
        📈 每 Key 用量
        <span class="probe-pill">请求 = 成功 + 失败；重置只作用于所选范围</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>标签</th>
              <th>来源</th>
              <th>今日请求</th>
              <th>今日成功</th>
              <th>今日失败</th>
              <th>累计请求</th>
              <th>累计失败</th>
              <th>今日输入<br /><span class="text-dim" style="font-size: 10px">缓存命中 / 未命中</span></th>
              <th>今日输出</th>
              <th>累计输入<br /><span class="text-dim" style="font-size: 10px">缓存命中 / 未命中</span></th>
              <th>累计输出</th>
              <th>最后使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!items.length">
              <td colspan="14" class="empty">{{ loading ? '加载中…' : '暂无用量数据' }}</td>
            </tr>
            <tr v-for="it in items" :key="it.keyId">
              <td>
                <span class="key-display">{{ it.keyMasked || '-' }}</span>
                <div class="text-dim" style="font-size: 11px" :title="it.keyId">{{ it.keyId }}</div>
              </td>
              <td>{{ it.label || '-' }}</td>
              <td><span class="model-tag" :class="it.source">{{ SOURCE_LABELS[it.source] || it.source || '-' }}</span></td>
              <td class="mono">{{ fmtNum(it.requestsToday) }}</td>
              <td class="mono text-green">{{ fmtNum(it.successToday) }}</td>
              <td class="mono" :class="it.failedToday ? 'text-danger' : ''">
                {{ fmtNum(it.failedToday) }}
                <span v-if="failPercent(it)" class="text-dim" style="font-size: 10px">({{ failPercent(it) }}%)</span>
              </td>
              <td class="mono">{{ fmtNum(it.requestsTotal) }}</td>
              <td class="mono" :class="it.failedTotal ? 'text-danger' : ''">{{ fmtNum(it.failedTotal) }}</td>
              <td class="mono">
                {{ fmtTokens(it.cacheReadToday) }} / {{ fmtTokens(it.cacheMissToday) }}
                <div class="text-dim" style="font-size: 11px">
                  命中率 {{ fmtPct(it.cacheHitRateToday) }}
                  · 合计 {{ fmtTokens(it.tokensInToday) }}<template v-if="it.cacheWriteToday"> · 写 {{ fmtTokens(it.cacheWriteToday) }}</template>
                </div>
              </td>
              <td class="mono">{{ fmtTokens(it.tokensOutToday) }}</td>
              <td class="mono">
                {{ fmtTokens(it.cacheReadTotal) }} / {{ fmtTokens(it.cacheMissTotal) }}
                <div class="text-dim" style="font-size: 11px">
                  命中率 {{ fmtPct(it.cacheHitRateTotal) }} · 合计 {{ fmtTokens(it.tokensInTotal) }}
                </div>
              </td>
              <td class="mono">{{ fmtTokens(it.tokensOutTotal) }}</td>
              <td class="mono">{{ fmtDateTime(it.lastUsedAt) }}</td>
              <td style="white-space: nowrap">
                <button
                  class="btn btn-sm"
                  type="button"
                  title="重置该 Key 今日用量（累计数据不受影响）"
                  :disabled="!!busy[`${it.keyId}:today`]"
                  @click="resetUsage(it, 'today')"
                >
                  <span v-if="busy[`${it.keyId}:today`]" class="loading"></span>
                  <span v-else>↻ 今日</span>
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  style="margin-left: 6px"
                  type="button"
                  title="重置该 Key 全部用量（不可恢复）"
                  :disabled="!!busy[`${it.keyId}:all`]"
                  @click="resetUsage(it, 'all')"
                >
                  <span v-if="busy[`${it.keyId}:all`]" class="loading"></span>
                  <span v-else>🗑 全部</span>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="section-body" style="padding-top: 12px">
        <div class="hint">
          重置仅影响本代理的本地计数，不会改变上游真实额度；「全部」会同时清空累计数据。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        ⏱ 时间区间统计（本地口径）
        <span class="probe-pill">按本代理的逐请求明细滑动聚合，与官方额度无关</span>
        <button class="btn btn-sm" style="margin-left: auto" type="button" @click="loadAnalytics(false)">🔄 刷新</button>
      </div>
      <div class="section-body">
        <div v-if="!analytics" class="hint">暂无区间数据（需要有请求经过）。</div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>区间</th>
                <th>请求数</th>
                <th>成功率</th>
                <th>输入 / 输出</th>
                <th>缓存命中率</th>
                <th>P95 延迟</th>
                <th>估算成本</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in ANALYTICS_ROWS" :key="row[0]">
                <td>{{ row[1] }}</td>
                <td class="mono">{{ fmtNum(analytics.overview.windows[row[0]].requests) }}</td>
                <td class="mono">{{ fmtPct(analytics.overview.windows[row[0]].successRate) }}</td>
                <td class="mono">{{ fmtTokens(analytics.overview.windows[row[0]].tokensIn) }} / {{ fmtTokens(analytics.overview.windows[row[0]].tokensOut) }}</td>
                <td class="mono">{{ fmtPct(analytics.overview.windows[row[0]].cacheHitRate) }}</td>
                <td class="mono">{{ analytics.overview.windows[row[0]].latencyP95 === null ? '-' : analytics.overview.windows[row[0]].latencyP95 + ' ms' }}</td>
                <td class="mono">
                  <template v-if="analytics.overview.windows[row[0]].costUsd === null">-</template>
                  <template v-else>${{ analytics.overview.windows[row[0]].costUsd }}（估算）</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint" style="margin-top: 8px">
          这些是本地统计（<code>source: local</code>）；成本只在配置了价目表时估算并标注，绝不冒充官方计费。
          内存环形缓冲，最多保留 {{ fmtNum(analytics && analytics.overview.capacity.max) }} 条记录。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        📊 官方额度（官方口径）
        <span class="probe-pill">来自上游额度接口 · 与上方本地计数无关</span>
        <button
          class="btn btn-sm"
          style="margin-left: auto"
          type="button"
          :disabled="!!quotaBusy || quotaLoading"
          @click="refreshQuota(null)"
        >
          <span v-if="quotaBusy === 'all'" class="loading"></span>
          {{ quotaBusy === 'all' ? '刷新中…' : '🔄 刷新全部额度' }}
        </button>
      </div>
      <div class="section-body">
        <div v-if="!quota" class="hint">{{ quotaLoading ? '加载中…' : '尚未采集到官方额度' }}</div>
        <template v-else>
          <div class="hint" style="margin-bottom: 12px">
            当前策略：<strong>{{ quota.strategy }}</strong>
            <template v-if="quota.quotaRouting"> · 额度感知已启用</template>
            <template v-else> · 额度仅作展示，未参与调度（到设置里切换 quota_aware / quota_sticky）</template>
            <template v-if="quota.summary">
              · 可用 <strong>{{ quota.summary.usable }}</strong> / {{ quota.summary.total }}
              · 耗尽 {{ quota.summary.exhausted }}
            </template>
          </div>

          <div v-for="acc in quota.accounts" :key="acc.keyId" class="result-box" style="margin-bottom: 12px">
            <div class="title" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
              <span class="badge" :class="quoteStateTone(acc)">{{ quotaStateText(acc) }}</span>
              <span>{{ acc.label || acc.keyMasked || acc.keyId }}</span>
              <span class="text-dim" style="font-size: 12px">{{ acc.plan || '套餐未知' }}</span>
              <button
                class="btn btn-sm"
                type="button"
                style="margin-left: auto"
                :disabled="!!quotaBusy"
                @click="refreshQuota(acc.keyId)"
              >
                <span v-if="quotaBusy === acc.keyId" class="loading"></span>
                {{ quotaBusy === acc.keyId ? '刷新中…' : '📊 刷新' }}
              </button>
            </div>

            <div v-for="name in ['fiveHour', 'weekly', 'monthly']" :key="name" style="margin-top: 8px">
              <div style="display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 12px">
                <span>
                  {{ name === 'fiveHour' ? '五小时窗口' : name === 'weekly' ? '周窗口' : '月度 / 订阅窗口' }}
                  <span class="text-dim">· {{ qText(qWindow(acc, name)) }}</span>
                </span>
                <span class="text-dim">{{ qResetText(qWindow(acc, name)) }}</span>
              </div>
              <div class="quota-bar">
                <div
                  class="quota-bar-fill"
                  :class="(qPct(qWindow(acc, name)) || 0) >= 100 ? 'is-danger' : (qPct(qWindow(acc, name)) || 0) >= 90 ? 'is-warn' : 'is-ok'"
                  :style="{ width: Math.min(100, qPct(qWindow(acc, name)) || 0) + '%' }"
                ></div>
              </div>
              <div v-if="qPct(qWindow(acc, name)) === null" class="hint" style="font-size: 11px">
                官方没有返回可比对的数值 —— 这里不做任何推算。
              </div>
            </div>

            <div class="hint" style="margin-top: 8px; font-size: 11px">
              <template v-if="acc.forecast && acc.forecast.status === 'ok'">
                🔥 燃烧速度 {{ fmtNum(acc.forecast.burnPerHour) }} / 小时
                <template v-if="acc.forecast.etaAt"> · 预计 {{ fmtDateTime(acc.forecast.etaAt) }} 达到上限</template>
                <template v-if="acc.forecast.willExhaustBeforeReset === true"> · 会在重置前用完</template>
                <template v-else-if="acc.forecast.willExhaustBeforeReset === false"> · 预计能撑到重置</template>
                <template v-if="acc.forecast.confidence === 'low'">（低置信度）</template>
              </template>
              <template v-else-if="acc.forecast && acc.forecast.status === 'unknown'">
                🔥 预测：{{ acc.forecast.reason }}
              </template>
              <template v-else-if="acc.forecast && acc.forecast.status === 'idle'">🔥 预测：这段时间没有消耗</template>
              <template v-else-if="acc.forecast && acc.forecast.status === 'disabled'">🔥 预测未启用</template>
              <br />
              上次成功采集：{{ acc.fetchedAt ? fmtDateTime(acc.fetchedAt) : '从未' }}
              <span v-if="acc.stale" class="text-warn"> · 数据已过期，不是实时值</span>
              <template v-if="acc.partial && acc.partial.length">
                · 部分接口失败：{{ acc.partial.join(' / ') }}
              </template>
              <template v-if="acc.runtime && acc.runtime.lastFailure">
                · 上次查询失败：{{ Object.values(acc.runtime.lastFailure.errors || {}).join(' / ') }}
              </template>
              <template v-if="acc.stateUntil"> · 预计解除：{{ fmtDateTime(acc.stateUntil) }}</template>
              <template v-if="acc.proxy && acc.proxy.mode === 'strict_bind'">
                · 出站：严格固定（{{ acc.proxy.available ? '正常' : acc.proxy.reason }}）
              </template>
            </div>
          </div>
        </template>
        <div class="hint">
          这些数字全部来自官方响应，<strong>不用 token 数推算</strong>；
          缺失字段显示「未知/部分未知」，不会被当成 0。
        </div>
      </div>
    </div>
  </div>
</template>
