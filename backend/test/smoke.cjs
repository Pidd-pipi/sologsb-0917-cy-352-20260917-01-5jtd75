/**
 * 生产链路冒烟：模拟 nginx 行为（/api/* -> 后端根路径 /*，SPA fallback），
 * 用真实 mongod + 后端进程 + vite preview 之前先验证接口与静态资源。
 */
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_PORT = 29521;
const PROXY_PORT = 28513;
const MONGO_PORT = 27019;
const DATABASE_URL = `mongodb://127.0.0.1:${MONGO_PORT}/smoke?directConnection=true`;
const DIST_DIR = path.join(__dirname, "..", "..", "frontend", "dist");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`port ${port} 未就绪`));
        else setTimeout(tick, 300);
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

function rawRequest(port, reqOptions, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...reqOptions }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function jreq(port, reqOptions, payload) {
  const res = await rawRequest(port, reqOptions, payload === undefined ? undefined : JSON.stringify(payload));
  return { status: res.status, json: JSON.parse(res.body || "{}"), raw: res.body, headers: res.headers };
}

// 简易 nginx 替身：/api/ 去掉前缀转发到后端；其余走 dist 静态 + index.html fallback
function startNginxLike(backendPort) {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/")) {
      const proxyReq = http.request(
        { host: "127.0.0.1", port: backendPort, path: url.slice(4), method: req.method, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        res.writeHead(502);
        res.end("bad gateway");
      });
      req.pipe(proxyReq);
      return;
    }
    let filePath = path.join(DIST_DIR, url.split("?")[0]);
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isFile()) {
        res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] ?? "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(path.join(DIST_DIR, "index.html")).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, () => resolve(server)));
}

async function main() {
  const mongod = await MongoMemoryServer.create({
    binary: { version: "7.0.14" },
    instance: { port: MONGO_PORT },
  });

  const backend = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: { ...process.env, PORT: String(BACKEND_PORT), DATABASE_URL },
    stdio: "ignore",
  });

  try {
    await waitForPort(BACKEND_PORT);
    const proxy = await startNginxLike(BACKEND_PORT);

    // 1. 经“nginx”同源访问：静态资源
    const indexHtml = await rawRequest(PROXY_PORT, { path: "/", method: "GET" });
    check("GET / 返回前端 index.html", indexHtml.status === 200 && indexHtml.body.includes("<div id=\"root\""), `len=${indexHtml.body.length}`);
    const spaFallback = await rawRequest(PROXY_PORT, { path: "/records?foo=1", method: "GET" });
    check("SPA 深链 /records 回退 index.html", spaFallback.status === 200 && spaFallback.body.includes("id=\"root\""));
    const assets = [...indexHtml.body.matchAll(/src="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    check("index.html 引用构建产物", assets.length >= 1, assets.join(","));
    if (assets.length) {
      const asset = await rawRequest(PROXY_PORT, { path: assets[0], method: "GET" });
      check("构建产物 JS 可经同源加载", asset.status === 200 && asset.headers["content-type"]?.includes("javascript"));
    }

    // 2. 经 /api 前缀（nginx 改写）完成录入—查看—修正闭环
    const payload = {
      gameName: "阿瓦隆", category: "角色扮演",
      participants: ["周一", "周二", "周三", "周四"], winners: ["周二", "周四"],
      durationMinutes: 75, note: "冒烟局",
    };
    const create = await jreq(PROXY_PORT, {
      path: "/api/matches", method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "smoke-rid-1001" },
    }, payload);
    check("经 /api/matches 录入成功", create.status === 201 && create.json.data.revision === 1, create.status);

    // 并发重复提交（同 X-Request-Id × 5）
    const dups = await Promise.all(
      Array.from({ length: 5 }, () =>
        jreq(PROXY_PORT, {
          path: "/api/matches", method: "POST",
          headers: { "Content-Type": "application/json", "X-Request-Id": "smoke-rid-1001" },
        }, payload),
      ),
    );
    check(
      "经代理并发重复提交仍幂等（同 id × 5，计数不翻倍）",
      new Set(dups.map((r) => r.json.data?.id)).size === 1,
    );

    const board = await jreq(PROXY_PORT, { path: "/api/leaderboard", method: "GET" });
    check("经 /api/leaderboard 查看胜率榜", board.status === 200 && board.json.totalMatches === 1);
    const winner = board.json.rows.find((r) => r.player === "周二");
    const loser = board.json.rows.find((r) => r.player === "周一");
    check("并列胜者 周二/周四 各 100%，负者 0%", winner.winRate === 100 && loser.winRate === 0, `周二=${winner?.winRate}% 周一=${loser?.winRate}%`);

    // 修正：胜者改为 周一
    const id = create.json.data.id;
    const correct = await jreq(PROXY_PORT, {
      path: `/api/matches/${id}`, method: "PUT",
      headers: { "Content-Type": "application/json" },
    }, { ...payload, winners: ["周一"], expectedRevision: 1, note: "冒烟局-更正" });
    check("经代理修正成功且返回冲销条数", correct.status === 200 && correct.json.data.revision === 2 && correct.json.rolledBack === 4, `rolledBack=${correct.json.rolledBack}`);

    const board2 = await jreq(PROXY_PORT, { path: "/api/leaderboard", method: "GET" });
    const monday = board2.json.rows.find((r) => r.player === "周一");
    const tuesday = board2.json.rows.find((r) => r.player === "周二");
    check("修正后榜单：周一 100%、周二 0%（旧胜已冲销）", monday.winRate === 100 && tuesday.winRate === 0);

    // 非法输入经代理
    const bad = await jreq(PROXY_PORT, {
      path: "/api/matches", method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "smoke-rid-bad" },
    }, { gameName: "x", category: "策略", participants: ["A"], winners: ["A"], durationMinutes: 30 });
    check("非法对局经代理被 400 拒绝", bad.status === 400, bad.json.message);

    proxy.close();
  } finally {
    backend.kill("SIGTERM");
    await mongod.stop();
  }

  console.log(`\n===== smoke 结果: ${pass}/${pass + fail} 通过 =====`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
