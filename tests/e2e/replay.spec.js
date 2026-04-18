"use strict";

const { test, expect } = require("@playwright/test");

// Сценарий от юзера: два клиента встали в очередь → matched → один
// уходит (btn-home), второй жмёт «Играть снова». Канвас у второго не
// должен остаться чёрным 0×0 (исторический баг: show("menu") +
// show("game") в онлайне без ResizeObserver теряли размеры canvas).
// В этом тесте пара не воссоздаётся (A ушёл), второй уйдёт в бот через
// queue_timeout=1500мс — важен сам факт, что после replay canvas
// получает размеры и screen-game не скрыт.
async function devLogin(page, id){
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(id)}`);
  expect(r.ok()).toBeTruthy();
}

async function canvasSize(page){
  return await page.evaluate(() => {
    const cv = document.getElementById("cv");
    return cv ? { w: cv.width, h: cv.height } : null;
  });
}

test("replay после peer_left: canvas не чёрный и screen-game виден", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Дев-логин в каждом контексте (свои cookies).
  await devLogin(pageA, "e2e-replay-a");
  await devLogin(pageB, "e2e-replay-b");

  await pageA.goto("/");
  await pageB.goto("/");

  // Меню должно быть видно — это сигнал, что hello+auth прошли.
  await expect(pageA.locator("#screen-menu")).not.toHaveClass(/hidden/);
  await expect(pageB.locator("#screen-menu")).not.toHaveClass(/hidden/);

  // Оба жмут «Играть» — встают в очередь и находят друг друга.
  await pageA.locator("#btn-play").click();
  await pageB.locator("#btn-play").click();

  // screen-game становится видимым → matched + show("game").
  await expect(pageA.locator("#screen-game")).not.toHaveClass(/hidden/, { timeout: 10_000 });
  await expect(pageB.locator("#screen-game")).not.toHaveClass(/hidden/, { timeout: 10_000 });

  // Оба должны быть в ОНЛАЙНЕ, не в боте (state.mode из замыкания через window hook).
  const modeA = await pageA.evaluate(() => (window.__dvState || {}).mode);
  const modeB = await pageB.evaluate(() => (window.__dvState || {}).mode);
  expect(modeA).not.toBe("bot");
  expect(modeB).not.toBe("bot");

  // Пауза, чтобы у сервера точно успел прийти matched (ставки/opp). Короткая.
  await pageA.waitForTimeout(300);

  // A уходит в меню через btn-home → сервер рассылает peer_left → у B
  // срабатывает endByForfeit и показывает end-match оверлей с btn-replay.
  await pageA.locator("#btn-home").click();

  // B видит оверлей с кнопкой replay.
  await expect(pageB.locator("#overlay")).not.toHaveClass(/hidden/, { timeout: 5_000 });
  await expect(pageB.locator("#btn-replay")).toBeVisible();

  // Выдержка в 1 секунду — как в acceptance criteria.
  await pageB.waitForTimeout(1000);
  await pageB.locator("#btn-replay").click();

  // После replay: B делает quitToMenu → startMatchmaking. Пары нет, и через
  // QUEUE_TIMEOUT_MS=1500мс сервер шлёт queue_timeout → клиент падает в
  // бот-матч → show("game") + resizeCanvas. Ждём пока canvas не получит
  // боевой размер (>=300×300).
  await expect.poll(async () => {
    const s = await canvasSize(pageB);
    return s ? Math.min(s.w, s.h) : 0;
  }, { timeout: 10_000, intervals: [150, 250, 500, 1000] }).toBeGreaterThanOrEqual(300);

  // screen-game не скрылся — канвас живой.
  await expect(pageB.locator("#screen-game")).not.toHaveClass(/hidden/);

  await ctxA.close();
  await ctxB.close();
});
