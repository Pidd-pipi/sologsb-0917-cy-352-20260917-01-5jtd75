/**
 * 故障注入实测：写战绩流水中途失败时，战绩与排行榜不能不一致。
 * 通过 require 缓存替换打桩 applyDeltas（在 match.service 加载前替换）。
 */
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

let results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const mongod = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
  const uri = mongod.getUri("fault");
  await mongoose.connect(uri);

  const stats = require("../dist/modules/matches/stats.service");
  const { ensureIndexes } = require("../dist/modules/matches/match.model");
  await ensureIndexes();

  const realApply = stats.applyDeltas;

  // 让下一次 applyDeltas 失败，再下一次恢复（模拟瞬时故障，运行时 catch 自愈路径）
  let failOnce = false;
  stats.applyDeltas = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("模拟：insertMany 中途失败");
    }
    return realApply(...args);
  };

  const { MatchService } = require("../dist/modules/matches/match.service");
  const service = new MatchService();
  const { Match, StatsDelta } = require("../dist/modules/matches/match.model");

  try {
    // ---- 场景 A：提交时计流水失败 ----
    failOnce = true;
    let threw = false;
    let matchA;
    try {
      matchA = await service.createMatch(
        {
          gameName: "电力公司", category: "策略",
          participants: ["P1", "P2", "P3"], winners: ["P1"], durationMinutes: 90,
        },
        "fault-rid-0001",
      );
    } catch (error) {
      threw = true;
      console.log("提交如期抛错:", error.message);
    }
    report("提交时计流水失败会向上抛错（请求不会假成功）", threw);

    const docA = await Match.findOne({ clientRequestId: "fault-rid-0001" });
    report("失败后源对局仍存在（事实来源不丢）", !!docA);
    const deltasA = await StatsDelta.find({ matchId: docA._id }).lean();
    report(
      "运行时自愈：失败后流水仍完整（3 条 revision=1，胜负正确）",
      deltasA.length === 3 &&
        deltasA.every((d) => d.revision === 1) &&
        deltasA.find((d) => d.player === "P1").win === true &&
        deltasA.find((d) => d.player === "P2").win === false,
      `deltas=${deltasA.length}`,
    );
    const board = await service.getLeaderboard();
    report("排行榜仍可正常聚合", board.rows.length === 3 && board.totalMatches === 1);

    // ---- 场景 B：修正时“冲销成功、重放失败” ----
    failOnce = true;
    let threw2 = false;
    try {
      await service.correctMatch(String(docA._id), {
        gameName: "电力公司", category: "策略",
        participants: ["P1", "P2", "P3"], winners: ["P2"], durationMinutes: 90,
      });
    } catch (error) {
      threw2 = true;
      console.log("修正如期抛错:", error.message);
    }
    report("修正重放失败会向上抛错", threw2);

    const docB = await Match.findById(docA._id).lean();
    report("源记录已推进到新版本（revision=2，胜者=P2）", docB.revision === 2 && docB.winners[0] === "P2");
    const deltasB = await StatsDelta.find({ matchId: docA._id }).lean();
    report(
      "运行时自愈：无旧版本残留，新版本流水完整",
      deltasB.length === 3 &&
        deltasB.every((d) => d.revision === 2) &&
        deltasB.find((d) => d.player === "P2").win === true &&
        deltasB.find((d) => d.player === "P1").win === false,
      `revisions=[${deltasB.map((d) => d.revision).join(",")}]`,
    );
    const board2 = await service.getLeaderboard();
    const p1 = board2.rows.find((r) => r.player === "P1");
    const p2 = board2.rows.find((r) => r.player === "P2");
    report("修正失败后排行榜反映新版本（P1 0 胜 / P2 1 胜）", p1.wins === 0 && p2.wins === 1);

    // ---- 场景 C：故障持续，进程以“不一致中间态”退出 → 重启对账修复 ----
    // 直接制造中间态：源记录 revision=3，但流水停在 revision=2
    await Match.collection.updateOne({ _id: docA._id }, { $set: { winners: ["P3"], revision: 3 } });
    const staleState = await StatsDelta.find({ matchId: docA._id }).distinct("revision");
    report("已构造中间态（源记录 r3 / 流水 r2）", JSON.stringify(staleState) === "[2]");

    const { reconcileAllStats } = stats;
    const repair = await reconcileAllStats();
    report("启动对账识别并修复了该对局", repair.repaired === 1, `repaired=${repair.repaired}`);
    const deltasC = await StatsDelta.find({ matchId: docA._id }).lean();
    report(
      "对账后：旧 r2 流水清空，r3 流水完整且胜负正确",
      deltasC.length === 3 &&
        deltasC.every((d) => d.revision === 3) &&
        deltasC.find((d) => d.player === "P3").win === true &&
        deltasC.find((d) => d.player === "P1").win === false &&
        deltasC.find((d) => d.player === "P2").win === false,
    );
    const board3 = await service.getLeaderboard();
    report("对账后排行榜与源记录一致（P3 100% 居首）", board3.rows[0].player === "P3" && board3.rows[0].winRate === 100);

    // 再次对账应当无操作（幂等）
    const repair2 = await reconcileAllStats();
    report("对账幂等：再次执行修复数为 0", repair2.repaired === 0);
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== fault 结果: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
