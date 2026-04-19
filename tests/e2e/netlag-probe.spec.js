"use strict";

/* Диагностический прогон: два браузерных контекста, матчатся, измеряем
   реактивность своего слайма (CSP), задержку соперника и поведение буфера
   снапшотов. Не ассертит функциональность — только печатает метрики в log. */

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

test("local PvP latency probe", async ({ browser }) => {
  test.setTimeout(60_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await devLogin(ctxA, "probe-host", "Host");
  await devLogin(ctxB, "probe-guest", "Guest");
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const logsA = [], logsB = [];
  pageA.on("pageerror", e => logsA.push("[A err] " + e.message));
  pageB.on("pageerror", e => logsB.push("[B err] " + e.message));
  pageA.on("console", m => { if(m.type()==="error") logsA.push("[A cerr] " + m.text()); });
  pageB.on("console", m => { if(m.type()==="error") logsB.push("[B cerr] " + m.text()); });

  await pageA.goto("/");
  await pageB.goto("/");
  await pageA.waitForFunction(() => !!window.__dvDebug);
  await pageB.waitForFunction(() => !!window.__dvDebug);

  // Оба жмут "играть" — быстро, чтобы матчмейкер склеил.
  await pageA.click("#btn-play");
  await pageB.click("#btn-play");

  // Ставим мониторы frame-time и long-task ПЕРЕД матчем, чтобы ловить всё.
  for(const p of [pageA, pageB]){
    await p.evaluate(() => {
      window.__frameTimes = [];
      window.__longTasks = [];
      let prev = performance.now();
      const tick = (now) => {
        window.__frameTimes.push(now - prev);
        prev = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      try{
        const obs = new PerformanceObserver(list => {
          for(const entry of list.getEntries()){
            window.__longTasks.push({ d: entry.duration, s: entry.startTime, n: entry.name });
          }
        });
        obs.observe({ entryTypes: ["longtask"] });
      }catch(_){}
    });
  }

  const stA = await waitForState(pageA, s => s.inGame && (s.mode === "host" || s.mode === "guest"));
  const stB = await waitForState(pageB, s => s.inGame && (s.mode === "host" || s.mode === "guest"));
  console.log(`[probe] A.mode=${stA.mode}  B.mode=${stB.mode}`);
  expect([stA.mode, stB.mode].sort()).toEqual(["guest","host"]);

  // --- Тест 1: CSP — после keydown у гостя его p1.x должен сдвинуться почти мгновенно.
  const guest = stA.mode === "guest" ? pageA : pageB;
  const host  = stA.mode === "host"  ? pageA : pageB;

  // Ждём первый снапшот (буфер интерп. наполнился).
  await waitForState(guest, s => s.p2 && s.ball, 5000);
  await new Promise(r => setTimeout(r, 300));

  async function readGuest(){ return guest.evaluate(() => window.__dvDebug()); }
  async function readHost(){  return host.evaluate(() => window.__dvDebug()); }

  // Замер CSP изнутри страницы: ставим watcher на p1.x, возвращаем разницу
  // performance.now() между keydown и первым сдвигом >2px.
  await guest.evaluate(() => {
    window.__cspMs = null;
    window.__startProbe = () => {
      const g = window.__dvDebug();
      const x0 = g.p1 ? g.p1.x : 0;
      const t0 = performance.now();
      const id = requestAnimationFrame(function tick(){
        const s = window.__dvDebug();
        if(s.p1 && Math.abs(s.p1.x - x0) > 2){ window.__cspMs = performance.now() - t0; return; }
        requestAnimationFrame(tick);
      });
      window.__probeId = id;
    };
  });
  await guest.evaluate(() => window.__startProbe());
  await guest.keyboard.down("ArrowRight");
  await new Promise(r => setTimeout(r, 300));
  const cspMs = await guest.evaluate(() => window.__cspMs);
  await guest.keyboard.up("ArrowRight");
  console.log(`[probe] CSP self-reaction: ${cspMs != null ? cspMs.toFixed(1) : "null"} ms`);

  // Пауза перед следующим замером.
  await new Promise(r => setTimeout(r, 400));

  // --- Тест 2: peer-latency. Замер внутри guest-страницы. Ставим watcher
  // на p2.x, ждём keydown у хоста, засекаем первый визуальный сдвиг.
  await guest.evaluate(() => {
    window.__peerMs = null;
    window.__peerStart = null;
    const g = window.__dvDebug();
    window.__peerX0 = g.p2 ? g.p2.x : 0;
    requestAnimationFrame(function tick(){
      if(window.__peerStart !== null){
        const s = window.__dvDebug();
        if(s.p2 && Math.abs(s.p2.x - window.__peerX0) > 2){
          window.__peerMs = performance.now() - window.__peerStart;
          return;
        }
      }
      requestAnimationFrame(tick);
    });
  });
  // Синхронный сигнал: одновременно стартует watcher у гостя и keydown у хоста.
  await guest.evaluate(() => { window.__peerStart = performance.now(); });
  await host.keyboard.down("ArrowRight");
  await new Promise(r => setTimeout(r, 500));
  const peerMs = await guest.evaluate(() => window.__peerMs);
  await host.keyboard.up("ArrowRight");
  console.log(`[probe] Peer-visible reaction (host→guest): ${peerMs != null ? peerMs.toFixed(1) : "null"} ms`);

  await new Promise(r => setTimeout(r, 400));

  // --- Тест 3: состояние буфера во время rally
  const buf = [];
  for(let i = 0; i < 20; i++){
    const s = await readGuest();
    buf.push({ q: s.snapQLen, gap: s.snapAtoB });
    await new Promise(r => setTimeout(r, 50));
  }
  const avgQ = buf.reduce((a,b) => a + b.q, 0) / buf.length;
  const gaps = buf.map(b => b.gap).filter(v => v != null);
  const avgGap = gaps.length ? gaps.reduce((a,b) => a + b, 0) / gaps.length : null;
  console.log(`[probe] buffer avg length=${avgQ.toFixed(2)}  avg A→B gap=${avgGap ? (avgGap*1000).toFixed(1) : "n/a"} ms`);
  console.log(`[probe] RENDER_DELAY constant = ${(await readGuest()).renderDelay*1000} ms`);

  // --- Тест 4: пусть поиграют, смотрим на ошибки
  for(let i = 0; i < 10; i++){
    await host.keyboard.down(i % 2 ? "ArrowLeft" : "ArrowRight");
    await new Promise(r => setTimeout(r, 140));
    await host.keyboard.up(i % 2 ? "ArrowLeft" : "ArrowRight");
    await guest.keyboard.down(i % 2 ? "ArrowRight" : "ArrowLeft");
    await new Promise(r => setTimeout(r, 140));
    await guest.keyboard.up(i % 2 ? "ArrowRight" : "ArrowLeft");
    if(i % 3 === 0){ await host.keyboard.press("Space"); }
    if(i % 4 === 0){ await guest.keyboard.press("Space"); }
  }

  if(logsA.length || logsB.length){
    console.log("[probe] errors:\n" + logsA.concat(logsB).join("\n"));
  }

  // Анализ frame-times. Берём только «игровые» кадры (отсечь хвост загрузки).
  for(const [tag, page] of [["host", host], ["guest", guest]]){
    const { frames, longTasks } = await page.evaluate(() => ({
      frames: window.__frameTimes.slice(-300),
      longTasks: window.__longTasks.slice()
    }));
    if(!frames.length) continue;
    const sorted = frames.slice().sort((a,b) => a - b);
    const p50 = sorted[Math.floor(sorted.length*0.5)];
    const p95 = sorted[Math.floor(sorted.length*0.95)];
    const p99 = sorted[Math.floor(sorted.length*0.99)];
    const max = sorted[sorted.length - 1];
    const jank = frames.filter(f => f > 33).length;
    const freeze = frames.filter(f => f > 100).length;
    console.log(`[probe ${tag}] frames n=${frames.length} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} p99=${p99.toFixed(1)} max=${max.toFixed(1)} jank>33ms=${jank} freeze>100ms=${freeze}`);
    if(longTasks.length){
      const top = longTasks.slice().sort((a,b) => b.d - a.d).slice(0, 5);
      console.log(`[probe ${tag}] longTasks n=${longTasks.length} top=${top.map(t => t.d.toFixed(0)+"ms").join(",")}`);
    } else {
      console.log(`[probe ${tag}] longTasks: none`);
    }
  }

  const finalG = await readGuest();
  const finalH = await readHost();
  console.log(`[probe] final guest score=${finalG.score1}:${finalG.score2} inGame=${finalG.inGame} matchOver=${finalG.matchOver}`);
  console.log(`[probe] final host  score=${finalH.score1}:${finalH.score2} inGame=${finalH.inGame} matchOver=${finalH.matchOver}`);

  // Мягкий sanity: предсказание локальное, должно укладываться в ~33 мс
  // (двойной rAF + чуть физического шага).
  expect(cspMs).not.toBeNull();

  await ctxA.close();
  await ctxB.close();
});
