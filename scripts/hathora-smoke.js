"use strict";
/* eslint-disable no-console */

// Stage 7.6 smoke: end-to-end проверка Hathora-deployment'а без участия
// браузера/Railway. Делаем то же, что делает pairHathora + openGameSocket
// в проде, но из node-скрипта. Нужно, чтобы убедиться:
//   1. Hathora API token валиден, image собрался.
//   2. Room-server стартует в Hathora-контейнере и слушает /ws.
//   3. HMAC-токен, подписанный локально нашим ROOM_SECRET, совпадает с
//      тем, что верифицирует room-server (если не совпадает — значит
//      ROOM_SECRET на Hathora не тот же, что локально).
//   4. Binary codec работает: input 0x01 → state-snapshot 0x02 приходит.
//
// Запуск:
//   node scripts/hathora-smoke.js
// Читает .env из корня репо + process.env. Обязательные: HATHORA_APP_ID,
// HATHORA_TOKEN, ROOM_SECRET. Опционально: HATHORA_REGION (Frankfurt),
// HATHORA_WS_PROTO (ws|wss — auto-detect пробует обе).

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// Простой .env-loader (не тащим dotenv в deps).
(function loadEnv(){
  const p = path.resolve(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)){
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]){
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const { createRoom } = require("../hathora-client.js");
const { signRoomToken } = require("../room-auth.js");

function logStep(msg){ console.log(`\n▶ ${msg}`); }
function logOk(msg){ console.log(`  ✓ ${msg}`); }
function logFail(msg){ console.log(`  ✗ ${msg}`); }

async function openWs(url, timeoutMs = 10_000){
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const to = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`connect ${url} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once("open",  () => { clearTimeout(to); resolve(ws); });
    ws.once("error", e => { clearTimeout(to); reject(e); });
  });
}

async function tryConnect(host, port){
  const candidates = [];
  const override = (process.env.HATHORA_WS_PROTO || "").toLowerCase();
  if (override === "ws" || override === "wss") candidates.push(`${override}://${host}:${port}/ws`);
  else { candidates.push(`wss://${host}:${port}/ws`); candidates.push(`ws://${host}:${port}/ws`); }
  for (const url of candidates){
    try {
      const ws = await openWs(url, 8000);
      console.log(`  ✓ WS connected: ${url}`);
      return ws;
    } catch (e){
      console.log(`  · ${url} failed: ${e.message}`);
    }
  }
  throw new Error(`не удалось подключиться ни по ws:// ни по wss:// к ${host}:${port}`);
}

function waitJsonMsg(ws, predicate, timeoutMs){
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`waitJsonMsg timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    function onMsg(raw, isBinary){
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (predicate(msg)){
        clearTimeout(to);
        ws.off("message", onMsg);
        resolve(msg);
      }
    }
    ws.on("message", onMsg);
  });
}

function waitBinaryOp(ws, op, timeoutMs){
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`waitBinaryOp(0x${op.toString(16)}) timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    function onMsg(raw, isBinary){
      if (!isBinary) return;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length >= 1 && buf[0] === op){
        clearTimeout(to);
        ws.off("message", onMsg);
        resolve(buf);
      }
    }
    ws.on("message", onMsg);
  });
}

(async function main(){
  const need = ["HATHORA_APP_ID", "HATHORA_TOKEN", "ROOM_SECRET"];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length){
    console.error(`missing env: ${missing.join(", ")}. Load .env or export them.`);
    process.exit(2);
  }
  console.log(`Hathora app: ${process.env.HATHORA_APP_ID}`);
  console.log(`Region:      ${process.env.HATHORA_REGION || "Frankfurt"}`);

  logStep("createRoom (Hathora REST)");
  let room;
  try {
    room = await createRoom({ region: process.env.HATHORA_REGION || "Frankfurt" });
    logOk(`roomId=${room.roomId} host=${room.host} port=${room.port} transport=${room.transportType}`);
  } catch (e){
    logFail(`createRoom: ${e.message}`);
    console.error("→ проверь HATHORA_APP_ID/HATHORA_TOKEN, статус билда в Dashboard, и что deployment активен.");
    process.exit(1);
  }

  logStep("WS handshake на room-server");
  let hostWs, guestWs;
  try {
    hostWs = await tryConnect(room.host, room.port);
  } catch (e){
    logFail(e.message);
    console.error("→ room-server не принимает WS. Проверь env в Hathora Dashboard: ROOM_SECRET задан, EXPOSE 8080, transport type.");
    process.exit(1);
  }
  try { guestWs = await tryConnect(room.host, room.port); }
  catch (e){ logFail(`guest connect: ${e.message}`); try { hostWs.close(); } catch {} process.exit(1); }

  const matchId = "smoke-" + Date.now().toString(36);
  const hostToken  = signRoomToken(process.env.ROOM_SECRET, {
    userId: "smoke-host",  roomId: room.roomId, role: "host",  matchId
  }, 60_000);
  const guestToken = signRoomToken(process.env.ROOM_SECRET, {
    userId: "smoke-guest", roomId: room.roomId, role: "guest", matchId
  }, 60_000);

  logStep("JSON join (HMAC verify на room-server)");
  try {
    hostWs.send(JSON.stringify({ type: "join", token: hostToken }));
    const ack = await waitJsonMsg(hostWs, m => m.type === "joined", 5000);
    logOk(`host joined role=${ack.role} room=${ack.room}`);
  } catch (e){
    logFail(`host join: ${e.message}`);
    console.error("→ room-server закрыл connection. Скорее всего ROOM_SECRET в Hathora env не совпадает с локальным.");
    try { hostWs.close(); guestWs.close(); } catch {}
    process.exit(1);
  }
  try {
    guestWs.send(JSON.stringify({ type: "join", token: guestToken }));
    const ack = await waitJsonMsg(guestWs, m => m.type === "joined", 5000);
    logOk(`guest joined role=${ack.role} room=${ack.room}`);
  } catch (e){ logFail(`guest join: ${e.message}`); try { hostWs.close(); guestWs.close(); } catch {} process.exit(1); }

  logStep("binary input (opcode 0x01) → snapshot (opcode 0x02)");
  try {
    const snap = waitBinaryOp(hostWs, 0x02, 5000);
    const input = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);
    hostWs.send(input);
    const buf = await snap;
    logOk(`state snapshot received, ${buf.length} bytes`);
  } catch (e){
    logFail(`snapshot: ${e.message}`);
    console.error("→ room-server принимает join, но не эмитит snapshot'ы. Проверь DV_AUTH_PHYSICS=1 в Hathora env.");
    try { hostWs.close(); guestWs.close(); } catch {}
    process.exit(1);
  }

  logStep("cleanup");
  try { hostWs.close(); } catch {}
  try { guestWs.close(); } catch {}
  logOk("✓ Hathora room-server works end-to-end");
  console.log("\nВсё ок — можно флипать DV_ROOMS=hathora на Railway.");
  process.exit(0);
})().catch(e => {
  console.error("\nUNCAUGHT:", e && e.stack || e);
  process.exit(1);
});
