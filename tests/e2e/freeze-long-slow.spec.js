"use strict";

/* Расширенный freeze-тест: долгий матч с CPU throttle ×6 для симуляции
   слабого ПК + замер роста heap. Цель — воспроизвести жалобу «ОЗУ
   забивается, игра фризит».

   Параметры подобраны так, чтобы:
   - 60 секунд гоняем input → минимум ~60 физ-ударов, достаточно для
     detection утечек (linear heap growth).
   - CPU throttle ×6 приближает к Intel HD / старому ноуту.
   - Снимок heap каждые 5 секунд → тренд-слоп, а не единичный sample. */

const { test, expect } = require("@playwright/test");

test("long bot match on throttled CPU: frame-time + heap growth", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  test.skip(browserName !== "chromium", "CDP.Emulation.setCPUThrottlingRate доступен только в chromium");

  const r = await page.request.get(`/dev/login?id=slow-probe&name=Probe`);
  expect(r.ok()).toBeTruthy();
  page.on("pageerror", e => console.log("[page err]", e.message));
  await page.goto("/");
  await page.waitForFunction(() => !!window.__dvDebug);
  await page.bringToFront();

  // Привязываем CDP-клиент и врубаем throttle. Rate=6 ≈ слабый ноут /
  // iGPU. Поднимаем до старта матча — чтобы ранний-детект lowQuality тоже
  // учитывал «реальную» нагрузку.
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 6 });

  await page.evaluate(() => {
    window.__dvProfile = true;
    window.__frames = [];
    window.__long = [];
    window.__heap = [];
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
    // Снимаем heap каждые 5с на всё время теста.
    if(performance.memory){
      setInterval(() => {
        window.__heap.push({
          t: performance.now(),
          mb: performance.memory.usedJSHeapSize / 1048576
        });
      }, 5000);
    }
  });

  await page.click("#btn-play");
  await page.waitForFunction(
    () => { const s = window.__dvDebug && window.__dvDebug(); return s && s.inGame; },
    { timeout: 20_000 }
  );

  // 60с активного геймплея: чередуем движение + прыжок, чтобы триггерить
  // реальные коллизии и spawnParticles/Fx.hit.
  const ITER = 120;               // ~0.5с на итерацию → 60с суммарно
  for(let i = 0; i < ITER; i++){
    const key = i % 2 ? "ArrowLeft" : "ArrowRight";
    await page.keyboard.down(key);
    await new Promise(r => setTimeout(r, 250));
    await page.keyboard.up(key);
    if(i % 4 === 0) await page.keyboard.press("Space");
    await new Promise(r => setTimeout(r, 200));
  }

  const { frames, longTasks, prof, heap, debug } = await page.evaluate(() => ({
    frames: window.__frames.slice(-2000),
    longTasks: window.__long.slice(),
    prof: window.__dvProf ? {
      step: window.__dvProf.step.slice(-2000),
      render: window.__dvProf.render.slice(-2000),
      steps: window.__dvProf.steps.slice(-2000)
    } : null,
    heap: window.__heap.slice(),
    debug: window.__dvDebug && window.__dvDebug()
  }));

  await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const sorted = frames.slice().sort((a,b) => a - b);
  const p = q => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*q))];
  const mean = frames.reduce((a,b) => a+b, 0) / frames.length;
  const jank33 = frames.filter(f => f > 33).length;
  const jank50 = frames.filter(f => f > 50).length;
  const freeze100 = frames.filter(f => f > 100).length;
  const freeze200 = frames.filter(f => f > 200).length;

  console.log(`[slow] CPU throttle x6, duration ≈60s`);
  console.log(`[slow] frames n=${frames.length}  mean=${mean.toFixed(1)}  p50=${p(0.5).toFixed(1)}  p90=${p(0.9).toFixed(1)}  p95=${p(0.95).toFixed(1)}  p99=${p(0.99).toFixed(1)}  max=${p(1).toFixed(1)}`);
  console.log(`[slow] jank>33ms=${jank33}  jank>50ms=${jank50}  freeze>100ms=${freeze100}  freeze>200ms=${freeze200}`);

  if(longTasks.length){
    const top = longTasks.slice().sort((a,b) => b.d - a.d).slice(0, 10);
    console.log(`[slow] longTasks n=${longTasks.length}  top10=${top.map(t => t.d.toFixed(0)+"ms").join(",")}`);
  } else {
    console.log(`[slow] longTasks: none`);
  }

  if(prof){
    const stat = (arr) => {
      const s = arr.slice().sort((a,b)=>a-b);
      return { p50: s[Math.floor(s.length*0.5)], p95: s[Math.floor(s.length*0.95)], p99: s[Math.floor(s.length*0.99)], max: s[s.length-1] };
    };
    const st = stat(prof.step);
    const rd = stat(prof.render);
    const totalSteps = prof.steps.reduce((a,b)=>a+b,0);
    const maxSteps = Math.max(...prof.steps);
    console.log(`[slow] step  p50=${st.p50.toFixed(2)}  p95=${st.p95.toFixed(2)}  p99=${st.p99.toFixed(2)}  max=${st.max.toFixed(2)} ms`);
    console.log(`[slow] render p50=${rd.p50.toFixed(2)}  p95=${rd.p95.toFixed(2)}  p99=${rd.p99.toFixed(2)}  max=${rd.max.toFixed(2)} ms`);
    console.log(`[slow] total physics steps=${totalSteps}  max steps/frame=${maxSteps}`);
  }

  if(heap.length >= 2){
    const first = heap[0].mb;
    const last  = heap[heap.length - 1].mb;
    const peak  = Math.max(...heap.map(h => h.mb));
    console.log(`[slow] heap samples=${heap.length}  start=${first.toFixed(1)}MB  end=${last.toFixed(1)}MB  peak=${peak.toFixed(1)}MB  delta=${(last-first).toFixed(1)}MB`);
    // Линейный тренд: slope MB/min
    const n = heap.length;
    let sumX=0, sumY=0, sumXY=0, sumXX=0;
    for(const h of heap){
      const x = h.t / 60000; // минуты
      sumX += x; sumY += h.mb; sumXY += x*h.mb; sumXX += x*x;
    }
    const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX);
    console.log(`[slow] heap slope=${slope.toFixed(1)}MB/min (positive = leak)`);
  }

  console.log(`[slow] final debug: lowQuality=${debug.lowQuality} stepHz=${debug.stepHz} ft_avg=${debug.frameTimeAvg?.toFixed(1)}ms ft_p95=${debug.frameTimeP95?.toFixed(1)}ms heap=${debug.heapMB?.toFixed(0)}MB`);
});
