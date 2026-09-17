import type { MatchInput, MatchStatus } from "./record.types";

export class ValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeNames(rawNames: unknown, field: string): string[] {
  if (!Array.isArray(rawNames)) {
    throw new ValidationError(`${field} 必须是字符串数组`, field);
  }

  const names = rawNames.map((raw) => {
    if (typeof raw !== "string") {
      throw new ValidationError(`${field} 中的玩家名必须是字符串`, field);
    }
    const name = raw.trim();
    if (!name) {
      throw new ValidationError(`${field} 不能包含空玩家名`, field);
    }
    if (name.length > 40) {
      throw new ValidationError(`${field} 中的玩家名不能超过 40 个字符`, field);
    }
    return name;
  });

  const seen = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new ValidationError(`${field} 中存在重复玩家：${name}`, field);
    }
    seen.add(key);
  }

  return names;
}

/**
 * 校验并规范化对局录入内容。
 * 规则：只有 status=finished 的对局计入战绩；此类对局必须满足
 * 至少两名不同玩家，且胜者必须出自参与者。
 */
export function validateMatchInput(body: Record<string, unknown>): MatchInput {
  if (!body || typeof body !== "object") {
    throw new ValidationError("请求体格式不正确");
  }

  const matchId = body.matchId === undefined ? undefined : body.matchId;
  if (matchId !== undefined) {
    if (typeof matchId !== "string" || !ID_PATTERN.test(matchId.trim())) {
      throw new ValidationError("matchId 只能包含 1-64 位字母、数字、下划线或短横线", "matchId");
    }
  }

  if (typeof body.boardGame !== "string" || !body.boardGame.trim()) {
    throw new ValidationError("boardGame 不能为空", "boardGame");
  }
  const boardGame = body.boardGame.trim();
  if (boardGame.length > 80) {
    throw new ValidationError("boardGame 不能超过 80 个字符", "boardGame");
  }

  const participantNames = normalizeNames(body.participantNames, "participantNames");

  let status: MatchStatus = "finished";
  if (body.status !== undefined) {
    if (body.status !== "finished" && body.status !== "ongoing") {
      throw new ValidationError('status 只能是 "finished" 或 "ongoing"', "status");
    }
    status = body.status;
  }

  // 只有已结束的对局才参与战绩与排行榜统计。
  if (status === "finished" && participantNames.length < 2) {
    throw new ValidationError("已结束的对局至少需要两名不同玩家", "participantNames");
  }

  const winnerNames = normalizeNames(body.winnerNames ?? [], "winnerNames");
  if (status === "finished") {
    if (winnerNames.length === 0) {
      throw new ValidationError("已结束的对局必须记录至少一名胜者", "winnerNames");
    }
    const participants = new Set(participantNames.map((name) => name.toLowerCase()));
    for (const winner of winnerNames) {
      if (!participants.has(winner.toLowerCase())) {
        throw new ValidationError(`胜者 ${winner} 必须在参与者名单内`, "winnerNames");
      }
    }
  } else {
    // 进行中的对局没有确定胜负，任何携带的胜者都视为非法输入。
    if (winnerNames.length > 0) {
      throw new ValidationError("进行中的对局不能记录胜者", "winnerNames");
    }
  }

  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 100000) {
    throw new ValidationError("durationMinutes 必须是 1 到 100000 之间的数字", "durationMinutes");
  }

  let playedAt: string | undefined;
  if (body.playedAt !== undefined) {
    if (typeof body.playedAt !== "string" || Number.isNaN(Date.parse(body.playedAt))) {
      throw new ValidationError("playedAt 必须是合法的时间字符串", "playedAt");
    }
    playedAt = new Date(body.playedAt).toISOString();
  }

  let note = "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      throw new ValidationError("note 必须是字符串", "note");
    }
    note = body.note.trim();
    if (note.length > 500) {
      throw new ValidationError("note 不能超过 500 个字符", "note");
    }
  }

  return {
    matchId: matchId?.trim(),
    boardGame,
    participantNames,
    winnerNames: status === "finished" ? winnerNames : [],
    durationMinutes: Math.round(durationMinutes),
    playedAt,
    note,
    status,
  };
}
