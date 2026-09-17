import mongoose from "mongoose";
import { Match, StatsDelta } from "./match.model";
import { applyDeltas, rollbackDeltas } from "./stats.service";
import {
  ConflictError,
  NotFoundError,
  normalizeMatchPayload,
} from "./match.validate";
import type { LeaderboardRow, MatchPayload, MatchView } from "./match.types";

export class MatchService {
  /**
   * 录入一场已结束对局。
   * clientRequestId 为客户端生成的幂等键（UUID）：并发重复提交时唯一索引保证只落一条，
   * 后续请求直接返回首次创建的对局，绝不重复计分。
   */
  async createMatch(rawBody: unknown, clientRequestId?: string): Promise<MatchView> {
    const requestId = normalizeRequestId(clientRequestId);
    const payload = normalizeMatchPayload(rawBody);

    // 快速路径：已经提交过（含并发中的胜出者）
    const existing = await Match.findOne({ clientRequestId: requestId });
    if (existing) {
      return this.toView(existing);
    }

    const match = new Match({
      clientRequestId: requestId,
      game: { name: payload.gameName, category: payload.category },
      participants: payload.participants,
      winners: payload.winners,
      durationMinutes: payload.durationMinutes,
      playedAt: payload.playedAt,
      note: payload.note,
      revision: 1,
      finished: true,
    });

    try {
      await match.save();
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) {
        // 并发重复提交：另一个请求已先创建，返回它的结果
        const winner = await Match.findOne({ clientRequestId: requestId });
        if (winner) {
          return this.toView(winner);
        }
      }
      throw error;
    }

    try {
      await applyDeltas(match._id, 1, payload);
    } catch (error) {
      // 自愈完成后再把原始错误抛出，保证不会静默留下中间态
      await this.repairMatch(match._id);
      throw error;
    }

