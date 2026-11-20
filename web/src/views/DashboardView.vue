<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'
import {
  keysState,
  loadKeys,
  loadModels,
  loadStats,
  models,
  now,
  loadTestPrompt,
  refreshModels,
  resetTestPrompt,
  startBatch,
  stats,
  testMessagePayload,
  testPrompt,
} from '../store'
import { toast } from '../toast'
import {
  STRATEGY_LABELS,
  fmtDateTime,
  fmtLatency,
  fmtNum,
  fmtPct,
  fmtTokens,
  fmtResetTime,
  fmtUptime,
} from '../utils'
import StatCard from '../components/StatCard.vue'
import TestResultBox from '../components/TestResultBox.vue'

const router = useRouter()

const testMode = ref('model')
const testModel = ref('')
const testKeyId = ref('')
const testKeyInput = ref('')
const testing = ref(false)
const testResult = ref(null)
const refreshing = ref(false)
const statsAt = ref(0)

let statsTimer = null

const d = computed(() => stats.data || {})
const keysInfo = computed(() => d.value.keys || {})
const modelsInfo = computed(() => d.value.models || {})
const requests = computed(() => d.value.requests || {})
const tokens = computed(() => d.value.tokens || {})
const admin = computed(() => d.value.admin || {})
const storageInfo = computed(() => admin.value.storage || { mode: 'file', redis: {} })
const clientKeys = computed(() => d.value.clientKeys || { total: 0, enabled: 0 })
const protection = computed(() => d.value.protection || 'off')

// 官方额度概览
const quota = ref(null)

async function loadQuota(silent = true) {
  try {
    const res = await api('GET', '/quota')
    quota.value = res.data || null
  } catch (e) {
    if (!silent) toast.error('加载官方额度失败：' + e.message)
  }
}

function qPct(acc, name) {
  const w = acc && acc.windows && acc.windows[name]
  if (!w || w.percentUsed === null || w.percentUsed === undefined) return null
  return Math.round(w.percentUsed * 1000) / 10
}

const quotaAccounts = computed(() => quota.value?.accounts || [])

// 五小时额度卡片（高频动态额度）
const fiveHourQuota = computed(() => {
  if (!quotaAccounts.value.length) {
    return {
      value: '-',
      sub: '未配置上游 Key 或尚未采集',
      tone: 'muted',
    }
  }
  const list = quotaAccounts.value
  let maxPct = null
  let earliestReset = null
  let exhausted = 0
  let warning = 0

  for (const acc of list) {
    const w = acc.windows?.fiveHour
    if (w) {
      if (typeof w.percentUsed === 'number') {
        const pct = Math.round(w.percentUsed * 1000) / 10
        if (maxPct === null || pct > maxPct) maxPct = pct
      }
      if (w.resetAtMs) {
        if (!earliestReset || w.resetAtMs < earliestReset) earliestReset = w.resetAtMs
      }
    }
    if (acc.state === 'quota_exhausted') exhausted++
    else if (acc.state === 'quota_warning') warning++
  }

  let tone = 'green'
  if (exhausted > 0) tone = 'red'
  else if (warning > 0 || (maxPct !== null && maxPct >= 90)) tone = 'yellow'

  const value = maxPct !== null ? `${maxPct}%` : (exhausted > 0 ? '已耗尽' : '充足')
  let resetPart = ''
  if (earliestReset) {
    const sec = Math.max(0, Math.round((earliestReset - now.value) / 1000))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const cd = h > 0 ? `${h}h${m}m后` : `${m}m后`
    resetPart = `重置：${cd}（${fmtResetTime(earliestReset)}）`
  }

  const sub = [
    `可用 ${list.length - exhausted} / ${list.length}`,
    resetPart,
  ].filter(Boolean).join(' · ')

  return { value, sub, tone }
})

