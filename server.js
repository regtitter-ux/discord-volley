/* Discord OAuth2 + static frontend server.
   Логика максимально простая:
     GET  /auth/discord   — редирект на Discord с state-cookie
     GET  /auth/callback  — exchange code, сохраняем подписанную session-cookie
     GET  /api/me         — возвращает профиль или 401
     POST /auth/logout    — чистит session-cookie
   Client-secret хранится только на сервере (в Railway → Variables). */

"use strict";

// Мини-.env для локалки. В проде (NODE_ENV=production на Railway) пропускаем,
// Railway инжектит переменные сам.
if (process.env.NODE_ENV !== "production") {
  try {
    const fs = require("fs");
    for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (_) { /* .env отсутствует — ок */ }
}

const express      = require("express");
const cookieParser = require("cookie-parser");
const crypto       = require("crypto");
const path         = require("path");
const fs           = require("fs");
const http         = require("http");
const net          = require("net");
const { spawn }    = require("child_process");
const { WebSocketServer } = require("ws");

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  SESSION_SECRET,
  PUBLIC_URL,
  PORT = 8080,
  NODE_ENV = "development"
} = process.env;

function must(name, val){
  if (!val) {
    console.error(`[fatal] env ${name} is required`);
    process.exit(1);
  }
  return val;
}
must("DISCORD_CLIENT_ID",     DISCORD_CLIENT_ID);
must("DISCORD_CLIENT_SECRET", DISCORD_CLIENT_SECRET);
must("SESSION_SECRET",        SESSION_SECRET);

