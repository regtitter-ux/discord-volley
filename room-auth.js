"use strict";
// Room-token HMAC: Railway подписывает, room-server проверяет.
//
// Формат: <b64url(payload)>.<b64url(hmac)>
//   payload    = JSON-stringified { userId, roomId, role, matchId, exp }
//   hmac       = HMAC-SHA256(secret, b64url(payload))
//   b64url     = base64 без padding, со стандартной url-safe заменой +/.
//
// Используется на Stage 7.1+: Railway (server.js) выдаёт токен клиенту в
// matched-фрейме, клиент первым фреймом передаёт его standalone room-
// серверу (Hathora). Общий секрет — ENV ROOM_SECRET на обеих сторонах.
//
// verifyRoomToken timing-safe сравнивает HMAC и проверяет exp. Любой сбой
// (парсинг, подпись, истечение) = null — вызывающий код закрывает коннект
// единым кодом 4401. Никаких подробностей наружу.

const crypto = require("crypto");

function b64urlEncode(buf){
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(str){
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4);
  const norm = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(norm, "base64");
}

function signRoomToken(secret, claims, ttlMs){
  if (typeof secret !== "string" || !secret) throw new Error("secret required");
  const ttl = Number.isFinite(ttlMs) ? ttlMs : 60000;
  const payload = {
    userId:  String(claims.userId),
    roomId:  String(claims.roomId),
    role:    String(claims.role),
    matchId: String(claims.matchId),
    exp:     Date.now() + ttl
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  return payloadB64 + "." + b64urlEncode(sig);
}

function verifyRoomToken(secret, token){
  if (typeof secret !== "string" || !secret) return null;
  if (typeof token !== "string" || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64     = token.slice(dot + 1);
  let sigBuf;
  try { sigBuf = b64urlDecode(sigB64); } catch { return null; }
  const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  if (sigBuf.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")); }
  catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  const { userId, roomId, role, matchId, exp } = payload;
  if (typeof userId !== "string" || !userId) return null;
  if (typeof roomId !== "string" || !roomId) return null;
  if (role !== "host" && role !== "guest") return null;
  if (typeof matchId !== "string" || !matchId) return null;
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return { userId, roomId, role, matchId };
}

module.exports = { signRoomToken, verifyRoomToken };
