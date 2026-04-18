"use strict";

const { test, expect } = require("@playwright/test");

// resizeCanvas теперь rAF-throttled: в одном кадре допускается ровно
// одно реальное исполнение (первое), остальные пропускаются до
// следующего requestAnimationFrame. Тест бомбит 100 ресайзов подряд
// синхронно и проверяет счётчик — должен вырасти максимум на 1 внутри
// одного rAF-окна.
async function devLogin(page, id){
  const r = await page.request.get(`/dev/login?id=${id}&name=${encodeURIComponent(id)}`);
  expect(r.ok()).toBeTruthy();
}

test("resizeCanvas rAF-throttle: 100 вызовов в одном кадре = 1 исполнение", async ({ page }) => {
  await devLogin(page, "e2e-resize");
  await page.goto("/");
  await expect(page.locator("#screen-menu")).not.toHaveClass(/hidden/);

  // Читаем baseline count. На старте resizeCanvas уже мог вызваться
  // (см. конец game.js + ResizeObserver). Фиксируем число ДО нашего залпа.
  // И дожидаемся тишины (никто больше не дергает resizeCanvas): один rAF
  // после которого counter не изменится — значит очередь чиста.
  const baseline = await page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    return window.__dvResizeCount();
  });

  // Бомбим 100 прямых вызовов resizeCanvas синхронно (через reflection из
  // модульной области — недоступно; дёргаем через ResizeObserver/resize
  // событие. Но свободнее: эмулируем realistic залп через dispatchEvent
  // window-resize и ручные прямые вызовы, если доступны).
  // В проде фаст-путь — это ResizeObserver(canvas), который мы эмулируем
  // просто форсированной сменой style canvas'а: observer выстрелит
  // одним или двумя callback'ами, но все в одном кадре.
  const delta = await page.evaluate(async () => {
    const before = window.__dvResizeCount();
    // Берём локальный resizeCanvas через window-событие resize и рАФом
    // сливаем всё в ОДНОМ кадре: dispatchEvent синхронный, и слушатель
    // на 'resize' вызовет resizeCanvas 100 раз подряд.
    for (let i = 0; i < 100; i++){
      window.dispatchEvent(new Event("resize"));
    }
    // Ждём один rAF — throttle должен отработать, и только одно реальное
    // исполнение добавится к counter'у.
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    return window.__dvResizeCount() - before;
  });

  // Для 100 синхронных window.resize должно быть ровно 1 исполнение
  // (первое в кадре выполняется сразу, остальные 99 гасятся). Допускаем 2
  // как мягкий апсайд на случай, если rAF успел провалиться посреди
  // залпа — 100 всё равно катастрофически отличается от 1-2.
  expect(delta).toBeLessThanOrEqual(2);
  expect(delta).toBeGreaterThanOrEqual(1);

  // Sanity: canvas всё ещё имеет размеры (throttle не сломал нормальный
  // resize — первый вызов в залпе отработал на реальной ширине).
  const size = await page.evaluate(() => {
    const cv = document.getElementById("cv");
    return { w: cv.width, h: cv.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  // Базовое количество вызовов до нашего залпа было разумным — не тысячи.
  expect(baseline).toBeLessThan(50);
});
