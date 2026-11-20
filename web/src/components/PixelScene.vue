<script setup>
import houseUrl from '../assets/pixel/house.svg'
import treeUrl from '../assets/pixel/tree.svg'
import cloudUrl from '../assets/pixel/cloud.svg'
import grassUrl from '../assets/pixel/grass-tile.svg'
import flowerUrl from '../assets/pixel/flower.svg'

defineProps({
  /**
   * 场景配置：
   * - admin：后台主工作区，将所有装饰锚定在文档底部预留的安全留白区（绝不遮挡顶部标题/按钮或正文卡片）
   * - login：登录页，四周留白充裕，顶部点缀柔和云朵 + 底部小屋/树丛/草地框景
   */
  variant: {
    type: String,
    default: 'admin',
    validator: (v) => v === 'admin' || v === 'login',
  },
})

const grassStyle = {
  backgroundImage: `url("${grassUrl}")`,
}
</script>

<template>
  <div class="pixel-scene" :class="`pixel-scene--${variant}`" aria-hidden="true">
    <!-- 登录页顶部静谧云朵（四周大面积空白处） -->
    <div v-if="variant === 'login'" class="pixel-sky pixel-sky--login">
      <img :src="cloudUrl" alt="" class="pixel-sprite pixel-cloud pixel-cloud--l1" width="80" height="40" />
      <img :src="cloudUrl" alt="" class="pixel-sprite pixel-cloud pixel-cloud--l2" width="56" height="28" />
    </div>

    <!-- 文档底部草线与角落微景（锚定在容器底端，而非 fixed 浮层，避免遮挡长页面内容） -->
    <div class="pixel-ground">
      <div class="pixel-grass-strip" :style="grassStyle"></div>

      <template v-if="variant === 'admin'">
        <img :src="cloudUrl" alt="" class="pixel-sprite pixel-cloud pixel-cloud--admin-low" width="52" height="26" />
        <img :src="flowerUrl" alt="" class="pixel-sprite pixel-flower pixel-flower--a1" width="16" height="20" />
        <img :src="flowerUrl" alt="" class="pixel-sprite pixel-flower pixel-flower--a2" width="14" height="18" />
        <div class="pixel-cluster pixel-cluster--admin-right">
          <img :src="treeUrl" alt="" class="pixel-sprite pixel-tree-sm" width="38" height="48" />
          <img :src="houseUrl" alt="" class="pixel-sprite pixel-house-sm" width="68" height="56" />
          <img :src="treeUrl" alt="" class="pixel-sprite pixel-tree-xs" width="28" height="35" />
        </div>
      </template>

      <template v-else>
        <div class="pixel-cluster pixel-cluster--login-left">
          <img :src="treeUrl" alt="" class="pixel-sprite" width="52" height="65" />
          <img :src="flowerUrl" alt="" class="pixel-sprite pixel-flower-inline" width="16" height="20" />
        </div>
        <img :src="flowerUrl" alt="" class="pixel-sprite pixel-flower pixel-flower--l1" width="16" height="20" />
        <div class="pixel-cluster pixel-cluster--login-right">
          <img :src="flowerUrl" alt="" class="pixel-sprite pixel-flower-inline" width="16" height="20" />
          <img :src="treeUrl" alt="" class="pixel-sprite" width="44" height="55" />
          <img :src="houseUrl" alt="" class="pixel-sprite" width="96" height="80" />
          <img :src="treeUrl" alt="" class="pixel-sprite" width="56" height="70" />
        </div>
      </template>
    </div>
  </div>
</template>
