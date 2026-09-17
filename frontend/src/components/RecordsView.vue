<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import { fetchLeaderboard, fetchMatches, submitMatch } from "../api/records";
import type { LeaderboardEntry, MatchRecord, MatchStatus } from "../types";

const matches = ref<MatchRecord[]>([]);
const leaderboard = ref<LeaderboardEntry[]>([]);
const loading = ref(false);
const submitting = ref(false);
const formRef = ref<FormInstance>();

interface MatchFormState {
  matchId: string;
  boardGame: string;
  participantsText: string;
  winnersText: string;
  durationMinutes: number | undefined;
  status: MatchStatus;
  playedAt: string;
  note: string;
}

const createInitialForm = (): MatchFormState => ({
  matchId: "",
  boardGame: "",
  participantsText: "",
  winnersText: "",
  durationMinutes: undefined,
  status: "finished",
  playedAt: "",
  note: "",
});

const form = reactive<MatchFormState>(createInitialForm());
const isEditing = computed(() => Boolean(form.matchId));

const rules: FormRules<MatchFormState> = {
  boardGame: [{ required: true, message: "请填写桌游名称", trigger: "blur" }],
  participantsText: [
    { required: true, message: "请填写至少两名参与者", trigger: "blur" },
  ],
  winnersText: [
    {
      validator: (_rule, value: string, callback) => {
        if (form.status === "finished" && !splitNames(value).length) {
          callback(new Error("已结束对局必须填写胜者"));
          return;
        }
        callback();
      },
      trigger: "blur",
    },
  ],
  durationMinutes: [
    { required: true, message: "请填写对局时长", trigger: "change" },
  ],
};

function splitNames(raw: string): string[] {
  return raw
    .split(/[,，;；\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function refresh() {
  loading.value = true;
  try {
    const [matchList, board] = await Promise.all([fetchMatches(), fetchLeaderboard()]);
    matches.value = matchList;
    leaderboard.value = board;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "加载战绩失败");
  } finally {
    loading.value = false;
  }
}

async function handleSubmit() {
  if (!formRef.value) {
    return;
  }

  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) {
    return;
  }

  const participantNames = splitNames(form.participantsText);
  const winnerNames = form.status === "finished" ? splitNames(form.winnersText) : [];

  if (form.status === "finished" && participantNames.length < 2) {
    ElMessage.error("已结束的对局至少需要两名不同玩家");
    return;
  }

  const duplicateParticipants = participantNames.filter(
    (name, index) => participantNames.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== index
  );
  if (duplicateParticipants.length) {
    ElMessage.error(`参与者重复：${[...new Set(duplicateParticipants)].join("、")}`);
    return;
  }

  const participantSet = new Set(participantNames.map((name) => name.toLowerCase()));
  const invalidWinner = winnerNames.find((name) => !participantSet.has(name.toLowerCase()));
  if (invalidWinner) {
    ElMessage.error(`胜者 ${invalidWinner} 不在参与者名单内`);
    return;
  }

  submitting.value = true;
  try {
    const saved = await submitMatch({
      matchId: form.matchId || undefined,
      boardGame: form.boardGame.trim(),
      participantNames,
      winnerNames,
      durationMinutes: Number(form.durationMinutes),
      playedAt: form.playedAt || undefined,
      note: form.note.trim() || undefined,
      status: form.status,
    });
    ElMessage.success(isEditing.value ? `对局 ${saved.matchId} 已修正` : `对局 ${saved.matchId} 已录入`);
    resetForm();
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "提交失败");
  } finally {
    submitting.value = false;
  }
}

function startEdit(row: MatchRecord) {
  form.matchId = row.matchId;
  form.boardGame = row.boardGame;
  form.participantsText = row.participantNames.join("、");
  form.winnersText = row.winnerNames.join("、");
  form.durationMinutes = row.durationMinutes;
  form.status = row.status;
  form.playedAt = row.playedAt ? new Date(row.playedAt).toISOString().slice(0, 16) : "";
  form.note = row.note;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  Object.assign(form, createInitialForm());
  formRef.value?.clearValidate();
}

function formatTime(iso: string): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function winnerText(row: MatchRecord): string {
  if (row.status !== "finished") {
    return "进行中";
  }
  return row.winnerNames.length ? row.winnerNames.join("、") : "—";
}

onMounted(refresh);
</script>

