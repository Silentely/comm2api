<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../api'
import { toast } from '../toast'

const props = defineProps({
  apiKey: {
    type: Object,
    required: true,
  },
  initialPlainKey: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['close', 'revealed'])

// 凭证状态隔离：组件内部维护独立响应式明文引用，关闭时清空
const localPlainKey = ref(props.initialPlainKey || '')
const revealing = ref(false)

watch(
  () => props.initialPlainKey,
  (val) => {
    if (val) localPlainKey.value = val
  }
)

const hasPlainKey = computed(() => !!localPlainKey.value)
const effectiveKey = computed(() => localPlainKey.value || props.apiKey?.keyMasked || 'ccp_your_api_key')

// Base Origin 配置：默认读取浏览器 window.location.origin
const defaultOrigin = typeof window !== 'undefined' && window.location?.origin
  ? window.location.origin
  : 'http://127.0.0.1:3050'

const originInput = ref(defaultOrigin)
const origin = computed(() => {
  const raw = originInput.value.trim() || defaultOrigin
  return raw.replace(/\/+$/, '')
})

function resetOrigin() {
  originInput.value = defaultOrigin
}

// 选项卡状态
const activeTab = ref('claude')
const tabs = [
  { id: 'claude', name: 'Claude Code', icon: '🤖' },
  { id: 'cursor', name: 'Cursor', icon: '⚡' },
  { id: 'opencode', name: 'OpenCode', icon: '💻' },
  { id: 'nextchat', name: 'NextChat', icon: '💬' },
  { id: 'curl', name: 'cURL', icon: '📡' },
]

// 模板引用，用于全选文本
const claudeShellRef = ref(null)
const claudeJsonRef = ref(null)
const cursorTextRef = ref(null)
const opencodeRef = ref(null)
const nextchatDockerRef = ref(null)
const curlChatRef = ref(null)
const curlMsgRef = ref(null)

// 客户端模板计算属性
const claudeShellText = computed(() =>
`export ANTHROPIC_BASE_URL="${origin.value}"
export ANTHROPIC_AUTH_TOKEN="${effectiveKey.value}"`
)

const claudeJsonText = computed(() =>
JSON.stringify(
  {
    env: {
      ANTHROPIC_BASE_URL: origin.value,
      ANTHROPIC_AUTH_TOKEN: effectiveKey.value,
    },
  },
  null,
  2
)
)

const cursorBaseUrl = computed(() => `${origin.value}/v1`)
const cursorModel = 'deepseek/deepseek-v4.1-flash'
const cursorText = computed(() =>
`Base URL: ${cursorBaseUrl.value}
API Key:  ${effectiveKey.value}`
)

const opencodeText = computed(() =>
JSON.stringify(
  {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      comm2api: {
        baseURL: `${origin.value}/v1`,
        apiKey: effectiveKey.value,
      },
    },
  },
  null,
  2
)
)

const nextchatDockerText = computed(() =>
`docker run -d -p 3000:3000 \\
  -e BASE_URL="${origin.value}/v1" \\
  -e OPENAI_API_KEY="${effectiveKey.value}" \\
  -e CUSTOM_MODELS="+deepseek/deepseek-v4.1-flash,+claude-sonnet-4-6,+gpt-5.5" \\
  yidadaa/chatgpt-next-web`
)

const curlChatText = computed(() =>
`curl '${origin.value}/v1/chat/completions' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${effectiveKey.value}' \\
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ],
    "stream": false
  }'`
)

const curlMessagesText = computed(() =>
`curl '${origin.value}/v1/messages' \\
  -H 'Content-Type: application/json' \\
  -H 'x-api-key: ${effectiveKey.value}' \\
  -H 'anthropic-version: 2023-06-01' \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'`
)

// 健壮剪贴板复制：navigator.clipboard -> textarea + execCommand 降级
async function copyText(text, label = '已复制') {
  if (!text) return
  let ok = false

  // 1. 优先使用标准异步 Clipboard API
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = false
    }
  }

  // 2. 降级：局域网非 HTTPS 或老旧浏览器环境
  if (!ok) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '-9999px'
      ta.setAttribute('readonly', '')
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      ok = false
    }
  }

  if (ok) {
    toast.success(label)
  } else {
    toast.error('复制失败，请点击“全选”后手动按 Ctrl+C / Cmd+C 复制')
  }
}

// 文本全选辅助
function selectBlock(el) {
  if (!el) return
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    toast.info('已全选代码，可按 Ctrl+C / Cmd+C 复制')
  } catch {
    toast.error('全选失败，请手动鼠标拖动选择')
  }
}

