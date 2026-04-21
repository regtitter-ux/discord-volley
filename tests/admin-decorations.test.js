"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer, devLogin } = require("./helpers/harness");

/* Admin CRUD каталога украшений: upload multipart, update, delete.
   DV_ADMIN_IDS поднимает тестового админа без хардкод-id в ADMIN_IDS. */

let srv;
test.before(async () => { srv = await startServer({ DV_ADMIN_IDS: "admin-1" }); });
test.after(async ()  => { if (srv) await srv.stop(); });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fakePng(extra = 32){
  return Buffer.concat([PNG_SIG, Buffer.alloc(extra)]);
}
// RIFF + 4-byte little-endian размера + WEBP — минимально корректная "шапка"
// для нашей magic-byte проверки. Серверу достаточно первых 12 байт.
function fakeWebp(extra = 32){
  const head = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "ascii");
  return Buffer.concat([head, Buffer.alloc(extra)]);
}

async function loginAs(id){
  return await devLogin(srv.baseUrl, id, id);
}

function buildForm(fields, atlasBuffer){
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  if (atlasBuffer){
    fd.set("atlas", new Blob([atlasBuffer], { type: "image/png" }), "atlas.png");
  }
  return fd;
}

async function apiJson(path, opts){
  const r = await fetch(srv.baseUrl + path, opts);
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

test("GET /api/admin/decorations: 403 для non-admin, 200 для admin со встроенными deco1..deco4", async () => {
  const plain = await loginAs("user-1");
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations", { headers: { Cookie: plain } });
  assert.equal(r1.status, 403);

  const admin = await loginAs("admin-1");
  const r2 = await apiJson("/api/admin/decorations", { headers: { Cookie: admin } });
  assert.equal(r2.status, 200);
  assert.ok(Array.isArray(r2.body.catalog));
  const ids = r2.body.catalog.map(d => d.id);
  for (const seed of ["deco1", "deco2", "deco3", "deco4"]){
    assert.ok(ids.includes(seed), `seed ${seed} must be present`);
  }
  // Встроенные размечены флагом builtin=true — фронт использует для Delete-кнопки.
  const d1 = r2.body.catalog.find(d => d.id === "deco1");
  assert.equal(d1.builtin, true);
});

test("POST /api/admin/decorations: 403 non-admin, 400 bad_id", async () => {
  const plain = await loginAs("user-2");
  const fd = buildForm({ id: "sparkle", price: 1000, frames: 1, fps: 12, frameW: 96, frameH: 96, cols: 1, rows: 1 }, fakePng());
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: plain }, body: fd
  });
  assert.equal(r1.status, 403);

  const admin = await loginAs("admin-1");
  const badFd = buildForm({ id: "BAD!!", price: 100, frames: 1, fps: 12, frameW: 96, frameH: 96, cols: 1, rows: 1 }, fakePng());
  const r2 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: badFd
  });
  assert.equal(r2.status, 400);
  const j = await r2.json();
  assert.equal(j.error, "bad_id");
});

test("POST /api/admin/decorations: upsert создаёт и обновляет; /api/decorations видит запись", async () => {
  const admin = await loginAs("admin-1");

  // Create
  const createFd = buildForm({
    id: "sparkle", title: "Sparkle Test", price: 2500,
    frames: 4, fps: 12, frameW: 96, frameH: 96, cols: 2, rows: 2, sortOrder: 10
  }, fakePng(64));
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: createFd
  });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(j1.decoration.id, "sparkle");
  assert.equal(j1.decoration.price, 2500);
  assert.equal(j1.decoration.builtin, false);
  assert.match(j1.decoration.atlas, /^\/cdn\/decorations\/sparkle\/atlas\.png$/);

  // Public catalog видит украшение
  const user = await loginAs("user-3");
  const pub = await apiJson("/api/decorations", { headers: { Cookie: user } });
  assert.equal(pub.status, 200);
  const sparkle = pub.body.catalog.find(d => d.id === "sparkle");
  assert.ok(sparkle, "sparkle must be in public catalog");
  assert.equal(sparkle.title, "Sparkle Test");
  assert.equal(sparkle.price, 2500);
  // Cache-buster ?v=<updatedAt> на пути к атласу
  assert.match(sparkle.atlas, /^\/cdn\/decorations\/sparkle\/atlas\.png\?v=\d+$/);

  // Атлас-файл реально отдаётся
  const atlasResp = await fetch(srv.baseUrl + sparkle.atlas);
  assert.equal(atlasResp.status, 200);
  const buf = Buffer.from(await atlasResp.arrayBuffer());
  assert.ok(buf.slice(0, 8).equals(PNG_SIG));

  // Update: правим цену и title, без файла
  const updFd = buildForm({
    id: "sparkle", title: "Sparkle v2", price: 3500,
    frames: 4, fps: 12, frameW: 96, frameH: 96, cols: 2, rows: 2
  });
  const r2 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: updFd
  });
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.equal(j2.decoration.title, "Sparkle v2");
  assert.equal(j2.decoration.price, 3500);
});

