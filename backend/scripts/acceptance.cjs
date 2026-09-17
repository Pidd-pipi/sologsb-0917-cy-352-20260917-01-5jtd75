/* eslint-disable */
/**
 * 需求验收实测（全新库）：提交 → 修正 → 并发重复提交 → 重启回读。
 * 用法：先启动后端连到一个全新库，然后 BASE=... node scripts/acceptance.cjs
 */

const BASE = process.env.BASE ?? "http://127.0.0.1:29512";

const log = (title) => console.log(`\n${title}`);
const json = (r) => r.json();

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  console.log("================ 战绩与排行榜 验收实测 ================");
  console.log("目标后端：", BASE);

  // 1) 录入：桌游、参与者、胜者、时长
  log("[1] 录入对局 G-1：卡坦岛 / Alice、Bob、Carol / 胜者 Alice / 45 分钟");
  const c1 = await call("POST", "/api/records/matches", {
    matchId: "G-1",
    boardGame: "卡坦岛",
    participantNames: ["Alice", "Bob", "Carol"],
    winnerNames: ["Alice"],
    durationMinutes: 45,
  });
  console.log("   HTTP", c1.status, "revision=", c1.body?.match?.revision);

  const c2 = await call("POST", "/api/records/matches", {
    matchId: "G-2",
    boardGame: "璀璨宝石",
    participantNames: ["Alice", "Bob"],
    winnerNames: ["Bob"],
    durationMinutes: 30,
  });
  console.log("[1b] 录入对局 G-2：HTTP", c2.status);

  const lb1 = (await call("GET", "/api/records/leaderboard")).body.leaderboard;
  console.log("   排行榜：");
  for (const row of lb1) {
    console.log(
      `   #${row.rank} ${row.playerName}  ${row.matchesCount}场 ${row.winsCount}胜 ${(row.winRate * 100).toFixed(1)}%`
    );
  }

  // 2) 修正：旧胜负先冲销再计新结果
  log("[2] 修正 G-1：胜者改为 Bob，Carol 换成 Dave，时长 50");
  const u1 = await call("PUT", "/api/records/matches/G-1", {
    boardGame: "卡坦岛",
    participantNames: ["Alice", "Bob", "Dave"],
    winnerNames: ["Bob"],
    durationMinutes: 50,
    status: "finished",
  });
  console.log("   HTTP", u1.status, "revision=", u1.body?.match?.revision, "胜者=", u1.body?.match?.winnerNames);

  const lb2 = (await call("GET", "/api/records/leaderboard")).body.leaderboard;
  const find = (name) => lb2.find((r) => r.playerName === name);
  console.log("   修正后排行榜：");
  for (const row of lb2) {
    console.log(
      `   #${row.rank} ${row.playerName}  ${row.matchesCount}场 ${row.winsCount}胜 ${(row.winRate * 100).toFixed(1)}%`
    );
  }
  console.log(
    "   校验：Carol 应完全消失（1 场被冲销），实际",
    find("Carol") ? `仍在(${JSON.stringify(find("Carol"))})` : "已消失 ✓"
  );
  console.log("   Dave 新增：", find("Dave") ? `${find("Dave").matchesCount}场${find("Dave").winsCount}胜 ✓` : "缺失 ✗");
  console.log("   Bob：", `${find("Bob").matchesCount}场${find("Bob").winsCount}胜（应为2场2胜）`);

  // 3) 并发重复提交
  log("[3] 同一 matchId G-DUP 并发提交 20 次");
  const payload = {
    matchId: "G-DUP",
    boardGame: "重复对决",
    participantNames: ["Eve", "Frank"],
    winnerNames: ["Eve"],
    durationMinutes: 20,
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => call("POST", "/api/records/matches", payload)));
  const created = results.filter((r) => r.status === 201).length;
  const conflict = results.filter((r) => r.status === 409).length;
  console.log(`   201=${created}（应为1），409=${conflict}（应为19）`);

  const dupList = (await call("GET", "/api/records/matches")).body.matches.filter((m) => m.matchId === "G-DUP");
  console.log(`   matches 中 G-DUP 记录数=${dupList.length}（应为1）`);
  const eve = (await call("GET", "/api/records/leaderboard")).body.leaderboard.find((r) => r.playerName === "Eve");
  console.log(`   Eve 统计=${eve.matchesCount}场${eve.winsCount}胜（应1场1胜，没有重复计分）`);

  // 4) 非法修正回滚
  log("[4] 把 G-2 修正成非法内容（胜者不在参与者），必须回滚");
  const bad = await call("PUT", "/api/records/matches/G-2", {
    boardGame: "璀璨宝石",
    participantNames: ["Alice", "Bob"],
    winnerNames: ["Ghost"],
    durationMinutes: 30,
    status: "finished",
  });
  console.log("   HTTP", bad.status, bad.body?.message);
  const g2 = (await call("GET", "/api/records/matches/G-2")).body.match;
  console.log(`   G-2 回滚后 revision=${g2.revision}（应0），胜者=${g2.winnerNames.join()}（应Bob）`);

  console.log("\n================ 验收脚本结束（重启回读见外部验证） ================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
