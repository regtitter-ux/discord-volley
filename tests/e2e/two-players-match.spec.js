"use strict";

/* Regression: два игрока жмут «Играть» (А чуть раньше B). Оба должны
   попасть в PvP-матч (host/guest), НЕ в бот до queue_timeout. Было:
   клик «Играть» до того как fire-and-forget ensureMenuSocket у enterMenu
   успевал прописать state.ws создавал параллельный сокет; его 2.5с
   таймаут иногда не добирался до open → startMatchmaking получал null и
   сваливал игрока в бот-матч у обоих сторон. */

const { test, expect } = require("@playwright/test");

async function devLogin(ctx, id, name){
  const page = await ctx.newPage();
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(name)}`);
  expect(r.ok()).toBeTruthy();
  await page.close();
}

test("two players clicking Play: PvP match, not bot", async ({ browser }) => {
  test.setTimeout(30_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await devLogin(ctxA, "pvp-a", "PvpA");
  await devLogin(ctxB, "pvp-b", "PvpB");
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto("/");
  await pageB.goto("/");
  await pageA.waitForFunction(() => !!window.__dvDebug);
  await pageB.waitForFunction(() => !!window.__dvDebug);

  // Кликаем «Играть» сразу после загрузки — до того, как enterMenu's
  // ensureMenuSocket() успевает установить WS. Это тот самый race из бага.
  await pageA.click("#btn-play");
  await new Promise(r => setTimeout(r, 200));
  await pageB.click("#btn-play");

  const waitInGame = async (page, label) => {
    const deadline = Date.now() + 10_000;
    while(Date.now() < deadline){
      const st = await page.evaluate(() => window.__dvDebug && window.__dvDebug());
      if(st && st.inGame) return st;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`${label}: never entered game`);
  };
  const stA = await waitInGame(pageA, "A");
  const stB = await waitInGame(pageB, "B");
  expect(stA.mode).not.toBe("bot");
  expect(stB.mode).not.toBe("bot");
  expect(["host", "guest"]).toContain(stA.mode);
  expect(["host", "guest"]).toContain(stB.mode);

  await ctxA.close();
  await ctxB.close();
});