test("POST /api/admin/decorations: валидация (atlas_bad_format, frames_exceed_grid, atlas_required)", async () => {
  const admin = await loginAs("admin-1");

  // Не-PNG и не-WebP файл
  const notImg = Buffer.from("hello-not-image-12345678");
  const fd1 = buildForm({
    id: "badpng", price: 100, frames: 1, fps: 12, frameW: 16, frameH: 16, cols: 1, rows: 1
  }, notImg);
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd1
  });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "atlas_bad_format");

  // Create без файла → atlas_required
  const fd2 = buildForm({
    id: "nofile", price: 100, frames: 1, fps: 12, frameW: 16, frameH: 16, cols: 1, rows: 1
  });
  const r2 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd2
  });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, "atlas_required");

  // frames > cols*rows
  const fd3 = buildForm({
    id: "gridbad", price: 100, frames: 100, fps: 12, frameW: 16, frameH: 16, cols: 2, rows: 2
  }, fakePng());
  const r3 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd3
  });
  assert.equal(r3.status, 400);
  assert.equal((await r3.json()).error, "frames_exceed_grid");
});

test("DELETE /api/admin/decorations/:id: удаляет запись + сбрасывает selected у носителей", async () => {
  const admin = await loginAs("admin-1");

  // Create decoration
  const fd = buildForm({
    id: "ghostdec", title: "Ghost", price: 0,
    frames: 1, fps: 12, frameW: 32, frameH: 32, cols: 1, rows: 1
  }, fakePng());
  const r0 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd
  });
  assert.equal(r0.status, 200);

  // Пользователь покупает + выбирает (price=0, так что покупка идёт бесплатно)
  const user = await loginAs("user-4");
  const buy = await fetch(srv.baseUrl + "/api/decorations/buy?id=ghostdec", {
    method: "POST", headers: { Cookie: user }
  });
  assert.equal(buy.status, 200);
  const sel = await fetch(srv.baseUrl + "/api/decorations/select?id=ghostdec", {
    method: "POST", headers: { Cookie: user }
  });
  assert.equal(sel.status, 200);

  const meBefore = await apiJson("/api/me", { headers: { Cookie: user } });
  assert.equal(meBefore.body.decoration.id, "ghostdec");

  // Admin удаляет
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations/ghostdec", {
    method: "DELETE", headers: { Cookie: admin }
  });
  assert.equal(r1.status, 200);

  // 404 на повторный delete
  const r2 = await fetch(srv.baseUrl + "/api/admin/decorations/ghostdec", {
    method: "DELETE", headers: { Cookie: admin }
  });
  assert.equal(r2.status, 404);

  // /api/me у юзера теперь без decoration (selected сброшен)
  const meAfter = await apiJson("/api/me", { headers: { Cookie: user } });
  assert.equal(meAfter.body.decoration, null);

  // /api/decorations больше не содержит ghostdec
  const pub = await apiJson("/api/decorations", { headers: { Cookie: user } });
  const found = pub.body.catalog.find(d => d.id === "ghostdec");
  assert.equal(found, undefined);
});

test("POST /api/admin/decorations: WebP-атлас принимается, URL заканчивается на .webp", async () => {
  const admin = await loginAs("admin-1");

  const fd = buildForm({
    id: "webpdec", title: "WebP Deco", price: 500,
    frames: 1, fps: 12, frameW: 32, frameH: 32, cols: 1, rows: 1
  }, fakeWebp(64));
  const r = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.decoration.atlas, /^\/cdn\/decorations\/webpdec\/atlas\.webp$/);

  // Публичный каталог отдаёт тот же URL + cache-buster
  const user = await loginAs("user-webp");
  const pub = await apiJson("/api/decorations", { headers: { Cookie: user } });
  const entry = pub.body.catalog.find(d => d.id === "webpdec");
  assert.ok(entry, "webpdec must be in public catalog");
  assert.match(entry.atlas, /^\/cdn\/decorations\/webpdec\/atlas\.webp\?v=\d+$/);

  // Файл реально доступен
  const atlasResp = await fetch(srv.baseUrl + entry.atlas);
  assert.equal(atlasResp.status, 200);
  const buf = Buffer.from(await atlasResp.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString("ascii"), "RIFF");
  assert.equal(buf.slice(8, 12).toString("ascii"), "WEBP");
});

test("POST /api/admin/decorations: смена формата png→webp подчищает старый файл", async () => {
  const admin = await loginAs("admin-1");

  // Загружаем как PNG
  const fd1 = buildForm({
    id: "swapfmt", title: "Swap", price: 0,
    frames: 1, fps: 12, frameW: 16, frameH: 16, cols: 1, rows: 1
  }, fakePng(64));
  const r1 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd1
  });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.match(j1.decoration.atlas, /atlas\.png$/);

  // Та же запись, но теперь WebP
  const fd2 = buildForm({
    id: "swapfmt", title: "Swap", price: 0,
    frames: 1, fps: 12, frameW: 16, frameH: 16, cols: 1, rows: 1
  }, fakeWebp(64));
  const r2 = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin }, body: fd2
  });
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.match(j2.decoration.atlas, /atlas\.webp$/);

  // Старый URL должен отдать 404 (а не stale-картинку) — файл снесён
  const staleResp = await fetch(srv.baseUrl + "/cdn/decorations/swapfmt/atlas.png");
  assert.equal(staleResp.status, 404);
});

test("POST /api/admin/decorations: 415 на не-multipart запрос", async () => {
  const admin = await loginAs("admin-1");
  const r = await fetch(srv.baseUrl + "/api/admin/decorations", {
    method: "POST", headers: { Cookie: admin, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "x" })
  });
  assert.equal(r.status, 415);
});
