<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { loadModels, models, stats, loadStats } from '../store'
import { toast } from '../toast'
import { LEVEL_OPTIONS, STRATEGY_OPTIONS, fmtNum } from '../utils'

const config = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const form = reactive({
  strategy: 'round_robin',
  defaultModel: '',
  zdr: false,
  upstreamProxy: '',
  logLevel: 'info',
  logFile: '',
  apiBase: '',
  projectSlug: '',
  proxyKey: '',
  // 额度 / 调度 / 粘性（新增）
  quotaWarnRatio: 0.9,
  quotaRefreshSec: 300,
  quotaUnknownBlock: false,
  quotaForecast: true,
  accountMaxConcurrency: 0,
  crossAccountRetry: true,
  sessionAffinity: true,
  sessionAffinityTtlMin: 30,
  // 告警
  alertsEnabled: false,
  alertsWebhookUrl: '',
  alertsWebhookFormat: 'generic',
  alertsCooldownMin: 10,
  alertsAllowPrivate: false,
})

// Webhook 地址是**写入型字段**（回读时只有是否配置与主机名，不回显路径里的 token）。
// 留空 = 不修改；想清空请勾“清除已保存地址”。
const webhook = reactive({ clear: false, testing: false })

const pw = reactive({ current: '', next: '', confirm: '' })
const pwBusy = ref(false)
const pwResult = ref('')
const pwOk = ref(false)
const alertStatus = ref(null)

async function testWebhook() {
  webhook.testing = true
  try {
    const res = await api('POST', '/alerts/test', {})
    toast.success(res.message || '测试通知已发送')
  } catch (e) {
    toast.error('发送测试通知失败：' + e.message)
  } finally {
    webhook.testing = false
  }
}

const modelOptions = computed(() => {
  const list = (models.list || []).map((m) => m.id)
  if (form.defaultModel && !list.includes(form.defaultModel)) list.unshift(form.defaultModel)
  return list
})

const version = computed(() => (config.value && config.value.version) || (stats.data && stats.data.version) || '-')

function applyConfig(cfg) {
  if (!cfg) return
  form.strategy = cfg.strategy || 'round_robin'
  form.defaultModel = cfg.defaultModel || ''
  form.zdr = !!cfg.zdr
  form.upstreamProxy = cfg.upstreamProxy || ''
  form.logLevel = cfg.logLevel || 'info'
  form.logFile = cfg.logFile || ''
  form.apiBase = cfg.apiBase || ''
  form.projectSlug = cfg.projectSlug || ''
  form.proxyKey = ''
  const q = cfg.quota || {}
  form.quotaWarnRatio = q.warnRatio ?? 0.9
  form.quotaRefreshSec = Math.round((q.refreshIntervalMs ?? 300000) / 1000)
  form.quotaUnknownBlock = !!q.unknownBlock
  form.quotaForecast = q.forecast !== false
  const sch = cfg.scheduling || {}
  form.accountMaxConcurrency = sch.accountMaxConcurrency ?? 0
  form.crossAccountRetry = sch.crossAccountRetry !== false
  const aff = cfg.sessionAffinity || {}
  form.sessionAffinity = aff.enabled !== false
  form.sessionAffinityTtlMin = Math.round((aff.ttlMs ?? 1800000) / 60000)
  const al = cfg.alerts || {}
  form.alertsEnabled = !!al.enabled
  form.alertsWebhookFormat = al.format || 'generic'
  form.alertsCooldownMin = Math.round((al.cooldownMs ?? 600000) / 60000)
  form.alertsAllowPrivate = !!al.allowPrivate
  form.alertsWebhookUrl = ''
  webhook.clear = false
  alertStatus.value = al
}

