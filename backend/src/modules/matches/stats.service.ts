import { Match, StatsDelta, type MatchId } from "./match.model";
import type { MatchPayload } from "./match.types";

/**
 * 为某局的指定版本写入战绩流水（参与者每人一条，胜负各计）。
 * 依赖 (matchId, revision, player) 唯一索引：并发/重试重放同版本不会重复计分，
 * 重复的 InsertMany 批次 ordered=false 时忽略唯一键冲突即可幂等。
 */
export async function applyDeltas(
  matchId: MatchId,
  revision: number,
  payload: Pick<MatchPayload, "participants" | "winners" | "durationMinutes" | "gameName" | "playedAt">,
): Promise<void> {
  const docs = payload.participants.map((player) => ({
    matchId,
    revision,
    player,
    gameName: payload.gameName,
    win: payload.winners.includes(player),
    durationMinutes: payload.durationMinutes,
    playedAt: payload.playedAt,
  }));
  await StatsDelta.insertMany(docs, { ordered: false }).catch((error) => {
    // 11000 = 唯一键冲突：相同版本流水已存在（并发重放），属于幂等成功
    if (error?.code === 11000) {
      return;
    }
    throw error;
  });
}

/** 完整冲销某局旧版本的胜负流水（物理删除，不留旧记录） */
export async function rollbackDeltas(matchId: MatchId): Promise<number> {
  const result = await StatsDelta.deleteMany({ matchId });
  return result.deletedCount ?? 0;
}

/**
 * 启动自愈：以 matches 源记录为准，逐局核对流水。
 * - 存在非当前版本流水（上次修正中途失败的残留）→ 删除并按当前版本重建
 * - 当前版本流水缺失/不全 → 补齐（唯一索引保证不会重复）
 * 这样即使写入序列中途进程崩溃，战绩与排行榜也会恢复一致。
 */
export async function reconcileAllStats(): Promise<{ repaired: number }> {
  const matches = await Match.find({}).lean();
  let repaired = 0;

  for (const match of matches as unknown as Array<{
    _id: MatchId;
    revision: number;
    participants: string[];
    winners: string[];
    durationMinutes: number;
    playedAt: Date;
    game: { name: string };
  }>) {
    const matchId = match._id;
    const current = await StatsDelta.find({ matchId }).lean();
    const stale = current.filter((delta) => delta.revision !== match.revision);
    const currentRevisionDeltas = current.filter(
      (delta) => delta.revision === match.revision,
    );
    const expectedPlayers = new Set(match.participants);
    const actualPlayers = new Set(currentRevisionDeltas.map((delta) => delta.player));
    const playersMissing =
      stale.length > 0 ||
      currentRevisionDeltas.length !== expectedPlayers.size ||
      [...expectedPlayers].some((player) => !actualPlayers.has(player));

    if (!playersMissing) {
      continue;
    }

    if (stale.length > 0) {
      await StatsDelta.deleteMany({
        matchId,
        revision: { $ne: match.revision },
      });
    }
    await applyDeltas(matchId, match.revision, {
      participants: match.participants,
      winners: match.winners,
      durationMinutes: match.durationMinutes,
      gameName: match.game.name,
      playedAt: match.playedAt,
    });
    repaired += 1;
  }

  return { repaired };
}
