/* eslint-disable */
/**
 * 战绩与排行榜闭环端到端实测脚本（无外部测试框架依赖）。
 *
 * 运行前：后端已启动并连接到一个干净的测试库。
 *   BASE=http://127.0.0.1:29512 node scripts/e2e-records.cjs
 *
 * 覆盖：
 *  1. 校验规则（单人对局 / 胜者不在参与者中 / 缺时长）
 *  2. 正常提交 + 排行榜物化
 *  3. 并发重复提交同一 matchId：恰好一场计分
 *  4. 并发提交不同对局：全部成功
 *  5. 修正对局：旧胜负完整冲销后计入新结果
 *  6. 修正为非法内容：事务回滚，战绩与排行榜保持一致
 *  7. 进行中对局不计分
 *  8. 直连 Mongo 核对 matches 与 player_stats 完全一致（重算对账）
 */

const { MongoClient } = require("mongodb");

const BASE = process.env.BASE ?? "http://127.0.0.1:29512";
const MONGO_URL =
  process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/lpboardgame_test?replicaSet=rs0";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function postMatch(payload) {
  return request("/api/records/matches", { method: "POST", body: JSON.stringify(payload) });
}

function putMatch(matchId, payload) {
  return request(`/api/records/matches/${encodeURIComponent(matchId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 直接从 matches 集合重算排行榜，与 player_stats 物化视图对账。 */
async function recomputeFromMatches(db) {
  const matches = await db.collection("matches").find({}).toArray();
  const expected = new Map();

  for (const match of matches) {
    if (match.status !== "finished") {
      continue;
    }
    const participants = new Set(match.participantNames);
    if (participants.size < 2) {
      throw new Error(`脏数据：已结束对局 ${match.matchId} 参与者不足两人`);
    }
    for (const name of match.participantNames) {
      const row = expected.get(name) ?? { matchesCount: 0, winsCount: 0 };
      row.matchesCount += 1;
      expected.set(name, row);
    }
    for (const name of match.winnerNames) {
      if (!participants.has(name)) {
        throw new Error(`脏数据：对局 ${match.matchId} 的胜者 ${name} 不在参与者中`);
      }
      const row = expected.get(name) ?? { matchesCount: 0, winsCount: 0 };
      row.winsCount += 1;
      expected.set(name, row);
    }
  }

  return { expected, matchesCount: matches.length };
}

async function assertStatsConsistent(db, label) {
  const { expected, matchesCount } = await recomputeFromMatches(db);
  const statsDocs = await db.collection("player_stats").find({}).toArray();
  const actual = new Map(statsDocs.map((doc) => [doc.playerName, doc]));

  let ok = true;
  const details = [];

  for (const [name, exp] of expected) {
    const act = actual.get(name);
    if (!act) {
      ok = false;
      details.push(`缺少玩家统计行：${name}`);
      continue;
    }
    if (act.matchesCount !== exp.matchesCount || act.winsCount !== exp.winsCount) {
      ok = false;
      details.push(
        `${name} 期望 M${exp.matchesCount}/W${exp.winsCount}，实际 M${act.matchesCount}/W${act.winsCount}`
      );
    }
  }

  for (const [name, act] of actual) {
    const exp = expected.get(name);
    if (!exp && (act.matchesCount !== 0 || act.winsCount !== 0)) {
      ok = false;
      details.push(`多余的非零统计行：${name} M${act.matchesCount}/W${act.winsCount}`);
    }
    if (act.winsCount > act.matchesCount || act.matchesCount < 0 || act.winsCount < 0) {
      ok = false;
      details.push(`${name} 统计行出现非法计数`);
    }
  }

  assert(ok, `[一致性] ${label}：matches(${matchesCount}场) 与 player_stats 完全对账${ok ? "" : ` -> ${details.join("; ")}`}`);
  return ok;
}

async function getBoard() {
  const { body, status } = await request("/api/records/leaderboard");
  if (status !== 200) {
    throw new Error(`排行榜接口异常 ${status}`);
  }
  return new Map(body.leaderboard.map((row) => [row.playerName, row]));
}

async function cleanup(db) {
  await db.collection("matches").deleteMany({});
  await db.collection("player_stats").deleteMany({});
}

async function main() {
  console.log(`\n=== 战绩与排行榜 E2E（BASE=${BASE}） ===`);

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db();
  await cleanup(db);

  // ---------- 1. 校验规则 ----------
  console.log("\n[1] 录入校验：只有已结束且至少两名不同玩家、胜者合法才计分");
  {
    const single = await postMatch({
      matchId: "bad-single",
      boardGame: " solo",
      participantNames: ["OnlyOne"],
      winnerNames: ["OnlyOne"],
      durationMinutes: 30,
      status: "finished",
    });
    assert(single.status === 400, "单人已结束对局被拒绝 (400)");

    const badWinner = await postMatch({
      matchId: "bad-winner",
      boardGame: "卡坦岛",
      participantNames: ["A", "B"],
      winnerNames: ["C"],
      durationMinutes: 30,
      status: "finished",
    });
    assert(badWinner.status === 400, "胜者不在参与者中被拒绝 (400)");

    const noDuration = await postMatch({
      matchId: "bad-duration",
      boardGame: "卡坦岛",
      participantNames: ["A", "B"],
      winnerNames: ["A"],
      status: "finished",
    });
    assert(noDuration.status === 400, "缺少时长被拒绝 (400)");

    const dupPlayer = await postMatch({
      matchId: "bad-dup",
      boardGame: "卡坦岛",
      participantNames: ["A", "a"],
      winnerNames: ["A"],
      durationMinutes: 30,
      status: "finished",
    });
    assert(dupPlayer.status === 400, "大小写重复玩家被拒绝 (400)");

    const ongoingWinner = await postMatch({
      matchId: "bad-ongoing",
      boardGame: "卡坦岛",
      participantNames: ["A", "B"],
      winnerNames: ["A"],
      durationMinutes: 30,
      status: "ongoing",
    });
    assert(ongoingWinner.status === 400, "进行中对局携带胜者被拒绝 (400)");

    await assertStatsConsistent(db, "全部非法提交后");
  }

  // ---------- 2. 正常提交 ----------
  console.log("\n[2] 正常提交三场已结束对局");
  {
    const r1 = await postMatch({
      matchId: "m-001",
      boardGame: "卡坦岛",
      participantNames: ["Alice", "Bob", "Carol"],
      winnerNames: ["Alice"],
      durationMinutes: 45,
    });
    assert(r1.status === 201 && r1.body.match.revision === 0, "m-001 提交成功 (201, revision=0)");

    const r2 = await postMatch({
      matchId: "m-002",
      boardGame: "璀璨宝石",
      participantNames: ["Alice", "Bob"],
      winnerNames: ["Bob"],
      durationMinutes: 30,
    });
    assert(r2.status === 201, "m-002 提交成功");

    const r3 = await postMatch({
      matchId: "m-003",
      boardGame: "狼人杀",
      participantNames: ["Bob", "Carol", "Dave"],
      winnerNames: ["Carol", "Dave"],
      durationMinutes: 60,
    });
    assert(r3.status === 201, "m-003（多胜者）提交成功");

    const board = await getBoard();
    assert(board.get("Alice").matchesCount === 2 && board.get("Alice").winsCount === 1, "Alice: 2 场 1 胜");
    assert(board.get("Bob").matchesCount === 3 && board.get("Bob").winsCount === 1, "Bob: 3 场 1 胜");
    assert(board.get("Carol").matchesCount === 2 && board.get("Carol").winsCount === 1, "Carol: 2 场 1 胜");
    assert(board.get("Dave").matchesCount === 1 && board.get("Dave").winsCount === 1, "Dave: 1 场 1 胜");
    assert(board.get("Dave").winRate === 1 && board.get("Dave").rank === 1, "100% 胜率 Dave 排名第一");

    await assertStatsConsistent(db, "三场正常提交后");
  }

  // ---------- 3. 并发重复提交 ----------
  console.log("\n[3] 并发重复提交同一 matchId：只能计一次分");
  {
    const payload = {
      matchId: "dup-race",
      boardGame: "双倍对决",
      participantNames: ["Eve", "Frank"],
      winnerNames: ["Eve"],
      durationMinutes: 25,
    };
    const responses = await Promise.all(Array.from({ length: 12 }, () => postMatch(payload)));
    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);
    assert(created.length === 1, `12 个并发请求只有 1 个 201（实际 ${created.length}）`);
    assert(conflicts.length === 11, `其余 11 个返回 409（实际 ${conflicts.length}）`);

    const count = await db.collection("matches").countDocuments({ matchId: "dup-race" });
    assert(count === 1, "matches 集合中 dup-race 只有一条记录");

    const board = await getBoard();
    assert(board.get("Eve").matchesCount === 1 && board.get("Eve").winsCount === 1, "Eve 只计 1 场 1 胜");
    assert(board.get("Frank").matchesCount === 1 && board.get("Frank").winsCount === 0, "Frank 只计 1 场 0 胜");

    await assertStatsConsistent(db, "并发重复提交后");
  }

  // ---------- 4. 并发不同对局 ----------
  console.log("\n[4] 并发提交 8 个不同对局：全部成功且统计正确");
  {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      postMatch({
        matchId: `par-${index}`,
        boardGame: `并发局${index}`,
        participantNames: [`P${index}`, "Hub"],
        winnerNames: [index % 2 === 0 ? `P${index}` : "Hub"],
        durationMinutes: 10 + index,
      })
    );
    const responses = await Promise.all(tasks);
    const okCount = responses.filter((r) => r.status === 201).length;
    assert(okCount === 8, `8 个并发不同对局全部 201（实际 ${okCount}）`);

    const board = await getBoard();
    assert(board.get("Hub").matchesCount === 8 && board.get("Hub").winsCount === 4, "Hub: 8 场 4 胜");
    await assertStatsConsistent(db, "并发不同对局后");
  }

  // ---------- 5. 修正对局：冲销 + 重计 ----------
  console.log("\n[5] 修正 m-001：胜者 Alice -> Bob，时长 45 -> 50，参与者调整");
  {
    const before = await getBoard();
    const beforeAlice = before.get("Alice");
    const beforeBob = before.get("Bob");

    const res = await putMatch("m-001", {
      boardGame: "卡坦岛(修正)",
      participantNames: ["Alice", "Bob", "Erin"],
      winnerNames: ["Bob"],
      durationMinutes: 50,
      status: "finished",
    });
    assert(res.status === 200 && res.body.match.revision === 1, "m-001 修正成功 (revision=1)");
    assert(res.body.match.winnerNames.join() === "Bob", "新胜者为 Bob");

    const after = await getBoard();
    // Alice: 仍在 m-001 参与者中，但旧的 1 胜被冲销（m-001 胜者改为 Bob）
    assert(after.get("Alice").matchesCount === beforeAlice.matchesCount, "Alice 场次不变（仍是参与者）");
    assert(after.get("Alice").winsCount === beforeAlice.winsCount - 1, "Alice 胜场 -1（旧胜者冲销）");
    // Bob: m-001 场次不变（仍参与），胜场 +1
    assert(after.get("Bob").matchesCount === beforeBob.matchesCount, "Bob 场次不变（仍是参与者）");
    assert(after.get("Bob").winsCount === beforeBob.winsCount + 1, "Bob 胜场 +1");
    // Carol 退出 m-001
    assert(after.get("Carol").matchesCount === 1, "Carol 场次 -1（退出 m-001），仅剩 m-003");
    // Erin 新加入
    assert(after.get("Erin").matchesCount === 1 && after.get("Erin").winsCount === 0, "Erin 新增 1 场 0 胜");

    await assertStatsConsistent(db, "修正 m-001 后");
  }

  // ---------- 6. 非法修正必须回滚 ----------
  console.log("\n[6] 非法修正（胜者不在参与者）整体回滚，不留旧记录残留");
  {
    const beforeBoard = await getBoard();
    const res = await putMatch("m-002", {
      boardGame: "璀璨宝石",
      participantNames: ["Alice", "Bob"],
      winnerNames: ["Hacker"],
      durationMinutes: 30,
      status: "finished",
    });
    assert(res.status === 400, `非法修正被拒绝 (400)，实际 ${res.status}`);

    const getRes = await request("/api/records/matches/m-002");
    assert(getRes.status === 200 && getRes.body.match.revision === 0, "m-002 仍是修正前版本 revision=0");
    assert(getRes.body.match.winnerNames.join() === "Bob", "m-002 胜者仍是 Bob");

    const afterBoard = await getBoard();
    let boardUnchanged = true;
    for (const [name, row] of beforeBoard) {
      const next = afterBoard.get(name);
      if (!next || next.matchesCount !== row.matchesCount || next.winsCount !== row.winsCount) {
        boardUnchanged = false;
      }
    }
    assert(boardUnchanged, "排行榜与修正前完全一致（事务回滚）");
    await assertStatsConsistent(db, "非法修正回滚后");

    // 修正不存在的对局 -> 404，不产生任何数据
    const res404 = await putMatch("not-exist", {
      boardGame: "x",
      participantNames: ["A", "B"],
      winnerNames: ["A"],
      durationMinutes: 10,
    });
    assert(res404.status === 404, "修正不存在对局返回 404");
    await assertStatsConsistent(db, "404 修正后");
  }

  // ---------- 7. 进行中对局不计分，结束后补计 ----------
  console.log("\n[7] 进行中对局不计入排行榜，修正为已结束后补计");
  {
    const res = await postMatch({
      matchId: "live-1",
      boardGame: "长局",
      participantNames: ["Alice", "Grace"],
      winnerNames: [],
      durationMinutes: 200,
      status: "ongoing",
    });
    assert(res.status === 201, "进行中对局创建成功");

    const board = await getBoard();
    assert(!board.has("Grace"), "新玩家 Grace 未出现在排行榜");
    const aliceDuring = board.get("Alice");

    const finish = await putMatch("live-1", {
      boardGame: "长局",
      participantNames: ["Alice", "Grace"],
      winnerNames: ["Grace"],
      durationMinutes: 210,
      status: "finished",
    });
    assert(finish.status === 200 && finish.body.match.revision === 1, "进行中 -> 已结束 修正成功");

    const after = await getBoard();
    assert(after.get("Grace").matchesCount === 1 && after.get("Grace").winsCount === 1, "Grace 补计 1 场 1 胜");
    assert(after.get("Alice").matchesCount === aliceDuring.matchesCount + 1, "Alice 补计 1 场");

    // 反向：已结束修正为进行中，旧胜负应完整冲销
    const reopen = await putMatch("live-1", {
      boardGame: "长局",
      participantNames: ["Alice", "Grace"],
      winnerNames: [],
      durationMinutes: 210,
      status: "ongoing",
    });
    assert(reopen.status === 200, "已结束 -> 进行中 修正成功");
    const reopened = await getBoard();
    assert(!reopened.has("Grace"), "回退为进行中后 Grace 的统计被完整冲销");
    assert(reopened.get("Alice").matchesCount === aliceDuring.matchesCount, "Alice 的补计也被冲销");

    await assertStatsConsistent(db, "进行中/已结束转换后");
  }

  // ---------- 8. 并发修正同一场对局 ----------
  console.log("\n[8] 并发修正同一场对局：不产生负计数/重复计分");
  {
    await postMatch({
      matchId: "edit-race",
      boardGame: "原局",
      participantNames: ["Ivan", "Judy"],
      winnerNames: ["Ivan"],
      durationMinutes: 12,
    });

    const edits = [
      { boardGame: "修正A", participantNames: ["Ivan", "Judy"], winnerNames: ["Judy"], durationMinutes: 13, status: "finished" },
      { boardGame: "修正B", participantNames: ["Ivan", "Judy", "Karl"], winnerNames: ["Karl"], durationMinutes: 14, status: "finished" },
      { boardGame: "修正C", participantNames: ["Ivan", "Judy"], winnerNames: ["Ivan", "Judy"], durationMinutes: 15, status: "finished" },
      { boardGame: "修正D", participantNames: ["Ivan", "Judy"], winnerNames: ["Ivan"], durationMinutes: 16, status: "finished" },
    ];
    const responses = await Promise.all(edits.map((payload) => putMatch("edit-race", payload)));
    const okCount = responses.filter((r) => r.status === 200).length;
    assert(okCount === 4, `4 个并发修正全部有确定结果（200 数量=${okCount}）`);

    const finalRes = await request("/api/records/matches/edit-race");
    assert([13, 14, 15, 16].includes(finalRes.body.match.durationMinutes), "最终只保留一个修正版本，无重复记录");
    const docCount = await db.collection("matches").countDocuments({ matchId: "edit-race" });
    assert(docCount === 1, "edit-race 在 matches 中仍只有一条");

    await assertStatsConsistent(db, "并发修正后");
  }

  console.log("\n[9] 最终全量对账");
  await assertStatsConsistent(db, "全部场景结束");

  const totalMatches = await db.collection("matches").countDocuments({});
  const totalStats = await db.collection("player_stats").countDocuments({});
  console.log(`\nmatches 文档数=${totalMatches}，player_stats 文档数=${totalStats}`);

  await client.close();

  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  if (failed > 0) {
    console.log("失败项：");
    for (const item of failures) {
      console.log(`  - ${item}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("E2E 脚本异常：", error);
  process.exit(1);
});
