"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Онлайн-счётчик ведётся на брокере (incrOnline/decrOnline) и рассылается
// всем подключённым фреймом {type:"stats", online}. Проверяем:
//   1) N клиентов последовательно → у последнего hello.online >= N,
//      и все предыдущие получают stats-фрейм с online >= N.
//   2) после закрытия всех → следующий свежий клиент видит
//      hello.online == 1 (он сам — единственный).
let srv;
test.before(async () => { srv = await startServer({ STATS_INTERVAL_MS: "400" }); });
test.after(async ()  => { if (srv) await srv.stop(); });

test("online counter: hello + stats учитывают всех подключённых (5 клиентов) и корректно уменьшается", async () => {
  const N = 5;
  const ids = Array.from({ length: N }, (_, i) => `u-online-${i + 1}`);
  const cookies = await Promise.all(ids.map(id => devLogin(srv.baseUrl, id, id)));
  const clients = [];
  for (let i = 0; i < N; i++){
    clients.push(await openClient(srv.baseUrl, cookies[i], ids[i]));
  }

  // hello приходит первым фреймом на каждом openClient (см. harness).
  const lastHello = clients[N - 1].received.find(m => m && m.type === "hello");
  assert.ok(lastHello, "последний клиент видел hello");
  assert.ok(Number(lastHello.online) >= N,
    `последний клиент видит hello.online >= ${N}, получил ${lastHello.online}`);

  // Stats-broadcast шлётся всем — у первых клиентов к моменту подключения
  // последнего должен быть хотя бы один фрейм с online >= N.
  const statsP = m => m && m.type === "stats" && Number(m.online) >= N;
  await Promise.all(clients.slice(0, N - 1).map(c => c.waitFor(statsP, 2000)));

  // Закрываем всех, ждём, пока сервер спустит online к 0.
  for (const c of clients) c.close();
  await new Promise(r => setTimeout(r, 500));

  // Свежий (N+1)-й клиент должен увидеть hello.online == 1 (он сам).
  const extraId = `u-online-${N + 1}`;
  const cookieExtra = await devLogin(srv.baseUrl, extraId, extraId);
  const cExtra = await openClient(srv.baseUrl, cookieExtra, extraId);
  const helloExtra = cExtra.received.find(m => m && m.type === "hello");
  assert.ok(helloExtra);
  assert.equal(helloExtra.online, 1,
    `после disconnect всех предыдущих новый клиент должен видеть online=1, получил ${helloExtra.online}`);

  cExtra.close();
});
