"use strict";

/* Регрессия: после peer_left гость продолжает рендер. Раньше при форфейте
   state.opponent=null, а drawPlayer(p2, null) кидал TypeError по .avatar_url
   на каждый rAF-кадр — это убивало перф и валилось в консоль. Проверяем,
   что uncaught-ошибок нет в течение ~1с после peer_left. */

const { test, expect } = require("@playwright/test");

async function devLogin(page, id){
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(id)}`);
  expect(r.ok()).toBeTruthy();
}

test("forfeit: рендер гостя не кидает uncaught после peer_left", async ({ browser }, testInfo) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Собираем pageerror из B — они и были симптомом бага.
  const pageErrorsB = [];
  pageB.on("pageerror", e => pageErrorsB.push(e.message));

  const tag = String(testInfo.project.name).replace(/[^a-z0-9]/gi, "-");
  await devLogin(pageA, `forfeit-a-${tag}`);
  await devLogin(pageB, `forfeit-b-${tag}`);
  await pageA.goto("/");
  await pageB.goto("/");

  await pageA.locator("#btn-play").click();
  await pageB.locator("#btn-play").click();

  // Обе стороны встали в матч.
  await expect.poll(async () => {
    const mA = await pageA.evaluate(() => (window.__dvState || {}).mode);
    const mB = await pageB.evaluate(() => (window.__dvState || {}).mode);
    return mA !== "bot" && mB !== "bot" && mA && mB ? "ok" : "wait";
  }, { timeout: 10_000 }).toBe("ok");
  await expect.poll(async () => {
    return await pageB.evaluate(() => !!(window.__dvState || {}).inGame);
  }, { timeout: 5_000 }).toBe(true);

  // A уходит → B видит peer_left → endByForfeit → state.opponent=null.
  await pageA.locator("#btn-home").click();

  // B видит оверлей форфейта.
  await expect(pageB.locator("#overlay")).not.toHaveClass(/hidden/, { timeout: 10_000 });

  // Даём рендеру отработать ещё секунду — раньше за это время падало ~30
  // TypeError'ов (каждый кадр).
  await pageB.waitForTimeout(1200);

  const avatarErrors = pageErrorsB.filter(m => /avatar_url/.test(m));
  expect(avatarErrors).toEqual([]);

  await ctxA.close();
  await ctxB.close();
});
