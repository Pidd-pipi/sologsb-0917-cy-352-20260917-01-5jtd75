<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { FormInstance, FormRules } from "element-plus";
import type { MatchFormValues, MatchView } from "../types/records";

const props = defineProps<{
  visible: boolean;
  /** 传入对局表示修正，否则为录入 */
  match?: MatchView | null;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:visible", value: boolean): void;
  (event: "submit", values: MatchFormValues): void;
}>();

interface FormState {
  gameName: string;
  category: string;
  participantsText: string;
  winnersText: string;
  durationMinutes: number | null;
  playedAt: string;
  note: string;
}

function parseNames(text: string): string[] {
  const result: string[] = [];
  for (const raw of text.split(/[\s,，、;；\n]+/)) {
    const name = raw.trim();
    if (name && !result.includes(name)) {
      result.push(name);
    }
  }
  return result;
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function emptyForm(): FormState {
  return {
    gameName: "",
    category: "策略",
    participantsText: "",
    winnersText: "",
    durationMinutes: 60,
    playedAt: toLocalInput(new Date().toISOString()),
    note: "",
  };
}

const formRefRef = ref<FormInstance>();
const form = reactive<FormState>(emptyForm());

const rules: FormRules = {
  gameName: [{ required: true, message: "请输入桌游名称", trigger: "blur" }],
  participantsText: [
    { required: true, message: "请输入至少 2 名不同参与者", trigger: "blur" },
  ],
  winnersText: [{ required: true, message: "请输入胜者", trigger: "blur" }],
  durationMinutes: [
    { required: true, message: "请输入对局时长", trigger: "change" },
  ],
};

const participantList = computed(() => parseNames(form.participantsText));
const winnerList = computed(() => parseNames(form.winnersText));
const winnersOutside = computed(
  () => winnerList.value.filter((name) => !participantList.value.includes(name)),
);
const duplicateParticipants = computed(() => {
  const names = form.participantsText
    .split(/[\s,，、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length !== new Set(names).size;
});
const participantsError = computed(() => {
  if (duplicateParticipants.value) return "参与者不能重复";
  if (
    participantList.value.length > 0 &&
    participantList.value.length < 2
  ) {
    return "至少需要 2 名不同玩家";
  }
  return "";
});
const winnersError = computed(() =>
  winnersOutside.value.length > 0
    ? `胜者必须出自参与者：${winnersOutside.value.join("、")}`
    : "",
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    if (props.match) {
      form.gameName = props.match.game.name;
      form.category = props.match.game.category;
      form.participantsText = props.match.participants.join("、");
      form.winnersText = props.match.winners.join("、");
      form.durationMinutes = props.match.durationMinutes;
      form.playedAt = toLocalInput(props.match.playedAt);
      form.note = props.match.note;
    } else {
      Object.assign(form, emptyForm());
    }
    formRefRef.value?.clearValidate();
  },
);

const dialogTitle = computed(() => (props.match ? "修正对局战绩" : "录入对局"));

function handleClose() {
  emit("update:visible", false);
}

async function handleSubmit() {
  const valid = await formRefRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (participantsError.value || winnersError.value) return;
  if (!form.playedAt) return;
  const playedDate = new Date(form.playedAt);
  if (Number.isNaN(playedDate.getTime())) return;
  emit("submit", {
    gameName: form.gameName.trim(),
    category: form.category.trim() || "未分类",
    participants: participantList.value,
    winners: winnerList.value,
    durationMinutes: Number(form.durationMinutes),
    playedAt: playedDate.toISOString(),
    note: form.note.trim(),
  });
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="dialogTitle"
    width="560px"
    @update:model-value="emit('update:visible', $event)"
    @close="handleClose"
  >
    <el-form
      ref="formRefRef"
      :model="form"
      :rules="rules"
      label-width="92px"
      label-position="right"
    >
      <el-form-item label="桌游" prop="gameName">
        <el-input
          v-model="form.gameName"
          placeholder="桌游名称，如：卡坦岛"
          maxlength="60"
        />
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="form.category" style="width: 100%">
          <el-option label="策略" value="策略" />
          <el-option label="聚会" value="聚会" />
          <el-option label="角色扮演" value="角色扮演" />
          <el-option label="卡牌" value="卡牌" />
          <el-option label="其他" value="其他" />
        </el-select>
      </el-form-item>
      <el-form-item label="参与者" prop="participantsText" :error="participantsError">
        <el-input
          v-model="form.participantsText"
          type="textarea"
          :rows="2"
          placeholder="用顿号/逗号/空格分隔，如：阿甲、阿乙、阿丙"
        />
      </el-form-item>
      <el-form-item label="胜者" prop="winnersText" :error="winnersError">
        <el-input
          v-model="form.winnersText"
          placeholder="并列胜者可填多个，如：阿甲"
        />
      </el-form-item>
      <el-form-item label="时长(分钟)" prop="durationMinutes">
        <el-input-number
          v-model="form.durationMinutes"
          :min="1"
          :max="10080"
          :step="5"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="结束时间">
        <el-date-picker
          v-model="form.playedAt"
          type="datetime"
          placeholder="对局结束时间"
          format="YYYY-MM-DD HH:mm"
          value-format="YYYY-MM-DDTHH:mm"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item label="备注">
        <el-input
          v-model="form.note"
          type="textarea"
          :rows="2"
          maxlength="300"
          show-word-limit
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="saving" @click="handleSubmit">
        {{ match ? "提交修正" : "提交对局" }}
      </el-button>
    </template>
  </el-dialog>
</template>
