"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async ()  => { if (srv) await srv.stop(); });

async function solo(id){
  const cookie = await devLogin(srv.baseUrl, id, id);
  return await openClient(srv.baseUrl, cookie, id);
}

const walletOf = kind => m => m.type === "wallet" && m.kind === kind;

test("rally.hit: два подряд с gap < minGapMs → первый wallet ок, второй зажат", async () => {
  const c = await solo("u-wallet-1");
  const mid = "m-wallet-1a";
  c.send({ type: "award", kind: "rally.hit", matchId: mid });
  const first = await c.waitFor(walletOf("rally.hit"), 2000);
  assert.equal(first.delta, 1);
  // Сразу второй — должен быть зажат minGapMs=250 мс.
  c.send({ type: "award", kind: "rally.hit", matchId: mid });
  const after = await c.collectFor(400, walletOf("rally.hit"));
  assert.equal(after.length, 0, `второй wallet НЕ должен прийти, получили ${after.length}`);
  c.close();
});

test("rally.hit: два с gap > minGapMs → два wallet", async () => {
  const c = await solo("u-wallet-2");
  const mid = "m-wallet-2a";
  c.send({ type: "award", kind: "rally.hit", matchId: mid });
  const first = await c.waitFor(walletOf("rally.hit"), 2000);
  assert.equal(first.delta, 1);
  await new Promise(r => setTimeout(r, 300));
  c.send({ type: "award", kind: "rally.hit", matchId: mid });
  const second = await c.waitFor(walletOf("rally.hit"), 2000);
  assert.equal(second.delta, 1, "второй wallet должен прийти после паузы");
  c.close();
});

test("match.win: per-match cap = 1 — второй подряд не начисляется", async () => {
  const c = await solo("u-wallet-3");
  const mid = "m-wallet-3a";
  c.send({ type: "award", kind: "match.win", matchId: mid });
  const first = await c.waitFor(walletOf("match.win"), 2000);
  assert.equal(first.delta, 50);
  // minGapMs=1000 + cap=1. Даже через 1.1 с второй запрос с тем же matchId
  // должен быть отклонён именно по per-match cap, а не по gap.
  await new Promise(r => setTimeout(r, 1100));
  c.send({ type: "award", kind: "match.win", matchId: mid });
  const after = await c.collectFor(400, walletOf("match.win"));
  assert.equal(after.length, 0, `второй match.win НЕ должен пройти, получили ${after.length}`);
  c.close();
});
