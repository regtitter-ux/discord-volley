"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Общий сервер на все кейсы (поднять быстрее, чем на каждый тест). Тесты
// изолированы по userId и matchId, так что shared state безопасен.
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async ()  => { if (srv) await srv.stop(); });

async function pair(baseUrl, idA, idB){
  const cookieA = await devLogin(baseUrl, idA, idA);
  const cookieB = await devLogin(baseUrl, idB, idB);
  const a = await openClient(baseUrl, cookieA, idA);
  const b = await openClient(baseUrl, cookieB, idB);
  a.send({ type: "queue" });
  // Микро-пауза: первый queue создаёт waiting, второй делает pair. Чтобы
  // порядок хост/гость был предсказуемым, ждём пока A встанет в очередь.
  await new Promise(r => setTimeout(r, 50));
  b.send({ type: "queue" });
  const [matchedA, matchedB] = await Promise.all([
    a.waitFor("matched", 5000),
    b.waitFor("matched", 5000)
  ]);
  assert.equal(matchedA.matchId, matchedB.matchId, "both peers see same matchId");
  const host  = matchedA.role === "host"  ? a : b;
  const guest = matchedA.role === "guest" ? a : b;
  return { host, guest, matchId: matchedA.matchId, stakes: matchedA.stakes };
}

test("host win + leave: winner НЕ получает второй штрафной trophies", async () => {
  const { host, guest, stakes } = await pair(srv.baseUrl, "u-host-1", "u-guest-1");

  host.send({ type: "match_win" });
  const trophyWin = await host.waitFor("trophies", 3000);
  assert.equal(trophyWin.delta, stakes.win, "winner gets +stakes.win");

  guest.send({ type: "leave" });
  const trophyLoss = await guest.waitFor("trophies", 3000);
  assert.equal(trophyLoss.delta, -stakes.loss, "guest gets -stakes.loss on leave");

  host.send({ type: "leave" });
  const extraHostTrophies = await host.collectFor(500, "trophies");
  assert.equal(extraHostTrophies.length, 0,
    "host MUST NOT receive a second trophies frame after already winning");

  host.close(); guest.close();
});

test("guest leaves before host reports win: guest -stakes, затем host +stakes один раз", async () => {
  const { host, guest, stakes } = await pair(srv.baseUrl, "u-host-2", "u-guest-2");

  guest.send({ type: "leave" });
  const guestT = await guest.waitFor("trophies", 3000);
  assert.equal(guestT.delta, -stakes.loss);

  host.send({ type: "match_win" });
  const hostT = await host.waitFor("trophies", 3000);
  assert.equal(hostT.delta, stakes.win);

  // Повторный match_loss от гостя не должен добавить второй штраф.
  guest.send({ type: "match_loss" });
  const extraGuest = await guest.collectFor(500, "trophies");
  assert.equal(extraGuest.length, 0);

  host.close(); guest.close();
});