    const created = await Match.findById(match._id);
    return this.toView(created!);
  }

  /**
   * 修正一场对局。
   * 用 revision 做乐观条件更新：同一时刻只有一个修正能把版本号向前推进，
   * 其余并发修正得到 409。推进后：先完整冲销旧版本全部胜负流水，再计入新版本结果。
   * 任一步抛错都立即按源记录自愈，保证战绩流水与排行榜不出现中间态。
   */
  async correctMatch(
    id: string,
    rawBody: unknown,
  ): Promise<{ view: MatchView; rolledBack: number }> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundError("对局不存在");
    }
    const payload = normalizeMatchPayload(rawBody);
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const expectedRevision =
      body.expectedRevision === undefined || body.expectedRevision === null
        ? undefined
        : Number(body.expectedRevision);
    if (
      expectedRevision !== undefined &&
      (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw new ConflictError("expectedRevision 必须是正整数");
    }

    const match = await Match.findById(id);
    if (!match) {
      throw new NotFoundError("对局不存在");
    }

    // 内容相同的重复修正直接幂等返回（双击提交场景），不再冲销/重放
    if (this.sameAsStored(match, payload)) {
      return { view: this.toView(match), rolledBack: 0 };
    }

    const baseRevision = expectedRevision ?? match.revision;
    const bumped = await Match.findOneAndUpdate(
      { _id: match._id, revision: baseRevision },
      {
        $set: {
          game: { name: payload.gameName, category: payload.category },
          participants: payload.participants,
          winners: payload.winners,
          durationMinutes: payload.durationMinutes,
          playedAt: payload.playedAt,
          note: payload.note,
        },
        $inc: { revision: 1 },
      },
      { new: true },
    );

    if (!bumped) {
      throw new ConflictError("对局已被其他修正更新，请刷新后基于最新结果重试");
    }

    let rolledBack = 0;
    try {
      // 旧胜负先完整冲销（物理删除旧版本流水，不留旧记录）
      rolledBack = await rollbackDeltas(bumped._id);
      // 再计入新版本结果（唯一索引保证并发重放不重复）
      await applyDeltas(bumped._id, bumped.revision, payload);
    } catch (error) {
      await this.repairMatch(bumped._id);
      throw error;
    }

    return { view: this.toView(bumped), rolledBack };
  }

  async listMatches(): Promise<MatchView[]> {
    const matches = await Match.find({}).sort({ playedAt: -1, createdAt: -1 });
    return matches.map((match) => this.toView(match));
  }

  /**
   * 胜率榜：只统计战绩流水中“对局当前版本”的记录。
   * join 到 matches 并按 revision 对齐，已冲销的旧版本流水天然不参与。
   */
  async getLeaderboard(): Promise<{ rows: LeaderboardRow[]; totalMatches: number }> {
    const totalMatches = await Match.countDocuments({ finished: true });

    const pipeline: unknown[] = [
      {
        $lookup: {
          from: "matches",
          localField: "matchId",
          foreignField: "_id",
          as: "match",
        },
      },
      { $unwind: "$match" },
      // 关键过滤：只有属于对局当前版本的流水才计分
      { $match: { $expr: { $eq: ["$revision", "$match.revision"] } } },
      { $match: { "match.finished": true } },
      {
        $group: {
          _id: "$player",
          matches: { $sum: 1 },
          wins: { $sum: { $cond: ["$win", 1, 0] } },
          totalMinutes: { $sum: "$durationMinutes" },
          gameSet: { $addToSet: "$gameName" },
        },
      },
      {
        $project: {
          _id: 0,
          player: "$_id",
          matches: 1,
          wins: 1,
          losses: { $subtract: ["$matches", "$wins"] },
          winRate: {
            $round: [
              { $multiply: [{ $divide: ["$wins", "$matches"] }, 100] },
              1,
            ],
          },
          totalMinutes: 1,
          games: "$gameSet",
        },
      },
      { $sort: { winRate: -1, wins: -1, matches: -1, player: 1 } },
    ];

    const rows = (await StatsDelta.aggregate(
      pipeline as Parameters<typeof StatsDelta.aggregate>[0],
    )) as unknown as Omit<LeaderboardRow, "rank">[];

    return {
      totalMatches,
      rows: rows.map((row, index) => ({ ...row, rank: index + 1 })),
    };
  }

  /**
   * 按 matches 源记录直接重算某局流水：删除非当前版本残留，补齐当前版本。
   * 写操作中途失败 / 进程异常退出后，调用即可恢复一致。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async repairMatch(matchId: any): Promise<void> {
    const match = await Match.findById(matchId);
    if (!match) {
      await rollbackDeltas(matchId);
      return;
    }
    // 无条件清空该对局流水后按当前源记录重建：
    // 既能处理旧版本残留，也能兜住同版本半批插入的残缺流水。
    await StatsDelta.deleteMany({ matchId });
    await applyDeltas(matchId, match.revision, {
      participants: match.participants,
      winners: match.winners,
      durationMinutes: match.durationMinutes,
      gameName: match.game!.name,
      playedAt: match.playedAt,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sameAsStored(match: any, payload: MatchPayload): boolean {
    if (!match || !match.game) {
      return false;
    }
    return (
      match.game.name === payload.gameName &&
      match.game.category === payload.category &&
      match.durationMinutes === payload.durationMinutes &&
      match.note === payload.note &&
      sameStringSet(match.participants, payload.participants) &&
      sameStringSet(match.winners, payload.winners)
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toView(match: any): MatchView {
    return {
      id: String(match._id),
      clientRequestId: match.clientRequestId,
      game: { name: match.game.name, category: match.game.category },
      participants: [...match.participants],
      winners: [...match.winners],
      durationMinutes: match.durationMinutes,
      playedAt: new Date(match.playedAt).toISOString(),
      note: match.note ?? "",
      revision: match.revision,
      createdAt: new Date(match.createdAt).toISOString(),
      updatedAt: new Date(match.updatedAt).toISOString(),
    };
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function normalizeRequestId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new ConflictError(
      "缺少 X-Request-Id（8-80 位字母/数字/-/_），用于防止重复提交",
    );
  }
  return value;
}
