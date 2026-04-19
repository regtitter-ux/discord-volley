"use strict";

/* Замер frame-time в одной активной вкладке (vs bot) — без tab throttling.
   Проверяем: реальные фризы vs artefacts Playwright параллельных contexts. */

const { test, expect } = require("@playwright/test");

test("single-page bot match: frame-time distribution", async ({ page }) => {
  test.setTimeout(40_000);
  const r = await page.request.get(`/dev/login?id=freeze-probe&name=Probe`);
  expect(r.ok()).toBeTruthy();
  page.on("pageerror", e => console.log("[page err]", e.message));
  page.on("console", m => { if(m.type()==="error") console.log("[page cerr]", m.text()); });
  await page.goto("/");
  await page.waitForFunction(() => !!window.__dvDebug);
  await page.bringToFront();

  // Запускаем мониторы frame-time и long-task.
  await page.evaluate(() => {
    window.__dvProfile = true;
    window.__frames = [];
    window.__long = [];
    let prev = performance.now();
    requestAnimationFrame(function tick(now){
      window.__frames.push(now - prev); prev = now;
      requestAnimationFrame(tick);
    });
    try{
      new PerformanceObserver(list => {
        for(const e of list.getEntries()){
          window.__long.push({ d: e.duration, s: e.startTime });
        }
      }).observe({ entryTypes: ["longtask"] });
    }catch(_){}
  });

  // Запускаем матч против бота (кнопка #btn-play-bot либо через бот-fallback).
  // В этой сборке кнопка одна — #btn-play, и matchmaking fallback вкинет бота
  // через QUEUE_TIMEOUT_MS (5000мс в тесте). Ждём inGame, играем ~12с.
  await page.click("#btn-play");
  await page.waitForFunction(
    () => { const s = window.__dvDebug && window.__dvDebug(); return s && s.inGame; },
    { timeout: 20_000 }
  );

  // Пошевелимся чтобы physics реально считался.
  for(let i = 0; i < 24; i++){
    await page.keyboard.down(i % 2 ? "ArrowLeft" : "ArrowRight");
    await new Promise(r => setTimeout(r, 180));
    await page.keyboard.up(i % 2 ? "ArrowLeft" : "ArrowRight");
    if(i % 3 === 0) await page.keyboard.press("Space");
  }

  const { frames, longTasks, prof } = await page.evaluate(() => ({
    frames: window.__frames.slice(-400),
    longTasks: window.__long.slice(),
    prof: window.__dvProf ? {
      step: window.__dvProf.step.slice(-400),
      render: window.__dvProf.render.slice(-400),
      steps: window.__dvProf.steps.slice(-400)
    } : null
  }));

  const sorted = frames.slice().sort((a,b) => a - b);
  const p = q => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*q))];
  const mean = frames.reduce((a,b) => a+b, 0) / frames.length;
  const jank33 = frames.filter(f => f > 33).length;
  const jank50 = frames.filter(f => f > 50).length;
  const freeze100 = frames.filter(f => f > 100).length;

  console.log(`[freeze] frames n=${frames.length}  mean=${mean.toFixed(1)}  p50=${p(0.5).toFixed(1)}  p90=${p(0.9).toFixed(1)}  p95=${p(0.95).toFixed(1)}  p99=${p(0.99).toFixed(1)}  max=${p(1).toFixed(1)}`);
  console.log(`[freeze] jank>33ms=${jank33}  jank>50ms=${jank50}  freeze>100ms=${freeze100}`);
  if(longTasks.length){
    const top = longTasks.slice().sort((a,b) => b.d - a.d).slice(0, 10);
    console.log(`[freeze] longTasks n=${longTasks.length}  top=${top.map(t => t.d.toFixed(0)+"ms").join(",")}`);
  } else {
    console.log(`[freeze] longTasks: none`);
  }

  // Идентифицируем подозрительные паттерны: повторные «зубцы» около 33ms
  // (физ-шаг не успевает в 16ms) или отдельные 60+ms (GC/layout/trace).
  let clusters33 = 0, lastBig = -5;
  for(let i = 0; i < frames.length; i++){
    if(frames[i] > 30 && frames[i] < 40){
      if(i - lastBig > 3) clusters33++;
      lastBig = i;
    }
  }
  console.log(`[freeze] 30-40ms clusters = ${clusters33}`);

  if(prof){
    const stat = (arr) => {
      const s = arr.slice().sort((a,b)=>a-b);
      return { p50: s[Math.floor(s.length*0.5)], p95: s[Math.floor(s.length*0.95)], p99: s[Math.floor(s.length*0.99)], max: s[s.length-1] };
    };
    const st = stat(prof.step);
    const rd = stat(prof.render);
    const totalSteps = prof.steps.reduce((a,b)=>a+b,0);
    const maxSteps = Math.max(...prof.steps);
    console.log(`[freeze] step  p50=${st.p50.toFixed(2)}  p95=${st.p95.toFixed(2)}  p99=${st.p99.toFixed(2)}  max=${st.max.toFixed(2)} ms`);
    console.log(`[freeze] render p50=${rd.p50.toFixed(2)}  p95=${rd.p95.toFixed(2)}  p99=${rd.p99.toFixed(2)}  max=${rd.max.toFixed(2)} ms`);
    console.log(`[freeze] total physics steps=${totalSteps}  max steps/frame=${maxSteps}`);
  }
});