<template>
  <section class="records-page" v-loading="loading">
    <div class="records-grid">
      <el-card class="form-card" shadow="never">
        <template #header>
          <div class="card-header">
            <h2>{{ isEditing ? `修正对局 ${form.matchId}` : "录入对局战绩" }}</h2>
            <el-button v-if="isEditing" size="small" @click="resetForm">取消修正</el-button>
          </div>
        </template>

        <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
          <el-form-item label="桌游名称" prop="boardGame">
            <el-input v-model="form.boardGame" placeholder="例如：卡坦岛" maxlength="80" />
          </el-form-item>

          <el-form-item label="对局状态">
            <el-radio-group v-model="form.status">
              <el-radio-button value="finished">已结束（计入排行）</el-radio-button>
              <el-radio-button value="ongoing">进行中（不计分）</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="参与者（至少两名不同玩家，逗号/顿号分隔）" prop="participantsText">
            <el-input
              v-model="form.participantsText"
              type="textarea"
              :rows="2"
              placeholder="Alice、Bob、Carol"
            />
          </el-form-item>

          <el-form-item v-if="form.status === 'finished'" label="胜者（必须在参与者内）" prop="winnersText">
            <el-input
              v-model="form.winnersText"
              type="textarea"
              :rows="2"
              placeholder="多人合作胜可填多名"
            />
          </el-form-item>

          <el-form-item label="对局时长（分钟）" prop="durationMinutes">
            <el-input-number v-model="form.durationMinutes" :min="1" :max="100000" :step="5" />
          </el-form-item>

          <el-form-item label="对局时间">
            <el-date-picker
              v-model="form.playedAt"
              type="datetime"
              placeholder="留空默认为当前时间"
              format="YYYY-MM-DD HH:mm"
              value-format="YYYY-MM-DDTHH:mm:ss"
              style="width: 100%"
            />
          </el-form-item>

          <el-form-item label="备注">
            <el-input v-model="form.note" maxlength="500" placeholder="可选" />
          </el-form-item>

          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="handleSubmit">
              {{ isEditing ? "保存修正" : "提交战绩" }}
            </el-button>
            <el-button @click="resetForm">清空</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="board-card" shadow="never">
        <template #header>
          <div class="card-header">
            <h2>个人胜率榜</h2>
            <el-button size="small" :loading="loading" @click="refresh">刷新</el-button>
          </div>
        </template>
        <el-table :data="leaderboard" size="small" empty-text="暂无战绩，先录入一场已结束对局">
          <el-table-column label="排名" width="64" align="center">
            <template #default="{ row }">
              <el-tag :type="row.rank <= 3 ? 'warning' : 'info'" effect="plain">#{{ row.rank }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="playerName" label="玩家" min-width="110" />
          <el-table-column prop="matchesCount" label="场次" width="64" align="center" />
          <el-table-column prop="winsCount" label="胜场" width="64" align="center" />
          <el-table-column prop="lossesCount" label="负场" width="64" align="center" />
          <el-table-column label="胜率" width="90" align="right">
            <template #default="{ row }">
              <strong>{{ formatPercent(row.winRate) }}</strong>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-card class="matches-card" shadow="never">
      <template #header>
        <div class="card-header">
          <h2>对局记录</h2>
          <span class="muted">共 {{ matches.length }} 场，仅「已结束」对局参与统计</span>
        </div>
      </template>
      <el-table :data="matches" size="small" empty-text="暂无对局记录">
        <el-table-column prop="matchId" label="对局 ID" width="240" show-overflow-tooltip />
        <el-table-column prop="boardGame" label="桌游" min-width="120" />
        <el-table-column label="参与者" min-width="180">
          <template #default="{ row }">{{ row.participantNames.join("、") }}</template>
        </el-table-column>
        <el-table-column label="胜者" min-width="120">
          <template #default="{ row }">{{ winnerText(row) }}</template>
        </el-table-column>
        <el-table-column prop="durationMinutes" label="时长(分)" width="86" align="center" />
        <el-table-column label="状态" width="92" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'finished' ? 'success' : 'info'" size="small">
              {{ row.status === "finished" ? "已结束" : "进行中" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对局时间" width="168">
          <template #default="{ row }">{{ formatTime(row.playedAt) }}</template>
        </el-table-column>
        <el-table-column label="版本" width="64" align="center">
          <template #default="{ row }">v{{ row.revision }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="startEdit(row)">修正</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </section>
</template>

<style scoped>
.records-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.records-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.85fr);
  gap: 22px;
  align-items: start;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-header h2 {
  margin: 0;
  font-size: 18px;
}

.matches-card,
.form-card,
.board-card {
  border-radius: 8px;
}

.muted {
  color: #7a869a;
  font-size: 13px;
}

@media (max-width: 960px) {
  .records-grid {
    grid-template-columns: 1fr;
  }
}
</style>