// 周/月度长期额度卡片
const longTermQuota = computed(() => {
  if (!quotaAccounts.value.length) {
    return {
      value: '-',
      sub: '未配置上游 Key 或尚未采集',
      tone: 'muted',
    }
  }
  const list = quotaAccounts.value
  let maxPct = null
  let earliestReset = null

  for (const acc of list) {
    const w = acc.windows?.monthly || acc.windows?.weekly
    if (w) {
      if (typeof w.percentUsed === 'number') {
        const pct = Math.round(w.percentUsed * 1000) / 10
        if (maxPct === null || pct > maxPct) maxPct = pct
      }
      if (w.resetAtMs) {
        if (!earliestReset || w.resetAtMs < earliestReset) earliestReset = w.resetAtMs
      }
    }
  }

  const tone = (maxPct !== null && maxPct >= 90) ? 'yellow' : 'green'
  const value = maxPct !== null ? `${maxPct}%` : '充足'
  const resetPart = earliestReset ? `重置：${fmtResetTime(earliestReset)}` : '配额充足'
  const sub = `${resetPart} · 账号 ${list.length} 个`

  return { value, sub, tone }
})

// 上游 Key 池状态（整合可用、总数、冷却、异常与调度策略）
const keyPoolStatus = computed(() => {
  const total = keysInfo.value.total || 0
  const enabled = keysInfo.value.enabled || 0
  const cooldown = keysInfo.value.cooldown || 0
  const unhealthy = keysInfo.value.unhealthy || 0
  const tone = unhealthy > 0 ? 'red' : (cooldown > 0 ? 'yellow' : (enabled > 0 ? 'green' : 'muted'))
  return {
    value: `${fmtNum(enabled)} / ${fmtNum(total)}`,
    sub: `轮询：${strategyText.value} · 冷却 ${fmtNum(cooldown)} · 异常 ${fmtNum(unhealthy)}`,
    tone,
  }
})

const uptimeText = computed(() => {
  const base = Number(d.value.uptimeSec)
  if (!Number.isFinite(base)) return '-'
  const extra = statsAt.value ? (now.value - statsAt.value) / 1000 : 0
  return fmtUptime(base + Math.max(0, extra))
})

const strategyText = computed(() => STRATEGY_LABELS[d.value.strategy] || d.value.strategy || '-')

const modelOptions = computed(() => models.list || [])
const keyOptions = computed(() => keysState.list || [])

// 下拉里只列**启用**的模型：被禁用的模型测了也是 400，列出来徒增困惑
const selectableModels = computed(() => modelOptions.value.filter((m) => m.enabled !== false))

/**
 * 预选测试模型：
 *  1) 优先用「设置」里配的默认测试模型（models.defaultModel，后端已保证它是启用中的最新值）；
 *  2) 没配就取第一个启用的模型；
 *  3) 用户在下面自己改过就不覆盖（只有当前值不在可选列表里时才重新预选）。
 */
function preselectTestModel() {
  const list = selectableModels.value
  if (!list.length) return
  const preferred = models.defaultModel
  const stillValid = testModel.value && list.some((m) => m.id === testModel.value)
  if (stillValid) return
  testModel.value = (preferred && list.some((m) => m.id === preferred)) ? preferred : list[0].id
}

watch(
  () => [models.list.length, models.defaultModel],
  preselectTestModel,
  { immediate: true },
)

watch(
  () => stats.data,
  (v) => {
    if (v) statsAt.value = Date.now()
  },
)

async function doRefreshStats() {
  await Promise.all([loadStats(true), loadQuota(true)])
}

async function doRefreshModels() {
  refreshing.value = true
  try {
    await refreshModels()
    toast.success(`模型清单已刷新：共 ${models.list.length} 个模型`)
  } catch (e) {
    toast.error('刷新模型失败：' + e.message)
  } finally {
    refreshing.value = false
  }
}

async function doBatchTest() {
  if (!window.confirm('确定对全部模型发起批量测试吗？\n批量测试会向上游逐个发送真实请求。')) return
  try {
    await startBatch({ concurrency: 4 })
    toast.success('批量测试已启动')
    router.push({ name: 'models' })
  } catch (e) {
    toast.error('启动批量测试失败：' + e.message)
  }
}

