import { randomUUID } from "crypto";
import mongoose, { type ClientSession } from "mongoose";
import { Match } from "./match.model";
import { PlayerStats } from "./player-stats.model";
import { validateMatchInput, ValidationError } from "./record.validator";
import type {
  LeaderboardEntry,
  MatchDoc,
  MatchInput,
  PlayerStatsDoc,
} from "./record.types";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class StatsConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsConsistencyError";
  }
}

const DUPLICATE_KEY_CODE = 11000;

interface MatchView {
  matchId: string;
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt: string;
  note: string;
  status: "finished" | "ongoing";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface PersistedMatchData {
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt: Date;
  note: string;
  status: MatchInput["status"];
}

function toMatchView(doc: MatchDoc): MatchView {
  return {
    matchId: doc.matchId,
    boardGame: doc.boardGame,
    participantNames: doc.participantNames,
    winnerNames: doc.winnerNames,
    durationMinutes: doc.durationMinutes,
    playedAt: new Date(doc.playedAt).toISOString(),
    note: doc.note,
    status: doc.status,
    revision: doc.revision,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

/**
 * 统计增量：对每个玩家计算场次/胜场的变化量（-1 / 0 / +1）。
 * 修正对局时旧结果按 -1 完整冲销，再按新结果 +1 计入。
 */
function buildStatsDeltas(
  oldMatch: Pick<MatchDoc, "participantNames" | "winnerNames" | "status"> | null,
  newMatch: Pick<PersistedMatchData, "participantNames" | "winnerNames" | "status">
): Map<string, { matchesDelta: number; winsDelta: number }> {
  const deltas = new Map<string, { matchesDelta: number; winsDelta: number }>();

  const bump = (name: string, field: "matchesDelta" | "winsDelta", amount: number) => {
    const current = deltas.get(name) ?? { matchesDelta: 0, winsDelta: 0 };
    current[field] += amount;
    deltas.set(name, current);
  };

  if (oldMatch && oldMatch.status === "finished") {
    for (const name of oldMatch.participantNames) bump(name, "matchesDelta", -1);
    for (const name of oldMatch.winnerNames) bump(name, "winsDelta", -1);
  }

  if (newMatch.status === "finished") {
    for (const name of newMatch.participantNames) bump(name, "matchesDelta", +1);
    for (const name of newMatch.winnerNames) bump(name, "winsDelta", +1);
  }

  return deltas;
}

export class RecordService {
  async listMatches(): Promise<MatchView[]> {
    const docs = await Match.find().sort({ playedAt: -1, createdAt: -1 }).lean<MatchDoc[]>();
    return docs.map(toMatchView);
  }

  async getMatch(matchId: string): Promise<MatchView> {
    const doc = await Match.findOne({ matchId }).lean<MatchDoc | null>();
    if (!doc) {
      throw new NotFoundError(`对局 ${matchId} 不存在`);
    }
    return toMatchView(doc);
  }

  async createMatch(body: Record<string, unknown>): Promise<MatchView> {
    const input = validateMatchInput(body);
    const matchId = input.matchId?.trim() || randomUUID();

    const matchData: PersistedMatchData = {
      boardGame: input.boardGame,
      participantNames: input.participantNames,
      winnerNames: input.winnerNames,
      durationMinutes: input.durationMinutes,
      playedAt: input.playedAt ? new Date(input.playedAt) : new Date(),
      note: input.note ?? "",
      status: input.status,
    };

    try {
      await mongoose.connection.transaction(async (session) => {
        const doc = new Match({ matchId, ...matchData, revision: 0 });
        // matchId 唯一索引兜底：并发重复提交只有一个事务能插入成功，其余整体回滚。
        await doc.save({ session });
        await this.applyStatsDeltas(null, matchData, session);
      });
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY_CODE) {
        throw new ConflictError(`对局 ${matchId} 已存在，请勿重复提交`);
      }
      throw error;
    }

    return this.getMatch(matchId);
  }

  async updateMatch(matchId: string, body: Record<string, unknown>): Promise<MatchView> {
    const input = validateMatchInput({ ...body, matchId });
    const nextData: PersistedMatchData = {
      boardGame: input.boardGame,
      participantNames: input.participantNames,
      winnerNames: input.winnerNames,
      durationMinutes: input.durationMinutes,
      playedAt: input.playedAt ? new Date(input.playedAt) : new Date(),
      note: input.note ?? "",
      status: input.status,
    };

    await mongoose.connection.transaction(async (session) => {
      const doc = await Match.findOne({ matchId }, null, { session });
      if (!doc) {
        throw new NotFoundError(`对局 ${matchId} 不存在`);
      }

      const oldData = {
        participantNames: doc.participantNames,
        winnerNames: doc.winnerNames,
        status: doc.status,
      };

      // 旧胜负完整冲销 + 新结果计入，全部在同一事务内，任一步失败整体回滚。
      await this.applyStatsDeltas(oldData, nextData, session);

      doc.boardGame = nextData.boardGame;
      doc.participantNames = nextData.participantNames;
      doc.winnerNames = nextData.winnerNames;
      doc.durationMinutes = nextData.durationMinutes;
      doc.playedAt = nextData.playedAt;
      doc.note = nextData.note;
      doc.status = nextData.status;
      doc.revision += 1;
      await doc.save({ session });
    });

    return this.getMatch(matchId);
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const docs = await PlayerStats.find()
      .sort({ winsCount: -1, matchesCount: -1, playerName: 1 })
      .lean<PlayerStatsDoc[]>();

    const ranked = docs
      .filter((doc) => doc.matchesCount > 0)
      .map((doc) => ({
        playerName: doc.playerName,
        matchesCount: doc.matchesCount,
        winsCount: doc.winsCount,
        lossesCount: doc.matchesCount - doc.winsCount,
        winRate: doc.matchesCount > 0 ? doc.winsCount / doc.matchesCount : 0,
      }))
      .sort((a, b) => {
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        if (b.winsCount !== a.winsCount) return b.winsCount - a.winsCount;
        if (b.matchesCount !== a.matchesCount) return b.matchesCount - a.matchesCount;
        return a.playerName.localeCompare(b.playerName, "zh-Hans-CN");
      });

    return ranked.map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  /**
   * 在事务会话内把统计增量落到 player_stats。
   * 负增量（冲销旧结果）必须命中已存在的统计行且余额足够，否则判定战绩与排行榜不一致，
   * 抛出异常让整个事务回滚；正增量使用 upsert，为新玩家自动建行。
   */
  private async applyStatsDeltas(
    oldMatch: Pick<MatchDoc, "participantNames" | "winnerNames" | "status"> | null,
    newMatch: Pick<PersistedMatchData, "participantNames" | "winnerNames" | "status">,
    session: ClientSession
  ): Promise<void> {
    const deltas = buildStatsDeltas(oldMatch, newMatch);

    const operations = [];
    for (const [playerName, delta] of deltas) {
      const { matchesDelta, winsDelta } = delta;
      if (matchesDelta === 0 && winsDelta === 0) {
        continue;
      }

      const hasDecrement = matchesDelta < 0 || winsDelta < 0;
      if (hasDecrement) {
        operations.push({
          updateOne: {
            filter: {
              playerName,
              matchesCount: { $gte: Math.max(0, -matchesDelta) },
              winsCount: { $gte: Math.max(0, -winsDelta) },
            },
            update: {
              $inc: { matchesCount: matchesDelta, winsCount: winsDelta },
            },
            upsert: false,
          },
        });
      } else {
        operations.push({
          updateOne: {
            filter: { playerName },
            update: {
              $inc: { matchesCount: matchesDelta, winsCount: winsDelta },
              $setOnInsert: { playerName },
            },
            upsert: true,
          },
        });
      }
    }

    if (operations.length === 0) {
      return;
    }

    const result = await PlayerStats.bulkWrite(operations as never, { session });

    // 每个玩家恰好一条操作：要么新建（upserted），要么命中已存在行（matched）。
    // 负增量操作的 upsert=false，若守卫过滤掉了某行，touched 就会少于操作数，直接回滚。
    const touched = (result.upsertedCount ?? 0) + (result.matchedCount ?? 0);
    if (touched !== operations.length) {
      throw new StatsConsistencyError(
        "战绩与排行榜统计更新不完整（冲销行缺失或余额不足），事务回滚"
      );
    }
  }
}

export { DUPLICATE_KEY_CODE, ValidationError };
