import { Schema, model } from "mongoose";
import type { PlayerStatsDoc } from "./record.types";

/**
 * 排行榜物化视图：每个玩家一条统计记录。
 * 所有变更都在对局事务内完成，保证与 matches 集合始终一致。
 */
const playerStatsSchema = new Schema<PlayerStatsDoc>(
  {
    playerName: { type: String, required: true, unique: true, trim: true },
    matchesCount: { type: Number, required: true, min: 0, default: 0 },
    winsCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);

export const PlayerStats = model<PlayerStatsDoc>("PlayerStats", playerStatsSchema, "player_stats");
