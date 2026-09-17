import { Schema, model } from "mongoose";
import type { MatchDoc } from "./record.types";

const matchSchema = new Schema<MatchDoc>(
  {
    matchId: { type: String, required: true, unique: true, trim: true },
    boardGame: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    participantNames: {
      type: [String],
      required: true,
      validate: {
        validator: (values: string[]) => Array.isArray(values) && values.length > 0,
        message: "participantNames 不能为空",
      },
    },
    winnerNames: { type: [String], required: true },
    durationMinutes: { type: Number, required: true, min: 1, max: 100000 },
    playedAt: { type: Date, required: true },
    note: { type: String, default: "", maxlength: 500 },
    status: {
      type: String,
      enum: ["finished", "ongoing"],
      default: "finished",
      required: true,
    },
    revision: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// 玩家名统一规范化后比较，避免同一场对局内大小写/空白差异绕过去重。
matchSchema.path("participantNames").validate(function (values: string[]) {
  const normalized = values.map((name) => name.trim().toLowerCase());
  return new Set(normalized).size === normalized.length;
}, "participantNames 中存在重复玩家");

export const Match = model<MatchDoc>("Match", matchSchema, "matches");
