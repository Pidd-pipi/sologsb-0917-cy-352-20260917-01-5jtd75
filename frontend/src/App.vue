<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { APP_CODE, APP_NAME } from "./constants/app";
import { REQUEST_MESSAGES } from "./constants/messages";

const route = useRoute();
const navItems = [
  { path: "/", label: "运营总览" },
  { path: "/records", label: "战绩与排行榜" },
];
const activePath = computed(() => route.path);

function goHealth() {
  window.location.href = REQUEST_MESSAGES.healthPath;
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-block">
        <span class="brand-code">{{ APP_CODE }}</span>
        <h1 class="brand-title">{{ APP_NAME }}</h1>
      </div>
      <nav class="topnav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="topnav-link"
          :class="{ active: activePath === item.path }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
      <el-button @click="goHealth">API Health</el-button>
    </header>
    <RouterView />
  </main>
</template>
