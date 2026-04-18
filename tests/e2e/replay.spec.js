"use strict";

const { test, expect } = require("@playwright/test");

// Сценарий от юзера: два клиента встали в очередь → matched → один
// уходит (btn-home), второй жмёт «Играть снова». Канвас у второго не
// должен остаться чёрным 0×0 (исторический баг: show("menu") +
// show("game") в онлайне без ResizeObserver теряли размеры canvas).
// В этом тесте пара не воссоздаётся (A ушёл), второй уйдёт в бот через
// QUEUE_TIMEOUT_MS (см. playwright.config.js) — важен сам факт, что
// после replay canvas получает размеры и screen-game не скрыт.
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

test("replay после peer_left: canvas не чёрный и screen-game виден", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Дев-логин с уникальным userId на проект (desktop-chrome/mobile-chrome):
  // иначе параллельные прогоны кладут в один сервер клиентов с совпадающим
  // userId — и "A" из desktop может запариться с "A" из mobile вместо B.
  const tag = String(testInfo.project.name).replace(/[^a-z0-9]/gi, "-");
  await devLogin(pageA, `e2e-replay-a-${tag}`);
  await devLogin(pageB, `e2e-replay-b-${tag}`);

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

  // Ждём, пока обе стороны пропишут mode не-бот (может задержаться на 1-2
  // кадра относительно screen-game.classList). Параллельные прогоны
  // другого .spec на том же webServer иногда замедляют эту трассу.
  await expect.poll(async () => {
    const mA = await pageA.evaluate(() => (window.__dvState || {}).mode);
    const mB = await pageB.evaluate(() => (window.__dvState || {}).mode);
    return mA !== "bot" && mB !== "bot" ? "online" : `${mA}/${mB}`;
  }, { timeout: 10_000 }).toBe("online");

  // Ждём state.inGame у B — это сигнал, что Game.start() уже прописал
  // состояние и onPeerLeft сможет уйти в ветку endByForfeit.
  await expect.poll(async () => {
    return await pageB.evaluate(() => !!(window.__dvState || {}).inGame);
  }, { timeout: 5_000 }).toBe(true);

  // HUD-индикатор режима должен совпадать со state.mode: в онлайне это
  // перевод "hud.online" (ONLINE/ОНЛАЙН), в боте — "hud.bot" (BOT/БОТ).
  // Берём фактический текст из I18n через окно, чтобы тест был
  // language-agnostic (ru дефолт, en fallback).
  const onlineLabel = await pageB.evaluate(() => (window.I18n && window.I18n.t("hud.online")) || "ONLINE");
  const botLabel    = await pageB.evaluate(() => (window.I18n && window.I18n.t("hud.bot"))    || "BOT");
  const hudDiffOnline = (await pageB.locator("#hud-diff").textContent() || "").trim();
  expect(hudDiffOnline).toBe(onlineLabel);

  // A уходит в меню через btn-home → сервер рассылает peer_left → у B
  // срабатывает endByForfeit и показывает end-match оверлей с btn-replay.
  await pageA.locator("#btn-home").click();

  // B видит оверлей с кнопкой replay.
  await expect(pageB.locator("#overlay")).not.toHaveClass(/hidden/, { timeout: 10_000 });
  await expect(pageB.locator("#btn-replay")).toBeVisible();

  // Выдержка в 1 секунду — как в acceptance criteria.
  await pageB.waitForTimeout(1000);
  await pageB.locator("#btn-replay").click();

  // После replay: B делает quitToMenu → startMatchmaking. Пары нет, и через
  // QUEUE_TIMEOUT_MS сервер шлёт queue_timeout → клиент падает в бот-матч
  // → show("game") + resizeCanvas. Сначала дождёмся, что B снова на
  // screen-game (после quitToMenu→show("menu") это не мгновенно), затем
  // что canvas уехал в реальный размер.
  await expect(pageB.locator("#screen-game")).not.toHaveClass(/hidden/, { timeout: 10_000 });
  await expect.poll(async () => {
    const s = await canvasSize(pageB);
    return s ? Math.min(s.w, s.h) : 0;
  }, { timeout: 10_000, intervals: [150, 250, 500, 1000] }).toBeGreaterThanOrEqual(300);

  // После fallback в бот (QUEUE_TIMEOUT_MS выстрелил) state.mode === "bot"
  // и hud-diff обязан переключиться на перевод "hud.bot".
  await expect.poll(async () => {
    return await pageB.evaluate(() => (window.__dvState || {}).mode);
  }, { timeout: 10_000 }).toBe("bot");
  const hudDiffBot = (await pageB.locator("#hud-diff").textContent() || "").trim();
  expect(hudDiffBot).toBe(botLabel);

  await ctxA.close();
  await ctxB.close();
});
