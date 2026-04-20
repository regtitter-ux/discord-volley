"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { signRoomToken, verifyRoomToken, signWebhook, verifyWebhook } = require("../room-auth.js");

const SECRET = "testkey-0123456789";

test("signRoomToken → verifyRoomToken round-trip возвращает claims", () => {
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "host", matchId: "m1"
  }, 60000);
  const payload = verifyRoomToken(SECRET, token);
  assert.deepEqual(payload, { userId: "u1", roomId: "r1", role: "host", matchId: "m1" });
});

test("verifyRoomToken с другим секретом → null", () => {
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "guest", matchId: "m1"
  }, 60000);
  assert.equal(verifyRoomToken("wrong-secret", token), null);
});

test("verifyRoomToken tampered payload → null", () => {
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "host", matchId: "m1"
  }, 60000);
  const [p, s] = token.split(".");
  // Меняем один символ в payload (внутри base64url-алфавита, чтобы парсинг
  // дошёл до сравнения HMAC, а не отвалился раньше).
  const mutated = (p[0] === "A" ? "B" : "A") + p.slice(1);
  assert.equal(verifyRoomToken(SECRET, mutated + "." + s), null);
});

test("verifyRoomToken tampered signature → null", () => {
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "host", matchId: "m1"
  }, 60000);
  const [p, s] = token.split(".");
  // Меняем ПЕРВЫЙ символ подписи: последний в base64url-кодировке 32-байт
  // HMAC несёт только 4 значащих бита (2 — padding), его мутация может
  // декодироваться в те же 32 байта, и тест становился flaky.
  const mutated = (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.equal(verifyRoomToken(SECRET, p + "." + mutated), null);
});

test("verifyRoomToken expired → null", () => {
  // Отрицательный TTL даёт exp в прошлом — детерминированная проверка
  // без зависимости от setTimeout/системных таймеров (node:test под
  // параллельной CPU-нагрузкой их сбивает).
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "host", matchId: "m1"
  }, -1000);
  assert.equal(verifyRoomToken(SECRET, token), null);
});

test("verifyRoomToken malformed input → null", () => {
  assert.equal(verifyRoomToken(SECRET, ""), null);
  assert.equal(verifyRoomToken(SECRET, "not-a-token"), null);
  assert.equal(verifyRoomToken(SECRET, ".sig-only"), null);
  assert.equal(verifyRoomToken(SECRET, "payload-only."), null);
  assert.equal(verifyRoomToken("", "any.thing"), null);
});

test("verifyRoomToken отвергает неизвестную role", () => {
  const token = signRoomToken(SECRET, {
    userId: "u1", roomId: "r1", role: "spectator", matchId: "m1"
  }, 60000);
  assert.equal(verifyRoomToken(SECRET, token), null);
});

// Stage 7.5: webhook HMAC для /internal/match-result.
test("signWebhook → verifyWebhook round-trip на той же строке", () => {
  const body = JSON.stringify({ matchId: "m1", winnerRole: "host", ts: 1 });
  const sig = signWebhook(SECRET, body);
  assert.equal(verifyWebhook(SECRET, body, sig), true);
});

test("verifyWebhook: другой секрет → false", () => {
  const body = JSON.stringify({ matchId: "m1", winnerRole: "host", ts: 1 });
  const sig = signWebhook(SECRET, body);
  assert.equal(verifyWebhook("wrong", body, sig), false);
});

test("verifyWebhook: изменённый body → false", () => {
  const body = JSON.stringify({ matchId: "m1", winnerRole: "host", ts: 1 });
  const sig = signWebhook(SECRET, body);
  const tampered = body.replace("host", "guest");
  assert.equal(verifyWebhook(SECRET, tampered, sig), false);
});

test("verifyWebhook: пустая/мусорная подпись → false", () => {
  const body = "{}";
  assert.equal(verifyWebhook(SECRET, body, ""), false);
  assert.equal(verifyWebhook(SECRET, body, "abc"), false);
  assert.equal(verifyWebhook(SECRET, body, null), false);
});
