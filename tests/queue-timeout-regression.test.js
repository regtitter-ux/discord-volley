"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Сервер с очень коротким QUEUE_TIMEOUT_MS, чтобы поймать regression:
// если после pairLocal у хоста не сбросить _queueTimer, сервер через
// QUEUE_TIMEOUT_MS пришлёт ему {type:"queue_timeout"} прямо в середине
// живого матча, и клиент запустит startBotMatch поверх PvP.
let srv;
test.before(async () => { srv = await startServer({ QUEUE_TIMEOUT_MS: "400" }); });
test.after(async ()  => { if (srv) await srv.stop(); });

test("после matched хост НЕ получает queue_timeout (regression)", async () => {
  const cookieA = await devLogin(srv.baseUrl, "u-host-qt", "u-host-qt");
  const cookieB = await devLogin(srv.baseUrl, "u-guest-qt", "u-guest-qt");
  const host  = await openClient(srv.baseUrl, cookieA, "u-host-qt");
  const guest = await openClient(srv.baseUrl, cookieB, "u-guest-qt");

  host.send({ type: "queue" });
  // Небольшая пауза — хост уходит в waiting и получает _queueTimer(400мс).
  await new Promise(r => setTimeout(r, 50));
  guest.send({ type: "queue" });

  const [m1, m2] = await Promise.all([
    host.waitFor("matched", 2000),
    guest.waitFor("matched", 2000)
  ]);
  assert.equal(m1.role, "host");
  assert.equal(m2.role, "guest");

  // Ждём >QUEUE_TIMEOUT_MS, чтобы отложенный таймер успел выстрелить.
  const qt = await host.collectFor(800, "queue_timeout");
  assert.equal(qt.length, 0, "queue_timeout НЕ должен прийти хосту после matched");

  host.close(); guest.close();
});
