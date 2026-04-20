"use strict";
// Standalone room-runtime (Stage 7.1): WS-сервер + authoritative physics
// для одной Hathora-комнаты. Подключаются host+guest, шлют бинарные
// фреймы по тому же Codec, что прод. ShadowRegistry крутит sim и эмитит
// снапшоты в peerSinks — ровно как server.js в DV_AUTH_PHYSICS=1.
//
// На Stage 7.1 этот файл ещё не вызывается из server.js (интеграция —
// Stage 7.2 за DV_ROOMS). Сейчас он запускается отдельно и тестируется
// через node room-server.js --port N --secret S.
//
// CLI:
//   --port <n>         обязательный
//   --secret <s>       HMAC-секрет для verifyRoomToken (иначе ENV ROOM_SECRET)
//   --match-id <id>    опциональный тег в логах и для webhook'а (Stage 7.5)
//   --authoritative    принудительно включить auth-режим (дефолт: on)
//   --no-authoritative выключить auth-режим (режим наблюдателя)
//
// Первый фрейм клиента — JSON {type:"join", token}. Токен подписан
// Railway через signRoomToken. Reject = close(4401).

const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const { verifyRoomToken, signWebhook } = require("./room-auth.js");
const { ShadowRegistry }  = require("./shadowsim.js");

const IDLE_TIMEOUT_MS = Number(process.env.ROOM_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;
const MAX_FRAME_BYTES = 256;
const WEBHOOK_TIMEOUT_MS = Number(process.env.ROOM_WEBHOOK_TIMEOUT_MS) || 5000;

function parseArgs(argv){
  const out = { port: null, secret: null, matchId: null, authoritative: true, railwayUrl: null };
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === "--port")             out.port = Number(argv[++i]);
    else if (a === "--secret")      out.secret = argv[++i];
    else if (a === "--match-id")    out.matchId = argv[++i];
    else if (a === "--railway-url") out.railwayUrl = argv[++i];
    else if (a === "--authoritative")    out.authoritative = true;
    else if (a === "--no-authoritative") out.authoritative = false;
  }
  if (!out.secret) out.secret = process.env.ROOM_SECRET || null;
  if (!out.matchId) out.matchId = process.env.ROOM_MATCH_ID || null;
  if (!out.railwayUrl) out.railwayUrl = process.env.ROOM_RAILWAY_URL || null;
  return out;
}