const APP_URL      = (PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const REDIRECT_URI = `${APP_URL}/auth/callback`;
const IS_HTTPS     = APP_URL.startsWith("https://");

// Build-ID для cache-busting статики. Railway сам подставляет git SHA
// деплоя в RAILWAY_GIT_COMMIT_SHA; локально — случайный короткий хэш
// на каждый запуск (перезапустил node — новый билд, браузер подхватит).
const BUILD_ID =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_DEPLOYMENT_ID ||
  crypto.randomBytes(6).toString("hex");

// Читаем index.html один раз, проставляем ?v=<build> на локальные ассеты и
// инлайним build-id в window.__BUILD__, чтобы фронт знал «свою» версию.
const INDEX_HTML = (function(){
  let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  html = html.replace(
    /(href|src)="(styles\.css|auth\.js|game\.js|i18n\.js|physics\.js|codec\.js|admin\.js|decorations-ui\.js)"/g,
    (_m, attr, file) => `${attr}="${file}?v=${BUILD_ID}"`
  );
  const tag = `<script>window.__BUILD__=${JSON.stringify(BUILD_ID)};</script>`;
  html = html.replace("</head>", `  ${tag}\n</head>`);
  return html;
})();

const SESSION_COOKIE   = "dv_session";
const STATE_COOKIE     = "dv_state";
const SESSION_MAX_AGE  = 7 * 24 * 3600 * 1000; // 7 дней
const STATE_MAX_AGE    = 10 * 60 * 1000;       // 10 минут

const app = express();
app.disable("x-powered-by");
// Railway терминирует TLS перед нами; без trust proxy secure-cookie не ставится.
app.set("trust proxy", 1);
app.use(cookieParser(SESSION_SECRET));

const baseCookieOpts = {
  signed:   true,
  httpOnly: true,
  secure:   IS_HTTPS,     // на localhost secure=false, иначе браузер не сохранит
  sameSite: "lax",        // OAuth-редирект — GET, lax проходит
  path:     "/"
};
const sessionCookieOpts = { ...baseCookieOpts, maxAge: SESSION_MAX_AGE };
const stateCookieOpts   = { ...baseCookieOpts, maxAge: STATE_MAX_AGE };

function getSession(req){
  const v = req.signedCookies[SESSION_COOKIE];
  if (!v) return null;
  try {
    const u = JSON.parse(v);
    if (!u || !u.id) return null;
    return u;
  } catch { return null; }
}

function cdnAvatar(id, hash){
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=128`;
}

/* ---------- OAuth routes ---------- */

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, stateCookieOpts);

  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id",     DISCORD_CLIENT_ID);
  u.searchParams.set("redirect_uri",  REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope",         "identify");
  u.searchParams.set("state",         state);
  res.redirect(u.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const saved = req.signedCookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/" });

  if (error) {
    return res.redirect("/?auth_error=" + encodeURIComponent(String(error)));
  }
  if (!code || !state || !saved || state !== saved) {
    return res.redirect("/?auth_error=state_mismatch");
  }

  try {
    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code:          String(code),
        redirect_uri:  REDIRECT_URI
      })
    });
    if (!tokenResp.ok) {
      throw new Error("token exchange failed: " + tokenResp.status);
    }
    const tok = await tokenResp.json();

    const meResp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    if (!meResp.ok) throw new Error("users/@me failed: " + meResp.status);
    const me = await meResp.json();

    const user = {
      id:          me.id,
      username:    me.username,
      global_name: me.global_name || me.username,
      avatar_url:  cdnAvatar(me.id, me.avatar),
      iat:         Date.now()
    };
    res.cookie(SESSION_COOKIE, JSON.stringify(user), sessionCookieOpts);
    res.redirect("/");
  } catch (e) {
    console.error("[auth] callback error:", e);
    res.redirect("/?auth_error=exchange_failed");
  }
});

app.get("/api/me", noStore, (req, res) => {
  const u = getSession(req);
  if (!u) return res.status(401).json(null);
  const deco = DB.getDecorations(u.id);
  res.json({
    id:          u.id,
    username:    u.username,
    global_name: u.global_name,
    avatar_url:  u.avatar_url,
    coins:       userCoins(u.id),
    trophies:    userTrophies(u.id),
    decoration:  selectedDecorationPayload(deco.selected),
    is_admin:    isAdmin(u)
  });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Dev-only login shortcut для E2E-тестов. Подписывает поддельную session-
// куку без Discord OAuth. Никогда не активен в проде: отключён, если
// NODE_ENV==="production" ИЛИ если не выставлен DV_DEV_LOGIN=1, так что
// даже случайный запуск с NODE_ENV!=production на публичном узле без явной
// опт-ин переменной его не откроет.
if (NODE_ENV !== "production" && process.env.DV_DEV_LOGIN === "1"){
  app.get("/dev/login", (req, res) => {
    const id   = String(req.query.id || "").slice(0, 32) || ("t-" + crypto.randomBytes(4).toString("hex"));
    const name = String(req.query.name || "").slice(0, 32) || id;
    const user = {
      id, username: name, global_name: name, avatar_url: null, iat: Date.now()
    };
    res.cookie(SESSION_COOKIE, JSON.stringify(user), sessionCookieOpts);
    res.json({ ok: true, user });
  });
  console.log("[dev] /dev/login enabled (DV_DEV_LOGIN=1)");
}

/* ---------- Build version (cache-busting / auto-reload) ---------- */

app.get("/api/version", noStore, (req, res) => {
  res.json({ build: BUILD_ID });
});

/* ---------- Leaderboard (trophies) + wallet (coins) ----------
   Хранение — SQLite (data/volley.sqlite). Одна таблица users со всеми
   полями лидерборда/кошелька. Писатели — applyMatchOutcome (+трофеи/-трофеи)
   и awardCoins (+монеты); читатель /api/leaderboard идёт через индекс по
   trophies DESC и работает за O(log n + pageSize). При росте таблицы
   in-memory LB.users + sort() в каждом ответе стал бы узким местом. */

// Путь к каталогу персистентных данных. На локалке — ./data (под .gitignore).
// В проде на Railway FS эфемерна между деплоями — нужно смонтировать Volume
// (например, в /data) и задать DATA_DIR=/data в Variables. Иначе топ и
// балансы кошелька сбросятся на каждом редеплое.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// SQLite (node:sqlite, WAL-mode). Заменил JSON-файл, который блокировал
// event loop на каждый flush и требовал сериализации всей таблицы при
// любом изменении. Теперь update — это одна транзакция в пару мс без
// участия event loop'а в I/O. Миграция leaderboard.json → users делается
// внутри openDb() лениво, при первом старте на чистой базе.
const { openDb } = require("./db");
const DB = openDb(DATA_DIR);

function ensureUser(user){ return DB.ensureUser(user); }

/* ---------- Wallet (монеты) + Trophies/stakes ----------
   Server-authoritative. Рейт-лимиты, размеры наград, match stakes TTL,
   global cooldowns — всё живёт в ./wallet.js. Тут только импорт и
   ленивая ссылка на broker (он создаётся ниже). */
const Wallet = require("./wallet")({ DB, getBroker: () => broker });
const {
  AWARDS,
  MATCH_STAKES_TTL_MS,
  rollStakes,
  applyMatchOutcome,
  awardCoins,
  userCoins,
  userTrophies,
} = Wallet;

const LB_PAGE_SIZE = 10;

app.get("/api/leaderboard", noStore, (req, res) => {
  const me = getSession(req);
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  // Индексированный SELECT ORDER BY trophies DESC LIMIT/OFFSET — при росте
  // таблицы до десятков тысяч пользователей остаётся O(log n + pageSize),
  // а не O(n log n) как было при сортировке in-memory массива.
  const pg = DB.leaderboardPage(page, LB_PAGE_SIZE);
  const mine = me ? DB.meRank(me.id, LB_PAGE_SIZE) : null;
  // Раскрываем decoration_id → payload из каталога. decoration_id из БД
  // может указывать на украшение, удалённое из каталога — тогда null.
  const top = pg.entries.map(e => ({
    id:          e.id,
    global_name: e.global_name,
    avatar_url:  e.avatar_url,
    trophies:    e.trophies,
    rank:        e.rank,
    decoration:  selectedDecorationPayload(e.decoration_id)
  }));
  res.json({
    top,
    me: mine,
    total: pg.total,
    page: pg.page,
    pages: pg.pages,
    pageSize: LB_PAGE_SIZE
  });
});

app.get("/api/stats", noStore, async (req, res) => {
  const online = broker ? await broker.getOnline() : 0;
  res.json({ online });
});

/* ---------- Admin ----------
   Белый список ID с админ-правами. Хардкод на сервере — клиенту верить
   нельзя: is_admin во флаге /api/me нужен только для UI (показать кнопку
   «+»), реальная проверка прав стоит на каждой admin-ручке. */
// Основной админ — хардкод (Discord-snowflake владельца). DV_ADMIN_IDS
// (csv) — дополнительные id без редеплоя (прод-фоллбек + тестовые прогоны).
const ADMIN_IDS = (function(){
  const set = new Set(["743913502997086219"]);
  const extra = String(process.env.DV_ADMIN_IDS || "").split(",");
  for (const raw of extra){
    const s = raw.trim();
    if (s) set.add(s);
  }
  return set;
})();
function isAdmin(u){ return !!(u && ADMIN_IDS.has(String(u.id))); }

function noStore(_req, res, next){ res.setHeader("Cache-Control", "no-store"); next(); }

function requireAdmin(req, res, next){
  const me = getSession(req);
  if (!isAdmin(me)) return res.status(403).json({ error: "forbidden" });
  req._admin = me;
  next();
}

// Поиск пользователя по произвольному хендлу: сперва пробуем как точный ID
// (у Discord это числовой snowflake, у dev-login — любой TEXT), потом
// fallback — username / global_name без учёта регистра. Возвращаем только
// id — больше серверу ничего не нужно для addCoins.
app.get("/api/admin/lookup", noStore, requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "empty_query" });
  const byId = DB.db.prepare("SELECT id, global_name, username, coins FROM users WHERE id = ?").get(q);
  const row = byId || DB.db.prepare(
    "SELECT id, global_name, username, coins FROM users WHERE username = ? COLLATE NOCASE OR global_name = ? COLLATE NOCASE LIMIT 1"
  ).get(q, q);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ id: row.id, global_name: row.global_name || row.username || "", coins: row.coins | 0 });
});

// Изменение баланса: delta — signed integer. Серверная правка идёт через
// DB.addCoins (MAX(0,...) не уходит в минус), так что «−5000» у юзера с
// балансом 100 обнулит его, а не улетит в отрицательное.
app.post("/api/admin/coins", noStore, requireAdmin, (req, res) => {
  const me = req._admin;
  const id = String(req.query.id || "").trim();
  const delta = parseInt(req.query.delta, 10);
  if (!id) return res.status(400).json({ error: "empty_id" });
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: "bad_delta" });
  // DB.addCoins сам вызовет ensureUser — если записи нет, создастся с пустым
  // username (он проставится при следующем логине юзера через ensureUser).
  // Это нужно, чтобы админ мог начислить монеты игроку, который ещё ни разу
  // не сыграл матч (до этого момента у него может не быть строки в users).
  const coins = DB.addCoins({ id }, delta);
  pushCoinsToUser(id, coins);
  console.log(`[admin] ${me.id} adjusted ${id} coins by ${delta} → ${coins}`);
  res.json({ ok: true, id, coins });
});

/* ---------- Decorations (каталог + admin CRUD + client /api) ----------
   Модуль регистрирует /api/decorations, /api/decorations/buy/select,
   /api/admin/decorations, /cdn/decorations/*. Возвращает хелперы
   selectedDecorationPayload / isKnownDecoration для использования в
   hello/me/leaderboard. */
const {
  selectedDecorationPayload,
  isKnownDecoration,
} = require("./decorations")({
  app, DB, DATA_DIR, noStore, requireAdmin, getSession,
  pushCoinsToUser: (id, coins) => pushCoinsToUser(id, coins),
});

/* ---------- Stage 7.5: match-result webhook от room-server ---------- */
// Room-server (Hathora) по окончании матча шлёт POST с HMAC. Railway
// применяет match.win/loss через те же applyMatchOutcome (broker.claimOutcome
// идемпотентный, так что повторный webhook или гонка с клиентским match_win
// безопасны) и пушит trophies-фрейм в menu-WS обоим.
//
// Body — raw Buffer (express.raw), HMAC считается по байт-в-байт строке.
// Отдельный parser: глобального express.json нет, да и нельзя, т.к. он
// съел бы raw body до проверки подписи.
const WEBHOOK_TS_WINDOW_MS = Number(process.env.ROOM_WEBHOOK_TS_WINDOW_MS) || 5 * 60 * 1000;
app.post("/internal/match-result",
  express.raw({ type: "*/*", limit: "4kb" }),
  async (req, res) => {
    if (!ROOM_SECRET) return res.status(503).json({ ok: false, error: "room-secret-unset" });
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return res.status(400).json({ ok: false, error: "no-body" });
    const sig = req.headers["x-dv-room-signature"];
    if (!verifyWebhook(ROOM_SECRET, raw.toString("utf8"), sig)){
      return res.status(401).json({ ok: false, error: "bad-signature" });
    }
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); }
    catch { return res.status(400).json({ ok: false, error: "bad-json" }); }
    if (!msg || typeof msg !== "object") return res.status(400).json({ ok: false, error: "bad-json" });
    const { matchId, roomId, winnerRole, scoreHost, scoreGuest, ts } = msg;
    if (typeof matchId !== "string" || !matchId)    return res.status(400).json({ ok: false, error: "bad-matchId" });
    if (winnerRole !== "host" && winnerRole !== "guest"){
      return res.status(400).json({ ok: false, error: "bad-winner" });
    }
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_TS_WINDOW_MS){
      return res.status(401).json({ ok: false, error: "ts-out-of-window" });
    }
    const users = hathoraMatchUsers.get(matchId);
    if (!users) return res.status(404).json({ ok: false, error: "unknown-match" });
    const winnerUser = winnerRole === "host" ? users.host : users.guest;
    const loserUser  = winnerRole === "host" ? users.guest : users.host;
    const rw = await applyMatchOutcome(winnerUser, matchId, "win");
    const rl = await applyMatchOutcome(loserUser,  matchId, "loss");
    // Trophies-фрейм через menu-WS — находим оба WS по activeMatchId. Если
    // клиент уже ушёл (disconnect), его WS не найдётся — это ок, трофеи всё
    // равно записаны в БД через applyMatchOutcome.
    for (const client of wss.clients){
      if (!client || client.readyState !== 1) continue;
      if (!client.user || client.activeMatchId !== matchId) continue;
      const r = client.user.id === winnerUser.id ? rw : rl;
      if (r) send(client, { type: "trophies", total: r.total, delta: r.delta });
    }
    console.log(`[ws] match-result webhook ok match=${matchId} winner=${winnerRole} scores=${scoreHost}:${scoreGuest}`);
    res.json({ ok: true, applied: { win: !!rw, loss: !!rl } });
  }
);

/* ---------- Static frontend ---------- */

function sendIndex(res){
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(INDEX_HTML);
}

app.get(["/", "/index.html"], (req, res) => sendIndex(res));

app.use(express.static(path.join(__dirname), {
  index: false,  // index.html отдаём сами — с проставленным build-id
  setHeaders: (res, p) => {
    if (/\.(webp|png|jpg|jpeg|svg|woff2|ico)$/i.test(p)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/\.(js|css)$/i.test(p)) {
      // У версионированных URL (?v=...) ключ кеша меняется на каждом деплое,
      // поэтому можно кешировать агрессивно. Без ?v= всё равно релоад подтянет
      // свежее за счёт INDEX_HTML, где ссылки уже со свежим build-id.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }
}));

// SPA fallback: любой неизвестный GET → index.html (для будущих клиент-роутов).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) return next();
  sendIndex(res);
});

/* ---------- WebSocket matchmaking + relay ----------
   Очень простая одноочерёдная матчмейкинг:
     • клиент коннектится на /ws, проходит auth по session-cookie
     • шлёт {type:"queue"} — если кто-то уже ждёт, матчим пару
     • иначе встаёт в слот ожидания на 3 секунды; по таймауту клиент
       сам решает пойти в игру с ботом ({type:"timeout"} → dequeue)
     • после матча оба получают {type:"matched", role, opponent};
       host = первый встал в очередь, guest = второй (пара хост/гость
       важна, поскольку физика автортитарна на хосте)
     • внутриигровые сообщения ретранслируются через {type:"relay", payload}
       → пир получает {type:"peer", payload} */

const httpServer = http.createServer(app);
// perMessageDeflate: false — на hot-path 30 Гц бинарных снапшотов (~61 байт)
// zlib-сжатие даёт отрицательный выигрыш по размеру и буферизует мелкие
// фреймы, добавляя джиттер. Отключаем явно, не полагаясь на клиентский offer.
const wss = new WebSocketServer({ server: httpServer, path: "/ws", perMessageDeflate: false });

// Broker — абстракция над (local | redis). Инициализируется в startup
// async IIFE ниже. Все multi-instance примитивы (очередь, relay, stakes,
// online-counter) идут через него; под капотом либо in-memory, либо Redis.
const { createBroker }    = require("./broker");
const { ShadowRegistry }  = require("./shadowsim");
const hathoraClient       = require("./hathora-client");
const { signRoomToken, verifyWebhook } = require("./room-auth");
// DV_SHADOW_PHYSICS=1 — observer (host остаётся авторитетом).
// DV_AUTH_PHYSICS=1   — сервер сам крутит физику для каждого матча и
// шлёт бинарные снапшоты обоим клиентам. Клиентский код читает
// matched.net === "auth" и в этом режиме выключает локальную физику.
const AUTH_PHYSICS = process.env.DV_AUTH_PHYSICS === "1";
// DV_ROOMS=hathora — pair создаёт room на Hathora Cloud и отдаёт клиентам
// адрес room-server'а (второй WS). Дефолт local — весь gameplay идёт через
// этот же server.js как раньше. ROOM_SECRET обязателен для hathora-пути:
// Railway подписывает, room-server верифицирует.
//
// DV_ROOMS_ROLLBACK=1 — Stage 7.6: kill-switch для экстренного отката. Если
// Hathora лёг/деплой сломался/фичу хотим раскатать обратно — ставим флаг в
// Railway dashboard, перезапускаем инстанс, матчи снова идут через pairLocal.
// Префлит-флаг важнее DV_ROOMS, т.к. Hathora-процессы могут быть недоступны
// и фолбэк внутри pairHathora добавил бы лишний latency/таймауты на каждую
// пару. Проще отсечь на корню.
const _DV_ROOMS_RAW = process.env.DV_ROOMS === "hathora" ? "hathora" : "local";
const DV_ROOMS_ROLLBACK = process.env.DV_ROOMS_ROLLBACK === "1";
const DV_ROOMS = (DV_ROOMS_ROLLBACK && _DV_ROOMS_RAW === "hathora") ? "local" : _DV_ROOMS_RAW;
if (DV_ROOMS_ROLLBACK && _DV_ROOMS_RAW === "hathora"){
  console.warn("[ws] DV_ROOMS_ROLLBACK=1 — игнорируем DV_ROOMS=hathora, едем через pairLocal");
}
// DV_LOCAL_ROOMS=1 — Stage 7.4: вместо удалённой Hathora создаём room-server.js
// как child-process на свободном порту (127.0.0.1). Для integration-тестов
// и dev-preview без Hathora account.
const DV_LOCAL_ROOMS = process.env.DV_LOCAL_ROOMS === "1";
const ROOM_SECRET = process.env.ROOM_SECRET || "";
const ROOM_TOKEN_TTL_MS = Number(process.env.ROOM_TOKEN_TTL_MS) || 60000;
const HATHORA_REGION    = process.env.HATHORA_REGION || "Frankfurt";
if (DV_ROOMS === "hathora" && !ROOM_SECRET){
  console.warn("[ws] DV_ROOMS=hathora но ROOM_SECRET пуст — pairHathora будет падать в local");
}

// roomId → child_process. Стартуется в spawnLocalRoomServer при
// DV_LOCAL_ROOMS=1, убивается при leaveRoom (оба пира ушли → закрытие
// комнаты) и на server.js shutdown. idle-timeout 5мин в room-server'е —
// независимая страховка от повисших процессов.
const localRoomChildren = new Map();

// Stage 7.5: matchId → { host: user, guest: user, roomId }. Заполняется
// в pairHathora, используется в POST /internal/match-result для маппинга
// winnerRole → userId. Чистим в leaveRoom после broker.closeRoom.
const hathoraMatchUsers = new Map();

// Наш base URL для webhook'ов room-server → Railway. В проде это
// PUBLIC_URL (Railway), в интеграционных тестах — http://127.0.0.1:<PORT>.
// Если DV_LOCAL_ROOMS=1, child'у нужен реальный callback-адрес — иначе
// webhook уйдёт в никуда и трофеи не начислятся.
const RAILWAY_SELF_URL = process.env.RAILWAY_SELF_URL || process.env.PUBLIC_URL || "";

async function _getFreePort(){
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnLocalRoomServer({ roomId, matchId }){
  const port = await _getFreePort();
  const args = [
    path.join(__dirname, "room-server.js"),
    "--port",   String(port),
    "--secret", ROOM_SECRET
  ];
  if (matchId) args.push("--match-id", matchId);
  if (RAILWAY_SELF_URL) args.push("--railway-url", RAILWAY_SELF_URL);
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: {
      ...process.env,
      ROOM_SECRET,
      ROOM_MATCH_ID: matchId || ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const tag = `[room:${port}]`;
  const logs = [];
  const passthrough = (stream) => (buf) => {
    const s = String(buf);
    logs.push(s);
    for (const line of s.split(/\r?\n/)){
      if (line) stream.write(`${tag} ${line}\n`);
    }
  };
  child.stdout.on("data", passthrough(process.stdout));
  child.stderr.on("data", passthrough(process.stderr));
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(
      new Error(`room-server not ready in 10s. logs:\n${logs.join("")}`)
    ), 10000);
    const onData = (buf) => {
      if (/ready on :/.test(String(buf))){
        clearTimeout(to);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", code => {
      clearTimeout(to);
      reject(new Error(`room-server exited early code=${code}. logs:\n${logs.join("")}`));
    });
  });
  localRoomChildren.set(roomId, child);
  child.once("exit", () => {
    if (localRoomChildren.get(roomId) === child) localRoomChildren.delete(roomId);
  });
  return { host: "127.0.0.1", port, roomId: `local-${matchId || roomId}` };
}

function killLocalRoomChild(roomId){
  const child = localRoomChildren.get(roomId);
  if (!child) return;
  localRoomChildren.delete(roomId);
  try { child.kill(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
}

process.on("exit", () => {
  for (const child of localRoomChildren.values()){
    try { child.kill(); } catch {}
  }
});
const shadow = new ShadowRegistry({
  shadow: process.env.DV_SHADOW_PHYSICS === "1",
  auth:   AUTH_PHYSICS
});
shadow.start();
let broker = null;
let INSTANCE_ID = crypto.randomBytes(6).toString("hex");

// Разбор cookie + проверка HMAC-подписи тем же секретом, что и Express.
const cookieLib       = require("cookie");
const cookieSignature = require("cookie-signature");
function authUserFromCookie(req){
  const header = req.headers.cookie || "";
  const parsed = cookieLib.parse(header);
  const signed = parsed[SESSION_COOKIE];
  if (!signed) return null;
  const body = signed.startsWith("s:") ? signed.slice(2) : signed;
  const raw = cookieSignature.unsign(body, SESSION_SECRET);
  if (raw === false) return null;
  try {
    const u = JSON.parse(raw);
    if (!u || !u.id) return null;
    return u;
  } catch { return null; }
}

// Таймаут ожидания пары в очереди. В проде 30с, но тесты переопределяют
// через env QUEUE_TIMEOUT_MS, чтобы проверять regression-сценарии за <1с.
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 30000;

// stats broadcast — throttle 1 раз в 2с, leading-edge + trailing tail.
// Под Redis-брокером счётчик онлайна общий; пульс публикуется каждым
// инстансом в дружественный dv:stats канал, и каждый локально фанаутит
// в свои wss.clients. В local-режиме работает идентично.
const STATS_INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS) || 2000;
let _statsTimer   = null;
let _statsPending = false;
let _lastStatsTotal = 0;
function _doBroadcastStats(){
  const msg = JSON.stringify({ type: "stats", online: _lastStatsTotal });
  wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(msg); } catch {} } });
}

// Индекс userId → Set<ws> для точечных пушей. wss.clients.forEach в hot
// admin/deco path при 10k коннектов блокирует event loop на каждой покупке;
// Map даёт O(k) по числу живых сессий конкретного юзера (обычно 1-2).
const wssByUserId = new Map();
function _indexWsUser(ws){
  if (!ws || !ws.user || !ws.user.id) return;
  let set = wssByUserId.get(ws.user.id);
  if (!set){ set = new Set(); wssByUserId.set(ws.user.id, set); }
  set.add(ws);
}
function _unindexWsUser(ws){
  if (!ws || !ws.user || !ws.user.id) return;
  const set = wssByUserId.get(ws.user.id);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) wssByUserId.delete(ws.user.id);
}

// Точечный пуш нового баланса монет всем живым WS-сессиям этого юзера на
// текущем инстансе. Используется после HTTP-покупки украшения, чтобы
// открытое меню в другой вкладке не показывало устаревший баланс до
// следующего award'а.
function pushCoinsToUser(userId, coins){
  const set = wssByUserId.get(userId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify({ type: "wallet", coins: coins | 0, delta: 0, kind: "deco.buy" });
  for (const ws of set){
    if (ws.readyState !== 1) continue;
    try { ws.send(msg); } catch {}
  }
}
function scheduleStatsBroadcast(){
  if (_statsTimer){ _statsPending = true; return; }
  _doBroadcastStats();
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    if (_statsPending){ _statsPending = false; scheduleStatsBroadcast(); }
  }, STATS_INTERVAL_MS);
}

// Раз в 5с выкидываем клиентов с зависшим буфером отправки: если мы успели
// запушить >2МБ в сокет, значит клиент либо мёртв, либо не успевает читать —
// держать память процесса ради него опасно при 10k коннектов.
const WS_STUCK_BYTES = 2 * 1024 * 1024;
setInterval(() => {
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.bufferedAmount > WS_STUCK_BYTES){
      try { c.terminate(); } catch {}
    }
  });
}, 5000).unref();

// WS heartbeat ping/pong. Без него мёртвые сокеты (уснувший Wi-Fi, сбой NAT)
// обнаруживались только по накоплению bufferedAmount > 2MB (sweep выше),
// т.е. когда в буфер уже успели загрузиться сотни снапшотов → лишнее
// давление на память и GC живых матчей. Теперь раз в HEARTBEAT_MS шлём
// ping: если клиент не ответил pong'ом до следующего тика — terminate.
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS) || 20000;
setInterval(() => {
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (c._alive === false){
      try { c.terminate(); } catch {}
      return;
    }
    c._alive = false;
    try { c.ping(); } catch {}
  });
}, WS_HEARTBEAT_MS).unref();

// Token bucket на входящие сообщения — 120 msg/s с бёрстом 60. Защищает
// relay и switch от флуда одним клиентом. Сверх бюджета — тихо дропаем
// (ответ об ошибке сам по себе стоил бы ресурсов).
const MSG_RATE_PER_SEC = 120;
const MSG_BURST        = 60;
function takeToken(ws){
  const now = Date.now();
  const dt  = (now - ws._tokensT) / 1000;
  ws._tokensT = now;
  ws._tokens  = Math.min(MSG_BURST, (ws._tokens || 0) + dt * MSG_RATE_PER_SEC);
  if (ws._tokens < 1) return false;
  ws._tokens--;
  return true;
}

function safeUser(u){
  if (!u) return null;
  // Один SELECT вместо двух (trophies + decorations раньше были раздельные).
  const info = DB.getSafeInfo(u.id);
  return {
    id:          u.id,
    username:    u.username,
    global_name: u.global_name || u.username,
    avatar_url:  u.avatar_url || null,
    trophies:    info.trophies,
    decoration:  selectedDecorationPayload(info.selected)
  };
}

const WS_BACKPRESSURE_DROP = 1 * 1024 * 1024;
function send(ws, obj){
  if (!ws || ws.readyState !== 1) return;
  // Не забиваем сокет, если клиент уже отстаёт: дальнейший push только
  // раздувает буфер процесса. terminate отдан фоновому sweep'у.
  if (ws.bufferedAmount > WS_BACKPRESSURE_DROP) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

async function clearQueue(ws){
  if (ws._inQueue){
    ws._inQueue = false;
    await broker.dequeue(ws._client);
  }
  if (ws._queueTimer){ clearTimeout(ws._queueTimer); ws._queueTimer = null; }
}

// Локальный сброс таймера + флага, БЕЗ обращения к broker (на момент
// pairLocal/onRemotePair нас уже достали из очереди — dequeue не нужен, а
// на Redis он был бы лишним round-trip'ом). Ровно то, что нужно, чтобы
// отсроченный queue_timeout не выстрелил в середине уже начатого матча.
function clearQueueTimer(ws){
  if (!ws) return;
  if (ws._queueTimer){ clearTimeout(ws._queueTimer); ws._queueTimer = null; }
  ws._inQueue = false;
}

// Локальный pair: оба клиента на этом инстансе. host — тот, что ждал,
// guest — тот, что только что подошёл и заключил пару.
async function pairLocal(host, guest){
  const roomId  = crypto.randomBytes(6).toString("hex");
  const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
  const stakes  = rollStakes();
  await broker.setStakes(matchId, stakes, MATCH_STAKES_TTL_MS);
  host.role  = "host"; guest.role = "guest";
  host.roomId = guest.roomId = roomId;
  host.activeMatchId = guest.activeMatchId = matchId;
  // Критично: хост ждал в очереди — у него стоит _inQueue + _queueTimer.
  // Без сброса через QUEUE_TIMEOUT_MS (30с) таймер сработает прямо посреди
  // живого матча, увидит _inQueue=true и отправит хосту {type:"queue_timeout"}.
  // Клиент воспримет это как «не нашли пару» и запустит startBotMatch поверх
  // активного PvP-матча (→ бот у хоста, зависшая картинка у гостя).
  clearQueueTimer(host);
  clearQueueTimer(guest);
  await broker.joinRoom(roomId, host._client);
  await broker.joinRoom(roomId, guest._client);
  const stakesMsg = { win: stakes.win, loss: stakes.loss };
  const net = AUTH_PHYSICS ? "auth" : "host";
  send(host,  { type: "matched", role: "host",  room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(guest.user), net });
  send(guest, { type: "matched", role: "guest", room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(host.user),  net });
  shadow.registerRole(host.wsId,  "host");
  shadow.registerRole(guest.wsId, "guest");
  shadow.openRoom(roomId, { authoritative: AUTH_PHYSICS });
  if (AUTH_PHYSICS){
    shadow.attachPeer(roomId, "host",  host._client.sendRaw);
    shadow.attachPeer(roomId, "guest", guest._client.sendRaw);
  }
  console.log(`[ws] matched host=${host.user.id} guest=${guest.user.id} room=${roomId} match=${matchId} stakes=+${stakes.win}/-${stakes.loss} net=${net}`);
}

// DV_ROOMS=hathora: pair выносит gameplay-WS на эфемерный room-server на
// Hathora Cloud. Клиент получает расширенный matched с roomHost/roomPort/
// roomToken — открывает второй WS на Hathora и шлёт туда input/snapshot.
// Railway-WS остаётся подключённым для lobby/stats/wallet/trophies.
//
// Физику server.js НЕ крутит в этом режиме — она живёт в room-server.js.
// Shadow не регистрируется тут: room-server регистрирует свой ShadowRegistry.
// Broker.joinRoom всё равно зовём — по нему идёт peer_left при leave/disconnect.
//
// Fail-safe: если createRoom упал (сеть, квоты, Hathora down) — падаем в
// pairLocal, матч не теряется. Факт инцидента уходит в лог.
async function pairHathora(host, guest){
  if (!ROOM_SECRET){
    console.warn("[ws] pairHathora: ROOM_SECRET пуст — fallback to pairLocal");
    return pairLocal(host, guest);
  }
  const roomId  = crypto.randomBytes(6).toString("hex");
  const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
  const stakes  = rollStakes();
  let room;
  try {
    if (DV_LOCAL_ROOMS){
      room = await spawnLocalRoomServer({ roomId, matchId });
    } else {
      room = await hathoraClient.createRoom({ region: HATHORA_REGION });
    }
  } catch (e){
    console.warn(`[ws] room-create failed (${e && e.message || e}) — fallback to pairLocal`);
    return pairLocal(host, guest);
  }
  await broker.setStakes(matchId, stakes, MATCH_STAKES_TTL_MS);
  host.role  = "host";  guest.role = "guest";
  host.roomId = guest.roomId = roomId;
  host.activeMatchId = guest.activeMatchId = matchId;
  clearQueueTimer(host);
  clearQueueTimer(guest);
  await broker.joinRoom(roomId, host._client);
  await broker.joinRoom(roomId, guest._client);
  // Stage 7.5: запомнить user-объекты под matchId. Webhook от room-server
  // принесёт только winnerRole (host/guest), нам нужны полные userObj для
  // applyMatchOutcome + ensureUser. Снимаем запись в leaveRoom.
  hathoraMatchUsers.set(matchId, { host: host.user, guest: guest.user, roomId });
  const hostToken  = signRoomToken(ROOM_SECRET, { userId: host.user.id,  roomId, role: "host",  matchId }, ROOM_TOKEN_TTL_MS);
  const guestToken = signRoomToken(ROOM_SECRET, { userId: guest.user.id, roomId, role: "guest", matchId }, ROOM_TOKEN_TTL_MS);
  const stakesMsg = { win: stakes.win, loss: stakes.loss };
  const common = {
    type: "matched", room: roomId, matchId, stakes: stakesMsg, net: "auth",
    roomHost: room.host, roomPort: room.port
  };
  send(host,  { ...common, role: "host",  opponent: safeUser(guest.user), roomToken: hostToken });
  send(guest, { ...common, role: "guest", opponent: safeUser(host.user),  roomToken: guestToken });
  console.log(`[ws] hathora-matched host=${host.user.id} guest=${guest.user.id} room=${roomId} match=${matchId} hathoraRoom=${room.roomId} at=${room.host}:${room.port}`);
}

// Cross-instance pair: нас забрали из очереди на другом инстансе. Пришло
// сообщение в наш dv:inst:<id> канал. Мы — host (ждали в очереди).
async function onRemotePair(info){
  const host = broker.clients.get(info.hostWsId);
  if (!host || host.ws.readyState !== 1) return;
  host.ws.role = "host";
  host.ws.roomId = info.roomId;
  host.ws.activeMatchId = info.matchId;
  // Тот же хазард, что и в pairLocal: у ждавшего хоста висит _queueTimer,
  // который без сброса через 30с рубит живой матч через queue_timeout.
  clearQueueTimer(host.ws);
  await broker.joinRoom(info.roomId, host);
  const stakesMsg = { win: info.stakes.win, loss: info.stakes.loss };
  // Cross-instance = остаёмся на host-auth: у нас только sink хоста, guest
  // на другом инстансе — authoritative sim некуда воткнуть второй sendRaw.
  send(host.ws, { type: "matched", role: "host", room: info.roomId, matchId: info.matchId, stakes: stakesMsg, opponent: info.guestUser, net: "host" });
  shadow.registerRole(host.ws.wsId, "host");
  shadow.openRoom(info.roomId);
  console.log(`[ws] remote-matched host=${host.ws.user.id} room=${info.roomId} match=${info.matchId}`);
}

async function onQueue(ws){
  if (ws.roomId) return; // уже в матче — игнорируем повторный queue
  if (ws._inQueue) return;

  let res = await broker.enqueue(ws._client);
  if (res && res.kind === "local"){
    const partner = res.partner.ws; // client wraps ws
    if (partner && partner.readyState === 1){
      if (DV_ROOMS === "hathora") await pairHathora(partner, ws);
      else                        await pairLocal(partner, ws);
      return;
    }
    // Partner умер в узкой гонке между LocalBroker.enqueue (там уже есть
    // readyState-гард) и этой веткой. broker.waiting=null, мы «достались»
    // из очереди, но pair не случился. Без ре-enqueue клиент застрял бы
    // в лобби: _inQueue=false, таймер не поставлен, никакое событие его
    // не разбудит. Перекладываем себя обратно в waiting и падаем в null-
    // ветку ниже (таймер + _inQueue).
    res = await broker.enqueue(ws._client);
  }
  if (res && res.kind === "remote"){
    // Партнёр на другом инстансе — мы guest, он host. Сгенерим общие
    // идентификаторы и отправим pair туда.
    const roomId  = crypto.randomBytes(6).toString("hex");
    const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
    const stakes  = rollStakes();
    await broker.setStakes(matchId, stakes, MATCH_STAKES_TTL_MS);
    ws.role = "guest";
    ws.roomId = roomId;
    ws.activeMatchId = matchId;
    await broker.joinRoom(roomId, ws._client);
    const stakesMsg = { win: stakes.win, loss: stakes.loss };
    // Симметрично onRemotePair: cross-instance не умеет server-auth, клиент
    // переходит в host-auth независимо от локального DV_AUTH_PHYSICS.
    send(ws, { type: "matched", role: "guest", room: roomId, matchId, stakes: stakesMsg, opponent: { id: res.partner.userId }, net: "host" });
    shadow.registerRole(ws.wsId, "guest");
    shadow.openRoom(roomId);
    await broker.publishPair(res.partner.instance, {
      hostWsId:  res.partner.wsId,
      guestUser: safeUser(ws.user),
      roomId, matchId,
      stakes: { win: stakes.win, loss: stakes.loss }
    });
    console.log(`[ws] cross-instance matched guest=${ws.user.id} room=${roomId} match=${matchId}`);
    return;
  }
  // null → нас поставили в очередь, ждём.
  ws._inQueue = true;
  if (ws._queueTimer) clearTimeout(ws._queueTimer);
  ws._queueTimer = setTimeout(async () => {
    ws._queueTimer = null;
    if (ws._inQueue){
      ws._inQueue = false;
      await broker.dequeue(ws._client);
      send(ws, { type: "queue_timeout" });
    }
  }, QUEUE_TIMEOUT_MS);
}

async function leaveRoom(ws, reason){
  // Анти-ренакт: уходящий из активного матча автоматически получает
  // поражение (−loss трофеев). Только если матч ещё не закрыт и исход
  // от этого юзера ещё не пришёл. Cancel в лобби (до pair) не достигает
  // этой ветки — activeMatchId там не выставлен.
  const mid = ws.activeMatchId;
  if (mid && reason !== "cancel"){
    const res = await applyMatchOutcome(ws.user, mid, "loss");
    if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
  }
  const roomId = ws.roomId;
  ws.activeMatchId = null;
  ws.roomId = null;
  if (roomId){
    // Уведомим пира (где бы он ни был) «control»-фреймом через publishRoom.
    // В local-режиме это прямой send, в Redis-режиме — publish по каналу.
    const frame = JSON.stringify({ type: "peer_left", reason: reason || "disconnect" });
    broker.publishRoom(roomId, ws.wsId, frame);
    // Симметрично сбрасываем серверное состояние локальных пиров в этой
    // комнате: матч кончился, комната больше не нужна. Иначе у пира
    // остаётся ws.roomId, и его следующий queue игнорится как "уже в
    // матче", пока он не нажмёт cancel. В Redis-режиме аналогичная
    // чистка отдалённого пира происходит в broker._onRoomFrame при
    // доставке peer_left — так покрыты оба layout'а.
    if (broker.getLocalRoomClients){
      const peers = broker.getLocalRoomClients(roomId);
      for (const c of peers){
        if (!c || c.wsId === ws.wsId) continue;
        // Только roomId — это ворота для "уже в матче" в onQueue. activeMatchId
        // держим: оставшийся пир всё ещё может прислать match_win/match_loss
        // без matchId-в-пейлоаде, и сервер найдёт нужный matchId через него.
        if (c.ws) c.ws.roomId = null;
        // Shadow: у пира roomId только что занулили, его собственный close
        // не зайдёт в блок unregisterRole. Чистим здесь по snapshot списку.
        shadow.unregisterRole(c.wsId);
      }
    }
    await broker.leaveRoom(roomId, ws._client);
    shadow.unregisterRole(ws.wsId);
    shadow.closeRoom(roomId);
    // Stage 7.4: если комната стартовалась как child-process (DV_LOCAL_ROOMS=1
    // или Hathora=local_spawn), грохаем процесс. Для Hathora-cloud такого
    // child'а нет (room-server живёт в их контейнере), Map не знает о нём.
    killLocalRoomChild(roomId);
    // Stage 7.5: освобождаем Map user'ов под matchId. Если webhook ещё не
    // пришёл — beast-case: клиент ушёл до конца матча. broker.claimOutcome
    // всё равно идемпотентен, а хранение user-объекта под TTL смысла не
    // имеет — leave/disconnect значит webhook приходит в никуда.
    if (mid) hathoraMatchUsers.delete(mid);
  } else {
    shadow.unregisterRole(ws.wsId);
  }
}

wss.on("connection", async (ws, req) => {
  const user = authUserFromCookie(req);
  if (!user) {
    try { ws.close(4401, "unauthorized"); } catch {}
    return;
  }
  // TCP_NODELAY на underlying сокете — Nagle по умолчанию включён и может
  // задерживать 61-байтные снапшоты до ~40 мс ради батчинга. На hot-path
  // это чистая просадка плавности. ws@8 отдаёт Node.js-сокет через _socket.
  try { ws._socket && ws._socket.setNoDelay(true); } catch {}
  ws.user          = user;
  ws.roomId        = null;
  ws.activeMatchId = null;
  ws._tokens       = MSG_BURST;
  ws._tokensT      = Date.now();
  // Heartbeat: pong от клиента сбрасывает флаг в true. Sweep выше каждые
  // WS_HEARTBEAT_MS проверит, был ли pong, и terminate'нет, если нет.
  ws._alive = true;
  ws.on("pong", () => { ws._alive = true; });
  // wsId — стабильный идентификатор клиента на время жизни WebSocket-коннекта,
  // общий для всех инстансов через Redis. В local-режиме тоже нужен:
  // publishRoom использует его как senderId, чтобы не отправлять эхо себе.
  ws.wsId    = broker.generateWsId();
  ws._client = {
    wsId:   ws.wsId,
    userId: user.id,
    ws,
    // sendRaw — горячий путь доставки уже сериализованного фрейма (снапшот
    // 30 Гц). Проверки readyState/bufferedAmount здесь обязательны, потому
    // что broker.publishRoom зовёт sendRaw без собственных проверок.
    sendRaw: (frame) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > WS_BACKPRESSURE_DROP) return;
      try { ws.send(frame); } catch {}
    }
  };
  broker.registerClient(ws._client);
  _indexWsUser(ws);
  _lastStatsTotal = await broker.incrOnline();

  send(ws, { type: "hello", user: safeUser(user), online: _lastStatsTotal, coins: userCoins(user.id), trophies: userTrophies(user.id) });
  scheduleStatsBroadcast();

  ws.on("message", async (raw, isBinary) => {
    if (!takeToken(ws)) return;
    // Сверхгабаритные фреймы отрезаем по сырому размеру ещё до JSON.parse.
    if (raw && raw.length > 8192) return;
    // Бинарный горячий путь — relay без JSON.parse/JSON.stringify.
    // Клиент шлёт снапшоты/инпут/эмоции как бинарные WS-фреймы (см. Codec
    // в game.js); сервер forward'ит байты как есть всем в комнате через
    // broker.publishRoom. При 10k матчей × 30 Гц это снимает ~300k JSON-
    // циклов в секунду с главного event loop'а.
    if (isBinary) {
      if (!ws.roomId) return;
      if (!raw || raw.length < 2 || raw.length > 256) return;
      // Observer/auth захватывает бинарку ДО relay. В auth-комнате вход
      // (input+state) не ретранслируется — сервер сам эмитит снапшоты
      // обоим через peerSinks. Emote-фрейм (0x03) всё ещё идёт через
      // relay, чтобы не дублировать peer-дискавери.
      shadow.observeFrame(ws.roomId, ws.wsId, raw);
      if (shadow.isAuthoritative(ws.roomId) && raw.length >= 1){
        const op = (raw instanceof Buffer) ? raw[0] : new Uint8Array(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength)[0];
        if (op === 0x01 || op === 0x02) return;
      }
      broker.publishRoom(ws.roomId, ws.wsId, raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "queue":
        await onQueue(ws);
        break;
      case "cancel":
        await clearQueue(ws);
        if (ws.roomId) await leaveRoom(ws, "cancel");
        break;
      case "leave":
        await leaveRoom(ws, "leave");
        break;
      case "match_stakes_request": {
        // Бот-матч: клиент сгенерил matchId локально и просит сервер
        // зафиксировать ставки трофеев. Если для этого matchId уже есть
        // запись — возвращаем кэш (ре-коннекты, повторный запрос).
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : "";
        if (!mid) break;
        let st = await broker.getStakes(mid);
        if (!st){
          st = rollStakes();
          await broker.setStakes(mid, st, MATCH_STAKES_TTL_MS);
        }
        ws.activeMatchId = mid;
        send(ws, { type: "match_stakes", matchId: mid, win: st.win, loss: st.loss });
        break;
      }
      case "match_win": {
        // Сервер берёт размер награды из зафиксированных ставок — клиент
        // не может раздуть сумму. Защищено одноразовостью: повторный
        // match_win с тем же matchId → no-op.
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : (ws.activeMatchId || "");
        if (!mid) break;
        const res = await applyMatchOutcome(ws.user, mid, "win");
        if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
        break;
      }
      case "match_loss": {
        // Потеря трофеев: сервер применяет ставку loss (с клампом в 0).
        // Повторный match_loss с тем же matchId проигнорируется.
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : (ws.activeMatchId || "");
        if (!mid) break;
        const res = await applyMatchOutcome(ws.user, mid, "loss");
        if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
        break;
      }
      case "award": {
        // Серверно-авторитетные награды (все kind из AWARDS, включая match.win).
        // Клиент шлёт {kind, matchId, context}. Клиентский amount игнорируется —
        // размер награды определяет сервер. Защита от фарма бота:
        // global cooldown 30 с между match.win + per-match cap по каждому kind.
        const kind = String(msg.kind || "");
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : "";
        if (!mid) break;
        const ctx = (msg.context && typeof msg.context === "object") ? msg.context : null;
        const res = awardCoins(ws.user, kind, mid, ctx);
        if (res) send(ws, { type: "wallet", coins: res.coins, delta: res.delta, kind });
        break;
      }
    }
  });

  ws.on("close", async () => {
    _lastStatsTotal = await broker.decrOnline();
    await clearQueue(ws);
    await leaveRoom(ws, "disconnect");
    _unindexWsUser(ws);
    broker.unregisterClient(ws._client);
    // Счётчик онлайна изменился — уведомим всех подключённых клиентов.
    scheduleStatsBroadcast();
  });

  ws.on("error", () => {});
});

// Брокер инициализируем ДО listen(): wss прицеплен к httpServer, пока он
// не слушает — upgrade-запросы не приходят, так что обработчик connection
// не дёрнет ещё-пустой broker. После init регистрируем колбэки для
// cross-instance pair (нас разбудили через dv:inst:<id>) и stats pulse,
// и запускаем housekeeping ставок (в Redis-режиме — no-op, там TTL в SET).
(async () => {
  broker = await createBroker({ redisUrl: process.env.REDIS_URL, instanceId: INSTANCE_ID });
  broker.onPairFromPeer(onRemotePair);
  broker.onStatsUpdate(total => { _lastStatsTotal = total; scheduleStatsBroadcast(); });
  broker.startHousekeeping(MATCH_STAKES_TTL_MS);
  httpServer.listen(Number(PORT), () => {
    console.log(`[discord-volley] listening on :${PORT}`);
    console.log(`[discord-volley] public: ${APP_URL}`);
    console.log(`[discord-volley] redirect_uri: ${REDIRECT_URI}`);
    console.log(`[discord-volley] NODE_ENV=${NODE_ENV} broker=${broker.kind} instance=${INSTANCE_ID} rooms=${DV_ROOMS}${DV_ROOMS_ROLLBACK ? " (rollback)" : ""}`);
  });
})().catch(e => {
  console.error("[fatal] startup failed:", e);
  process.exit(1);
});
