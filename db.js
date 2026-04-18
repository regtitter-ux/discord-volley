"use strict";

/* Persistence layer on top of node:sqlite (стабильно с Node 22.5+,
   встроено в рантайм — без нативной компиляции). Схема минимальная:
   одна таблица users с полями лидерборда/кошелька.

   WAL-режим: читатели не блокируют писателей и наоборот — в нашем
   профиле (много SELECT'ов лидерборда + короткие UPDATE'ы) это
   многократно дешевле, чем rollback-journal по умолчанию.

   Миграция: если таблица пустая И существует старый leaderboard.json —
   заливаем его одной транзакцией и переименовываем файл в .migrated,
   чтобы не импортировать повторно.
*/

const path = require("path");
const fs   = require("fs");
const { DatabaseSync } = require("node:sqlite");

function openDb(dataDir){
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch(_) {}
  const dbPath = path.join(dataDir, "volley.sqlite");
  const db = new DatabaseSync(dbPath);

  // PRAGMA: WAL + NORMAL sync — прод-дефолт для серверных нагрузок, где
  // fsync на каждый commit слишком дорог. Потеря питания может стоить
  // последних транзакций, но не повредит базу.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL DEFAULT '',
      global_name TEXT NOT NULL DEFAULT '',
      avatar_url  TEXT,
      coins       INTEGER NOT NULL DEFAULT 0,
      trophies    INTEGER NOT NULL DEFAULT 0,
      wins        INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_trophies ON users(trophies DESC, updated_at ASC);
  `);

  // Миграция на лету: добавляем колонки под систему украшений на уже
  // существующей базе. owned_decorations — csv из id'шек купленных украшений
  // (id без запятых — ограничиваем серверным regex), selected_decoration —
  // текущее выбранное либо NULL. SQLite ADD COLUMN безопасен и идемпотентен
  // через проверку PRAGMA table_info.
  {
    const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
    if (!cols.includes("owned_decorations"))
      db.exec("ALTER TABLE users ADD COLUMN owned_decorations TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("selected_decoration"))
      db.exec("ALTER TABLE users ADD COLUMN selected_decoration TEXT");
  }

  // Ленивая миграция с JSON. Запускаем только если таблица пуста — так
  // передеплои на уже мигрированной базе ничего не перезапишут.
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    if ((row.n | 0) === 0){
      const jsonPath = path.join(dataDir, "leaderboard.json");
      if (fs.existsSync(jsonPath)){
        const raw = fs.readFileSync(jsonPath, "utf8");
        const j = JSON.parse(raw);
        if (j && j.users && typeof j.users === "object"){
          const upsert = db.prepare(`
            INSERT INTO users (id, username, global_name, avatar_url, coins, trophies, wins, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const tx = db.prepare("BEGIN"); tx.run();
          try {
            for (const u of Object.values(j.users)){
              if (!u || !u.id) continue;
              upsert.run(
                u.id,
                u.username || "",
                u.global_name || u.username || "",
                u.avatar_url || null,
                (u.coins | 0),
                (u.trophies | 0),
                (u.wins | 0),
                (u.updatedAt | 0) || Date.now()
              );
            }
            db.prepare("COMMIT").run();
          } catch(e) {
            db.prepare("ROLLBACK").run();
            throw e;
          }
          try { fs.renameSync(jsonPath, jsonPath + ".migrated"); } catch(_) {}
          console.log(`[db] migrated ${Object.keys(j.users).length} users from leaderboard.json`);
        }
      }
    }
  } catch(e){
    console.error("[db] migration failed:", e);
  }

  const stmts = {
    getById: db.prepare("SELECT id, username, global_name, avatar_url, coins, trophies, wins, updated_at FROM users WHERE id = ?"),
    insertUser: db.prepare(`
      INSERT OR IGNORE INTO users (id, username, global_name, avatar_url, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    // COALESCE: не затираем сохранённое значение, если пришёл пустой профиль
    // (например, Discord по какой-то причине не прислал global_name).
    updateProfile: db.prepare(`
      UPDATE users
      SET username    = CASE WHEN ?2 != '' THEN ?2 ELSE username END,
          global_name = CASE WHEN ?3 != '' THEN ?3 ELSE global_name END,
          avatar_url  = COALESCE(?4, avatar_url)
      WHERE id = ?1
    `),
    addCoins: db.prepare(`
      UPDATE users
      SET coins = MAX(0, coins + ?2),
          updated_at = ?3
      WHERE id = ?1
    `),
    addTrophies: db.prepare(`
      UPDATE users
      SET trophies = MAX(0, trophies + ?2),
          updated_at = ?3
      WHERE id = ?1
    `),
    getCoins: db.prepare("SELECT coins FROM users WHERE id = ?"),
    getTrophies: db.prepare("SELECT trophies FROM users WHERE id = ?"),
    topPage: db.prepare(`
      SELECT id, global_name, username, avatar_url, trophies
      FROM users
      WHERE trophies > 0
      ORDER BY trophies DESC, updated_at ASC
      LIMIT ? OFFSET ?
    `),
    totalRanked: db.prepare("SELECT COUNT(*) AS n FROM users WHERE trophies > 0"),
    myRank: db.prepare(`
      SELECT 1 + (
        SELECT COUNT(*) FROM users u2
        WHERE u2.trophies > u1.trophies
           OR (u2.trophies = u1.trophies AND u2.updated_at < u1.updated_at)
      ) AS rank
      FROM users u1 WHERE u1.id = ?
    `),
    getDecorations: db.prepare("SELECT owned_decorations, selected_decoration, coins FROM users WHERE id = ?"),
    // Атомарная покупка: в одном UPDATE проверяем баланс и отсутствие
    // дубликата в owned_decorations. Если changes = 0 — либо не хватило
    // монет, либо уже куплено; вызывающий код интерпретирует оба случая
    // по текущему состоянию. instr(',' || csv || ',', ',id,') = 0 —
    // точное совпадение id без подстрок (поэтому в csv всегда обёрнуто
    // в запятые на обоих концах).
    buyDecoration: db.prepare(`
      UPDATE users
      SET coins = coins - ?2,
          owned_decorations = CASE
            WHEN owned_decorations = '' THEN ?3
            ELSE owned_decorations || ',' || ?3
          END,
          updated_at = ?4
      WHERE id = ?1
        AND coins >= ?2
        AND instr(',' || owned_decorations || ',', ',' || ?3 || ',') = 0
    `),
    setSelectedDecoration: db.prepare(`
      UPDATE users
      SET selected_decoration = ?2,
          updated_at = ?3
      WHERE id = ?1
    `)
  };

  function ensureUser(user){
    if (!user || !user.id) return null;
    const now = Date.now();
    stmts.insertUser.run(
      user.id,
      user.username || "",
      user.global_name || user.username || "",
      user.avatar_url || null,
      now
    );
    stmts.updateProfile.run(
      user.id,
      user.username || "",
      user.global_name || user.username || "",
      user.avatar_url || null
    );
    return stmts.getById.get(user.id) || null;
  }

  function getCoins(id){
    const r = stmts.getCoins.get(id);
    return r ? (r.coins | 0) : 0;
  }
  function getTrophies(id){
    const r = stmts.getTrophies.get(id);
    return r ? (r.trophies | 0) : 0;
  }

  function addCoins(user, delta){
    ensureUser(user);
    stmts.addCoins.run(user.id, delta | 0, Date.now());
    return getCoins(user.id);
  }

  function addTrophies(user, delta){
    ensureUser(user);
    stmts.addTrophies.run(user.id, delta | 0, Date.now());
    return getTrophies(user.id);
  }

  function getDecorations(id){
    const r = stmts.getDecorations.get(id);
    if (!r) return { owned: [], selected: null, coins: 0 };
    const csv = (r.owned_decorations || "").trim();
    const owned = csv ? csv.split(",").filter(Boolean) : [];
    return { owned, selected: r.selected_decoration || null, coins: r.coins | 0 };
  }

  function buyDecoration(user, decoId, price){
    ensureUser(user);
    const info = stmts.buyDecoration.run(user.id, price | 0, String(decoId), Date.now());
    if (!info || !info.changes){
      return { ok: false, ...getDecorations(user.id) };
    }
    return { ok: true, ...getDecorations(user.id) };
  }

  function setSelectedDecoration(user, decoId){
    ensureUser(user);
    const val = decoId == null ? null : String(decoId);
    const state = getDecorations(user.id);
    // Нельзя выбрать не купленное — серверный guard, клиенту верить нельзя.
    if (val && !state.owned.includes(val)) return { ok: false, ...state };
    stmts.setSelectedDecoration.run(user.id, val, Date.now());
    return { ok: true, ...getDecorations(user.id) };
  }

  function leaderboardPage(page, pageSize){
    const total = stmts.totalRanked.get().n | 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (page < 1) page = 1;
    if (page > pages) page = pages;
    const offset = (page - 1) * pageSize;
    const rows = stmts.topPage.all(pageSize, offset);
    const entries = rows.map((r, i) => ({
      id: r.id,
      global_name: r.global_name || r.username || "",
      avatar_url: r.avatar_url || null,
      trophies: r.trophies | 0,
      rank: offset + i + 1
    }));
    return { entries, total, page, pages };
  }

  function meRank(id, pageSize){
    const r = stmts.getById.get(id);
    const trophies = r ? (r.trophies | 0) : 0;
    if (trophies <= 0) return { id, trophies: 0, rank: null, page: null };
    const row = stmts.myRank.get(id);
    const rank = row ? (row.rank | 0) : null;
    const page = rank ? (Math.floor((rank - 1) / pageSize) + 1) : null;
    return { id, trophies, rank, page };
  }

  return {
    db,
    ensureUser,
    getCoins,
    getTrophies,
    addCoins,
    addTrophies,
    getDecorations,
    buyDecoration,
    setSelectedDecoration,
    leaderboardPage,
    meRank
  };
}

module.exports = { openDb };