function main(){
  const args = parseArgs(process.argv.slice(2));
  if (!args.port || !Number.isFinite(args.port)){
    console.error("[room-server] --port <n> required");
    process.exit(2);
  }
  if (!args.secret){
    console.error("[room-server] --secret <s> or ROOM_SECRET env required");
    process.exit(2);
  }

  const shadow = new ShadowRegistry({ shadow: false, auth: args.authoritative });
  shadow.start();

  // Webhook на Railway: единоразово на matchOver-transition, с HMAC по raw-body.
  // Retry 1 раз через 500мс при 5xx/network-fail, дальше — лог и idle-timeout
  // добьёт процесс. Идемпотентность в Railway: applyMatchOutcome через
  // broker.claimOutcome — повторные webhook'и не начислят трофеи дважды.
  let webhookFired = false;
  async function postMatchResult(payload){
    if (!args.railwayUrl){
      console.log(`[room-server] matchOver but no --railway-url — skipping webhook. payload=${JSON.stringify(payload)}`);
      return;
    }
    const body = JSON.stringify(payload);
    const sig  = signWebhook(args.secret, body);
    const url  = args.railwayUrl.replace(/\/+$/, "") + "/internal/match-result";
    const attempt = async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-dv-room-signature": sig
          },
          body,
          signal: ctrl.signal
        });
        clearTimeout(to);
        return r.ok;
      } catch (e){
        clearTimeout(to);
        return false;
      }
    };
    const ok = await attempt();
    if (ok){
      console.log(`[room-server] match-result webhook ok match=${payload.matchId} winner=${payload.winnerRole}`);
      return;
    }
    await new Promise(r => setTimeout(r, 500));
    const ok2 = await attempt();
    if (ok2) console.log(`[room-server] match-result webhook ok (retry) match=${payload.matchId} winner=${payload.winnerRole}`);
    else     console.error(`[room-server] match-result webhook FAILED match=${payload.matchId} url=${url}`);
  }

  // Связь wsId ↔ room-клиент: peers хранит sendRaw, role, roomId, userId.
  // rooms — множество wsId по roomId для emote-relay (один room-process
  // теоретически может обслужить несколько комнат, но в Hathora-модели
  // это 1 процесс = 1 матч; оставлено явно, чтобы код не сломался при
  // переподключении до закрытия старой сессии).
  const peers = new Map();
  const rooms = new Map();

  let lastActivityAt = Date.now();
  const touchActivity = () => { lastActivityAt = Date.now(); };

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz"){ res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.wsId = crypto.randomBytes(6).toString("hex");
    ws._joined = false;
    ws._roomId = null;
    ws._role = null;
    ws._userId = null;
    touchActivity();

    const sendRaw = (frame) => {
      if (ws.readyState !== 1) return;
      try { ws.send(frame); } catch {}
    };

    const closeWith = (code, reason) => {
      try { ws.close(code, reason); } catch {}
    };

    ws.on("message", (raw, isBinary) => {
      touchActivity();
      if (!raw) return;
      if (raw.length > (isBinary ? MAX_FRAME_BYTES : 8192)) return;

      if (!ws._joined){
        // До join принимаем только текстовый JSON {type:"join", token}.
        if (isBinary) return closeWith(4401, "join-required");
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return closeWith(4400, "bad-json"); }
        if (!msg || msg.type !== "join" || typeof msg.token !== "string"){
          return closeWith(4400, "bad-join");
        }
        const claims = verifyRoomToken(args.secret, msg.token);
        if (!claims) return closeWith(4401, "unauthorized");
        // Если room-server запущен с --match-id, ожидаем совпадение —
        // иначе это чужой токен (случайный или от другой комнаты).
        if (args.matchId && claims.matchId !== args.matchId){
          return closeWith(4401, "match-mismatch");
        }

        ws._joined = true;
        ws._roomId = claims.roomId;
        ws._role   = claims.role;
        ws._userId = claims.userId;

        let set = rooms.get(claims.roomId);
        if (!set){ set = new Set(); rooms.set(claims.roomId, set); }
        set.add(ws.wsId);
        peers.set(ws.wsId, { ws, sendRaw, role: claims.role, roomId: claims.roomId, userId: claims.userId });

        shadow.registerRole(ws.wsId, claims.role);
        shadow.openRoom(claims.roomId, {
          authoritative: args.authoritative,
          onMatchOver: ({ winnerSide, score1, score2 }) => {
            if (webhookFired) return;
            webhookFired = true;
            postMatchResult({
              matchId:    args.matchId || claims.matchId,
              roomId:     claims.roomId,
              winnerRole: winnerSide === 1 ? "host" : "guest",
              scoreHost:  score1 | 0,
              scoreGuest: score2 | 0,
              ts:         Date.now()
            }).catch(() => {});
          }
        });
        shadow.attachPeer(claims.roomId, claims.role, sendRaw);
        try { ws.send(JSON.stringify({ type: "joined", role: claims.role, room: claims.roomId })); } catch {}
        console.log(`[room-server] peer joined wsId=${ws.wsId} user=${claims.userId} role=${claims.role} room=${claims.roomId}`);
        return;
      }

      // После join — бинарный горячий путь.
      if (!isBinary) return;
      if (raw.length < 2) return;
      const op = raw[0];

      // shadow.observeFrame применяет input в auth-режиме и drift-compare
      // в observer-режиме. Ровно тот же вызов, что в server.js:959.
      shadow.observeFrame(ws._roomId, ws.wsId, raw);

      // Auth-комнаты: input/state клиентов не ретранслируется, сервер
      // сам шлёт снапшоты через peerSinks. Emote (0x03) — relay всем
      // кроме отправителя.
      if (op === 0x03){
        const set = rooms.get(ws._roomId);
        if (set){
          for (const wsId of set){
            if (wsId === ws.wsId) continue;
            const peer = peers.get(wsId);
            if (peer) peer.sendRaw(raw);
          }
        }
        return;
      }

      if (!args.authoritative && (op === 0x01 || op === 0x02)){
        // Observer-режим (не используется в Hathora-пути, но поддержан
        // для отладки): relay input/state напрямую между пирами.
        const set = rooms.get(ws._roomId);
        if (set){
          for (const wsId of set){
            if (wsId === ws.wsId) continue;
            const peer = peers.get(wsId);
            if (peer) peer.sendRaw(raw);
          }
        }
      }
    });

    ws.on("close", () => {
      touchActivity();
      if (!ws._joined) return;
      const set = rooms.get(ws._roomId);
      if (set){
        set.delete(ws.wsId);
        if (set.size === 0) rooms.delete(ws._roomId);
      }
      peers.delete(ws.wsId);
      shadow.detachPeer(ws._roomId, ws._role);
      shadow.unregisterRole(ws.wsId);
      console.log(`[room-server] peer left wsId=${ws.wsId} user=${ws._userId} role=${ws._role} room=${ws._roomId}`);
      // Комнату закрываем, когда оба пира ушли. На Stage 7.5 здесь же
      // пойдёт match-result webhook на Railway.
      if (!rooms.has(ws._roomId)){
        shadow.closeRoom(ws._roomId);
      }
    });

    ws.on("error", () => {});
  });

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS){
      console.log(`[room-server] idle timeout ${IDLE_TIMEOUT_MS}ms — exiting`);
      shutdown(0);
    }
  }, 15000);
  idleTimer.unref?.();

  function shutdown(code){
    try { clearInterval(idleTimer); } catch {}
    try { shadow.stop(); } catch {}
    try { wss.close(); } catch {}
    httpServer.close(() => process.exit(code));
    // Safety net: не дать зависнуть, если WS-клиент держит сокет.
    setTimeout(() => process.exit(code), 2000).unref?.();
  }

  process.on("SIGINT",  () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  httpServer.listen(args.port, () => {
    console.log(`[room-server] ready on :${args.port} ws=/ws auth=${args.authoritative} matchId=${args.matchId || "-"} idleTimeoutMs=${IDLE_TIMEOUT_MS}`);
  });
}

if (require.main === module){
  main();
}

module.exports = { parseArgs };
