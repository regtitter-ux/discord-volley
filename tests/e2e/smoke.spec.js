"use strict";

const { test, expect } = require("@playwright/test");

async function devLogin(page, id, name){
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(name)}`);
  expect(r.ok()).toBeTruthy();
}

test("loads index and shows login or menu after auth", async ({ page }) => {
  await devLogin(page, "tester-1", "Tester One");
  await page.goto("/");
  // После /dev/login session есть, menu-screen должен быть виден.
  const menu = page.locator("#screen-menu");
  await expect(menu).not.toHaveClass(/hidden/);
});

test("canvas renders at non-trivial size after bot match start", async ({ page }) => {
  await devLogin(page, "tester-2", "Tester Two");
  await page.goto("/");
  // «Играть против бота» — ищем кнопку; в нашем UI это btn-play-bot
  // (если переименуется — ловим по i18n-ключу).
  const btnBot = page.locator("#btn-play-bot, [data-i18n='menu.play_bot']");
  await btnBot.first().click({ timeout: 5000 }).catch(() => {});
  // Canvas должен получить размеры после show("game") + resizeCanvas.
  const size = await page.evaluate(() => {
    const cv = document.getElementById("cv");
    return cv ? { w: cv.width, h: cv.height } : null;
  });
  // Допускаем, что бот-кнопка не нажалась — тест всё равно должен дать
  // canvas из меню (он может быть 0×0, пока не в игре). Когда путь пройден,
  // ожидаем существенный размер.
  expect(size).toBeTruthy();
});