async function runTest() {
  if (testing.value) return
  if (testMode.value === 'model') {
    if (!testModel.value) {
      toast.error('请选择测试模型')
      return
    }
  } else if (!testKeyInput.value.trim() && !testKeyId.value) {
    toast.error('请选择或输入要测试的 Key')
    return
  }

  testing.value = true
  testResult.value = null
  try {
    let data = null
    if (testMode.value === 'model') {
      const body = { model: testModel.value, ...testMessagePayload() }
      if (testKeyId.value) body.keyId = testKeyId.value
      const res = await api('POST', '/models/test', body)
      data = res.data
    } else {
      const raw = testKeyInput.value.trim()
      const body = { ...(raw ? { key: raw } : { id: testKeyId.value }), ...testMessagePayload() }
      const res = await api('POST', '/keys/test', body)
      data = res.data
    }
    testResult.value = data || null
    if (!data) {
      toast.info('测试完成，但服务端未返回结果')
      return
    }
    if (data.ok) {
      toast.success(`链路正常（${fmtLatency(data.latencyMs)}）`)
    } else if (data.category === 'not_in_plan') {
      toast.warning('Key 有效，但该模型不在套餐内')
    } else {
      toast.error(`测试失败：${data.message || data.category || '未知错误'}`)
    }
  } catch (e) {
    toast.error('测试失败：' + e.message)
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  loadStats()
  loadModels()
  loadKeys()
  loadQuota()
  loadTestPrompt()
  statsTimer = setInterval(() => {
    loadStats(true)
    loadQuota(true)
  }, 10000)
})

onUnmounted(() => {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
})
</script>

