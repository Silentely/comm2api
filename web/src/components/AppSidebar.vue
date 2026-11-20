<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { logout } from '../store'
import { toast } from '../toast'

const router = useRouter()

const NAV = [
  { name: 'dashboard', icon: '📊', title: '仪表盘' },
  { name: 'apiKeys', icon: '🔐', title: '2API Key' },
  { name: 'keys', icon: '🔑', title: '上游 Key' },
  { name: 'models', icon: '🧠', title: '模型' },
  { name: 'proxies', icon: '🌐', title: '出站代理池' },
  { name: 'usage', icon: '📈', title: '用量' },
  { name: 'logs', icon: '📜', title: '请求日志' },
  { name: 'settings', icon: '⚙️', title: '设置' },
]

const apiAddress = computed(() => {
  if (typeof window === 'undefined' || !window.location || !window.location.host) return '-'
  return window.location.origin
})

const theme = ref(readTheme())
const themeIcon = computed(() => (theme.value === 'dark' ? '🌙' : '☀️'))
const themeLabel = computed(() => (theme.value === 'dark' ? '深色' : '浅色'))

function readTheme() {
  try {
    return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem('theme', t)
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
}

async function doLogout() {
  if (!window.confirm('确定退出登录吗？')) return
  await logout()
  toast.success('已退出登录')
  router.replace({ name: 'login' })
}
</script>

<template>
  <aside class="sidebar">
    <h1>
      <span class="logo" aria-hidden="true">⚡</span>
      <span class="brand-name">Command Code</span>
      <button
        class="theme-toggle"
        type="button"
        :title="theme === 'dark' ? '切换到暖白浅色主题' : '切换到暖夜深色主题'"
        @click="toggleTheme"
      >
        <span class="icon" aria-hidden="true">{{ themeIcon }}</span>
        <span class="theme-label">{{ themeLabel }}</span>
      </button>
    </h1>

    <nav class="sidebar-nav" aria-label="主导航">
      <router-link
        v-for="item in NAV"
        :key="item.name"
        class="nav-item"
        active-class="active"
        :to="{ name: item.name }"
      >
        <span class="nav-ico" aria-hidden="true">{{ item.icon }}</span>
        <span>{{ item.title }}</span>
      </router-link>
    </nav>

    <div class="sidebar-footer">
      <div class="sidebar-footer-actions">
        <button class="btn btn-sm btn-danger" type="button" @click="doLogout">⏻ 退出登录</button>
      </div>
      <div class="footer-addr">API 地址: <span>{{ apiAddress }}</span></div>
    </div>
  </aside>
</template>
