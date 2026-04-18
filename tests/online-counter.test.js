"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Онлайн-счётчик ведётся на брокере (incrOnline/decrOnline) и рассылается
// всем подключённым фреймом {type:"stats", online}. Проверяем:
//   1) три клиента последовательно → у третьего hello.online >= 3 и/или
//      приходит stats-фрейм с online >= 3.
//   2) после закрытия всех трёх → следующий свежий клиент видит
//      hello.online == 1 (он сам — единственный).
let srv;
test.before(async () => { srv = await startServer({ STATS_INTERVAL_MS: "400" }); });
test.after(async ()  => { if (srv) await srv.stop(); });

test("online counter: hello + stats учитывают всех подключённых (3 клиента) и корректно уменьшается", async () => {
  const cookies = await Promise.all([
    devLogin(srv.baseUrl, "u-online-1", "u-online-1"),
    devLogin(srv.baseUrl, "u-online-2", "u-online-2"),
    devLogin(srv.baseUrl, "u-online-3", "u-online-3"),
  ]);

  const c1 = await openClient(srv.baseUrl, cookies[0], "u-online-1");
  const c2 = await openClient(srv.baseUrl, cookies[1], "u-online-2");
  const c3 = await openClient(srv.baseUrl, cookies[2], "u-online-3");

  // hello приходит первым фреймом на каждом openClient (см. harness).
  const hello3 = c3.received.find(m => m && m.type === "hello");
  assert.ok(hello3, "третий клиент видел hello");
  assert.ok(Number(hello3.online) >= 3,
    `третий клиент видит hello.online >= 3, получил ${hello3.online}`);

  // Stats-broadcast триггерится на каждом connect/disconnect, поэтому у c1/c2
  // должен был прийти хотя бы один stats-фрейм с online >= 3 к моменту
  // подключения c3. Ждём до 1.2с (STATS_INTERVAL_MS=400 × ~3 тика запас).
  const statsP = m => m && m.type === "stats" && Number(m.online) >= 3;
  const [s1, s2] = await Promise.all([
    c1.waitFor(statsP, 1500),
    c2.waitFor(statsP, 1500),
  ]);
  assert.ok(s1.online >= 3 && s2.online >= 3);

  // Закрываем всех трёх, ждём, пока сервер спустит online обратно к 0.
  c1.close(); c2.close(); c3.close();
  await new Promise(r => setTimeout(r, 500));

  // Свежий четвёртый клиент должен увидеть hello.online == 1 (он сам).
  const cookie4 = await devLogin(srv.baseUrl, "u-online-4", "u-online-4");
  const c4 = await openClient(srv.baseUrl, cookie4, "u-online-4");
  const hello4 = c4.received.find(m => m && m.type === "hello");
  assert.ok(hello4);
  assert.equal(hello4.online, 1,
    `после disconnect всех предыдущих новый клиент должен видеть online=1, получил ${hello4.online}`);

  c4.close();
});
