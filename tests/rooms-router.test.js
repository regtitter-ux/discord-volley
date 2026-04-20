"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { startServer, devLogin, openClient, getFreePort } = require("./helpers/harness.js");
const { verifyRoomToken } = require("../room-auth.js");

// Мини-мок Hathora Cloud REST API. Принимает POST /rooms/v2/{appId}/create
// и GET /rooms/v2/{appId}/connectioninfo/{roomId}. Все вызовы логирует,
// отвечает детерминированно — hathora-client должен перейти от create к
// connectioninfo и вернуть {host:"hathora-mock.local", port:9999}.
async function startHathoraMock(appId){
  const port = await getFreePort();
  const log = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === `/rooms/v2/${appId}/create`){
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ roomId: "mockroom-" + Math.random().toString(16).slice(2, 10) }));
      });
      return;
    }
    const m = /^\/rooms\/v2\/([^/]+)\/connectioninfo\/([^/]+)$/.exec(req.url);
    if (req.method === "GET" && m && decodeURIComponent(m[1]) === appId){
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "active",
        exposedPort: { host: "hathora-mock.local", port: 9999, transportType: "tcp" }
      }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(port, r));
  return {
    port, url: `http://127.0.0.1:${port}`, log,
    stop: () => new Promise(r => server.close(() => r()))
  };
}

test("DV_ROOMS=hathora: matched содержит roomHost/roomPort/roomToken, токены валидны", async (t) => {
  const appId  = "test-app-7-2";
  const token  = "test-token";
  const secret = "test-room-secret-at-least-32-bytes-long-xx";
  const mock = await startHathoraMock(appId);
  t.after(() => mock.stop());

  const srv = await startServer({
    DV_ROOMS:         "hathora",
    HATHORA_API_BASE: mock.url,
    HATHORA_APP_ID:   appId,
    HATHORA_TOKEN:    token,
    HATHORA_REGION:   "Frankfurt",
    ROOM_SECRET:      secret
  });
  t.after(() => srv.stop());

  const cookieA = await devLogin(srv.baseUrl, "alice", "Alice");
  const cookieB = await devLogin(srv.baseUrl, "bob",   "Bob");
  const a = await openClient(srv.baseUrl, cookieA, "alice");
  const b = await openClient(srv.baseUrl, cookieB, "bob");
  t.after(() => { a.close(); b.close(); });

  a.send({ type: "queue" });
  b.send({ type: "queue" });

  const [ma, mb] = await Promise.all([a.waitFor("matched"), b.waitFor("matched")]);

  assert.equal(ma.net, "auth");
  assert.equal(mb.net, "auth");
  assert.equal(ma.roomHost, "hathora-mock.local");
  assert.equal(mb.roomHost, "hathora-mock.local");
  assert.equal(ma.roomPort, 9999);
  assert.equal(mb.roomPort, 9999);
  assert.equal(typeof ma.roomToken, "string");
  assert.equal(typeof mb.roomToken, "string");
  assert.notEqual(ma.roomToken, mb.roomToken); // разные role → разные токены

  const claimsA = verifyRoomToken(secret, ma.roomToken);
  const claimsB = verifyRoomToken(secret, mb.roomToken);
  assert.ok(claimsA && claimsB, "токены должны верифицироваться тем же секретом");
  assert.equal(claimsA.role, "host");
  assert.equal(claimsB.role, "guest");
  assert.equal(claimsA.roomId, ma.room);
  assert.equal(claimsB.roomId, mb.room);
  assert.equal(claimsA.matchId, ma.matchId);
  assert.equal(claimsB.matchId, mb.matchId);
  assert.equal(claimsA.userId, "alice");
  assert.equal(claimsB.userId, "bob");

  // Убедимся, что hathora-client реально сходил в Hathora API.
  assert.ok(mock.log.some(l => l === `POST /rooms/v2/${appId}/create`),
    `ожидался POST create в mock.log, получено: ${mock.log.join(" | ")}`);
  assert.ok(mock.log.some(l => /^GET \/rooms\/v2\/[^/]+\/connectioninfo\//.test(l)),
    `ожидался GET connectioninfo в mock.log, получено: ${mock.log.join(" | ")}`);
});

test("DV_ROOMS=local (default): matched БЕЗ roomHost/roomToken (старый wire-format)", async (t) => {
  const srv = await startServer({});
  t.after(() => srv.stop());

  const cookieA = await devLogin(srv.baseUrl, "carol", "Carol");
  const cookieB = await devLogin(srv.baseUrl, "dan",   "Dan");
  const a = await openClient(srv.baseUrl, cookieA, "carol");
  const b = await openClient(srv.baseUrl, cookieB, "dan");
  t.after(() => { a.close(); b.close(); });

  a.send({ type: "queue" });
  b.send({ type: "queue" });

  const [ma, mb] = await Promise.all([a.waitFor("matched"), b.waitFor("matched")]);

  assert.equal(ma.roomHost,  undefined);
  assert.equal(mb.roomHost,  undefined);
  assert.equal(ma.roomPort,  undefined);
  assert.equal(mb.roomPort,  undefined);
  assert.equal(ma.roomToken, undefined);
  assert.equal(mb.roomToken, undefined);
});

