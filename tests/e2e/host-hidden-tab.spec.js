"use strict";

/* Регрессия: когда хост скрывает вкладку (браузер троттлит rAF до ~1 Гц),
   гость не должен «замерзать». Физика и broadcastSnapshot у хоста идут
   через Worker-tick, который не подвержен tab throttling. */

const { test, expect } = require("@playwright/test");

async function devLogin(ctx, id, name){
  const page = await ctx.newPage();
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(name)}`);
  expect(r.ok()).toBeTruthy();
  await page.close();
}

async function waitForState(page, predicate, timeoutMs = 15000){
  const start = Date.now();
  while(Date.now() - start < timeoutMs){
    const st = await page.evaluate(() => window.__dvDebug && window.__dvDebug());
    if(st && predicate(st)) return st;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("waitForState timeout");
}

test("host hidden tab: guest still sees ball moving", async ({ browser }) => {
  test.setTimeout(60_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await devLogin(ctxA, "probe-bg-host", "BgHost");
  await devLogin(ctxB, "probe-bg-guest", "BgGuest");
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto("/");
  await pageB.goto("/");
  await pageA.waitForFunction(() => !!window.__dvDebug);
  await pageB.waitForFunction(() => !!window.__dvDebug);
  await pageA.click("#btn-play");
  await pageB.click("#btn-play");

  const stA = await waitForState(pageA, s => s.inGame && (s.mode === "host" || s.mode === "guest"));
  await waitForState(pageB, s => s.inGame && (s.mode === "host" || s.mode === "guest"));
  const host  = stA.mode === "host"  ? pageA : pageB;
  const guest = stA.mode === "host"  ? pageB : pageA;

  // Ждём первый снапшот у гостя.
  await waitForState(guest, s => s.p2 && s.ball, 5000);

  // Запускаем мяч в движение (подача).
  await host.keyboard.press("Space");
  await new Promise(r => setTimeout(r, 150));

  // Отбираем 20 позиций мяча у гостя с интервалом 100мс, пока хост в
  // background. Собираем ещё до hidden, чтобы отличить активность.
  const cdp = await host.context().newCDPSession(host);
  await cdp.send("Page.enable");
  try{ await cdp.send("Emulation.setVisibilityState", { state: "hidden" }); }catch(_){}

  const positions = [];
  for(let i = 0; i < 25; i++){
    const p = await guest.evaluate(() => {
      const s = window.__dvDebug();
      return s && s.ball ? { x: s.ball.x, y: s.ball.y } : null;
    });
    if(p) positions.push(p);
    await new Promise(r => setTimeout(r, 100));
  }

  try{ await cdp.send("Emulation.setVisibilityState", { state: "visible" }); }catch(_){}

  // Если хост был заморожен (rAF ~1 Hz) — у гостя мяч либо застрял в одной
  // точке, либо очень медленно «тикал» раз в секунду. Считаем число разных
  // позиций мяча: при работающей физике на каждом из 25 семплов x будет
  // отличаться, без фикса — ≤5 разных позиций за 2.5с.
  const unique = new Set(positions.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
  let moveTotal = 0;
  for(let i = 1; i < positions.length; i++){
    const dx = positions[i].x - positions[i-1].x;
    const dy = positions[i].y - positions[i-1].y;
    moveTotal += Math.sqrt(dx*dx + dy*dy);
  }
  console.log(`[hidden-tab] ball samples=${positions.length}  unique=${unique.size}  total move=${moveTotal.toFixed(1)}px`);

  // Порог консервативный: рабочая физика даёт 15+ уникальных точек за 2.5с.
  expect(unique.size).toBeGreaterThan(10);
  expect(moveTotal).toBeGreaterThan(100);

  await ctxA.close();
  await ctxB.close();
});