<template>
  <div>
    <h2>
      📊 仪表盘
      <span class="probe-pill">每 10 秒自动刷新</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" @click="doRefreshStats">🔄 刷新</button>
    </h2>

    <div v-if="stats.error" class="result-box result-box-danger">
      <div class="title text-danger">❌ 统计加载失败</div>
      <div class="hint">{{ stats.error }}</div>
    </div>

    <div class="cards">
      <StatCard :value="fiveHourQuota.value" label="五小时额度（最高占用）" :tone="fiveHourQuota.tone" :sub="fiveHourQuota.sub" />
      <StatCard :value="longTermQuota.value" label="周/月度额度" :tone="longTermQuota.tone" :sub="longTermQuota.sub" />
      <StatCard :value="keyPoolStatus.value" label="上游 Key 池（可用/总数）" :tone="keyPoolStatus.tone" :sub="keyPoolStatus.sub" />
      <StatCard
        :value="`${fmtNum(clientKeys.enabled)} / ${fmtNum(clientKeys.total)}`"
        label="2API 客户端 Key"
        :tone="clientKeys.total > 0 ? 'blue' : 'yellow'"
        :sub="`访问保护：${protection === 'on' ? '已启用（必须凭证）' : '未启用（免鉴权）'}`"
      />
      <StatCard :value="fmtNum(requests.today)" label="今日请求" tone="blue" :sub="`累计 ${fmtNum(requests.total)}`" />
      <StatCard :value="fmtNum(requests.failedToday)" label="今日失败" tone="red" :sub="`进行中 ${fmtNum(requests.inflight)}`" />
      <StatCard
        :value="`${fmtTokens(tokens.cacheReadToday)} / ${fmtTokens(tokens.cacheMissToday)} / ${fmtTokens(tokens.outToday)}`"
        label="今日 Tokens（命中 / 未命中 / 输出）"
        tone="yellow"
        :sub="`前两项是输入拆分（命中率 ${fmtPct(tokens.cacheHitRateToday)}，输入合计 ${fmtTokens(tokens.inToday)}）· 输出 ${fmtTokens(tokens.outToday)} · 累计 ${fmtTokens(tokens.inTotal)} / ${fmtTokens(tokens.outTotal)}`"
      />
      <StatCard
        :value="fmtNum(modelsInfo.total)"
        label="模型总数"
        tone="green"
        :sub="`同步于 ${fmtDateTime(modelsInfo.lastSyncAt)}`"
      />
    </div>

    <div class="section">
      <div class="section-title">📋 快捷操作</div>
      <div class="section-body">
        <div class="form-actions">
          <button class="btn btn-primary" type="button" @click="router.push({ name: 'keys' })">➕ 去添加 Key</button>
          <button class="btn" type="button" :disabled="refreshing" @click="doRefreshModels">
            <span v-if="refreshing" class="loading"></span>
            {{ refreshing ? '刷新中…' : '🔄 刷新模型' }}
          </button>
          <button class="btn btn-success" type="button" @click="doBatchTest">
            🧪 批量测试
          </button>
        </div>
        <div class="hint">
          批量测试会在「模型」页显示实时进度与分类汇总结果。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        🧪 上游连通性测试
        <span class="probe-pill">向本代理发起一次真实请求，验证整个链路是否正常</span>
      </div>
      <div class="tabs">
        <button class="tab" :class="{ active: testMode === 'model' }" type="button" @click="testMode = 'model'">
          按模型测试
        </button>
        <button class="tab" :class="{ active: testMode === 'key' }" type="button" @click="testMode = 'key'">
          按 Key 测试
        </button>
      </div>
      <div class="section-body">
        <div v-if="testMode === 'model'" class="form-row">
          <div class="field">
            <label>测试模型</label>
            <select v-model="testModel">
              <option v-if="!selectableModels.length" value="">（没有启用的模型，请先同步并启用）</option>
              <option v-for="m in selectableModels" :key="m.id" :value="m.id">
                {{ m.id }}{{ m.id === models.defaultModel ? '（默认）' : '' }}
              </option>
            </select>
          </div>
          <div class="field">
            <label>使用 Key（可选）</label>
            <select v-model="testKeyId">
              <option value="">自动选择可用 Key</option>
              <option v-for="k in keyOptions" :key="k.id" :value="k.id">
                {{ k.label || k.keyMasked }}（{{ k.keyMasked }}）
              </option>
            </select>
          </div>
        </div>

        <div v-else class="form-row">
          <div class="field">
            <label>选择已保存的 Key</label>
            <select v-model="testKeyId" :disabled="!!testKeyInput.trim()">
              <option value="">（未选择）</option>
              <option v-for="k in keyOptions" :key="k.id" :value="k.id">
                {{ k.label || k.keyMasked }}（{{ k.keyMasked }}）
              </option>
            </select>
          </div>
          <div class="field">
            <label>或直接输入 Key（可选）</label>
            <input v-model="testKeyInput" type="text" placeholder="user_…（填写后优先使用）" class="mono" />
          </div>
        </div>

        <div class="form-row">
          <div class="field" style="flex: 1 1 100%">
            <label>
              测试消息
              <button class="btn btn-sm" type="button" style="margin-left: 8px" @click="resetTestPrompt">
                ↺ 恢复默认
              </button>
            </label>
            <input
              v-model="testPrompt.message"
              type="text"
              :maxlength="testPrompt.maxLen"
              placeholder="留空则使用默认提示词"
            />
            <div class="hint" style="margin-top: 6px">
              默认与同类实现一致：<code>{{ testPrompt.defaultMessage }}</code>；可改成任意内容用于验证链路。
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="button" :disabled="testing" @click="runTest">
            <span v-if="testing" class="loading"></span>
            {{ testing ? '测试中…' : '🚀 发送测试请求' }}
          </button>
        </div>

        <TestResultBox v-if="testResult" :result="testResult" />
        <div v-else class="hint">选择模型或 Key 后点击按钮，将向上游发起一次真实的最小请求。</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">ℹ️ 运行信息</div>
      <div class="section-body">
        <dl class="kv">
          <dt>引擎版本</dt>
          <dd class="mono">{{ d.version || '-' }}</dd>
          <dt>运行时长</dt>
          <dd class="mono">{{ uptimeText }}</dd>
          <dt>轮询策略</dt>
          <dd>{{ strategyText }}</dd>
          <dt>上游地址</dt>
          <dd class="mono">{{ admin.address || '-' }}</dd>
          <dt>持久化存储</dt>
          <dd>
            <template v-if="storageInfo.mode === 'redis'">
              <span class="badge" :class="storageInfo.redis?.connected ? 'ok' : 'warn'">
                {{ storageInfo.redis?.connected ? 'Redis 已连接' : 'Redis 待重连' }}
              </span>
              <span class="mono" style="margin-left: 8px">{{ storageInfo.redis?.url || '-' }}</span>
              <span v-if="storageInfo.redis?.hashKey" class="hint" style="margin-left: 6px">
                ({{ storageInfo.redis.hashKey }} · {{ fmtNum(storageInfo.redis.keysCount || 0) }} 项)
              </span>
            </template>
            <span v-else class="badge muted">本地文件</span>
          </dd>
          <dt>数据目录</dt>
          <dd class="mono">{{ admin.dataDir || '-' }}</dd>
          <dt>模型上次同步</dt>
          <dd class="mono">{{ fmtDateTime(modelsInfo.lastSyncAt) }}</dd>
          <dt>模型同步状态</dt>
          <dd>
            <span class="badge" :class="modelsInfo.syncing ? 'warn' : 'ok'">
              {{ modelsInfo.syncing ? '同步中' : '空闲' }}
            </span>
          </dd>
          <dt>进行中请求</dt>
          <dd class="mono">{{ fmtNum(requests.inflight) }}</dd>
        </dl>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        📊 账号额度概览
        <span class="probe-pill">官方口径 · 后台定时刷新</span>
        <button class="btn btn-sm" style="margin-left: auto" type="button" @click="loadQuota(false)">🔄 刷新</button>
      </div>
      <div class="section-body">
        <div v-if="!quota" class="hint">尚未采集到官方额度（首次采集在启动后进行）。</div>
        <template v-else>
          <div class="cards" style="margin-bottom: 12px">
            <StatCard
              :value="`${fmtNum(quota.summary && quota.summary.usable)} / ${fmtNum(quota.summary && quota.summary.total)}`"
              label="可参与调度的账号"
              tone="green"
              :sub="`额度耗尽 ${fmtNum(quota.summary && quota.summary.exhausted)} · 未知 ${fmtNum(quota.summary && quota.summary.unknown)}`"
            />
            <StatCard
              :value="quota.quotaRouting ? '已启用' : '未启用'"
              label="额度感知调度"
              :tone="quota.quotaRouting ? 'blue' : 'yellow'"
              :sub="`当前策略：${STRATEGY_LABELS[quota.strategy] || quota.strategy}`"
            />
            <StatCard
              :value="fmtNum(quota.summary && quota.summary.proxyDown)"
              label="因代理不可用而停派"
              tone="red"
              sub="严格绑定下代理故障不会自动换出口"
            />
            <StatCard
              :value="(quota.affinity && quota.affinity.size) || 0"
              label="会话映射数"
              tone="yellow"
              :sub="`命中率 ${fmtPct(quota.affinity && quota.affinity.hitRate)}`"
            />
          </div>

          <div v-for="acc in quota.accounts" :key="acc.keyId" style="margin-bottom: 8px">
            <div style="display: flex; justify-content: space-between; font-size: 12px">
              <span>
                <strong>{{ acc.label || acc.keyMasked || acc.keyId }}</strong>
                <span class="text-dim"> · {{ acc.plan || '套餐未知' }} · {{ acc.state }}</span>
                <span v-if="acc.stale" class="text-warn"> · 数据过期</span>
                <span v-if="acc.proxy && acc.proxy.mode === 'strict_bind'" class="badge" :class="acc.proxy.available ? 'ok' : 'danger'" style="margin-left: 6px">
                  严格固定{{ acc.proxy.available ? '' : '（不可用）' }}
                </span>
              </span>
              <span class="text-dim">
                5h {{ qPct(acc, 'fiveHour') === null ? '未知' : qPct(acc, 'fiveHour') + '%' }}
                · 周 {{ qPct(acc, 'weekly') === null ? '未知' : qPct(acc, 'weekly') + '%' }}
              </span>
            </div>
            <div class="quota-bar">
              <div
                class="quota-bar-fill"
                :class="(qPct(acc, 'fiveHour') || 0) >= 100 ? 'is-danger' : (qPct(acc, 'fiveHour') || 0) >= 90 ? 'is-warn' : 'is-ok'"
                :style="{ width: Math.min(100, qPct(acc, 'fiveHour') || 0) + '%' }"
              ></div>
            </div>
          </div>

          <div v-if="quota.events && quota.events.length" style="margin-top: 14px">
            <div class="hint" style="margin-bottom: 6px"><strong>最近事件</strong>（额度耗尽 / 恢复 / 自动切号）</div>
            <div v-for="(ev, i) in quota.events.slice(0, 5)" :key="i" class="mono" style="font-size: 11px; margin-bottom: 2px">
              <span class="text-dim">{{ fmtDateTime(ev.at) }}</span>
              · {{ ev.type === 'quota_exhausted' ? '额度耗尽' : ev.type === 'quota_recovered' ? '额度恢复' : ev.type === 'account_switched' ? '自动切号' : ev.type }}
              <template v-if="ev.keyId"> · {{ ev.keyId }}</template>
              <template v-if="ev.from"> · {{ ev.from }} → {{ ev.to }}</template>
              <template v-if="ev.reason"> · {{ ev.reason }}</template>
            </div>
          </div>

          <div class="hint">
            额度为官方接口返回的真实值；缺失字段显示「未知」，不用 token 数推算。
            详细窗口、重置倒计时与燃烧预测见 <router-link to="/usage">📈 用量 → 官方额度</router-link>。
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
