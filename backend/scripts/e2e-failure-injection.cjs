/* eslint-disable */
/**
 * 故障注入实测：模拟"对局已写入，但排行榜统计步骤失败"。
 * 期望：整个多文档事务回滚——matches 不留记录、player_stats 不变化、不产生负计数。
 *
 *   MONGO_URL=mongodb://127.0.0.1:27017/lpboardgame_test?replicaSet=rs0 \
 *   node scripts/e2e-failure-injection.cjs
 */

const mongoose = require("mongoose");

const MONGO_URL =
  process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/lpboardgame_test?replicaSet=rs0";

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${message}`);
  }
}

async function main() {
  console.log(`\n=== 故障注入实测（MONGO_URL=${MONGO_URL}） ===`);
  await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 });

  // 直接使用编译后的模型（dist），避免再跑一次 ts 编译。
  const { Match } = require("../dist/modules/records/match.model.js");
  const { PlayerStats } = require("../dist/modules/records/player-stats.model.js");

  await Match.deleteMany({ matchId: /^fail-/ });
  await PlayerStats.deleteMany({ playerName: { $in: ["Zed", "Xena"] } });

  // 预置一场真实对局，制造非零基线。
  await mongoose.connection.transaction(async (session) => {
    await new Match({
      matchId: "fail-base",
      boardGame: "基线局",
      participantNames: ["Zed", "Xena"],
      winnerNames: ["Zed"],
      durationMinutes: 10,
      playedAt: new Date(),
      note: "",
      status: "finished",
      revision: 0,
    }).save({ session });
    await PlayerStats.bulkWrite(
      [
        {
          updateOne: {
            filter: { playerName: "Zed" },
            update: { $inc: { matchesCount: 1, winsCount: 1 }, $set: { updatedAt: new Date() } },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { playerName: "Xena" },
            update: { $inc: { matchesCount: 1 }, $set: { updatedAt: new Date() } },
            upsert: true,
          },
        },
      ],
      { session }
    );
  });

  const baseline = await PlayerStats.find({}).lean();
  console.log("基线统计：", baseline.map((d) => `${d.playerName}=M${d.matchesCount}/W${d.winsCount}`).join(", "));

  // ---- 注入：排行榜步骤抛错 ----
  console.log("\n[1] 对局保存后、统计更新时强制失败");
  const originalBulkWrite = PlayerStats.bulkWrite.bind(PlayerStats);
  let injected = false;
  PlayerStats.bulkWrite = function (ops, options) {
    injected = true;
    throw new Error("INJECTED_FAILURE: 模拟排行榜写入失败");
  };

  let transactionFailed = false;
  try {
    await mongoose.connection.transaction(async (session) => {
      await new Match({
        matchId: "fail-new",
        boardGame: "故障局",
        participantNames: ["Zed", "Xena"],
        winnerNames: ["Xena"],
        durationMinutes: 11,
        playedAt: new Date(),
        note: "",
        status: "finished",
        revision: 0,
      }).save({ session });
      await PlayerStats.bulkWrite([], { session }); // 必定抛错
    });
  } catch (error) {
    transactionFailed = true;
    assert(injected, "故障点确实被触发");
    assert(error.message.includes("INJECTED_FAILURE"), "事务抛出了注入的错误");
  }
  PlayerStats.bulkWrite = originalBulkWrite;
  assert(transactionFailed, "事务因注入错误而失败");

  const leftover = await Match.findOne({ matchId: "fail-new" }).lean();
  assert(leftover === null, "fail-new 对局未残留在 matches（插入已回滚）");

  const after = await PlayerStats.find({}).sort({ playerName: 1 }).lean();
  const baselineMap = new Map(baseline.map((d) => [d.playerName, d]));
  let statsUnchanged = after.length === baseline.length;
  for (const doc of after) {
    const base = baselineMap.get(doc.playerName);
    if (!base || base.matchesCount !== doc.matchesCount || base.winsCount !== doc.winsCount) {
      statsUnchanged = false;
    }
  }
  assert(statsUnchanged, "player_stats 与故障前完全一致，没有半截写入");

  // ---- 注入：冲销阶段更新行数不符（模拟余额不足守卫拦截） ----
  console.log("\n[2] 修正时冲销旧战绩但统计行缺失：更新数为 0，事务必须回滚");
  // 先人为删掉 Zed 的统计行，制造"对局存在但排行榜缺行"的不一致场景。
  await PlayerStats.deleteOne({ playerName: "Zed" });

  let rollbackError = null;
  try {
    await mongoose.connection.transaction(async (session) => {
      const doc = await Match.findOne({ matchId: "fail-base" }, null, { session });
      doc.winnerNames = ["Xena"];
      // 直接模拟 service 的冲销 bulkWrite（负增量 upsert=false + 守卫过滤）。
      const result = await PlayerStats.bulkWrite(
        [
          {
            updateOne: {
              filter: { playerName: "Zed", matchesCount: { $gte: 1 } },
              update: { $inc: { matchesCount: -1, winsCount: -1 }, $set: { updatedAt: new Date() } },
              upsert: false,
            },
          },
        ],
        { session }
      );
      const touched = (result.upsertedCount ?? 0) + (result.matchedCount ?? 0);
      if (touched !== 1) {
        throw new Error("STATS_INCONSISTENT");
      }
      await doc.save({ session });
    });
  } catch (error) {
    rollbackError = error;
  }
  assert(rollbackError !== null && rollbackError.message === "STATS_INCONSISTENT", "冲销守卫检测到不一致并中止");
  const baseAfter = await Match.findOne({ matchId: "fail-base" }).lean();
  assert(baseAfter.winnerNames.join() === "Zed", "fail-base 对局修改已回滚，胜者仍为 Zed");

  // 恢复现场，避免污染后续 E2E。
  await Match.deleteMany({ matchId: /^fail-/ });
  await PlayerStats.deleteMany({});

  await mongoose.disconnect();
  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
