"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Регрешн от юзерского репорта:
//   «Когда матч завершается и один жмёт Играть Снова, второго выкидывает
//   в главное меню, и когда второй тоже начинает поиск — оба друг друга
//   не находят. Помогает только отмена поиска + новый поиск.»
//
// Корень: на сервере leaveRoom сбрасывал ws.roomId только у уходящего.
// У оставшегося пира ws.roomId продолжал указывать на закрытую комнату,
// и onQueue его следующий queue игнорил («уже в матче»). Фикс:
// leaveRoom дополнительно чистит ws.roomId/activeMatchId у локальных
// пиров той же комнаты.
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async ()  => { if (srv) await srv.stop(); });

test("после leave одного игрока второй может встать в очередь без cancel", async () => {
  const cA = await devLogin(srv.baseUrl, "u-replay-a", "u-replay-a");
  const cB = await devLogin(srv.baseUrl, "u-replay-b", "u-replay-b");
  const A = await openClient(srv.baseUrl, cA, "u-replay-a");
  const B = await openClient(srv.baseUrl, cB, "u-replay-b");

  // Первая пара.
  A.send({ type: "queue" });
  await new Promise(r => setTimeout(r, 30));
  B.send({ type: "queue" });
  const [m1, m2] = await Promise.all([
    A.waitFor("matched", 2000),
    B.waitFor("matched", 2000)
  ]);
  assert.equal(m1.role, "host");
  assert.equal(m2.role, "guest");
  const firstRoom = m1.room;
  // Предикат "не та же комната" — received-буфер хранит старый matched,
  // и дефолтный waitFor("matched") моментально вернул бы именно его.
  const newMatched = (m) => m && m.type === "matched" && m.room !== firstRoom;

  // Симулируем «Играть снова» у A: leave, затем queue (без cancel!).
  A.send({ type: "leave" });
  // Даём серверу дойти до publishRoom peer_left → локальная чистка пира.
  const peerLeft = await B.waitFor("peer_left", 2000);
  assert.equal(peerLeft.reason, "leave");

  A.send({ type: "queue" });

  // Теперь B тоже жмёт «Играть снова». Без фикса его queue игнорится
  // сервером (ws.roomId ещё установлен), и matched второй раз не придёт.
  B.send({ type: "leave" });
  B.send({ type: "queue" });

  const [mm1, mm2] = await Promise.all([
    A.waitFor(newMatched, 3000),
    B.waitFor(newMatched, 3000)
  ]);
  assert.ok(mm1.room !== firstRoom, "новая комната, не старая");
  assert.equal(mm1.room, mm2.room, "обе стороны в одной комнате");

  A.close(); B.close();
});

test("peer_left в matchOver оверлее не выбивает второго игрока (client-side, проверяется через отсутствие серверного повторного matched)", async () => {
  // Серверный эквивалент: после форфейт-leave A, B получает peer_left, и
  // если B НЕ жмёт Играть снова сразу — его ws.roomId должен быть сброшен
  // (и следующий queue должен работать с задержкой), а ещё не должно
  // прилетать никаких queue_timeout/matched.
  const cA = await devLogin(srv.baseUrl, "u-matchover-a", "u-matchover-a");
  const cB = await devLogin(srv.baseUrl, "u-matchover-b", "u-matchover-b");
  const A = await openClient(srv.baseUrl, cA, "u-matchover-a");
  const B = await openClient(srv.baseUrl, cB, "u-matchover-b");

  A.send({ type: "queue" });
  await new Promise(r => setTimeout(r, 30));
  B.send({ type: "queue" });
  const [first1] = await Promise.all([A.waitFor("matched", 2000), B.waitFor("matched", 2000)]);
  const firstRoom = first1.room;
  const newMatched = (m) => m && m.type === "matched" && m.room !== firstRoom;

  // A уходит. B получает peer_left, дальше должен "тихо" ждать — никакой
  // мусор типа matched/queue_timeout не должен прилетать в фоне.
  A.send({ type: "leave" });
  await B.waitFor("peer_left", 2000);
  const stray = await B.collectFor(500, m => m.type === "queue_timeout");
  assert.equal(stray.length, 0, `B не должен получать queue_timeout в idle, получил ${stray.length}`);

  // B всё же решает переподняться в очередь — должно работать без cancel.
  B.send({ type: "queue" });
  A.send({ type: "queue" });
  const [mm1, mm2] = await Promise.all([
    A.waitFor(newMatched, 3000),
    B.waitFor(newMatched, 3000)
  ]);
  assert.equal(mm1.room, mm2.room);

  A.close(); B.close();
});