async function loadConfig() {
  loading.value = true
  try {
    const { data } = await api('GET', '/config')
    config.value = data || null
    applyConfig(config.value)
    error.value = ''
  } catch (e) {
    error.value = e.message
    toast.error('加载配置失败：' + e.message)
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    const payload = {
      strategy: form.strategy,
      defaultModel: form.defaultModel,
      zdr: !!form.zdr,
      upstreamProxy: form.upstreamProxy,
      logLevel: form.logLevel,
      logFile: form.logFile,
      apiBase: form.apiBase,
      projectSlug: form.projectSlug,
    }
    // proxyKey 为写入型字段：留空表示不修改
    if (form.proxyKey) payload.proxyKey = form.proxyKey

    // 额度 / 调度 / 粘性
    payload.quotaWarnRatio = Number(form.quotaWarnRatio)
    payload.quotaRefreshIntervalMs = Math.round(Number(form.quotaRefreshSec) * 1000)
    payload.quotaUnknownBlock = !!form.quotaUnknownBlock
    payload.quotaForecast = !!form.quotaForecast
    payload.accountMaxConcurrency = Number(form.accountMaxConcurrency)
    payload.crossAccountRetry = !!form.crossAccountRetry
    payload.sessionAffinity = !!form.sessionAffinity
    payload.sessionAffinityTtlMs = Math.round(Number(form.sessionAffinityTtlMin) * 60000)

    // 告警：URL 只在真的填了新值（或主动清除）时下发
    payload.alertsEnabled = !!form.alertsEnabled
    payload.alertsWebhookFormat = form.alertsWebhookFormat
    payload.alertsCooldownMs = Math.round(Number(form.alertsCooldownMin) * 60000)
    payload.alertsAllowPrivate = !!form.alertsAllowPrivate
    if (webhook.clear) payload.alertsWebhookUrl = ''
    else if (form.alertsWebhookUrl.trim()) payload.alertsWebhookUrl = form.alertsWebhookUrl.trim()
    const res = await api('POST', '/config/update', payload)
    if (res.data) {
      config.value = res.data
      applyConfig(res.data)
    }
    toast.success(res.message || '配置已保存')
  } catch (e) {
    toast.error('保存失败：' + e.message)
  } finally {
    saving.value = false
  }
}

async function changePassword() {
  const current = pw.current
  const next = pw.next
  pwResult.value = ''
  pwOk.value = false
  if (!current || !next) {
    pwResult.value = '请填写当前密码和新密码'
    return
  }
  if (next !== pw.confirm) {
    pwResult.value = '两次输入的新密码不一致'
    return
  }
  if (next.length < 8) {
    pwResult.value = '新密码至少 8 位'
    return
  }
  pwBusy.value = true
  try {
    // 该接口用 401 表示「当前密码错误」，不能触发全局跳登录
    const res = await api('POST', '/password', { current, new: next }, { skipAuthRedirect: true })
    pwOk.value = true
    pwResult.value = '✅ ' + (res.message || '密码已更新')
    pw.current = ''
    pw.next = ''
    pw.confirm = ''
    toast.success(res.message || '密码已更新')
  } catch (e) {
    pwResult.value = '❌ ' + e.message
    toast.error(e.message)
  } finally {
    pwBusy.value = false
  }
}

onMounted(() => {
  loadConfig()
  loadModels()
  if (!stats.loaded) loadStats()
})
</script>

