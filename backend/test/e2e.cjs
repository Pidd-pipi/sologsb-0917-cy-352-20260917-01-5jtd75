/**
 * 战绩与排行榜闭环端到端实测：
 * 1. 真实 mongod（mongodb-memory-server，固定 dbpath 落盘）
 * 2. 编译后的后端以子进程方式启动/停止/重启（验证重启回读）
 * 3. 全程走 HTTP，并直连数据库校验“源记录 vs 战绩流水”一致性不变量
 */
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const mongoose = require("mongoose");

const PORT = 29520;
const MONGO_PORT = 27018;
const DB_PATH = path.join(__dirname, ".testdb");
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = `mongodb://127.0.0.1:${MONGO_PORT}/e2e?directConnection=true`;

let results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond, name, detail) {
  report(name, !!cond, detail ?? "");
  if (!cond) throw new Error(`断言失败: ${name}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let serverProcess = null;
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "..", "dist", "index.js")],
      {
        env: {
          ...process.env,
          PORT: String(PORT),
          DATABASE_URL,
          DB_HOST: "127.0.0.1",
          DB_PORT: String(MONGO_PORT),
          DB_NAME: "e2e",
          DB_USER: "",
          DB_PASSWORD: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("服务启动超时"));
      }
    }, 30000);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (process.env.VERBOSE) process.stdout.write(`[server] ${text}`);
      if (text.includes("API listening") && !settled) {
        settled = true;
        clearTimeout(timer);
        serverProcess = child;
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (process.env.VERBOSE) process.stderr.write(`[server] ${text}`);
      if (/Failed to start|EADDRINUSE/.test(text) && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`服务提前退出 code=${code}`));
      }
    });
  });
}
async function stopServer() {
  if (!serverProcess) return;
  const exit = new Promise((resolve) => serverProcess.on("exit", resolve));
  serverProcess.kill("SIGTERM");
  await exit;
  serverProcess = null;
}

async function api(method, url, { body, headers } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}
function reqId() {
  return `rid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- 直连数据库做一致性校验 ----
async function dbState() {
  const db = mongoose.connection.db;
  const matches = await db.collection("matches").find({}).toArray();
  const deltas = await db.collection("stats_deltas").find({}).toArray();
  const byMatch = new Map(matches.map((m) => [String(m._id), m]));
  const inconsistencies = [];
  for (const m of matches) {
    const mine = deltas.filter((d) => String(d.matchId) === String(m._id));
    const stale = mine.filter((d) => d.revision !== m.revision);
    if (stale.length) inconsistencies.push(`match ${m._id} 残留 ${stale.length} 条旧版本流水`);
    if (mine.length !== new Set(m.participants).size)
      inconsistencies.push(`match ${m._id} 流水数 ${mine.length} != 参与者 ${new Set(m.participants).size}`);
    for (const d of mine) {
      const expectedWin = m.winners.includes(d.player);
      if (expectedWin !== d.win) inconsistencies.push(`match ${m._id} 玩家 ${d.player} 胜负标记错误`);
    }
  }
  for (const d of deltas) {
    if (!byMatch.has(String(d.matchId))) inconsistencies.push(`流水 ${d._id} 找不到源对局`);
  }
  return { matches, deltas, inconsistencies };
}

async function expectConsistent(label) {
  const state = await dbState();
  assert(state.inconsistencies.length === 0, `一致性不变量（${label}）`, state.inconsistencies.join("; ") || `matches=${state.matches.length} deltas=${state.deltas.length}`);
  return state;
}

async function main() {
  fs.rmSync(DB_PATH, { recursive: true, force: true });
  fs.mkdirSync(DB_PATH, { recursive: true });

  const mongod = await MongoMemoryServer.create({
    binary: { version: "7.0.14" },
    instance: { dbPath: DB_PATH, port: MONGO_PORT },
  });
  console.log(`mongod 已启动（落盘目录 ${DB_PATH}）: ${mongod.getUri()}`);

  await mongoose.connect(DATABASE_URL);

  try {
    // ========== 1. 首次启动 + 提交 ==========
    await startServer();
    console.log("\n--- 1. 提交对局 ---");

    const bodyA = {
      gameName: "卡坦岛", category: "策略",
      participants: ["阿甲", "阿乙", "阿丙"], winners: ["阿甲"],
      durationMinutes: 60, note: "首局",
    };
    const ridA = reqId();
    const r1 = await api("POST", "/api/matches", { body: bodyA, headers: { "X-Request-Id": ridA } });
    assert(r1.status === 201, "提交对局 A 返回 201", `revision=${r1.json.data.revision}`);
    const matchA = r1.json.data;

    const bodyB = {
      gameName: "璀璨宝石", category: "聚会",
      participants: ["阿甲", "阿乙"], winners: ["阿乙"],
      durationMinutes: 40,
    };
    const ridB = reqId();
    const r2 = await api("POST", "/api/matches", { body: bodyB, headers: { "X-Request-Id": ridB } });
    assert(r2.status === 201, "提交对局 B 返回 201");
    const matchB = r2.json.data;

    let state = await expectConsistent("两次提交后");
    assert(state.matches.length === 2, "源对局共 2 条");
    assert(state.deltas.length === 5, "战绩流水共 5 条（3+2）");

    // ========== 2. 并发重复提交 ==========
    console.log("\n--- 2. 并发重复提交（同 X-Request-Id × 10）---");
    const dupResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        api("POST", "/api/matches", { body: bodyA, headers: { "X-Request-Id": ridA } }),
      ),
    );
    const ids = new Set(dupResults.map((r) => r.json.data?.id));
    assert(ids.size === 1 && [...ids][0] === matchA.id, "10 个并发重复提交返回同一条对局", `id=${matchA.id}`);
    assert(dupResults.every((r) => r.status === 201), "重复提交全部幂等返回 201");
    state = await expectConsistent("并发重复提交后");
    assert(state.matches.length === 2, "重复提交未新增对局");
    assert(state.deltas.length === 5, "重复提交未重复计分（流水仍为 5）");

    // ========== 3. 非法对局不能参与统计 ==========
    console.log("\n--- 3. 非法提交 ---");
    const bad1 = await api("POST", "/api/matches", {
      body: { gameName: " solo ", category: "x", participants: ["独狼"], winners: ["独狼"], durationMinutes: 10 },
      headers: { "X-Request-Id": reqId() },
    });
    assert(bad1.status === 400, "单人对局拒绝（至少 2 名不同玩家）", bad1.json.message);

    const bad2 = await api("POST", "/api/matches", {
      body: { gameName: "g", category: "x", participants: ["A", "B"], winners: ["C"], durationMinutes: 10 },
      headers: { "X-Request-Id": reqId() },
    });
    assert(bad2.status === 400, "胜者不在参与者中拒绝", bad2.json.message);

    const bad3 = await api("POST", "/api/matches", {
      body: { gameName: "g", category: "x", participants: ["A", "B"], winners: ["A"], durationMinutes: 0 },
      headers: { "X-Request-Id": reqId() },
    });
    assert(bad3.status === 400, "时长 0 拒绝", bad3.json.message);

    const bad4 = await api("POST", "/api/matches", { body: bodyA });
    assert(bad4.status === 409, "缺少幂等键拒绝（防止无键重试）", bad4.json.message);

    state = await expectConsistent("非法提交后");
    assert(state.matches.length === 2 && state.deltas.length === 5, "失败请求未留下任何记录");

    // ========== 4. 胜率榜 ==========
    console.log("\n--- 4. 胜率榜 ---");
    const board1 = await api("GET", "/api/leaderboard");
    assert(board1.status === 200 && board1.json.totalMatches === 2, "排行榜返回且对局总数 2");
    const find1 = (p) => board1.json.rows.find((r) => r.player === p);
    assert(find1("阿甲").matches === 2 && find1("阿甲").wins === 1 && find1("阿甲").winRate === 50, "阿甲 2 局 1 胜 50%", JSON.stringify(find1("阿甲")));
    assert(find1("阿乙").wins === 1 && find1("阿乙").winRate === 50, "阿乙 2 局 1 胜 50%");
    assert(find1("阿丙").wins === 0 && find1("阿丙").winRate === 0, "阿丙 1 局 0 胜 0%");
    assert(find1("阿甲").totalMinutes === 100, "阿甲总时长 100 分钟");

    // ========== 5. 修正：旧胜负完整冲销再计新结果 ==========
    console.log("\n--- 5. 修正对局 A（胜者阿甲 → 阿丙）---");
    const correctedA = {
      gameName: "卡坦岛", category: "策略",
      participants: ["阿甲", "阿乙", "阿丙"], winners: ["阿丙"],
      durationMinutes: 60, note: "首局-更正胜者",
    };
    const c1 = await api("PUT", `/api/matches/${matchA.id}`, { body: correctedA });
    assert(c1.status === 200, "修正返回 200", `revision=${c1.json.data.revision}, rolledBack=${c1.json.rolledBack}`);
    assert(c1.json.data.revision === 2, "版本号推进为 2");
    assert(c1.json.rolledBack === 3, "旧版本 3 条胜负流水被完整冲销");

    state = await expectConsistent("修正后");
    const aDeltas = state.deltas.filter((d) => String(d.matchId) === matchA.id);
    assert(aDeltas.every((d) => d.revision === 2), "不存在任何旧版本流水（不留旧记录）");
    assert(aDeltas.find((d) => d.player === "阿丙").win === true, "阿丙已计胜");
    assert(aDeltas.find((d) => d.player === "阿甲").win === false, "阿甲旧胜已冲销");

    const board2 = await api("GET", "/api/leaderboard");
    const find2 = (p) => board2.json.rows.find((r) => r.player === p);
    assert(find2("阿丙").wins === 1 && find2("阿丙").winRate === 100, "修正后阿丙 1 胜 100% 登顶", `rank=${find2("阿丙").rank}`);
    assert(find2("阿甲").wins === 0 && find2("阿甲").winRate === 0, "修正后阿甲 0 胜（旧胜未残留）", JSON.stringify(find2("阿甲")));
    assert(find2("阿乙").wins === 1 && find2("阿乙").winRate === 50, "阿乙仍 1 胜 50%");

    // 同内容重复修正幂等
    const c2 = await api("PUT", `/api/matches/${matchA.id}`, { body: correctedA });
    assert(c2.status === 200 && c2.json.data.revision === 2 && c2.json.rolledBack === 0, "同内容重复修正不冲销不升版");
    await expectConsistent("重复修正后");

    // ========== 6. 并发修正冲突 ==========
    console.log("\n--- 6. 并发修正冲突（6 个互异修正同时提交，均钉住 expectedRevision=2）---");
    // 六个请求内容互不相同：无论何时到达，都不可能命中“与当前存储相同”的幂等分支
    const parallelWinners = ["阿甲", "阿丁", "阿戊", "阿己", "阿庚", "阿辛"];
    const parallel = await Promise.all(
      parallelWinners.map((w) =>
        api("PUT", `/api/matches/${matchA.id}`, {
          body: {
            gameName: "卡坦岛", category: "策略",
            participants: [w, "阿乙", "阿丙"], winners: [w],
            durationMinutes: 60, expectedRevision: 2,
          },
        }),
      ),
    );
    const okCount = parallel.filter((r) => r.status === 200).length;
    const conflictCount = parallel.filter((r) => r.status === 409).length;
    assert(okCount === 1 && conflictCount === 5, `仅 1 个修正成功，5 个冲突 409（实际 200×${okCount}, 409×${conflictCount}）`);
    state = await expectConsistent("并发修正后");
    const aDoc = state.matches.find((m) => String(m._id) === matchA.id);
    assert(aDoc.revision === 3, "版本只推进一次（revision=3）");
    assert(state.deltas.length === 5, "流水总数仍为 5，无重复计分");
    const winningWinner = aDoc.winners[0];
    assert(parallelWinners.includes(winningWinner), `最终胜者为并发胜出者之一（${winningWinner}）`);
    const winningDeltas = state.deltas.filter((d) => String(d.matchId) === matchA.id);
    assert(
      winningDeltas.length === 3 &&
        winningDeltas.every((d) => d.revision === 3) &&
        winningDeltas.find((d) => d.player === winningWinner)?.win === true &&
        winningDeltas.filter((d) => d.win).length === 1,
      "胜出修正的 3 条流水完整且仅 1 胜",
    );

    // 基于旧版本再修正 → 409
    const stale = await api("PUT", `/api/matches/${matchA.id}`, {
      body: { ...correctedA, winners: ["阿甲"], expectedRevision: 1 },
    });
    assert(stale.status === 409, "基于过期版本修正拒绝");
    await expectConsistent("过期修正后");

    // 不存在的对局
    const missing = await api("PUT", `/api/matches/${new mongoose.Types.ObjectId()}`, { body: correctedA });
    assert(missing.status === 404, "修正不存在对局返回 404");

    // ========== 7. 服务重启回读 ==========
    console.log("\n--- 7. 重启服务后回读 ---");
    await stopServer();
    await startServer();
    const list = await api("GET", "/api/matches");
    assert(list.status === 200 && list.json.data.length === 2, "重启后对局仍为 2 条");
    const board3 = await api("GET", "/api/leaderboard");
    assert(board3.json.totalMatches === 2, "重启后排行榜对局总数仍为 2");
    const find3 = (p) => board3.json.rows.find((r) => r.player === p);
    const winningPlayer = aDoc.winners[0];
    assert(find3(winningPlayer).wins === 1, `重启后当前胜者 ${winningPlayer} 战绩保持`, JSON.stringify(find3(winningPlayer)));
    assert(board3.json.rows.every((r) => r.matches === r.wins + r.losses), "重启后胜负场次守恒");
    await expectConsistent("重启后");

    // ========== 8. 模拟崩溃残留 → 启动自愈 ==========
    console.log("\n--- 8. 注入中途失败残留（旧版本流水 + 当前版本缺条）后重启自愈 ---");
    await stopServer();
    const deltasCol = mongoose.connection.db.collection("stats_deltas");
    // 8a. 注入一条 revision=2 的旧残留
    await deltasCol.insertOne({
      matchId: aDoc._id, revision: 2, player: "幽灵玩家", gameName: "卡坦岛",
      win: true, durationMinutes: 60, playedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    // 8b. 删掉当前版本一条流水
    await deltasCol.deleteOne({ matchId: aDoc._id, revision: 3, player: winningPlayer });
    const beforeFix = await dbState();
    assert(beforeFix.inconsistencies.length >= 2, "已确认注入了不一致（残留+缺条）", beforeFix.inconsistencies.join("; "));

    await startServer(); // 启动时 reconcileAllStats
    await sleep(500);
    state = await expectConsistent("自愈后");
    assert(!state.deltas.some((d) => d.player === "幽灵玩家"), "旧版本残留已清除");
    assert(state.deltas.some((d) => String(d.matchId) === matchA.id && d.player === winningPlayer && d.revision === 3), "缺失的当前版本流水已补齐");
    const board4 = await api("GET", "/api/leaderboard");
    assert(!board4.json.rows.some((r) => r.player === "幽灵玩家"), "幽灵玩家不进入排行榜");

    // ========== 9. 修正流程运行时失败也不留中间态（直接打 DB 校验）由 fault.mjs 覆盖 ==========

    await stopServer();
    console.log("\n端到端 HTTP 流程全部通过。");
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== e2e 结果: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  if (serverProcess) serverProcess.kill("SIGTERM");
  process.exit(1);
});
