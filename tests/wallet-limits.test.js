"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Env-оверрайды: снижаем rally-cap и global-cooldown до значений, которые
// проходят в секундах, а не минутах. Механика та же — просто маленькие числа.
let srv;
test.before(async () => { srv = await startServer({
  WALLET_RALLY_MAX: "5",
  WALLET_MATCHWIN_GLOBAL_MS: "800"
}); });
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

test("rally.hit: per-match cap (cap=5 в тесте) — 6-й подряд не начисляется", async () => {
  // WALLET_RALLY_MAX=5, minGapMs=250. Шлём 5 hit'ов с gap>=260мс → все 5
  // прилетят wallet'ом. 6-й → ни одного фрейма (cap сработал).
  const c = await solo("u-wallet-cap");
  const mid = "m-wallet-cap-1";
  for (let i = 0; i < 5; i++){
    c.send({ type: "award", kind: "rally.hit", matchId: mid });
    await c.waitFor(walletOf("rally.hit"), 1500);
    await new Promise(r => setTimeout(r, 260));
  }
  c.send({ type: "award", kind: "rally.hit", matchId: mid });
  const after = await c.collectFor(400, walletOf("rally.hit"));
  assert.equal(after.length, 0, `6-й rally.hit должен быть отрезан cap'ом, получили ${after.length}`);
  c.close();
});

test("match.win: 30с global cooldown (800мс в тесте) отрезает второй matchId", async () => {
  // WALLET_MATCHWIN_GLOBAL_MS=800. Даже смена matchId НЕ должна дать
  // второй match.win быстрее, чем globalGapMs.
  const c = await solo("u-wallet-global");
  const mid1 = "m-global-a", mid2 = "m-global-b";
  c.send({ type: "award", kind: "match.win", matchId: mid1 });
  const first = await c.waitFor(walletOf("match.win"), 2000);
  assert.equal(first.delta, 50);
  // Маленький отступ — но внутри окна cooldown'а. Новый matchId НЕ должен
  // обнулить защиту.
  await new Promise(r => setTimeout(r, 200));
  c.send({ type: "award", kind: "match.win", matchId: mid2 });
  const blocked = await c.collectFor(500, walletOf("match.win"));
  assert.equal(blocked.length, 0, "второй match.win (другой matchId, но в global-cooldown) должен быть отрезан");
  // После cooldown'а второй matchId должен пройти.
  await new Promise(r => setTimeout(r, 800));
  c.send({ type: "award", kind: "match.win", matchId: mid2 });
  const second = await c.waitFor(walletOf("match.win"), 2000);
  assert.equal(second.delta, 50, "после истечения global-cooldown второй match.win должен пройти");
  c.close();
});
