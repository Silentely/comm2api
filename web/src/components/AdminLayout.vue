<script setup>
import AppSidebar from './AppSidebar.vue'
import PixelScene from './PixelScene.vue'
</script>

<template>
  <div class="layout">
    <AppSidebar />
    <main class="main">
      <PixelScene variant="admin" />
      <div class="main-content">
        <router-view />
      </div>
    </main>
  </div>
</template>
