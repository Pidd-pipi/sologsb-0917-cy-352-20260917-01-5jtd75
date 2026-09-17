import { Schema, Types, model, type Model } from "mongoose";

/**
 * 对局源记录（战绩的唯一事实来源）。
 * - clientRequestId: 客户端生成的幂等键，重复提交（含并发）只会返回同一条对局
 * - revision: 每次成功修正 +1；stats_deltas 按 revision 版本化，旧版本完整冲销后才写入新版本
 */
const matchSchema = new Schema(
  {
    clientRequestId: { type: String, required: true, unique: true, trim: true },
    game: {
      name: { type: String, required: true, trim: true, maxlength: 60 },
      category: { type: String, required: true, trim: true, maxlength: 30 },
    },
    /** 参与者（去重后的玩家名），至少 2 名不同玩家 */
    participants: {
      type: [String],
      required: true,
      validate: {
        validator: (value: string[]) =>
          Array.isArray(value) && new Set(value).size >= 2,
        message: "对局至少需要 2 名不同玩家",
      },
    },
    /** 胜者（必须是参与者之一；多人并列获胜时可多名） */
    winners: {
      type: [String],
      required: true,
      validate: {
        validator: (value: string[]) =>
          Array.isArray(value) && value.length >= 1,
        message: "至少需要 1 名胜者",
      },
    },
    /** 对局时长（分钟），大于 0 */
    durationMinutes: { type: Number, required: true, min: 1 },
    /** 对局结束时间（录入的对局均已结束） */
    playedAt: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    revision: { type: Number, required: true, default: 1 },
    finished: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);

/**
 * 战绩流水：每名参与者在对局的每个版本各一条。
 * 排行榜只聚合 (matchId, revision=对局当前版本) 的流水。
 * 修正时旧版本流水物理删除（完整冲销），不留旧记录。
 */
const statsDeltaSchema = new Schema(
  {
    matchId: {
      type: Schema.Types.ObjectId,
      ref: "Match",
      required: true,
    },
    revision: { type: Number, required: true },
    player: { type: String, required: true, trim: true },
    gameName: { type: String, required: true, trim: true },
    win: { type: Boolean, required: true },
    durationMinutes: { type: Number, required: true },
    playedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

// 同一对局同一版本同一名玩家至多一条：并发重放也不会重复计分
statsDeltaSchema.index({ matchId: 1, revision: 1, player: 1 }, { unique: true });
statsDeltaSchema.index({ player: 1, playedAt: -1 });

export type MatchId = Types.ObjectId;

/* eslint-disable @typescript-eslint/no-explicit-any */
// 运行时模型；字段约束以 Schema 校验为准，读写处自行保证形状
export const Match = model("Match", matchSchema, "matches") as Model<any>;
export const StatsDelta = model(
  "StatsDelta",
  statsDeltaSchema,
  "stats_deltas",
) as Model<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function ensureIndexes(): Promise<void> {
  await Match.syncIndexes();
  await StatsDelta.syncIndexes();
}
