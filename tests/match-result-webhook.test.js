"use strict";

// Stage 7.5: POST /internal/match-result — точка входа для room-server'а,
// сообщающего Railway о конце матча. Тестируем напрямую (без живого
// room-server'а), чтобы получить детерминированные ассерты по состоянию
// applyMatchOutcome + trophies-фрейм через menu-WS.
//
// Сценарий happy-path: DV_ROOMS=hathora + DV_LOCAL_ROOMS=1, два клиента в
// матче, webhook с валидной подписью → оба получают trophies (+delta/−loss)
// через menu-WS. Негативные ветки — подпись, TS-окно, unknown matchId.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness.js");
const { signWebhook } = require("../room-auth.js");

const ROOM_SECRET = "test-room-secret-at-least-32-bytes-long-xx";

function postWebhook(baseUrl, bodyObj, signature){
  const body = JSON.stringify(bodyObj);
  const sig  = (signature === undefined) ? signWebhook(ROOM_SECRET, body) : signature;
  return fetch(`${baseUrl}/internal/match-result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sig != null ? { "x-dv-room-signature": sig } : {})
    },
    body
  });
}

async function pair(srv){
  const cookieA = await devLogin(srv.baseUrl, "mr-a", "MRAlice");
  const cookieB = await devLogin(srv.baseUrl, "mr-b", "MRBob");
  const a = await openClient(srv.baseUrl, cookieA, "mr-a");
  const b = await openClient(srv.baseUrl, cookieB, "mr-b");
  a.send({ type: "queue" });
  b.send({ type: "queue" });
  const [ma, mb] = await Promise.all([a.waitFor("matched", 10_000), b.waitFor("matched", 10_000)]);
  return { a, b, ma, mb };
}

test("match-result: valid HMAC → trophies отдаются обоим по winnerRole", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET
  });
  t.after(() => srv.stop());

  const { a, b, ma, mb } = await pair(srv);
  t.after(() => { a.close(); b.close(); });
  assert.equal(ma.net, "auth");

  // Host = mr-a (первый в очереди), Guest = mr-b. Роль закреплена в matched.
  const hostMatched  = ma.role === "host"  ? ma : mb;
  const guestMatched = ma.role === "guest" ? ma : mb;
  assert.equal(hostMatched.role,  "host");
  assert.equal(guestMatched.role, "guest");

  const r = await postWebhook(srv.baseUrl, {
    matchId: ma.matchId, roomId: ma.room,
    winnerRole: "host", scoreHost: 11, scoreGuest: 9, ts: Date.now()
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.applied.win, true, "winner должен получить +stakes один раз");
  assert.equal(body.applied.loss, true, "loser должен получить −stakes один раз");

  // Оба клиента через menu-WS должны увидеть trophies-фрейм с delta.
  const [trA, trB] = await Promise.all([a.waitFor("trophies", 4_000), b.waitFor("trophies", 4_000)]);
  // ma.role = host → "mr-a выиграл" если ma.role=host. (В очередь первым
  // встал A, он стал host — но это не гарантия; берём точно по role.)
  const hostClient  = hostMatched === ma ? a : b;
  const guestClient = guestMatched === ma ? a : b;
  const trHost  = hostClient  === a ? trA : trB;
  const trGuest = guestClient === a ? trA : trB;
  assert.ok(trHost.delta  > 0, `host trophies.delta > 0 (got ${trHost.delta})`);
  assert.ok(trGuest.delta < 0, `guest trophies.delta < 0 (got ${trGuest.delta})`);
});

test("match-result: guest winner — loss-фрейм уходит host'у", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET
  });
  t.after(() => srv.stop());

  const { a, b, ma } = await pair(srv);
  t.after(() => { a.close(); b.close(); });

  const r = await postWebhook(srv.baseUrl, {
    matchId: ma.matchId, roomId: ma.room,
    winnerRole: "guest", scoreHost: 7, scoreGuest: 11, ts: Date.now()
  });
  assert.equal(r.status, 200);

  const [trA, trB] = await Promise.all([a.waitFor("trophies", 4_000), b.waitFor("trophies", 4_000)]);
  // Host — тот, у кого ma.role === "host". У него delta<0; у guest'а delta>0.
  const trHost  = ma.role === "host" ? trA : trB;
  const trGuest = ma.role === "host" ? trB : trA;
  assert.ok(trHost.delta  < 0);
  assert.ok(trGuest.delta > 0);
});

test("match-result: bad signature → 401, трофеи не начисляются", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET
  });
  t.after(() => srv.stop());

  const { a, b, ma } = await pair(srv);
  t.after(() => { a.close(); b.close(); });

  // Ручная подпись НЕВЕРНЫМ секретом.
  const body = JSON.stringify({
    matchId: ma.matchId, roomId: ma.room,
    winnerRole: "host", scoreHost: 11, scoreGuest: 0, ts: Date.now()
  });
  const wrongSig = signWebhook("other-secret-32-bytes-long-xxxxxxxxxx", body);
  const r = await fetch(`${srv.baseUrl}/internal/match-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dv-room-signature": wrongSig },
    body
  });
  assert.equal(r.status, 401);

  const trA = await a.collectFor(400, "trophies");
  const trB = await b.collectFor(400, "trophies");
  assert.equal(trA.length, 0, "trophies не должны были прийти при 401");
  assert.equal(trB.length, 0);
});

test("match-result: ts вне окна → 401", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET
  });
  t.after(() => srv.stop());

  const { a, b, ma } = await pair(srv);
  t.after(() => { a.close(); b.close(); });

  const r = await postWebhook(srv.baseUrl, {
    matchId: ma.matchId, roomId: ma.room,
    winnerRole: "host", scoreHost: 11, scoreGuest: 0,
    ts: Date.now() - 10 * 60 * 1000  // 10 мин назад — выбивает из 5-мин окна
  });
  assert.equal(r.status, 401);
});

test("match-result: unknown matchId → 404", async (t) => {
  const srv = await startServer({
    DV_ROOMS:        "hathora",
    DV_LOCAL_ROOMS:  "1",
    DV_AUTH_PHYSICS: "1",
    ROOM_SECRET
  });
  t.after(() => srv.stop());

  const r = await postWebhook(srv.baseUrl, {
    matchId: "no-such-match", roomId: "x",
    winnerRole: "host", scoreHost: 11, scoreGuest: 0, ts: Date.now()
  });
  assert.equal(r.status, 404);
});
