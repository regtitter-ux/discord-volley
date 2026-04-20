"use strict";

/* Stage 7.3: клиент умеет dual-connect (gameWs на Hathora room-server'е),
   но при DV_ROOMS=local (дефолт) второй сокет не создаётся, всё идёт
   через menu-WS как раньше.

   Этот spec фиксирует wire-format backward-compatibility:
   matched без roomHost → state.gameWs остаётся null, inGame достигается,
   а в снапшоте _debug gameWsState="(none)". */

const { test, expect } = require("@playwright/test");

async function devLogin(ctx, id, name){
  const page = await ctx.newPage();
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(name)}`);
  expect(r.ok()).toBeTruthy();
  await page.close();
}

test("DV_ROOMS=local: matched без roomHost — gameWs не открывается, матч работает", async ({ browser }) => {
  test.setTimeout(30_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await devLogin(ctxA, "dc-a", "DualA");
  await devLogin(ctxB, "dc-b", "DualB");
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto("/");
  await pageB.goto("/");
  await pageA.waitForFunction(() => !!window.__dvDebug);
  await pageB.waitForFunction(() => !!window.__dvDebug);

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

  // Оба в PvP (не в бот), menu-WS открыт на обоих.
  expect(["host", "guest"]).toContain(stA.mode);
  expect(["host", "guest"]).toContain(stB.mode);
  expect(stA.wsState).toBe("OPEN");
  expect(stB.wsState).toBe("OPEN");

  // Ключевая проверка: без DV_ROOMS=hathora клиент НЕ должен создавать
  // второй сокет. gameWsState = "(none)" означает state.gameWs === null.
  expect(stA.gameWsState).toBe("(none)");
  expect(stB.gameWsState).toBe("(none)");

  await ctxA.close();
  await ctxB.close();
});
