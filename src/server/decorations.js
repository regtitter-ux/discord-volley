"use strict";

const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");
const express = require("express");

/* Decorations — каталог косметических украшений аватара.
   Источник истины — SQLite (таблица decorations). Админ правит через
   multipart-upload (admin-CRUD + валидация PNG/WebP-сигнатуры); обычный
   клиент читает через /api/decorations и меняет выбранное через
   /api/decorations/select. Атлас лежит либо в /assets (встроенные,
   в репе), либо в DATA_DIR/decorations/<id>/ (загруженные, CDN'ом). */

const SEED_DECORATIONS = [
  { id: "deco1", title: "",
    atlas: "/assets/decorations/deco1/atlas.png",
    price: 10000, frames: 60, fps: 12, frameW: 96, frameH: 96, cols: 6, rows: 10, sortOrder: 1 },
  { id: "deco2", title: "",
    atlas: "/assets/decorations/deco2/atlas.png",
    price: 10000, frames: 60, fps: 12, frameW: 96, frameH: 96, cols: 6, rows: 10, sortOrder: 2 },
  { id: "deco3", title: "",
    atlas: "/assets/decorations/deco3/atlas.png",
    price: 10000, frames: 60, fps: 12, frameW: 96, frameH: 96, cols: 6, rows: 10, sortOrder: 3 },
  { id: "deco4", title: "",
    atlas: "/assets/decorations/deco4/atlas.png",
    price: 10000, frames: 60, fps: 12, frameW: 96, frameH: 96, cols: 6, rows: 10, sortOrder: 4 }
];

const DECO_ID_RE = /^[a-z0-9_-]{2,32}$/;
const DECO_ATLAS_MAX_BYTES = Number(process.env.DV_ATLAS_MAX_BYTES) || 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// WebP: "RIFF" + 4-byte size + "WEBP" в первых 12 байтах.
const WEBP_RIFF_SIG = Buffer.from("RIFF", "ascii");
const WEBP_WEBP_SIG = Buffer.from("WEBP", "ascii");

function detectAtlasFormat(buf){
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 && buf.slice(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 12
      && buf.slice(0, 4).equals(WEBP_RIFF_SIG)
      && buf.slice(8, 12).equals(WEBP_WEBP_SIG)) return "webp";
  return null;
}

function sanitizeDecoId(raw){
  const s = String(raw || "").trim().toLowerCase();
  return DECO_ID_RE.test(s) ? s : null;
}

function decorationCommonFields(d){
  return {
    id:     d.id,
    title:  d.title || "",
    price:  d.price | 0,
    frames: d.frames | 0,
    fps:    d.fps | 0,
    frameW: d.frameW | 0,
    frameH: d.frameH | 0,
    cols:   d.cols | 0,
    rows:   d.rows | 0,
  };
}

function decorationToWire(d){
  if (!d) return null;
  const isStaticAsset = typeof d.atlas === "string" && d.atlas.startsWith("/assets/");
  const ver = Number(d.updatedAt) || 0;
  const atlas = isStaticAsset
    ? d.atlas
    : d.atlas + (d.atlas.includes("?") ? "&" : "?") + "v=" + ver;
  return { ...decorationCommonFields(d), atlas };
}

function adminDecoToWire(d){
  if (!d) return null;
  return {
    ...decorationCommonFields(d),
    atlas:     d.atlas,
    sortOrder: d.sortOrder | 0,
    updatedAt: Number(d.updatedAt) || 0,
    builtin:   typeof d.atlas === "string" && d.atlas.startsWith("/assets/")
  };
}

function parseMultipartUpload(req){
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: DECO_ATLAS_MAX_BYTES, files: 1, fields: 32, fieldSize: 4096 }
      });
    } catch (e) { reject(e); return; }
    const fields = {};
    let file = null;
    bb.on("field", (name, val) => {
      if (typeof name === "string" && name.length <= 64) fields[name] = String(val);
    });
    bb.on("file", (name, stream, info) => {
      if (name !== "atlas"){ stream.resume(); return; }
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on("data", (c) => { chunks.push(c); size += c.length; });
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => {
        file = {
          buffer:   Buffer.concat(chunks, size),
          filename: info && info.filename ? String(info.filename) : "",
          mime:     info && (info.mimeType || info.mime) ? String(info.mimeType || info.mime) : "",
          size,
          truncated
        };
      });
      stream.on("error", reject);
    });
    bb.on("error", reject);
    bb.on("close", () => resolve({ fields, file }));
    req.pipe(bb);
  });
}

