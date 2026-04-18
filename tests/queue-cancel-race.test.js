"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin, openClient } = require("./helpers/harness");

// Regression smoke: быстрая последовательность queue → cancel (50мс) не
// должна закрыть WS и не должна оставить юзера в «зависшей» waiting-записи.
// Если сервер пытается освобождать очередь до первого pairLocal-тика и при
// этом не пишет ws.roomId — обычная последовательность безопасна. Тест
// фиксирует это поведение, чтобы будущий рефакторинг не сломал пользовательский
// сценарий «передумал сразу после click».
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async ()  => { if (srv) await srv.stop(); });

test("queue + cancel через 50мс: WS жив, второй queue работает нормально", async () => {
  const cookie = await devLogin(srv.baseUrl, "u-cancel-race", "u-cancel-race");
  const c = await openClient(srv.baseUrl, cookie, "u-cancel-race");

  c.send({ type: "queue" });
  await new Promise(r => setTimeout(r, 50));
  c.send({ type: "cancel" });

  // Сокет остался живым — сервер не закрыл его по ошибке.
  assert.equal(c.ws.readyState, 1 /* OPEN */, "WS должен остаться open после queue+cancel");

  // Небольшая пауза — убеждаемся, что никакой matched/queue_timeout не
  // прилетел в фоне.
  const stray = await c.collectFor(300, m => m.type === "matched" || m.type === "queue_timeout");
  assert.equal(stray.length, 0, `не должно прилететь matched/queue_timeout после cancel, получили ${stray.length}`);

  // И повторный queue/cancel должен работать без зависаний — предыдущий
  // cancel корректно снял юзера со сервера.
  c.send({ type: "queue" });
  await new Promise(r => setTimeout(r, 30));
  c.send({ type: "cancel" });
  assert.equal(c.ws.readyState, 1);

  c.close();
});
