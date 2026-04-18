"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..", "..");

async function getFreePort(){
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Запускает server.js в child-процессе с DV_DEV_LOGIN=1 и фейковыми секретами.
// Ждёт stdout строку "listening on :<PORT>" — именно серверное подтверждение
// готовности, а не HTTP-polling (быстрее и честнее).
async function startServer(extraEnv = {}){
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "server.js"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development",
        DV_DEV_LOGIN: "1",
        DISCORD_CLIENT_ID: "test-cid",
        DISCORD_CLIENT_SECRET: "test-secret",
        SESSION_SECRET: "test-session-secret",
        PUBLIC_URL: `http://localhost:${port}`,
        DATA_DIR: path.join(ROOT, "data-test"),
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const logs = [];
  child.stdout.on("data", b => logs.push(String(b)));
  child.stderr.on("data", b => logs.push(String(b)));

  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(
      `server did not become ready in 10s. logs:\n${logs.join("")}`
    )), 10_000);
    function onData(buf){
      if (/listening on :/.test(String(buf))){
        clearTimeout(to);
        child.stdout.off("data", onData);
        resolve();
      }
    }
    child.stdout.on("data", onData);
    child.once("exit", code => {
      clearTimeout(to);
      reject(new Error(`server exited early with ${code}. logs:\n${logs.join("")}`));
    });
  });

  await ready;
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    logs,
    stop(){
      return new Promise(resolve => {
        if (child.exitCode != null) return resolve();
        child.once("exit", () => resolve());
        try { child.kill(); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
      });
    }
  };
}

// /dev/login возвращает JSON и Set-Cookie. Возвращаем сырое значение куки
// (в формате "dv_session=s%3A...") для последующей передачи в WS handshake.
async function devLogin(baseUrl, id, name){
  const url = `${baseUrl}/dev/login?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || id)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dev/login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  const m = /dv_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("dev/login did not set dv_session cookie");
  return `dv_session=${m[1]}`;
}

class TestClient {
  constructor(ws, userId){
    this.ws = ws;
    this.userId = userId;
    this.received = [];
    this._waiters = [];
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // binary snapshots — не интересны интеграционным тестам
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      this.received.push(msg);
      this._waiters = this._waiters.filter(w => {
        if (w.match(msg)){ w.resolve(msg); return false; }
        return true;
      });
    });
  }
  send(obj){ this.ws.send(JSON.stringify(obj)); }
  // Ждёт первый будущий фрейм, удовлетворяющий predicate. По умолчанию —
  // матч по type. Если фрейм уже пришёл раньше — тоже отдаём (wait-for
  // через буфер received).
  waitFor(predicate, timeoutMs = 5000){
    const match = (typeof predicate === "string")
      ? (m) => m && m.type === predicate
      : predicate;
    const already = this.received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this._waiters.push(waiter);
      setTimeout(() => {
        const idx = this._waiters.indexOf(waiter);
        if (idx >= 0){
          this._waiters.splice(idx, 1);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs).unref();
    });
  }
  // Собирает все фреймы, совпавшие с predicate за duration — удобно для
  // проверки "второго trophies-фрейма не было".
  async collectFor(ms, predicate){
    const start = this.received.length;
    await new Promise(r => setTimeout(r, ms));
    const match = (typeof predicate === "string")
      ? (m) => m && m.type === predicate
      : predicate;
    return this.received.slice(start).filter(match);
  }
  close(){ try { this.ws.close(); } catch {} }
}

async function openClient(baseUrl, cookie, userId){
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const client = new TestClient(ws, userId);
  // hello всегда приходит первым — дождёмся, чтобы все waitFor видели
  // актуальный received-буфер.
  await client.waitFor("hello", 3000);
  return client;
}

module.exports = { startServer, devLogin, openClient, TestClient, getFreePort };
