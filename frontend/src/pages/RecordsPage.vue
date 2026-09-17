<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  correctMatch,
  createMatch,
  fetchLeaderboard,
  fetchMatches,
} from "../api/matches";
import type {
  LeaderboardRow,
  MatchFormValues,
  MatchView,
} from "../types/records";
import MatchFormDialog from "../components/MatchFormDialog.vue";

const matches = ref<MatchView[]>([]);
const rows = ref<LeaderboardRow[]>([]);
const totalMatches = ref(0);
const loading = ref(false);
const dialogVisible = ref(false);
const saving = ref(false);
/** null = 录入；MatchView = 修正 */
const editing = ref<MatchView | null>(null);

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [matchList, board] = await Promise.all([
      fetchMatches(),
      fetchLeaderboard(),
    ]);
    matches.value = matchList;
    rows.value = board.rows;
    totalMatches.value = board.totalMatches;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editing.value = null;
  dialogVisible.value = true;
}

function openCorrect(match: MatchView): void {
  editing.value = match;
  dialogVisible.value = true;
}

async function handleSubmit(values: MatchFormValues): Promise<void> {
  saving.value = true;
  const target = editing.value;
  try {
    if (target) {
      const result = await correctMatch(target.id, values, target.revision);
      ElMessage.success(
        `修正已提交（第 ${result.data.revision} 版），旧版 ${result.rolledBack} 条胜负已完整冲销并重计`,
      );
    } else {
      await createMatch(values);
      ElMessage.success("对局已录入，战绩与排行榜已更新");
    }
    dialogVisible.value = false;
    await loadAll();
  } catch (error) {
    ElMessage.error(
      error instanceof Error ? error.message : "提交失败，战绩未发生变化",
    );
    // 冲突时刷新列表，让用户基于最新版本重试
    if (target) {
      await loadAll();
      const latest = matches.value.find((m) => m.id === target.id);
      if (latest) editing.value = latest;
    }
  } finally {
    saving.value = false;
  }
}

async function confirmCorrect(match: MatchView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将修正「${match.game.name}」（当前第 ${match.revision} 版）。旧版胜负会先完整冲销，再计入新结果。`,
      "修正对局",
      { confirmButtonText: "去修正", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  openCorrect(match);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function rankType(rank: number): "success" | "warning" | "info" {
  if (rank === 1) return "success";
  if (rank <= 3) return "warning";
  return "info";
}

const winRateColor = (rate: number) =>
  rate >= 66 ? "#67c23a" : rate >= 33 ? "#e6a23c" : "#909399";

const statSummary = computed(() => {
  const players = rows.value.length;
  const totalMinutes = rows.value.reduce((sum, row) => sum + row.totalMinutes, 0);
  return { players, totalMinutes };
});
</script>

<template>
  <section class="records-page">
    <div class="records-toolbar">
      <div>
        <h2 class="section-title">战绩记录与胜率榜</h2>
        <p class="section-sub">
          仅统计已结束且至少 2 名不同玩家的对局；重复提交自动幂等，修正先冲销旧胜负再计新结果。
        </p>
      </div>
      <div class="toolbar-actions">
        <el-button :loading="loading" @click="loadAll">刷新</el-button>
        <el-button type="primary" @click="openCreate">录入对局</el-button>
      </div>
    </div>

    <el-row :gutter="18" class="summary-row">
      <el-col :xs="12" :sm="8">
        <el-card shadow="never">
          <div class="summary-value">{{ totalMatches }}</div>
          <div class="summary-label">已统计对局</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :sm="8">
        <el-card shadow="never">
          <div class="summary-value">{{ statSummary.players }}</div>
          <div class="summary-label">参与玩家</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="8">
        <el-card shadow="never">
          <div class="summary-value">{{ statSummary.totalMinutes }}</div>
          <div class="summary-label">累计对局分钟</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="18">
      <el-col :xs="24" :lg="13">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <span class="panel-title">胜率排行榜</span>
          </template>
          <el-table :data="rows" v-loading="loading" size="default" stripe>
            <el-table-column label="名次" width="72">
              <template #default="{ row }">
                <el-tag :type="rankType(row.rank)" effect="plain" round>
                  {{ row.rank }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="player" label="玩家" min-width="90" />
            <el-table-column label="胜率" width="150">
              <template #default="{ row }">
                <el-progress
                  :percentage="row.winRate"
                  :color="winRateColor(row.winRate)"
                  :stroke-width="14"
                  :text-inside="true"
                />
              </template>
            </el-table-column>
            <el-table-column prop="matches" label="局数" width="64" align="center" />
            <el-table-column label="胜/负" width="80" align="center">
              <template #default="{ row }">
                <span class="wins">{{ row.wins }}</span>
                <span class="sep">/</span>
                <span class="losses">{{ row.losses }}</span>
              </template>
            </el-table-column>
            <el-table-column label="时长" width="80" align="right">
              <template #default="{ row }">{{ row.totalMinutes }} 分</template>
            </el-table-column>
            <el-table-column label="常玩桌游" min-width="140">
              <template #default="{ row }">
                <el-tag
                  v-for="game in row.games.slice(0, 3)"
                  :key="game"
                  size="small"
                  type="info"
                  effect="plain"
                  class="game-tag"
                >
                  {{ game }}
                </el-tag>
                <span v-if="row.games.length > 3" class="more-games">
                  +{{ row.games.length - 3 }}
                </span>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="还没有对局，先录入一场已结束的对局" />
            </template>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="11">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <span class="panel-title">对局记录（可修正）</span>
          </template>
          <el-table :data="matches" v-loading="loading" size="default">
            <el-table-column label="桌游 / 时间" min-width="170">
              <template #default="{ row }">
                <div class="match-game">{{ row.game.name }}</div>
                <div class="match-time">{{ formatTime(row.playedAt) }}</div>
              </template>
            </el-table-column>
            <el-table-column label="胜者" min-width="80">
              <template #default="{ row }">
                <el-tag
                  v-for="winner in row.winners"
                  :key="winner"
                  size="small"
                  type="success"
                  class="game-tag"
                >
                  {{ winner }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="局况" width="120">
              <template #default="{ row }">
                <div>{{ row.participants.length }} 人 · {{ row.durationMinutes }} 分</div>
                <div class="match-time">第 {{ row.revision }} 版</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="confirmCorrect(row)">
                  修正
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无对局记录" />
            </template>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <MatchFormDialog
      v-model:visible="dialogVisible"
      :match="editing"
      :saving="saving"
      @submit="handleSubmit"
    />
  </section>
</template>
