import type { MatchPayload } from "./match.types";

/** 校验/规范化对局录入内容。非法时抛出带字段信息的错误。 */
export function normalizeMatchPayload(input: unknown): MatchPayload {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }
  const body = input as Record<string, unknown>;

  const gameName = trimString(body.gameName) ?? trimString((body.game as Record<string, unknown> | undefined)?.name);
  if (!gameName) {
    throw new ValidationError("桌游名称不能为空", "gameName");
  }

  const category =
    trimString(body.category) ??
    trimString((body.game as Record<string, unknown> | undefined)?.category) ??
    "未分类";

  const participants = normalizeNameList(body.participants);
  if (participants.length < 2) {
    throw new ValidationError("对局至少需要 2 名不同玩家", "participants");
  }

  const winners = normalizeNameList(body.winners);
  if (winners.length < 1) {
    throw new ValidationError("至少需要 1 名胜者", "winners");
  }
  const outside = winners.filter((winner) => !participants.includes(winner));
  if (outside.length > 0) {
    throw new ValidationError(
      `胜者必须出自参与者：${outside.join("、")}`,
      "winners",
    );
  }

  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new ValidationError("对局时长必须是大于 0 的数字（分钟）", "durationMinutes");
  }

  let playedAt = new Date();
  if (body.playedAt !== undefined && body.playedAt !== null && body.playedAt !== "") {
    const parsed = new Date(body.playedAt as string);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("对局时间格式不正确", "playedAt");
    }
    playedAt = parsed;
  }
  if (playedAt.getTime() > Date.now() + 60_000) {
    throw new ValidationError("对局尚未结束（结束时间在未来），暂不参与统计", "playedAt");
  }

  const note = trimString(body.note) ?? "";
  if (note.length > 300) {
    throw new ValidationError("备注不能超过 300 字", "note");
  }

  return {
    gameName,
    category,
    participants,
    winners,
    durationMinutes: Math.round(durationMinutes * 100) / 100,
    playedAt,
    note,
  };
}

export class ValidationError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 规范化玩家名单：转字符串、去空白、去重并保持顺序 */
function normalizeNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError("玩家名单必须是字符串数组");
    }
    const name = item.trim();
    if (name.length === 0 || name.length > 30) {
      throw new ValidationError("玩家名必须为 1-30 个非空白字符");
    }
    if (!result.includes(name)) {
      result.push(name);
    }
  }
  return result;
}