<template>
  <div>
    <h2>
      ⚙️ 设置
      <span class="probe-pill">写入 data/settings.json（后台设置层，原子替换）</span>
      <button class="btn btn-sm" style="margin-left: auto" type="button" :disabled="loading" @click="loadConfig">
        <span v-if="loading" class="loading"></span>
        {{ loading ? '加载中…' : '🔄 重新加载' }}
      </button>
    </h2>

    <div v-if="error" class="result-box result-box-danger">
      <div class="title text-danger">❌ 配置加载失败</div>
      <div class="hint">{{ error }}</div>
    </div>

    <div class="section">
      <div class="section-title">🔧 运行配置</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>轮询策略</label>
            <select v-model="form.strategy">
              <option v-for="opt in STRATEGY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>默认测试模型</label>
            <select v-model="form.defaultModel">
              <option value="">（未设置 —— 自动取第一个启用的模型）</option>
              <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </div>
        <div class="hint" style="margin-bottom: 10px">
          「仪表盘 → 上游连通性测试」的模型下拉会**自动预选**这里设置的模型；
          你仍然可以在下拉里临时选别的模型来测。未设置时取第一个**启用**的模型。
          另外，客户端调用 <code>/v1/*</code> 时如果没有指定 <code>model</code>，也会用它作为兜底。
        </div>

        <div class="form-row">
          <div class="field">
            <label>上游地址 apiBase</label>
            <input v-model="form.apiBase" type="text" class="mono" placeholder="https://api.commandcode.ai" />
          </div>
          <div class="field">
            <label>项目标识 projectSlug</label>
            <input v-model="form.projectSlug" type="text" placeholder="cc-proxy" />
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>上游代理 upstreamProxy</label>
            <input v-model="form.upstreamProxy" type="text" class="mono" placeholder="http://127.0.0.1:7890（留空为直连）" />
          </div>
          <div class="field">
            <label>代理口令 proxyKey（留空表示不修改）</label>
            <input
              v-model="form.proxyKey"
              type="password"
              placeholder="设置后用于客户端访问代理"
              autocomplete="new-password"
            />
          </div>
        </div>

        <div class="form-row">
          <div class="field">
            <label>日志级别 logLevel</label>
            <select v-model="form.logLevel">
              <option v-for="opt in LEVEL_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>日志文件 logFile</label>
            <input v-model="form.logFile" type="text" class="mono" placeholder="留空表示仅输出到控制台" />
          </div>
        </div>

        <div class="form-row">
          <div class="field" style="flex: 0 0 auto">
            <label>零数据保留 zdr</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.zdr" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.zdr ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="button" :disabled="saving || loading" @click="saveConfig">
            <span v-if="saving" class="loading"></span>
            {{ saving ? '保存中…' : '💾 保存配置' }}
          </button>
        </div>
        <div class="hint">
          修改 <strong>port</strong> / <strong>host</strong> 需重启进程后生效（本页不修改这两项）。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        📊 官方额度与调度
        <span class="probe-pill">额度采集是后台任务，不会在推理热路径上查额度</span>
      </div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>额度警戒阈值（0~1）</label>
            <input v-model.number="form.quotaWarnRatio" type="number" min="0.1" max="1" step="0.05" />
          </div>
          <div class="field">
            <label>额度刷新间隔（秒）</label>
            <input v-model.number="form.quotaRefreshSec" type="number" min="30" max="86400" step="30" />
          </div>
          <div class="field">
            <label>单账号并发上限</label>
            <input v-model.number="form.accountMaxConcurrency" type="number" min="0" max="100" />
          </div>
        </div>
        <div class="hint" style="margin-top: 0; margin-bottom: 14px">
          警戒阈值是<strong>软阈值</strong>：到 90% 只降低优先级，不封禁；真正的封禁只看官方是否明确耗尽。
          单账号并发上限填 0 表示不限。
        </div>

        <div class="form-row">
          <div class="field">
            <label>额度未知时</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.quotaUnknownBlock" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.quotaUnknownBlock ? '停止派发' : '照常派发' }}</span>
            </label>
          </div>
          <div class="field">
            <label>额度燃烧预测</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.quotaForecast" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.quotaForecast ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
          <div class="field">
            <label>会话粘性</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.sessionAffinity" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.sessionAffinity ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
        </div>
        <div class="hint" style="margin-top: 0; margin-bottom: 14px">
          额度未知默认<strong>不停派</strong>（未知 ≠ 已满，一刀切封禁等于自己制造停服）；
          会话粘性只在 <code>quota_sticky</code> 策略下生效，账号不可用时优先切号。
        </div>

        <div class="form-row" style="margin-bottom: 6px">
          <div class="field">
            <label>跨账号重试</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.crossAccountRetry" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.crossAccountRetry ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
          <div class="field">
            <label>会话映射 TTL（分钟）</label>
            <input v-model.number="form.sessionAffinityTtlMin" type="number" min="1" max="1440" />
          </div>
        </div>
        <div class="hint" style="margin-top: 0">
          跨账号重试只在「下游尚未收到任何内容」时生效；已输出 SSE / 工具调用后绝不重放。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        🔔 告警通知
        <span class="probe-pill">默认关闭；只发事件，不发凭据与正文</span>
      </div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>Webhook 告警</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.alertsEnabled" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.alertsEnabled ? '已启用' : '已关闭' }}</span>
            </label>
          </div>
          <div class="field">
            <label>格式</label>
            <select v-model="form.alertsWebhookFormat">
              <option value="generic">通用 JSON（可接 Telegram 中转）</option>
              <option value="feishu">飞书</option>
              <option value="dingtalk">钉钉</option>
              <option value="slack">Slack</option>
            </select>
          </div>
          <div class="field">
            <label>去重窗口（分钟）</label>
            <input v-model.number="form.alertsCooldownMin" type="number" min="1" max="1440" />
          </div>
        </div>

        <div class="form-row">
          <div class="field" style="flex: 1 1 100%">
            <label>
              Webhook 地址
              <span v-if="alertStatus && alertStatus.webhookConfigured" class="badge ok" style="margin-left: 6px">
                已配置：{{ alertStatus.webhookHost }}
              </span>
            </label>
            <input
              v-model="form.alertsWebhookUrl"
              type="text"
              class="mono"
              :placeholder="alertStatus && alertStatus.webhookConfigured ? '已保存（留空则不修改）' : 'https://…'"
              autocomplete="off"
            />
          </div>
        </div>
        <div class="hint" style="margin-top: 0; margin-bottom: 14px">
          出于安全考虑后台不回显完整地址（里面常带 hook token），留空表示不修改。
          指向本机/内网地址默认会被拒绝（防 SSRF），确需放行请打开下方开关。
        </div>

        <div class="form-row" style="margin-bottom: 6px">
          <div class="field">
            <label>已保存地址</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="webhook.clear" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ webhook.clear ? '保存时清除' : '保持不变' }}</span>
            </label>
          </div>
          <div class="field">
            <label>内网地址</label>
            <label class="inline-flex" style="cursor: pointer">
              <span class="switch">
                <input v-model="form.alertsAllowPrivate" type="checkbox" />
                <span class="slider"></span>
              </span>
              <span style="font-size: 12.5px">{{ form.alertsAllowPrivate ? '允许' : '禁止' }}</span>
            </label>
          </div>
          <div class="field" style="flex: 0 0 auto">
            <button class="btn btn-sm" type="button" :disabled="webhook.testing" @click="testWebhook">
              <span v-if="webhook.testing" class="loading"></span>
              {{ webhook.testing ? '发送中…' : '📨 发送测试通知' }}
            </button>
          </div>
        </div>
        <div class="hint" style="margin-top: 0">
          测试通知会跳过事件去重，但仍然受地址校验与超时约束；发送结果不影响推理服务。
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">ℹ️ 运行环境（只读）</div>
      <div class="section-body">
        <dl class="kv">
          <dt>监听地址</dt>
          <dd class="mono">{{ (config && config.host) || '-' }}:{{ (config && config.port) || '-' }}</dd>
          <dt>引擎版本</dt>
          <dd class="mono">{{ version }}</dd>
          <dt>数据目录</dt>
          <dd class="mono">{{ (config && config.dataDir) || '-' }}</dd>
          <dt>配置文件</dt>
          <dd class="mono">{{ (config && config.configPath) || '-' }}</dd>
          <dt>代理口令</dt>
          <dd>
            <span class="badge" :class="config && config.proxyKeySet ? 'ok' : 'muted'">
              {{ config && config.proxyKeySet ? '已设置' : '未设置' }}
            </span>
          </dd>
          <dt>使用上游模型清单</dt>
          <dd>{{ config ? (config.useProviderModels ? '是' : '否') : '-' }}</dd>
          <dt>按套餐过滤模型</dt>
          <dd>{{ config ? (config.useProviderModelsWithPlanFilter ? '是' : '否') : '-' }}</dd>
          <dt>服务端 web_search</dt>
          <dd>{{ config ? (config.webSearch ? '由代理代执行' : '剥掉') : '-' }}</dd>
          <dt>出站代理池</dt>
          <dd>
            <router-link to="/proxies">🌐 出站代理池</router-link>
            <span class="hint" style="margin-left: 6px">
              config.json {{ config && config.proxies ? config.proxies.length : 0 }} 条
              <template v-if="config && config.proxyFile"> · 文件 {{ config.proxyFile }}</template>
            </span>
          </dd>
          <dt>模型刷新间隔</dt>
          <dd class="mono">
            {{ config && config.modelRefreshIntervalMs ? fmtNum(Math.round(config.modelRefreshIntervalMs / 1000)) + ' 秒' : '-' }}
          </dd>
        </dl>
      </div>
    </div>

    <div class="section">
      <div class="section-title">🔐 修改后台密码</div>
      <div class="section-body">
        <div class="form-row">
          <div class="field">
            <label>当前密码</label>
            <input v-model="pw.current" type="password" autocomplete="current-password" />
          </div>
          <div class="field">
            <label>新密码</label>
            <input v-model="pw.next" type="password" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>确认新密码</label>
            <input v-model="pw.confirm" type="password" autocomplete="new-password" @keyup.enter="changePassword" />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-success" type="button" :disabled="pwBusy" @click="changePassword">
            <span v-if="pwBusy" class="loading"></span>
            {{ pwBusy ? '提交中…' : '💾 修改密码' }}
          </button>
          <span v-if="pwResult" :class="pwOk ? 'text-green' : 'text-danger'" style="font-size: 12.5px">{{ pwResult }}</span>
        </div>
        <div class="hint">
          修改后密码会持久化保存，并立即使其它登录会话失效；新密码至少 8 位。
        </div>
      </div>
    </div>
  </div>
</template>
