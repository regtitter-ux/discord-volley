"use strict";

// Stage 7.4: full cycle без живого Hathora. Сервер стартует с
// DV_ROOMS=hathora + DV_LOCAL_ROOMS=1 → pairHathora spawn-ит room-server.js
// как child-process на свободном порту вместо Hathora REST. Тест прогоняет:
// queue(A) + queue(B) → matched(roomHost/roomPort/roomToken) → WS на
// room-server/ws → JSON join(token) → {type:"joined"} ack → бинарный input
// от host → бинарный state-snapshot обратно. Это первая end-to-end проверка
// 7.1 (room-server) + 7.2 (hathora-client router) + 7.3 (client dual-connect)
// вместе.

const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { startServer, devLogin, openClient } = require("./helpers/harness.js");

function openGameWs(host, port, token){
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}/ws`);
    ws.binaryType = "arraybuffer";
    let joined = false;
    const to = setTimeout(() => {
      if (!joined){ try { ws.close(); } catch {} reject(new Error("game-ws join timeout")); }
    }, 8000);
    ws.once("open", () => {
      try { ws.send(JSON.stringify({ type: "join", token })); }
      catch (e){ clearTimeout(to); reject(e); }
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (msg && msg.type === "joined" && !joined){
        joined = true;
        clearTimeout(to);
        resolve(ws);
      }
    });
    ws.once("error", (e) => { if (!joined){ clearTimeout(to); reject(e); } });
    ws.once("close", () => { if (!joined){ clearTimeout(to); reject(new Error("game-ws closed before joined")); } });
  });
}

// Ждёт первый бинарный фрейм с opcode op. Таймаут — не ошибка здесь,
// тест сам решит, как это интерпретировать (в auth-режиме state ДОЛЖЕН
// придти, в observer-режиме — нет).
function waitForBinary(ws, op, timeoutMs){
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`waitForBinary(op=0x${op.toString(16)}) timeout after ${timeoutMs}ms`));
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

test("DV_ROOMS=hathora + DV_LOCAL_ROOMS=1: full cycle queue → matched → room-server/ws → snapshot", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET:     "test-room-secret-at-least-32-bytes-long-xx"
  });
  t.after(() => srv.stop());

  const cookieA = await devLogin(srv.baseUrl, "hf-alice", "HFAlice");
  const cookieB = await devLogin(srv.baseUrl, "hf-bob",   "HFBob");
  const a = await openClient(srv.baseUrl, cookieA, "hf-alice");
  const b = await openClient(srv.baseUrl, cookieB, "hf-bob");
  t.after(() => { a.close(); b.close(); });

  a.send({ type: "queue" });
  b.send({ type: "queue" });
  const [ma, mb] = await Promise.all([a.waitFor("matched", 15_000), b.waitFor("matched", 15_000)]);

  assert.equal(ma.net, "auth");
  assert.equal(ma.roomHost, "127.0.0.1");
  assert.equal(mb.roomHost, "127.0.0.1");
  assert.equal(typeof ma.roomPort, "number");
  assert.equal(ma.roomPort, mb.roomPort, "оба пира подключаются к тому же room-server");
  assert.equal(typeof ma.roomToken, "string");
  assert.equal(typeof mb.roomToken, "string");
  assert.notEqual(ma.roomToken, mb.roomToken);

  const hostWs  = await openGameWs(ma.roomHost, ma.roomPort, ma.roomToken);
  const guestWs = await openGameWs(mb.roomHost, mb.roomPort, mb.roomToken);
  t.after(() => { try { hostWs.close(); } catch {} try { guestWs.close(); } catch {} });

  // Шлём input-фрейм (opcode 0x01) от host — auth-сервер должен ответить
  // state-снапшотом (opcode 0x02) обратно обоим пирам. Для простоты
  // проверяем получение host'ом, т.к. sink обслуживает обоих.
  const snapshot = waitForBinary(hostWs, 0x02, 5000);
  // Минимальный input-payload: 1 байт opcode + 7 байт как placeholder.
  // Сам Codec допускает переменный размер; auth-сервер валидирует сам.
  const input = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]);
  hostWs.send(input);
  const snap = await snapshot;
  assert.equal(snap[0], 0x02);
  assert.ok(snap.length >= 2, "state-снапшот должен быть непустым");
});

