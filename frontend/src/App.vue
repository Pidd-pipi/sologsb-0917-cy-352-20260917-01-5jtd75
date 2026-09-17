<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchOverview } from "./api/client";
import { APP_CODE, APP_NAME } from "./constants/app";
import { REQUEST_MESSAGES } from "./constants/messages";
import { createFallbackOverview } from "./state/dashboard";
import type { OverviewResponse } from "./types";
import FeatureStrip from "./components/FeatureStrip.vue";
import MetricGrid from "./components/MetricGrid.vue";
import OperationsTable from "./components/OperationsTable.vue";
import RecordsView from "./components/RecordsView.vue";

type ViewKey = "overview" | "records";

const activeView = ref<ViewKey>("records");
const overview = ref<OverviewResponse>(createFallbackOverview());
const notice = ref(REQUEST_MESSAGES.overviewFallback);

function goHealth() {
  window.location.href = REQUEST_MESSAGES.healthPath;
}

onMounted(async () => {
  try {
    overview.value = await fetchOverview();
    notice.value = "后端服务已联通，当前展示实时接口数据。";
  } catch {
    notice.value = REQUEST_MESSAGES.overviewFallback;
  }
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <span class="brand-code">{{ APP_CODE }}</span>
        <h1 class="brand-title">{{ APP_NAME }}</h1>
      </div>
      <nav class="topnav">
        <el-button
          :type="activeView === 'records' ? 'primary' : 'default'"
          @click="activeView = 'records'"
        >
          战绩与排行榜
        </el-button>
        <el-button
          :type="activeView === 'overview' ? 'primary' : 'default'"
          @click="activeView = 'overview'"
        >
          运营总览
        </el-button>
        <el-button @click="goHealth">API Health</el-button>
      </nav>
    </header>
    <section class="workspace">
      <RecordsView v-if="activeView === 'records'" />
      <template v-else>
        <div class="lead-grid">
          <article class="hero-panel">
            <span class="pill">{{ notice }}</span>
            <h2>{{ overview.appName }}</h2>
            <p>{{ overview.description }}</p>
          </article>
          <MetricGrid :items="overview.kpis" />
        </div>
        <FeatureStrip :items="overview.features" />
        <section class="work-panel">
          <h2>运营任务流</h2>
          <OperationsTable :records="overview.records" />
        </section>
      </template>
    </section>
  </main>
</template>

<style scoped>
.topnav {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-width: 860px) {
  .topnav {
    width: 100%;
  }
}
</style>