// 揭示真实明文 Key
async function revealKey() {
  if (!props.apiKey?.id) {
    toast.error('无法获取明文：缺少 Key ID')
    return
  }
  revealing.value = true
  try {
    const { data } = await api('POST', '/apikeys/reveal', { id: props.apiKey.id })
    if (data && data.key) {
      localPlainKey.value = data.key
      emit('revealed', { id: props.apiKey.id, key: data.key })
      toast.success('已载入明文密钥')
    } else {
      toast.error('未返回有效密钥')
    }
  } catch (e) {
    toast.error('获取明文失败：' + (e && e.message ? e.message : '未知错误'))
  } finally {
    revealing.value = false
  }
}

function clearPlainKey() {
  localPlainKey.value = ''
  toast.info('已从内存清除明文密钥，回退至脱敏显示')
}

// 关闭弹窗：彻底清除内存中的明文 Key 并通知父组件
function close() {
  localPlainKey.value = ''
  emit('close')
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    close()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  localPlainKey.value = ''
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="client-modal-overlay" @click.self="close">
    <div class="client-modal" role="dialog" aria-modal="true">
      <!-- 弹窗顶栏 -->
      <div class="client-modal-header">
        <div class="client-modal-title">
          <span>🛠️ 客户端配置生成器</span>
          <span class="probe-pill">{{ apiKey.label || '2API Key' }}</span>
        </div>
        <button
          class="client-modal-close"
          type="button"
          title="关闭 (Esc)"
          @click="close"
        >
          ✕
        </button>
      </div>

      <!-- 密钥与地址工具栏 -->
      <div class="config-toolbar">
        <div class="toolbar-section">
          <div class="toolbar-label">
            <span>🔐 2API Key：</span>
            <span v-if="hasPlainKey" class="badge ok">完整明文就绪</span>
            <span v-else class="badge warn">脱敏显示中</span>
          </div>
          <div class="toolbar-row">
            <code class="mono key-preview">{{ effectiveKey }}</code>
            <button
              v-if="!hasPlainKey"
              class="btn btn-sm btn-primary"
              type="button"
              :disabled="revealing"
              @click="revealKey"
            >
              <span v-if="revealing" class="loading"></span>
              {{ revealing ? '获取中…' : '👁 显示完整密钥' }}
            </button>
            <button
              v-else
              class="btn btn-sm"
              type="button"
              title="立即销毁组件内存中的明文 Key"
              @click="clearPlainKey"
            >
              🔒 隐藏明文
            </button>
            <button
              class="btn btn-sm"
              type="button"
              @click="copyText(effectiveKey, '已复制 Key')"
            >
              📋 复制
            </button>
          </div>
        </div>

        <div class="toolbar-section">
          <div class="toolbar-label">
            <span>🌐 服务 Base Origin（可按实际客户端访问地址调整）：</span>
          </div>
          <div class="toolbar-row">
            <input
              v-model="originInput"
              type="text"
              class="mono origin-input"
              placeholder="http://127.0.0.1:3050"
            />
            <button
              class="btn btn-sm"
              type="button"
              title="重置为当前页面地址"
              @click="resetOrigin"
            >
              重置
            </button>
            <button
              class="btn btn-sm"
              type="button"
              @click="copyText(origin, '已复制 Base URL')"
            >
              📋 复制
            </button>
          </div>
        </div>

        <div v-if="!hasPlainKey" class="hint text-danger" style="margin-top: 4px">
          ⚠️ 当前配置填入的是脱敏 Key（例如 <code>ccp_****</code>）。如需直接复制可用配置，请点击上方「显示完整密钥」。弹窗关闭时内存明文自动销毁。
        </div>
      </div>

      <!-- 选项卡切换 -->
      <div class="tabs modal-tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ active: activeTab === t.id }"
          type="button"
          @click="activeTab = t.id"
        >
          <span>{{ t.icon }}</span>
          <span>{{ t.name }}</span>
        </button>
      </div>

      <!-- 选项卡正文 -->
      <div class="client-modal-body">
        <!-- 1. Claude Code -->
        <div v-if="activeTab === 'claude'" class="tab-pane">
          <div class="guide-box">
            <div class="guide-title">💡 适用于 Anthropic 官方 CLI 工具 <code>claude</code> (Claude Code)</div>
            <div class="hint">
              <strong>重要规则</strong>：Anthropic SDK 与 Claude Code 会在请求时自动追加 <code>/v1/messages</code>，因此 <code>ANTHROPIC_BASE_URL</code> 必须配置为服务根地址（<code>{{ origin }}</code>），切勿在末尾附加 <code>/v1</code>。
            </div>
          </div>

          <div class="config-card">
            <div class="config-card-header">
              <span class="card-title">1. Shell 临时环境变量（当前终端生效）</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(claudeShellRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(claudeShellText, '已复制 Shell 环境变量')">📋 复制</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="claudeShellRef" class="mono">{{ claudeShellText }}</code></pre>
          </div>

          <div class="config-card">
            <div class="config-card-header">
              <span class="card-title">2. 配置文件持久化生效（<code>~/.claude/settings.json</code>）</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(claudeJsonRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(claudeJsonText, '已复制 JSON 配置')">📋 复制</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="claudeJsonRef" class="mono">{{ claudeJsonText }}</code></pre>
          </div>
        </div>

        <!-- 2. Cursor -->
        <div v-if="activeTab === 'cursor'" class="tab-pane">
          <div class="guide-box">
            <div class="guide-title">⚡ 适用于 Cursor 代码编辑器 (OpenAI 协议兼容模式)</div>
            <div class="hint">
              Cursor 将本项目作为 OpenAI 兼容端点连接，Base URL 需携带 <code>/v1</code>。
            </div>
          </div>

          <div class="table-wrap" style="margin-top: 10px">
            <table>
              <thead>
                <tr>
                  <th style="width: 160px">设置项</th>
                  <th>填写值</th>
                  <th style="width: 100px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>OpenAI Base URL</strong></td>
                  <td><code class="mono">{{ cursorBaseUrl }}</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText(cursorBaseUrl, '已复制 Base URL')">📋 复制</button>
                  </td>
                </tr>
                <tr>
                  <td><strong>OpenAI API Key</strong></td>
                  <td><code class="mono">{{ effectiveKey }}</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText(effectiveKey, '已复制 API Key')">📋 复制</button>
                  </td>
                </tr>
                <tr>
                  <td><strong>推荐模型 (Model)</strong></td>
                  <td><code class="mono">{{ cursorModel }}</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText(cursorModel, '已复制模型名')">📋 复制</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="config-card" style="margin-top: 14px">
            <div class="config-card-header">
              <span class="card-title">快速汇总文本</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(cursorTextRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(cursorText, '已复制 Cursor 配置')">📋 复制全部</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="cursorTextRef" class="mono">{{ cursorText }}</code></pre>
          </div>

          <div class="hint" style="margin-top: 10px">
            📌 配置路径：按 <code>Ctrl+,</code> / <code>Cmd+,</code> 打开 Cursor Settings ➔ <code>Features</code> ➔ <code>Models</code> ➔ 开启 <code>OpenAI API Key</code> ➔ 展开 <code>Override OpenAI Base URL</code> 填入上方配置，点击 Verify 保存。
          </div>
        </div>

        <!-- 3. OpenCode -->
        <div v-if="activeTab === 'opencode'" class="tab-pane">
          <div class="guide-box">
            <div class="guide-title">💻 适用于 OpenCode 编程助手 (<code>opencode.json</code>)</div>
            <div class="hint">
              将以下配置保存至项目根目录的 <code>opencode.json</code> 或全局配置文件 <code>~/.opencode/config.json</code> 中。
            </div>
          </div>

          <div class="config-card">
            <div class="config-card-header">
              <span class="card-title"><code>opencode.json</code> 配置片段</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(opencodeRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(opencodeText, '已复制 opencode.json 配置')">📋 复制 JSON</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="opencodeRef" class="mono">{{ opencodeText }}</code></pre>
          </div>
        </div>

        <!-- 4. NextChat -->
        <div v-if="activeTab === 'nextchat'" class="tab-pane">
          <div class="guide-box">
            <div class="guide-title">💬 适用于 NextChat (ChatGPT-Next-Web) 网页端 / 客户端</div>
            <div class="hint">
              在 NextChat「设置」页面中，将模型服务商切换为 <strong>OpenAI</strong> 并填写以下参数。
            </div>
          </div>

          <div class="table-wrap" style="margin-top: 10px">
            <table>
              <thead>
                <tr>
                  <th style="width: 160px">设置字段</th>
                  <th>推荐填入值</th>
                  <th style="width: 100px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>模型服务商</strong></td>
                  <td><code>OpenAI</code></td>
                  <td>-</td>
                </tr>
                <tr>
                  <td><strong>接口地址 (Base URL)</strong></td>
                  <td><code class="mono">{{ cursorBaseUrl }}</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText(cursorBaseUrl, '已复制接口地址')">📋 复制</button>
                  </td>
                </tr>
                <tr>
                  <td><strong>API Key</strong></td>
                  <td><code class="mono">{{ effectiveKey }}</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText(effectiveKey, '已复制 API Key')">📋 复制</button>
                  </td>
                </tr>
                <tr>
                  <td><strong>自定义模型</strong></td>
                  <td><code class="mono">+deepseek/deepseek-v4.1-flash,+claude-sonnet-4-6,+gpt-5.5</code></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="copyText('+deepseek/deepseek-v4.1-flash,+claude-sonnet-4-6,+gpt-5.5', '已复制自定义模型')">📋 复制</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="config-card" style="margin-top: 14px">
            <div class="config-card-header">
              <span class="card-title">Docker 容器启动环境变量示例</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(nextchatDockerRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(nextchatDockerText, '已复制 Docker 命令')">📋 复制</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="nextchatDockerRef" class="mono">{{ nextchatDockerText }}</code></pre>
          </div>
        </div>

        <!-- 5. cURL -->
        <div v-if="activeTab === 'curl'" class="tab-pane">
          <div class="guide-box">
            <div class="guide-title">📡 命令行终端 cURL 快捷调用验证</div>
            <div class="hint">
              已对单引号与请求体严格转义，直接粘贴至 Bash / Zsh 终端即可执行验证。
            </div>
          </div>

          <div class="config-card">
            <div class="config-card-header">
              <span class="card-title">1. OpenAI 兼容协议 (<code>/v1/chat/completions</code>)</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(curlChatRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(curlChatText, '已复制 cURL 命令')">📋 复制</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="curlChatRef" class="mono">{{ curlChatText }}</code></pre>
          </div>

          <div class="config-card">
            <div class="config-card-header">
              <span class="card-title">2. Anthropic Messages 协议 (<code>/v1/messages</code>)</span>
              <div class="card-actions">
                <button class="btn btn-sm" type="button" @click="selectBlock(curlMsgRef)">全选</button>
                <button class="btn btn-sm btn-primary" type="button" @click="copyText(curlMessagesText, '已复制 cURL 命令')">📋 复制</button>
              </div>
            </div>
            <pre class="code-pre"><code ref="curlMsgRef" class="mono">{{ curlMessagesText }}</code></pre>
          </div>
        </div>
      </div>

      <!-- 弹窗底部 -->
      <div class="client-modal-footer">
        <span class="hint">
          💡 关闭弹窗将立即销毁当前组件内存中的明文密钥，不会落盘或缓存。
        </span>
        <button class="btn btn-sm" type="button" @click="close">
          关闭 (Esc)
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.client-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(26, 23, 17, 0.65);
  backdrop-filter: blur(2px);
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.client-modal {
  background: var(--retro-surface);
  border: var(--retro-line);
  border-radius: var(--radius);
  box-shadow: var(--retro-shadow-lg);
  width: 100%;
  max-width: 820px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--retro-ink);
}

.client-modal-header {
  background: var(--retro-section-head);
  border-bottom: var(--retro-line);
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.client-modal-title {
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
}

.client-modal-close {
  cursor: pointer;
  background: var(--retro-surface);
  color: var(--retro-ink);
  border: var(--retro-line-sm);
  box-shadow: var(--retro-shadow-xs);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  transition: transform 0.1s ease;
}

.client-modal-close:hover {
  transform: translate(-1px, -1px);
}

.config-toolbar {
  background: var(--retro-surface-alt);
  border-bottom: var(--retro-line-sm);
  padding: 12px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toolbar-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.toolbar-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--retro-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.key-preview {
  background: var(--retro-surface);
  border: 1px solid var(--border-subtle);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  word-break: break-all;
  flex: 1 1 200px;
}

.origin-input {
  flex: 1 1 240px;
  padding: 4px 10px;
  font-size: 13px;
  border: var(--retro-line-sm);
  border-radius: var(--radius-sm);
  background: var(--retro-surface);
  color: var(--retro-ink);
}

.modal-tabs {
  padding: 8px 18px;
  border-bottom: var(--retro-line-sm);
  gap: 6px;
}

.client-modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
}

.tab-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.guide-box {
  background: var(--retro-surface-alt);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
}

.guide-title {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 4px;
  color: var(--retro-ink);
}

.config-card {
  background: var(--retro-surface-alt);
  border: var(--retro-line-sm);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  box-shadow: var(--retro-shadow-xs);
}

.config-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 8px;
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--retro-ink);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.code-pre {
  margin: 0;
  padding: 10px 12px;
  background: var(--retro-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.client-modal-footer {
  background: var(--retro-surface-alt);
  border-top: var(--retro-line);
  padding: 10px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

@media (max-width: 640px) {
  .client-modal {
    max-height: 96vh;
  }
  .client-modal-header,
  .config-toolbar,
  .client-modal-body,
  .client-modal-footer {
    padding-left: 12px;
    padding-right: 12px;
  }
  .origin-input,
  .key-preview {
    width: 100%;
  }
}
</style>