module.exports = function installDecorations({ app, DB, DATA_DIR, noStore, requireAdmin, getSession, pushCoinsToUser }){
  // Корень для загруженных админом атласов. Каждый id — своя подпапка.
  const DECORATIONS_DIR = path.join(DATA_DIR, "decorations");
  try { fs.mkdirSync(DECORATIONS_DIR, { recursive: true }); } catch(_) {}

  // Однократный сид при пустой таблице: встроенные deco1..deco4 заходят сами,
  // чтобы существующие прод-пользователи с купленными украшениями не
  // оказались с мёртвым owned_decorations csv.
  if (DB.countDecorations() === 0){
    for (const d of SEED_DECORATIONS) DB.upsertDecoration(d);
    console.log(`[decorations] seeded ${SEED_DECORATIONS.length} built-in entries`);
  }

  function decorationCatalogList(){
    return DB.listDecorationCatalog().map(decorationToWire);
  }

  // Клиент получает украшение вместе с /api/me и в WS hello — ему нужны
  // параметры атласа (frameW/cols/fps), чтобы отрисовать. Если выбранное
  // украшение было удалено из каталога — null, клиент отрендерит голый аватар.
  function selectedDecorationPayload(id){
    if (!id) return null;
    return decorationToWire(DB.getDecorationCatalogEntry(id));
  }

  function isKnownDecoration(id){
    return !!DB.getDecorationCatalogEntry(id);
  }

  function atlasPathUnder(id, ext){
    // id уже прошёл DECO_ID_RE, ext — строго "png" | "webp", traversal невозможен.
    if (ext !== "png" && ext !== "webp") return null;
    const full = path.join(DECORATIONS_DIR, id, `atlas.${ext}`);
    if (!full.startsWith(DECORATIONS_DIR + path.sep)) return null;
    return full;
  }

  /* ---- Client routes ---- */

  app.get("/api/decorations", noStore, (req, res) => {
    const u = getSession(req);
    if (!u) return res.status(401).json({ error: "unauthorized" });
    const s = DB.getDecorations(u.id);
    res.json({
      catalog:  decorationCatalogList(),
      owned:    s.owned,
      selected: s.selected,
      coins:    s.coins
    });
  });

  // Покупка — query-параметр, чтобы не тащить body-parser ради одной ручки.
  // Атомарный UPDATE в БД гарантирует, что даже при параллельных запросах
  // монеты снимутся ровно один раз; повторный POST с тем же id вернёт
  // already_owned (changes = 0 при instr-матче).
  app.post("/api/decorations/buy", noStore, (req, res) => {
    const u = getSession(req);
    if (!u) return res.status(401).json({ error: "unauthorized" });
    const id = String(req.query.id || "");
    const entry = DB.getDecorationCatalogEntry(id);
    if (!entry) return res.status(400).json({ error: "unknown_decoration" });
    const cur = DB.getDecorations(u.id);
    if (cur.owned.includes(id)) return res.json({ ok: true, already_owned: true, ...cur });
    const price = entry.price | 0;
    if ((cur.coins | 0) < price) return res.status(402).json({ error: "insufficient_coins", coins: cur.coins });
    const r = DB.buyDecoration(u, id, price);
    if (!r.ok) return res.status(409).json({ error: "buy_failed", coins: r.coins });
    // Пушим обновлённый баланс через живой WS-коннект, если он есть.
    pushCoinsToUser(u.id, r.coins);
    res.json({ ok: true, coins: r.coins, owned: r.owned, selected: r.selected });
  });

  app.post("/api/decorations/select", noStore, (req, res) => {
    const u = getSession(req);
    if (!u) return res.status(401).json({ error: "unauthorized" });
    const raw = req.query.id;
    const id = (raw === "" || raw == null || raw === "null") ? null : String(raw);
    if (id && !isKnownDecoration(id)) return res.status(400).json({ error: "unknown_decoration" });
    const r = DB.setSelectedDecoration(u, id);
    if (!r.ok) return res.status(403).json({ error: "not_owned" });
    res.json({
      ok: true,
      selected: r.selected,
      decoration: selectedDecorationPayload(r.selected),
      owned: r.owned,
      coins: r.coins
    });
  });

  /* ---- Admin CRUD ----
     ID sanitized под [a-z0-9_-]{2,32} (path traversal невозможен), атлас
     валидируется по PNG/WebP-сигнатуре и лимиту размера. */

  app.get("/api/admin/decorations", noStore, requireAdmin, (req, res) => {
    res.json({ catalog: DB.listDecorationCatalog().map(adminDecoToWire) });
  });

  // Статик-роут для загруженных атласов. fallthrough:false, чтобы 404 на
  // отсутствующий файл не улетел в SPA-fallback. immutable допустим: клиент
  // добавляет ?v=<updatedAt>, после upsert'а браузер перезапрашивает.
  app.use("/cdn/decorations", express.static(DECORATIONS_DIR, {
    fallthrough: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }));

  app.post("/api/admin/decorations", noStore, requireAdmin, async (req, res) => {
    const me = req._admin;
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("multipart/form-data")){
      return res.status(415).json({ error: "multipart_required" });
    }

    let parsed;
    try { parsed = await parseMultipartUpload(req); }
    catch (e) {
      console.error("[admin] upload parse error:", e);
      return res.status(400).json({ error: "bad_multipart" });
    }
    const { fields, file } = parsed;

    const id = sanitizeDecoId(fields.id);
    if (!id) return res.status(400).json({ error: "bad_id" });

    const existing = DB.getDecorationCatalogEntry(id);
    const isBuiltin = existing && typeof existing.atlas === "string" && existing.atlas.startsWith("/assets/");

    // Числовые поля: если есть в payload — валидируем, иначе (только при update)
    // оставляем текущее значение. При create — все обязательны.
    const pickInt = (key, min, max) => {
      if (fields[key] == null || fields[key] === ""){
        if (existing) return existing[key] | 0;
        return null;
      }
      const n = parseInt(fields[key], 10);
      if (!Number.isFinite(n) || n < min || n > max) return NaN;
      return n;
    };
    const price  = pickInt("price",  0,       10_000_000);
    const frames = pickInt("frames", 1,       512);
    const fps    = pickInt("fps",    1,       60);
    const frameW = pickInt("frameW", 1,       2048);
    const frameH = pickInt("frameH", 1,       2048);
    const cols   = pickInt("cols",   1,       64);
    const rows   = pickInt("rows",   1,       64);
    const sortOrderRaw = fields.sortOrder == null || fields.sortOrder === ""
      ? (existing ? existing.sortOrder | 0 : 100)
      : parseInt(fields.sortOrder, 10);
    const sortOrder = Number.isFinite(sortOrderRaw) ? sortOrderRaw : 100;

    for (const [k, v] of Object.entries({ price, frames, fps, frameW, frameH, cols, rows })){
      if (v == null)       return res.status(400).json({ error: "missing_field", field: k });
      if (Number.isNaN(v)) return res.status(400).json({ error: "bad_field",     field: k });
    }
    if (frames > cols * rows){
      return res.status(400).json({ error: "frames_exceed_grid" });
    }

    const title = String(fields.title || "").slice(0, 80);

    // Атлас: обязателен при создании и при upsert встроенного (иначе встроенные
    // нельзя «переопределить» локальным файлом).
    let atlasPath = existing && !isBuiltin ? existing.atlas : null;
    if (file){
      if (file.truncated) return res.status(413).json({ error: "atlas_too_large" });
      if (file.size < 16) return res.status(400).json({ error: "atlas_empty" });
      const ext = detectAtlasFormat(file.buffer);
      if (!ext){
        return res.status(400).json({ error: "atlas_bad_format" });
      }
      const dest = atlasPathUnder(id, ext);
      if (!dest) return res.status(400).json({ error: "bad_id" });
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.buffer);
        // Сменили формат (png→webp или наоборот) — подчищаем старый файл.
        const otherExt = ext === "png" ? "webp" : "png";
        const otherDest = atlasPathUnder(id, otherExt);
        if (otherDest && fs.existsSync(otherDest)){
          try { fs.unlinkSync(otherDest); } catch(_){}
        }
      } catch (e) {
        console.error("[admin] atlas write failed:", e);
        return res.status(500).json({ error: "atlas_write_failed" });
      }
      atlasPath = `/cdn/decorations/${id}/atlas.${ext}`;
    } else if (!atlasPath){
      return res.status(400).json({ error: "atlas_required" });
    }

    const entry = DB.upsertDecoration({
      id, title, price,
      atlas: atlasPath,
      frames, fps, frameW, frameH, cols, rows,
      sortOrder
    });
    console.log(`[admin] ${me.id} ${existing ? "updated" : "created"} decoration ${id}`);
    res.json({ ok: true, decoration: adminDecoToWire(entry) });
  });

  app.delete("/api/admin/decorations/:id", noStore, requireAdmin, (req, res) => {
    const me = req._admin;
    const id = sanitizeDecoId(req.params.id);
    if (!id) return res.status(400).json({ error: "bad_id" });
    const existed = DB.deleteDecoration(id);
    if (!existed) return res.status(404).json({ error: "not_found" });
    // Удаляем файл только для загруженных — встроенные под /assets/ трогать
    // не нужно (их вообще нет в DECORATIONS_DIR).
    try {
      const dir = path.join(DECORATIONS_DIR, id);
      if (dir.startsWith(DECORATIONS_DIR + path.sep)){
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch(e) {
      console.error("[admin] atlas cleanup failed for", id, ":", e);
    }
    console.log(`[admin] ${me.id} deleted decoration ${id}`);
    res.json({ ok: true, id });
  });

  return {
    decorationToWire,
    selectedDecorationPayload,
    isKnownDecoration,
    decorationCatalogList,
  };
};
