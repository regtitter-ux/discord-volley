"use strict";

// Stage 7.6: DV_ROOMS_ROLLBACK=1 — kill-switch. Даже если в Railway env
// стоит DV_ROOMS=hathora, флаг принудительно возвращает pairLocal —
// matched wire-format без roomHost/roomToken, весь gameplay на Railway.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness.js");

test("DV_ROOMS_ROLLBACK=1 при DV_ROOMS=hathora → pairLocal (нет roomHost)", async (t) => {
  const srv = await startServer({
    DV_ROOMS:          "hathora",
    DV_ROOMS_ROLLBACK: "1",
    // DV_LOCAL_ROOMS намеренно не ставим: rollback должен отсечь ДО того,
    // как pairHathora попытается спавнить child. ROOM_SECRET тоже не
    // обязателен — pairLocal его не трогает.
    ROOM_SECRET:       "test-secret-32-bytes-long-xxxxxxxxxxx"
  });
  t.after(() => srv.stop());

  const cookieA = await devLogin(srv.baseUrl, "rb-a", "RBAlice");
  const cookieB = await devLogin(srv.baseUrl, "rb-b", "RBBob");
  const a = await openClient(srv.baseUrl, cookieA, "rb-a");
  const b = await openClient(srv.baseUrl, cookieB, "rb-b");
  t.after(() => { a.close(); b.close(); });

  a.send({ type: "queue" });
  b.send({ type: "queue" });
  const [ma, mb] = await Promise.all([a.waitFor("matched", 10_000), b.waitFor("matched", 10_000)]);

  // pairLocal-wire: net == "host"/"auth" (в зависимости от DV_AUTH_PHYSICS),
  // но БЕЗ roomHost/roomPort/roomToken — это главное отличие от 7.2+.
  assert.equal(ma.roomHost,  undefined);
  assert.equal(mb.roomHost,  undefined);
  assert.equal(ma.roomToken, undefined);
  assert.equal(mb.roomToken, undefined);
});
